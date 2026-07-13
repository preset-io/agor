/**
 * Branches Service
 *
 * Provides REST + WebSocket API for branch management.
 * Uses DrizzleService adapter with BranchRepository.
 */

import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { analyticsLogger } from '@agor/core/analytics';
import {
  createUserProcessEnvironment,
  ENVIRONMENT,
  loadConfig,
  PAGINATION,
  resolveExecutionSecurityMode,
} from '@agor/core/config';
import {
  BoardRepository,
  BranchRepository,
  type BranchWithZoneAndSessions,
  getCurrentTenantId,
  KnowledgeNamespaceRepository,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { renderBranchSnapshot } from '@agor/core/environment/render-snapshot';
import {
  MANAGED_ENV_EXECUTION_MODE_DEFAULT,
  type ManagedEnvCommandType,
  type ManagedEnvExecutionMode,
  redactManagedEnvWebhookUrlForAudit,
  resolveManagedEnvCommandExecution,
  validateManagedEnvLifecyclePolicy,
  validateRenderedManagedEnvUrlFields,
} from '@agor/core/environment/webhook';
import { type Application, BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import { stripGitUrlCredentials } from '@agor/core/git/pure';
import type {
  AuthenticatedParams,
  Board,
  BoardID,
  Branch,
  BranchEnvironmentUpdate,
  BranchID,
  KnowledgeNamespace,
  QueryParams,
  Repo,
  UserID,
  UUID,
} from '@agor/core/types';
import {
  BRANCH_ENVIRONMENT_CLEARABLE_FIELDS,
  getTeammateConfig,
  isTeammate,
} from '@agor/core/types';
import {
  getGidFromGroupName,
  resolveUnixUserForImpersonation,
  validateResolvedUnixUser,
} from '@agor/core/unix';
import { resolveHostIpAddress } from '@agor/core/utils/host-ip';
import { isAllowedHealthCheckUrl } from '@agor/core/utils/url';
import { DrizzleService, type Query } from '../adapters/drizzle';
import { buildBranchCreatedAnalyticsProperties } from '../utils/analytics-payloads.js';
import { ensureCanControlBranchEnvironment } from '../utils/branch-authorization.js';
import { shouldUseCloneReferencePath } from '../utils/clone-reference.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { resolveGitImpersonationForBranch } from '../utils/git-impersonation.js';
import { parseLastMessageTruncationLength } from '../utils/query-params.js';
import {
  generateScopedServiceToken,
  getDaemonUrl,
  runExecutorCommand,
  spawnExecutor,
} from '../utils/spawn-executor.js';
import { deferWithTenantContext } from '../utils/tenant-db-scope.js';
import { isKnowledgeAdmin } from './knowledge-access.js';
import type { InternalEnrichmentParams } from './sessions';
import { ensureTeammateKnowledgeNamespace as ensureTeammateKnowledgeNamespaceForBranch } from './teammate-knowledge.js';

/**
 * Branch service params
 */
export type BranchParams = QueryParams<{
  branch_id?: BranchID | { $in?: BranchID[] };
  repo_id?: UUID;
  name?: string;
  ref?: string;
  zone_id?: string; // Virtual filter: board_objects.data.zone_id, handled before pagination
  deleteFromFilesystem?: boolean;
  include_sessions?: boolean | 'true' | 'false'; // Opt-in session activity enrichment
  last_message_truncation_length?: number; // Default: 500 chars, min: 50, max: 10000
}> &
  AuthenticatedParams &
  InternalEnrichmentParams & {
    /** Root-level include_sessions flag (bypasses Feathers query filtering, used by internal service calls) */
    _include_sessions?: boolean | 'true' | 'false';
    /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
    _agorSqlBranchAccessUserId?: UUID;
  };

type EnvironmentLifecycleAction = 'start' | 'stop' | 'restart' | 'nuke';

interface EnvironmentLifecycleExecutorPayload extends Record<string, unknown> {
  command: 'environment.lifecycle';
  sessionToken: string;
  daemonUrl: string;
  env: Record<string, string>;
  params: {
    branchId: BranchID;
    branchPath: string;
    action: EnvironmentLifecycleAction;
    startCommand?: string;
    stopCommand?: string;
    nukeCommand?: string;
    appUrl?: string;
  };
}

type EnvironmentInstance = NonNullable<Branch['environment_instance']>;

/**
 * Process tracking for environment management
 */
interface ManagedProcess {
  process: ChildProcess;
  pid: number;
  branchId: BranchID;
  startedAt: Date;
  logPath: string;
}

/**
 * Extended branches service with custom methods
 */
export class BranchesService extends DrizzleService<Branch, Partial<Branch>, BranchParams> {
  private branchRepo: BranchRepository;
  private boardRepo: BoardRepository;
  private db: TenantScopeAwareDatabase;
  private app: Application;
  private processes = new Map<BranchID, ManagedProcess>();
  // Cache board-objects service reference (lazy-loaded to avoid circular deps)
  private boardObjectsService?: {
    find: (params?: unknown) => Promise<unknown>;
    findByBranchId: (
      branchId: BranchID,
      params?: unknown
    ) => Promise<{ object_id: string; zone_id?: string } | null>;
    create: (data: unknown, params?: unknown) => Promise<unknown>;
    remove: (id: string) => Promise<unknown>;
    patch: (id: string, data: { zone_id?: string | null }) => Promise<unknown>;
  };

  constructor(db: TenantScopeAwareDatabase, app: Application) {
    const branchRepo = new BranchRepository(db);
    super(branchRepo, {
      id: 'branch_id',
      resourceType: 'Branch',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });

    this.branchRepo = branchRepo;
    this.boardRepo = new BoardRepository(db);
    this.db = db;
    this.app = app;
  }

  /** Short tenant/RLS unit of work for custom methods that bypass Feathers hooks. */
  private withTenantDatabase<T>(
    params: BranchParams | undefined,
    work: () => Promise<T>
  ): Promise<T> {
    const tenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();
    return runWithTenantDatabaseScope(this.db, tenantId, work);
  }

  private loadEnvironmentForAction(
    id: BranchID,
    params: BranchParams | undefined,
    action: string
  ): Promise<BranchWithZoneAndSessions> {
    return this.withTenantDatabase(params, async () => {
      await this.ensureCanTriggerEnv(id, params, action);
      return this.get(id, params);
    });
  }

  /**
   * Canonical control gate for managed environment custom methods.
   * Runs for REST, WebSocket, and MCP callers since all trigger paths reach
   * this service class.
   */
  private async ensureCanTriggerEnv(
    id: BranchID,
    params: BranchParams | undefined,
    action: string
  ): Promise<void> {
    await ensureCanControlBranchEnvironment(this.branchRepo, id, params, action);
  }

  private async getManagedEnvExecutionMode(): Promise<ManagedEnvExecutionMode> {
    const config = await loadConfig();
    return config.execution?.managed_envs_execution_mode ?? MANAGED_ENV_EXECUTION_MODE_DEFAULT;
  }

  private async resolveEnvironmentCommand(command: string, commandType: ManagedEnvCommandType) {
    return resolveManagedEnvCommandExecution(
      command,
      await this.getManagedEnvExecutionMode(),
      commandType
    );
  }

  private async validateRenderedEnvironmentActions(snapshot: {
    start?: string;
    stop?: string;
    nuke?: string;
    logs?: string;
  }): Promise<void> {
    const mode = await this.getManagedEnvExecutionMode();
    validateManagedEnvLifecyclePolicy(
      {
        start: snapshot.start,
        stop: snapshot.stop,
        nuke: snapshot.nuke,
        logs: snapshot.logs,
      },
      mode,
      'rendered branch environment'
    );
  }

  private async executeEnvironmentWebhook(options: {
    url: string;
    branch: Branch;
    commandType: ManagedEnvCommandType;
    triggeredBy?: { user_id?: string; email?: string };
    maxBytes?: number;
  }): Promise<{ body: string; truncated: boolean; status: number }> {
    const {
      url,
      branch,
      commandType,
      triggeredBy,
      maxBytes = ENVIRONMENT.LOGS_MAX_BYTES,
    } = options;
    const redactedUrl = redactManagedEnvWebhookUrlForAudit(url);

    console.log(
      `🔗 Calling environment ${commandType} webhook for branch ${branch.name}: ${redactedUrl}`
    );
    console.log(
      `AUDIT ${JSON.stringify({
        event: 'agor.env_webhook.get',
        timestamp: new Date().toISOString(),
        branch_id: branch.branch_id,
        branch_name: branch.name,
        command_type: commandType,
        url: redactedUrl,
        triggered_by_user_id: triggeredBy?.user_id,
        triggered_by_email: triggeredBy?.email,
      })}`
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ENVIRONMENT.LOGS_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Agor managed-environment webhook',
        },
      });

      const { body, truncated } = await this.readLimitedWebhookBody(response, maxBytes);

      if (!response.ok) {
        throw new Error(`Environment ${commandType} webhook returned HTTP ${response.status}`);
      }

      return { body, truncated, status: response.status };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `Environment ${commandType} webhook timed out after ${ENVIRONMENT.LOGS_TIMEOUT_MS / 1000}s`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readLimitedWebhookBody(
    response: Response,
    maxBytes: number
  ): Promise<{ body: string; truncated: boolean }> {
    const reader = response.body?.getReader();
    if (!reader) return { body: '', truncated: false };

    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }

      if (value.byteLength <= remaining) {
        chunks.push(value);
        total += value.byteLength;
      } else {
        chunks.push(value.slice(0, remaining));
        total += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }
    }

    return {
      body: Buffer.concat(chunks, total).toString('utf8'),
      truncated,
    };
  }

  private async resolveEnvironmentExecutorContext(
    branch: Branch,
    params?: BranchParams
  ): Promise<{
    asUser?: string;
    env: Record<string, string>;
  }> {
    const config = await loadConfig();
    const unixUserMode = config.execution?.unix_user_mode ?? 'simple';
    return this.withTenantDatabase(params, async () => {
      let asUser: string | undefined;

      if (unixUserMode !== 'simple') {
        const usersRepo = new UsersRepository(this.db);
        const user = await usersRepo.findById(branch.created_by);
        const impersonationResult = resolveUnixUserForImpersonation({
          mode: unixUserMode,
          userUnixUsername: user?.unix_username,
          executorUnixUser: config.execution?.executor_unix_user,
        });

        asUser = impersonationResult.unixUser ?? undefined;
        if (asUser) {
          validateResolvedUnixUser(unixUserMode, asUser);
        }
      }

      const env = await createUserProcessEnvironment(
        branch.created_by,
        this.db,
        undefined,
        !!asUser
      );
      return { asUser, env };
    });
  }

  private async createEnvironmentExecutorPayload(options: {
    branch: Branch;
    action: EnvironmentLifecycleAction;
    params?: BranchParams;
  }): Promise<{
    payload: EnvironmentLifecycleExecutorPayload;
    asUser?: string;
    env: Record<string, string>;
  }> {
    const { branch, action, params } = options;
    const userId =
      ((params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined) ??
      branch.created_by;
    const appWithToken = this.app as unknown as {
      sessionTokenService?: import('../services/session-token-service').SessionTokenService;
    };
    const sessionToken = await this.withTenantDatabase(
      params,
      () =>
        appWithToken.sessionTokenService?.generateToken(`environment-${action}`, userId, {
          branchId: branch.branch_id,
          maxUses: -1,
        }) ?? Promise.resolve(undefined)
    );
    if (!sessionToken) {
      throw new Error(`Session token service unavailable; cannot dispatch environment ${action}`);
    }

    const { asUser, env } = await this.resolveEnvironmentExecutorContext(branch, options.params);

    return {
      asUser,
      env,
      payload: {
        command: 'environment.lifecycle',
        sessionToken,
        daemonUrl: getDaemonUrl(),
        env,
        params: {
          branchId: branch.branch_id,
          branchPath: branch.path,
          action,
          startCommand: branch.start_command,
          stopCommand: branch.stop_command,
          nukeCommand: branch.nuke_command,
          appUrl: branch.app_url,
        },
      },
    };
  }

  private async dispatchEnvironmentExecutor(options: {
    branch: Branch;
    action: EnvironmentLifecycleAction;
    params?: BranchParams;
  }): Promise<void> {
    const { branch, action, params } = options;
    const { payload, asUser, env } = await this.createEnvironmentExecutorPayload(options);
    const logPrefix = `[Environment.${action} ${branch.name}]`;

    const spawnLifecycleExecutor = async () => {
      try {
        spawnExecutor(payload, {
          logPrefix,
          asUser,
          preparedEnv: env,
          templateVariables: {
            branch_id: branch.branch_id,
          },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to spawn environment executor';
        await this.updateEnvironment(
          branch.branch_id,
          {
            status: 'error',
            last_health_check: {
              timestamp: new Date().toISOString(),
              status: 'unhealthy',
              message,
            },
            last_error: message,
          },
          params
        );
        throw error;
      }
    };

    deferWithTenantContext(params, spawnLifecycleExecutor, (error) => {
      console.error(`${logPrefix} Failed to dispatch executor:`, error);
    });
  }

  private async runEnvironmentExecutor(options: {
    branch: Branch;
    action: EnvironmentLifecycleAction;
    params?: BranchParams;
  }): Promise<void> {
    const { branch, action } = options;
    const { payload, asUser, env } = await this.createEnvironmentExecutorPayload(options);

    const result = await runExecutorCommand(payload, {
      logPrefix: `[Environment.${action} ${branch.name}]`,
      asUser,
      preparedEnv: env,
      // Mixed webhook/shell restart needs the daemon to wait for shell stop
      // before it invokes the daemon-owned webhook start. Keep this generous
      // enough for docker compose down while still bounding the request.
      timeoutMs: 10 * 60_000,
      templateVariables: {
        branch_id: branch.branch_id,
      },
    });

    if (!result.success) {
      const details = result.error?.details as { output?: string } | undefined;
      const error = new Error(
        result.error?.message || 'Executor environment command failed'
      ) as Error & {
        commandOutput?: string;
      };
      error.commandOutput = details?.output;
      throw error;
    }
  }

  private async fetchEnvironmentLogsViaExecutor(
    branch: Branch,
    logsCommand: string,
    params?: BranchParams
  ): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
    const userId =
      ((params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined) ??
      branch.created_by;
    const appWithToken = this.app as unknown as {
      sessionTokenService?: import('../services/session-token-service').SessionTokenService;
    };
    const sessionToken = await this.withTenantDatabase(
      params,
      () =>
        appWithToken.sessionTokenService?.generateToken('environment-logs', userId, {
          branchId: branch.branch_id,
          maxUses: -1,
        }) ?? Promise.resolve(undefined)
    );
    if (!sessionToken) {
      throw new Error('Session token service unavailable; cannot fetch environment logs');
    }

    const { asUser, env } = await this.resolveEnvironmentExecutorContext(branch, params);
    const result = await runExecutorCommand(
      {
        command: 'environment.logs',
        sessionToken,
        daemonUrl: getDaemonUrl(),
        env,
        params: {
          branchId: branch.branch_id,
          branchPath: branch.path,
          logsCommand,
        },
      },
      {
        logPrefix: `[Environment.logs ${branch.name}]`,
        asUser,
        preparedEnv: env,
        timeoutMs: ENVIRONMENT.LOGS_TIMEOUT_MS,
        templateVariables: {
          branch_id: branch.branch_id,
        },
      }
    );

    if (!result.success) {
      const details = result.error?.details as { output?: string } | undefined;
      throw new Error(result.error?.message || details?.output || 'Failed to fetch logs');
    }

    const data = (result.data ?? {}) as { logs?: string; truncated?: boolean };
    return { stdout: data.logs ?? '', stderr: '', truncated: data.truncated ?? false };
  }

  /**
   * Extract caller identity for audit logging. Internal/daemon-initiated
   * calls (no params.provider, no user) return undefined which the audit
   * entry records explicitly.
   */
  private extractTriggeredBy(
    params: BranchParams | undefined
  ): { user_id?: string; email?: string } | undefined {
    const user = (params as AuthenticatedParams | undefined)?.user;
    if (!user) return undefined;
    return { user_id: user.user_id, email: user.email };
  }

  /**
   * Get board-objects service (lazy-loaded to prevent circular dependencies)
   * FIX: Cache service reference instead of calling this.app.service() repeatedly
   */
  private getBoardObjectsService() {
    if (!this.boardObjectsService) {
      this.boardObjectsService = this.app.service('board-objects') as unknown as NonNullable<
        BranchesService['boardObjectsService']
      >;
    }
    return this.boardObjectsService;
  }

  /**
   * Compute a smart default position for a branch on a board, based on existing entities/zones.
   * Falls back to a small jitter near origin if placement utilities fail.
   */
  private async computeDefaultBoardPositionForBranch(
    boardId: BoardID,
    currentBranchId: BranchID,
    params?: BranchParams
  ): Promise<{ x: number; y: number }> {
    try {
      const boardObjectsService = this.getBoardObjectsService();
      const board = (await this.app.service('boards').get(boardId, params)) as {
        objects?: Record<string, { type?: string }>;
      };

      const existingResult = (await boardObjectsService.find({
        query: { board_id: boardId },
        ...params,
      })) as { data: Array<{ branch_id?: string | null; position: { x: number; y: number } }> };

      const activeBranchesResult = await this.app.service('branches').find({
        query: { board_id: boardId, archived: false, $limit: 5000 },
        paginate: false,
      });
      const activeBranches = Array.isArray(activeBranchesResult)
        ? activeBranchesResult
        : (activeBranchesResult as { data: Array<{ branch_id: string }> }).data;
      const activeBranchIds = new Set(activeBranches.map((wt) => wt.branch_id));

      const activeEntities = existingResult.data.filter((obj) => {
        if (!obj.branch_id) return true;
        if (obj.branch_id === currentBranchId) return false;
        return activeBranchIds.has(obj.branch_id);
      });

      const zones = board?.objects
        ? Object.entries(board.objects)
            .filter(([, o]) => (o as { type?: string }).type === 'zone')
            .map(([id, o]) => ({ id, ...(o as object) }))
        : [];

      const { resolveEntityAbsolutePositions, computeDefaultBoardPosition } = await import(
        '@agor/core/utils/board-placement'
      );
      const absolutePositions = resolveEntityAbsolutePositions(
        activeEntities as never,
        zones as never
      );
      return computeDefaultBoardPosition(absolutePositions, zones as never);
    } catch (error) {
      console.warn(
        `⚠️ Failed smart board placement for branch ${currentBranchId}:`,
        error instanceof Error ? error.message : String(error)
      );
      return { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 };
    }
  }

  /**
   * Apply branch creation defaults before insert.
   *
   * New branches always start aligned with their board. Branch-specific
   * overrides are an explicit post-create action in the Branch modal.
   *
   * Store the board defaults on the branch row as a snapshot for legacy readers
   * and for a sensible starting point if the user later switches to override
   * mode. Effective access for board-aligned branches still resolves through the
   * board at read/enforcement time.
   */
  private async applyBranchCreateDefaults(data: Partial<Branch>): Promise<Partial<Branch>> {
    const withDefaults: Partial<Branch> = { ...data };
    // New branches always start aligned with their board. Branch-specific
    // overrides are an explicit post-create action in the Branch modal.
    withDefaults.permission_source = 'board';

    if (withDefaults.permission_source === 'board' && withDefaults.board_id) {
      const board = (await this.boardRepo.findById(withDefaults.board_id)) as Board | null;
      if (board) {
        withDefaults.others_can = board.default_others_can ?? 'session';
        withDefaults.others_fs_access = board.default_others_fs_access ?? 'read';
        withDefaults.dangerously_allow_session_sharing =
          board.default_dangerously_allow_session_sharing ?? false;
      }
      return withDefaults;
    }

    const config = await loadConfig();
    const defaults = config.branches;
    if (!defaults) return withDefaults;

    if (defaults.others_can_default !== undefined && withDefaults.others_can === undefined) {
      withDefaults.others_can = defaults.others_can_default;
    }
    if (
      defaults.others_fs_access_default !== undefined &&
      withDefaults.others_fs_access === undefined
    ) {
      withDefaults.others_fs_access = defaults.others_fs_access_default;
    }
    return withDefaults;
  }

  /**
   * Custom method: Initialize Unix group for a branch (daemon-side privileged operation).
   *
   * Called by the executor via Feathers RPC after creating the git branch on
   * disk, so that groupadd/chgrp/setfacl run with daemon sudo privileges
   * regardless of executor impersonation mode.
   *
   * Auth: only service accounts (executor JWTs) may invoke this externally.
   * Internal calls (no `provider`) pass through.
   */
  async initializeUnixGroup(
    data: { branchId: string; othersAccess?: 'none' | 'read' | 'write' },
    params?: BranchParams
  ): Promise<{ unixGroup: string }> {
    if (params?.provider) {
      const caller = (params as AuthenticatedParams | undefined)?.user;
      if (!caller) {
        throw new NotAuthenticated('Authentication required');
      }
      const isService = !!(caller as { _isServiceAccount?: boolean })._isServiceAccount;
      if (!isService) {
        throw new Forbidden('Only the executor service account may initialize Unix groups');
      }
    }

    const { initializeBranchUnixGroup } = await import('../utils/unix-group-init.js');
    const unixGroup = await initializeBranchUnixGroup(
      this.db,
      this.app,
      data.branchId,
      data.othersAccess || 'read'
    );
    return { unixGroup };
  }

  /**
   * Override create to inject config-driven branch defaults.
   */
  async create(
    data: Partial<Branch> | Partial<Branch>[],
    params?: BranchParams
  ): Promise<Branch | Branch[]> {
    const assertHasBoard = (item: Partial<Branch>) => {
      if (!item.board_id) {
        throw new BadRequest('board_id is required when creating a branch');
      }
    };

    if (Array.isArray(data)) {
      data.forEach(assertHasBoard);
      const withDefaults = await Promise.all(
        data.map((item) => this.applyBranchCreateDefaults(item))
      );
      const created = (await super.create(withDefaults, params)) as Branch[];
      const readyBranches = await Promise.all(
        created.map((branch) => this.maybeEnsureTeammateKnowledgeNamespace(branch, params))
      );
      await Promise.all(
        readyBranches.map((branch) => this.maybeSetBoardPrimaryTeammate(branch, params))
      );
      for (const branch of readyBranches) {
        this.trackBranchCreated(branch);
      }
      return readyBranches;
    }
    assertHasBoard(data);
    const withDefaults = await this.applyBranchCreateDefaults(data);
    const created = (await super.create(withDefaults, params)) as Branch;
    const readyBranch = await this.maybeEnsureTeammateKnowledgeNamespace(created, params);
    await this.maybeSetBoardPrimaryTeammate(readyBranch, params);
    this.trackBranchCreated(readyBranch);
    return readyBranch;
  }

  private trackBranchCreated(branch: Branch): void {
    analyticsLogger.track('branch.created', buildBranchCreatedAnalyticsProperties(branch), {
      userId: branch.created_by,
    });
  }

  private async maybeSetBoardPrimaryTeammate(branch: Branch, params?: BranchParams): Promise<void> {
    if (!branch.board_id || !isTeammate(branch)) return;

    try {
      const updatedBoard = await this.boardRepo.setPrimaryTeammateIfUnset(
        branch.board_id,
        branch.branch_id
      );
      if (updatedBoard) {
        emitServiceEvent(this.app, {
          path: 'boards',
          event: 'patched',
          data: updatedBoard,
          params,
          id: updatedBoard.board_id,
        });
      }
    } catch (error) {
      console.warn(
        `⚠️ Failed to set primary teammate for board ${branch.board_id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async maybeEnsureTeammateKnowledgeNamespace(
    branch: Branch,
    params?: BranchParams
  ): Promise<Branch> {
    if (!isTeammate(branch)) return branch;
    const userId = (params?.user?.user_id as UserID | undefined) ?? (branch.created_by as UserID);
    const result = await ensureTeammateKnowledgeNamespaceForBranch(
      this.db,
      branch.branch_id,
      userId
    );
    return result.branch;
  }

  private async assertCanManageTeammateKnowledge(branch: Branch, params?: BranchParams) {
    const user = params?.user;
    const userId = user?.user_id as UserID | undefined;
    if (isKnowledgeAdmin(user as never)) return;
    if (!userId) throw new NotAuthenticated('Authentication required');
    if (branch.created_by === userId) return;
    if (await this.branchRepo.isOwner(branch.branch_id, userId)) {
      return;
    }
    throw new Forbidden('Only branch owners or admins can manage teammate knowledge');
  }

  private containsTeammateKnowledgeConfigMutation(data: Partial<Branch>): boolean {
    if (!Object.hasOwn(data, 'custom_context')) return false;
    const customContext = data.custom_context;
    if (customContext === null) return true;
    if (!customContext || typeof customContext !== 'object' || Array.isArray(customContext)) {
      return false;
    }
    for (const key of ['teammate', 'assistant', 'agent']) {
      const value = customContext[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (Object.hasOwn(value as Record<string, unknown>, 'kb')) return true;
      }
    }
    return false;
  }

  private async assertCanMutateTeammateKnowledgeConfig(
    branch: Branch,
    data: Partial<Branch>,
    params?: BranchParams
  ): Promise<void> {
    if (!isTeammate(branch)) return;
    if (!this.containsTeammateKnowledgeConfigMutation(data)) return;
    await this.assertCanManageTeammateKnowledge(branch, params);
    await this.assertCanUseTeammateHomeNamespace(branch, data, params);
  }

  private extractTeammateKnowledgeConfigPatch(
    data: Partial<Branch>
  ): Record<string, unknown> | null {
    const customContext = data.custom_context;
    if (!customContext || typeof customContext !== 'object' || Array.isArray(customContext)) {
      return null;
    }
    for (const key of ['teammate', 'assistant', 'agent']) {
      const teammatePatch = customContext[key];
      if (!teammatePatch || typeof teammatePatch !== 'object' || Array.isArray(teammatePatch)) {
        continue;
      }
      const kbPatch = (teammatePatch as Record<string, unknown>).kb;
      if (kbPatch && typeof kbPatch === 'object' && !Array.isArray(kbPatch)) {
        return kbPatch as Record<string, unknown>;
      }
    }
    return null;
  }

  private async assertCanUseTeammateHomeNamespace(
    branch: Branch,
    data: Partial<Branch>,
    params?: BranchParams
  ): Promise<void> {
    const kbPatch = this.extractTeammateKnowledgeConfigPatch(data);
    const namespaceId = kbPatch?.primary_namespace_id;
    if (typeof namespaceId !== 'string' || !namespaceId) return;

    const currentNamespaceId = getTeammateConfig(branch)?.kb?.primary_namespace_id;
    if (namespaceId === currentNamespaceId) return;

    const namespaces = new KnowledgeNamespaceRepository(this.db);
    const namespace = await namespaces.findById(namespaceId);
    if (!namespace || namespace.archived) {
      throw new BadRequest('Teammate home Knowledge namespace not found');
    }

    const namespaceSlug = kbPatch.primary_namespace_slug;
    if (typeof namespaceSlug === 'string' && namespaceSlug && namespaceSlug !== namespace.slug) {
      throw new BadRequest('Teammate home Knowledge namespace slug does not match its ID');
    }

    const user = params?.user;
    if (isKnowledgeAdmin(user as never)) return;
    const userId = user?.user_id as UserID | undefined;
    if (!userId) throw new NotAuthenticated('Authentication required');

    const permission = await namespaces.resolveNamespacePermission(namespace.namespace_id, userId);
    if (permission !== 'write' && permission !== 'own') {
      throw new Forbidden('You need write access to use this Knowledge namespace as teammate home');
    }
  }

  async ensureTeammateKnowledgeNamespace(
    data: { branchId?: string; branch_id?: string } | string,
    params?: BranchParams
  ): Promise<{ namespace: KnowledgeNamespace; branch: Branch }> {
    const branchId = String(typeof data === 'string' ? data : (data.branchId ?? data.branch_id));
    if (!branchId || branchId === 'undefined') throw new BadRequest('branchId is required');
    const branch = await this.branchRepo.findById(branchId);
    if (!branch) throw new BadRequest(`Branch not found: ${branchId}`);
    if (!isTeammate(branch)) throw new BadRequest('Branch is not a teammate');
    await this.assertCanManageTeammateKnowledge(branch, params);
    return ensureTeammateKnowledgeNamespaceForBranch(
      this.db,
      branch.branch_id,
      (params?.user?.user_id as UserID | undefined) ?? (branch.created_by as UserID)
    );
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      Object.getPrototypeOf(value) === Object.prototype
    );
  }

  /**
   * Mirrors BranchRepository's patch merge semantics so we can reject
   * teammate/non-teammate conversions before the repository writes them.
   */
  private mergePatchPreview(
    target: Record<string, unknown>,
    source: Record<string, unknown>
  ): Record<string, unknown> {
    const result = { ...target };

    for (const key in source) {
      if (!Object.hasOwn(source, key)) continue;

      const sourceValue = source[key];
      const targetValue = target[key];

      if (sourceValue === undefined) continue;
      if (sourceValue === null || Array.isArray(sourceValue)) {
        result[key] = sourceValue;
        continue;
      }

      if (this.isPlainObject(sourceValue) && this.isPlainObject(targetValue)) {
        result[key] = this.mergePatchPreview(targetValue, sourceValue);
        continue;
      }

      result[key] = sourceValue;
    }

    return result;
  }

  private assertTeammateKindIsStable(currentBranch: Branch, patchData: Partial<Branch>): void {
    const wouldBeBranch = this.mergePatchPreview(
      currentBranch as unknown as Record<string, unknown>,
      patchData as Record<string, unknown>
    ) as unknown as Branch;
    if (isTeammate(currentBranch) === isTeammate(wouldBeBranch)) return;

    throw new BadRequest(
      'Branches cannot be converted between teammate and non-teammate types. Create a new branch or AI teammate instead.'
    );
  }

  private async maintainPrimaryTeammateAfterPatch(
    previousBranch: Branch,
    updatedBranch: Branch,
    params?: BranchParams
  ): Promise<void> {
    const oldBoardId = previousBranch.board_id;
    const newBoardId = updatedBranch.board_id;
    const wasTeammate = isTeammate(previousBranch);
    const isNowTeammate = isTeammate(updatedBranch);

    const shouldClearOldPrimary = Boolean(
      oldBoardId &&
        wasTeammate &&
        (oldBoardId !== newBoardId || !isNowTeammate || updatedBranch.archived === true)
    );

    const shouldSetNewPrimary = Boolean(
      newBoardId &&
        isNowTeammate &&
        updatedBranch.archived !== true &&
        (oldBoardId !== newBoardId || previousBranch.archived === true)
    );

    if (!shouldClearOldPrimary && !shouldSetNewPrimary) return;

    try {
      if (shouldClearOldPrimary) {
        const updatedOldBoard = await this.boardRepo.clearPrimaryTeammateIfMatches(
          oldBoardId!,
          previousBranch.branch_id
        );
        if (updatedOldBoard) {
          emitServiceEvent(this.app, {
            path: 'boards',
            event: 'patched',
            data: updatedOldBoard,
            params,
            id: updatedOldBoard.board_id,
          });
        }
      }

      if (shouldSetNewPrimary) {
        const updatedNewBoard = await this.boardRepo.setPrimaryTeammateIfUnset(
          newBoardId!,
          updatedBranch.branch_id
        );
        if (updatedNewBoard) {
          emitServiceEvent(this.app, {
            path: 'boards',
            event: 'patched',
            data: updatedNewBoard,
            params,
            id: updatedNewBoard.board_id,
          });
        }
      }
    } catch (error) {
      console.warn(
        `⚠️ Failed to maintain primary teammate pointer for branch ${updatedBranch.branch_id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Override patch to handle board_objects when board_id changes.
   *
   * Schedule config lives on the `schedules` table now (see
   * docs/internal/schedules-first-class-design-2026-05-24.md); patches
   * to schedule fields go through the `schedules` service, not here.
   */
  async patch(
    id: BranchID,
    data: Partial<Branch>,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    // Get current branch to check type/board changes
    const currentBranch = await super.get(id, params);
    await this.assertCanMutateTeammateKnowledgeConfig(currentBranch, data, params);
    this.assertTeammateKindIsStable(currentBranch, data);

    const oldBoardId = currentBranch.board_id;
    const boardIdProvided = Object.hasOwn(data, 'board_id');
    const newBoardId = data.board_id;
    const boardChanged = boardIdProvided && oldBoardId !== newBoardId;

    if (
      boardChanged &&
      currentBranch.permission_source === 'board' &&
      data.permission_source !== 'override'
    ) {
      throw new BadRequest(
        'This branch is aligned with board permissions. Switch to "Override board-level permissions" before moving it to another board.'
      );
    }

    // Call parent patch
    const updatedBranch = (await super.patch(id, data, params)) as Branch;
    await this.maintainPrimaryTeammateAfterPatch(currentBranch, updatedBranch, params);

    // Handle board_objects changes if board_id changed
    if (!boardIdProvided) {
      const withZone = await this.branchRepo.enrichWithZoneInfo(updatedBranch);

      // Only enrich with session activity if explicitly requested
      if (params?.query?.include_sessions === true || params?.query?.include_sessions === 'true') {
        const truncationLength = parseLastMessageTruncationLength(
          params?.query?.last_message_truncation_length
        );
        return this.branchRepo.enrichWithSessionActivity(withZone, truncationLength);
      }

      return withZone as BranchWithZoneAndSessions;
    }

    if (boardChanged) {
      const boardObjectsService = this.getBoardObjectsService();

      try {
        // First, check if a board_object already exists
        const existingObject = (await boardObjectsService.findByBranchId(id)) as {
          object_id: string;
        } | null;

        if (existingObject) {
          // Board object exists - delete it first
          await boardObjectsService.remove(existingObject.object_id);
        }

        // Now create new board_object if board_id is set
        if (newBoardId) {
          const position = await this.computeDefaultBoardPositionForBranch(newBoardId, id, params);
          await boardObjectsService.create({
            board_id: newBoardId,
            branch_id: id,
            position,
          });
        }
      } catch (error) {
        console.error(
          `❌ Failed to manage board_objects for branch ${id}:`,
          error instanceof Error ? error.message : String(error)
        );
        // Don't throw - allow branch patch to succeed even if board_object management fails
      }
    }

    const withZone = await this.branchRepo.enrichWithZoneInfo(updatedBranch);

    // Only enrich with session activity if explicitly requested
    if (params?.query?.include_sessions === true || params?.query?.include_sessions === 'true') {
      const truncationLength = parseLastMessageTruncationLength(
        params?.query?.last_message_truncation_length
      );
      return this.branchRepo.enrichWithSessionActivity(withZone, truncationLength);
    }

    return withZone as BranchWithZoneAndSessions;
  }

  async update(id: BranchID, data: Partial<Branch>, params?: BranchParams): Promise<Branch> {
    const currentBranch = await super.get(id, params);
    await this.assertCanMutateTeammateKnowledgeConfig(currentBranch, data, params);
    this.assertTeammateKindIsStable(currentBranch, data);
    if (
      currentBranch.board_id !== data.board_id &&
      currentBranch.permission_source === 'board' &&
      data.permission_source !== 'override'
    ) {
      throw new BadRequest(
        'This branch is aligned with board permissions. Switch to "Override board-level permissions" before moving it to another board.'
      );
    }
    return super.update(id, data, params) as Promise<Branch>;
  }

  /**
   * Override get to enrich with zone information
   *
   * Session activity enrichment is opt-in via include_sessions query parameter
   */
  async get(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    // Check both query params and root-level params (root-level bypasses Feathers query filtering)
    const includeSessionsQuery = params?.query?.include_sessions;
    const includeSessionsRoot = params?._include_sessions;
    const includeSessions = includeSessionsRoot ?? includeSessionsQuery;

    const branch = await super.get(id, params);
    const withZone = await this.branchRepo.enrichWithZoneInfo(branch as Branch);

    // Only enrich with session activity if explicitly requested
    if (includeSessions === true || includeSessions === 'true') {
      const truncationLengthQuery = params?.query?.last_message_truncation_length;
      const truncationLengthRoot = params?._last_message_truncation_length;
      const truncationLength = parseLastMessageTruncationLength(
        truncationLengthRoot ?? truncationLengthQuery
      );
      const result = await this.branchRepo.enrichWithSessionActivity(withZone, truncationLength);
      return result;
    }

    return withZone as BranchWithZoneAndSessions;
  }

  /**
   * Push the list read's high-selectivity predicates into SQL.
   *
   * The generic adapter would read the entire branches table and filter in
   * memory, so the cost scaled with total branch count rather than the scoped
   * result. `branches` is the highest-cardinality entity fetched during initial
   * app load, so we narrow the read to the board scope, archived state,
   * explicit/zone-derived branch ids, and any RBAC SQL visibility marker before
   * rows leave the database. `find` still re-applies every query filter
   * in memory, so this only ever returns a superset of the matching rows and the
   * downstream sort/pagination/enrichment is unaffected.
   *
   * `zone_id` is deliberately not pushed here — it is virtual (backed by
   * board_objects, not a branches column) and is already resolved to a
   * `branch_id` filter in `find` before this runs.
   *
   * A `{ $in }` is only pushed when every element is a string. `branches.branch_id`
   * is non-null so it can't diverge today, but the guard keeps the superset
   * invariant unconditional and avoids handing a malformed element to SQL.
   */
  protected async fetchData(query: Query, params?: BranchParams): Promise<Branch[]> {
    const filter: {
      repo_id?: UUID;
      board_id?: BoardID;
      archived?: boolean;
      branchIds?: BranchID[];
      visibleToUserId?: UUID;
    } = {};

    if (typeof query.repo_id === 'string') filter.repo_id = query.repo_id as UUID;
    if (typeof query.board_id === 'string') filter.board_id = query.board_id as BoardID;
    if (typeof query.archived === 'boolean') filter.archived = query.archived;
    if (params?._agorSqlBranchAccessUserId) {
      filter.visibleToUserId = params._agorSqlBranchAccessUserId;
    }

    const branchId = query.branch_id;
    if (typeof branchId === 'string') {
      filter.branchIds = [branchId as BranchID];
    } else if (
      branchId &&
      typeof branchId === 'object' &&
      Array.isArray(branchId.$in) &&
      branchId.$in.every((el: unknown) => typeof el === 'string')
    ) {
      filter.branchIds = branchId.$in as BranchID[];
    }

    return this.branchRepo.findAll(filter);
  }

  /**
   * Override find to enrich with zone information only
   *
   * Note: Session activity is NOT included in list operations - only on single GET
   *
   * `zone_id` is a virtual query parameter backed by board_objects.data.zone_id.
   * Resolve it to a branch_id filter before delegating to DrizzleService so
   * pagination is applied to the zone-filtered result set, while preserving any
   * existing branch_id scoping injected by RBAC hooks.
   */
  async find(params?: BranchParams) {
    const zoneId = params?.query?.zone_id;
    let findParams = params;

    if (zoneId) {
      const branchIdsInZone = await this.branchRepo.findBranchIdsByZone(zoneId);
      const existingBranchFilter = params?.query?.branch_id;
      let filteredBranchIds = branchIdsInZone;

      if (typeof existingBranchFilter === 'string') {
        filteredBranchIds = branchIdsInZone.includes(existingBranchFilter as BranchID)
          ? [existingBranchFilter as BranchID]
          : [];
      } else if (
        existingBranchFilter &&
        typeof existingBranchFilter === 'object' &&
        Array.isArray(existingBranchFilter.$in)
      ) {
        const allowed = new Set(existingBranchFilter.$in);
        filteredBranchIds = branchIdsInZone.filter((branchId) => allowed.has(branchId));
      }

      const { zone_id: _zoneId, ...queryWithoutZone } = params?.query ?? {};
      findParams = {
        ...params,
        query: {
          ...queryWithoutZone,
          branch_id: { $in: filteredBranchIds },
        },
      } as BranchParams;
    }

    // Use default find to ensure all hooks and scoping are applied (including repo_id filter)
    const result = await super.find(findParams);

    // Handle both paginated and non-paginated results
    if (Array.isArray(result)) {
      return this.branchRepo.enrichManyWithZoneInfo(result as Branch[]);
    } else {
      const enriched = await this.branchRepo.enrichManyWithZoneInfo(result.data as Branch[]);
      return {
        ...result,
        data: enriched,
      };
    }
  }

  /**
   * Override remove to support filesystem deletion
   *
   * Delegates filesystem removal to executor for Unix isolation.
   */
  async remove(id: BranchID, params?: BranchParams): Promise<Branch> {
    const { deleteFromFilesystem } = params?.query || {};

    // Get branch details before deletion
    const branch = await this.withTenantDatabase(params, () => this.get(id, params));

    // Remove from database FIRST for instant UI feedback
    // CASCADE will clean up related comments automatically
    const result = await super.remove(id, params);

    // Then remove from filesystem via executor (fire-and-forget)
    // Executor handles its own logging and error reporting via Feathers
    if (deleteFromFilesystem) {
      console.log(`🗑️  Spawning executor to remove branch from filesystem: ${branch.path}`);

      // Resolve Unix user for sudo wrap. Returns undefined in simple/no-RBAC
      // mode so we don't try to sudo on hosts without passwordless sudoers
      // (#1140 root cause; #1143 fixed the branch-remove sister bug by
      // centralizing the gate inside the resolver itself).
      const asUser = await resolveGitImpersonationForBranch(this.db, branch);

      // Generate session token for executor authentication. Hook chain
      // enforces auth before we get here, so non-null assertion is safe.
      const userId = (params as AuthenticatedParams).user!.user_id as UserID;
      const appWithToken = this.app as unknown as {
        sessionTokenService?: import('../services/session-token-service').SessionTokenService;
      };

      // Generate token and spawn executor (fire-and-forget)
      appWithToken.sessionTokenService
        ?.generateToken('branch-remove', userId, { branchId: branch.branch_id, maxUses: -1 })
        .then((sessionToken) => {
          spawnExecutor(
            {
              command: 'git.branch.remove',
              sessionToken,
              daemonUrl: getDaemonUrl(),
              params: {
                branchId: branch.branch_id,
                branchPath: branch.path,
                deleteDbRecord: false, // Already deleted above
                // Clean up the branch if it was created by Agor
                branch: branch.ref,
                deleteBranch: branch.new_branch,
                // Branch storage mode — executor needs this to pick the right
                // teardown path (clone-mode just rm -rf; worktree-mode also
                // runs `git worktree remove --force` against the base repo).
                storageMode: branch.storage_mode ?? 'worktree',
              },
            },
            {
              logPrefix: `[BranchesService.remove ${branch.name}]`,
              asUser, // Run as resolved user (fresh groups via sudo -u)
            }
          );
        })
        .catch((error) => {
          console.error(
            `⚠️  Failed to generate session token for branch removal:`,
            error instanceof Error ? error.message : String(error)
          );
        });
    }

    return result as Branch;
  }

  /**
   * Custom method: Archive or delete branch with filesystem options
   *
   * This method implements the archive/delete modal functionality.
   * Supports both soft delete (archive) and hard delete, with granular filesystem control.
   *
   * @param id - Branch ID
   * @param options - Archive/delete configuration
   * @param params - Query params
   */
  async archiveOrDelete(
    id: BranchID,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    },
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions | { deleted: true; branch_id: BranchID }> {
    const { metadataAction, filesystemAction } = options;
    const branch = await this.withTenantDatabase(params, () => this.get(id, params));
    // Hook chain enforces auth before we get here.
    const currentUserId = (params as AuthenticatedParams).user!.user_id as UUID;

    // Stop environment if running
    if (branch.environment_instance?.status === 'running') {
      console.log(`⚠️  Stopping environment for branch ${branch.name} before ${metadataAction}`);
      try {
        await this.stopEnvironment(id, params);
      } catch (error) {
        console.warn(
          `Failed to stop environment, continuing with ${metadataAction}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Perform filesystem action via executor (fire-and-forget)
    // Executor handles its own logging and error reporting via Feathers
    // Using executor ensures proper Unix isolation for file operations
    const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined;
    const appWithToken = this.app as unknown as {
      sessionTokenService?: import('../services/session-token-service').SessionTokenService;
    };

    if (filesystemAction === 'cleaned') {
      console.log(`🧹 Spawning executor to clean branch filesystem: ${branch.path}`);

      // No user impersonation for infrastructure operations — the daemon user
      // owns all branches and impersonation would resolve getBranchesDir()
      // to the wrong home directory, causing safety check failures.

      void this.withTenantDatabase(
        params,
        () =>
          appWithToken.sessionTokenService?.generateToken('branch-clean', userId ?? currentUserId, {
            branchId: branch.branch_id,
            maxUses: -1,
          }) ?? Promise.reject(new Error('Session token service unavailable'))
      )
        .then((sessionToken) => {
          spawnExecutor(
            {
              command: 'git.branch.clean',
              sessionToken,
              daemonUrl: getDaemonUrl(),
              params: {
                branchPath: branch.path,
              },
            },
            {
              logPrefix: `[BranchesService.clean ${branch.name}]`,
            }
          );
        })
        .catch((error) => {
          console.error(
            `⚠️  Failed to generate session token for branch cleaning:`,
            error instanceof Error ? error.message : String(error)
          );
        });
    } else if (filesystemAction === 'deleted') {
      console.log(`🗑️  Spawning executor to delete branch from filesystem: ${branch.path}`);

      // No user impersonation for infrastructure operations — the daemon user
      // owns all branches and impersonation would resolve getBranchesDir()
      // to the wrong home directory, causing safety check failures.

      void this.withTenantDatabase(
        params,
        () =>
          appWithToken.sessionTokenService?.generateToken(
            'branch-delete',
            userId ?? currentUserId,
            {
              branchId: branch.branch_id,
              maxUses: -1,
            }
          ) ?? Promise.reject(new Error('Session token service unavailable'))
      )
        .then((sessionToken) => {
          spawnExecutor(
            {
              command: 'git.branch.remove',
              sessionToken,
              daemonUrl: getDaemonUrl(),
              params: {
                branchId: branch.branch_id,
                branchPath: branch.path,
                deleteDbRecord: false, // Daemon handles DB deletion separately
                // Clean up the branch if it was created by Agor
                branch: branch.ref,
                deleteBranch: branch.new_branch,
                // Branch storage mode — see sibling call site comment in
                // `BranchesService.remove` above for why this matters.
                storageMode: branch.storage_mode ?? 'worktree',
              },
            },
            {
              logPrefix: `[BranchesService.delete ${branch.name}]`,
            }
          );
        })
        .catch((error) => {
          console.error(
            `⚠️  Failed to generate session token for branch deletion:`,
            error instanceof Error ? error.message : String(error)
          );
        });
    }

    // Metadata action: archive or delete
    if (metadataAction === 'archive') {
      // Archive: Soft delete branch and cascade to sessions
      console.log(`📦 Archiving branch: ${branch.name} (filesystem: ${filesystemAction})`);

      // Update branch
      const archivedBranch = await this.withTenantDatabase(params, () =>
        this.patch(
          id,
          {
            archived: true,
            archived_at: new Date().toISOString(),
            archived_by: currentUserId,
            filesystem_status: filesystemAction,
            // Preserve board_id + board_object placement so unarchive can restore in-place
            updated_at: new Date().toISOString(),
          },
          params
        )
      );

      // Archive all sessions in this branch
      // Use internal call (no provider) to bypass RBAC hooks that would ignore branch_id filter
      const sessionsService = this.app.service('sessions');
      const sessionsResult = await sessionsService.find({
        query: { branch_id: id, $limit: 1000 },
        paginate: false,
      });
      const sessions = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data;

      for (const session of sessions) {
        await sessionsService.patch(
          session.session_id,
          {
            archived: true,
            archived_reason: 'branch_archived',
          },
          { provider: undefined } // Bypass RBAC - this is an internal cascade operation
        );
      }

      console.log(`✅ Archived branch ${branch.name} and ${sessions.length} session(s)`);

      return archivedBranch;
    } else {
      // Delete: Hard delete (CASCADE will remove sessions, messages, tasks)
      console.log(`🗑️  Permanently deleting branch: ${branch.name}`);

      await this.withTenantDatabase(params, () => this.remove(id, params));

      console.log(`✅ Permanently deleted branch ${branch.name}`);
      return { deleted: true, branch_id: id };
    }
  }

  /**
   * Custom method: Unarchive a branch
   */
  async unarchive(
    id: BranchID,
    options?: { boardId?: BoardID },
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    const branch = await this.withTenantDatabase(params, () => this.get(id, params));

    if (!branch.archived) {
      throw new Error(`Branch ${branch.name} is not archived`);
    }

    console.log(`📦 Unarchiving branch: ${branch.name}`);

    const boardIdExplicitlyProvided = options !== undefined && 'boardId' in options;
    const targetBoardId = boardIdExplicitlyProvided ? options?.boardId : branch.board_id;

    // Update branch - clear archive metadata
    const patchData: Partial<Branch> = {
      archived: false,
      archived_at: undefined,
      archived_by: undefined,
      filesystem_status: undefined,
      updated_at: new Date().toISOString(),
    };
    if (boardIdExplicitlyProvided) {
      patchData.board_id = options?.boardId;
    }

    const unarchivedBranch = await this.withTenantDatabase(params, () =>
      this.patch(id, patchData, params)
    );

    // Recreate the git branch on filesystem if the directory is missing
    // (e.g., it was archived with filesystemAction: 'deleted')
    if (!existsSync(branch.path)) {
      console.log(`📂 Branch directory missing, spawning executor to recreate: ${branch.path}`);

      // Set filesystem_status to 'creating' while we rebuild
      await this.withTenantDatabase(params, () =>
        this.patch(id, { filesystem_status: 'creating' }, { ...params, provider: undefined })
      );

      // Look up repo to get local_path
      const reposService = this.app.service('repos');
      const repo = await this.withTenantDatabase(
        params,
        () => reposService.get(branch.repo_id, params) as Promise<Repo>
      );

      // Unix group initialization is a filesystem concern controlled by
      // unix_user_mode. Logical branch RBAC may be enabled in simple/Cloud mode
      // without creating OS groups.
      const initUnixGroup = resolveExecutionSecurityMode().shouldInitUnixGroups;
      const { getDaemonUser } = await import('@agor/core/config');
      const daemonUser = getDaemonUser();

      // No user impersonation for infrastructure operations — the daemon user
      // owns all branches and impersonation would resolve getBranchesDir()
      // to the wrong home directory, causing safety check failures.

      // Mirror the create path's storage-mode forwarding. Without this, a
      // clone-mode branch that was archived with filesystemAction='deleted'
      // would silently rebuild as native worktree mode, leaving the DB row
      // (storage_mode='clone') and disk (.git pointer file) inconsistent.
      const storageMode = branch.storage_mode ?? 'worktree';
      if (storageMode === 'clone' && !repo.remote_url) {
        const errMsg =
          `Cannot unarchive clone-mode branch '${branch.name}' for repo '${repo.slug}': ` +
          `repo has no remote_url. The clone source URL is unknown.`;
        console.error(`⚠️  ${errMsg}`);
        await this.withTenantDatabase(params, () =>
          this.patch(
            id,
            { filesystem_status: 'failed', error_message: errMsg },
            { ...params, provider: undefined }
          )
        );
        return unarchivedBranch;
      }
      const safeRemoteUrl = repo.remote_url ? stripGitUrlCredentials(repo.remote_url) : undefined;

      try {
        // Use a service JWT so the executor can patch rendered env command
        // templates without tripping requireAdminForEnvConfig when unarchive
        // is performed by a non-admin user.
        const sessionToken = generateScopedServiceToken(
          this.app as unknown as { settings: { authentication?: { secret?: string } } },
          params
        );
        spawnExecutor(
          {
            command: 'git.branch.add',
            sessionToken,
            daemonUrl: getDaemonUrl(),
            params: {
              branchId: branch.branch_id,
              repoId: repo.repo_id,
              repoPath: repo.local_path,
              branchName: branch.name,
              branchPath: branch.path,
              branch: branch.ref,
              refType: branch.ref_type || 'branch',
              // Use restore mode: checks if branch exists on remote via ls-remote,
              // checks out existing branch if found, otherwise creates new branch from base_ref.
              // This is safe because it only creates a new branch when ls-remote confirms
              // the branch doesn't exist on the remote (no risk of force-deleting existing branches).
              createBranch: false,
              restoreMode: true,
              sourceBranch: branch.base_ref || repo.default_branch || 'main',
              // Unix group isolation
              initUnixGroup,
              othersAccess: branch.others_fs_access || 'read',
              daemonUser,
              repoUnixGroup: repo.unix_group,
              // Branch storage mode — preserves the branch's original
              // storage_mode across archive → delete → unarchive.
              storageMode,
              ...(branch.clone_depth !== undefined ? { cloneDepth: branch.clone_depth } : {}),
              ...(storageMode === 'clone' && safeRemoteUrl ? { remoteUrl: safeRemoteUrl } : {}),
              // `--reference` hint: see the create-path call site in
              // ReposService.createBranch for the rationale and strict-mode
              // exception.
              ...(storageMode === 'clone' && repo.local_path && shouldUseCloneReferencePath()
                ? { referencePath: repo.local_path }
                : {}),
            },
          },
          {
            logPrefix: `[BranchesService.unarchive ${branch.name}]`,
          }
        );
      } catch (error) {
        console.error(
          `⚠️  Failed to spawn executor for branch recreation:`,
          error instanceof Error ? error.message : String(error)
        );
        // Mark as failed so the UI can show the error state
        const errMsg = error instanceof Error ? error.message : String(error);
        await this.withTenantDatabase(params, () =>
          this.patch(
            id,
            { filesystem_status: 'failed', error_message: `Failed to spawn executor: ${errMsg}` },
            { ...params, provider: undefined }
          )
        );
      }
    }

    // Ensure a board object exists when unarchiving to a board.
    // Older archived branches may have had their board object removed.
    if (targetBoardId) {
      const boardObjectsService = this.getBoardObjectsService();
      try {
        await this.withTenantDatabase(params, async () => {
          const existingObject = (await boardObjectsService.findByBranchId(id)) as {
            object_id: string;
          } | null;
          if (!existingObject) {
            const position = await this.computeDefaultBoardPositionForBranch(
              targetBoardId,
              id,
              params
            );
            await boardObjectsService.create({ board_id: targetBoardId, branch_id: id, position });
          }
        });
      } catch (error) {
        console.error(
          `⚠️ Failed to restore board object for unarchived branch ${id}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Unarchive all sessions that were archived due to branch archival
    // Use internal call (no provider) to bypass RBAC hooks that would ignore branch_id filter
    const sessionsService = this.app.service('sessions');
    const sessionsResult = await sessionsService.find({
      query: {
        branch_id: id,
        archived: true,
        archived_reason: 'branch_archived',
        $limit: 1000,
      },
      paginate: false,
    });
    const sessions = Array.isArray(sessionsResult) ? sessionsResult : sessionsResult.data;

    for (const session of sessions) {
      await sessionsService.patch(
        session.session_id,
        {
          archived: false,
          archived_reason: undefined,
        },
        { provider: undefined } // Bypass RBAC - this is an internal cascade operation
      );
    }

    console.log(`✅ Unarchived branch ${branch.name} and ${sessions.length} session(s)`);
    return unarchivedBranch;
  }

  /**
   * Custom method: Find branch by repo_id and name
   */
  async findByRepoAndName(
    repoId: UUID,
    name: string,
    _params?: BranchParams
  ): Promise<Branch | null> {
    return this.branchRepo.findByRepoAndName(repoId, name);
  }

  /**
   * Custom method: Add branch to board
   *
   * Phase 0: Sets board_id on branch
   * Phase 1: Will also create board_object entry for positioning
   */
  async addToBoard(
    id: BranchID,
    boardId: UUID,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    // Set branch.board_id (patch already enriches with zone info)
    const branch = await this.patch(
      id,
      {
        board_id: boardId,
        updated_at: new Date().toISOString(),
      },
      params
    );

    // TODO (Phase 1): Create board_object entry for positioning
    // await this.app.service('board-objects').create({
    //   board_id: boardId,
    //   object_type: 'branch',
    //   branch_id: id,
    //   position: { x: 100, y: 100 }, // Default position
    // });

    return branch;
  }

  /**
   * Custom method: Remove branch from board
   *
   * Phase 0: Clears board_id on branch
   * Phase 1: Will also remove board_object entry
   */
  async removeFromBoard(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    // Clear branch.board_id (patch already enriches with zone info, but it will be empty now)
    const branch = await this.patch(
      id,
      {
        board_id: undefined,
        updated_at: new Date().toISOString(),
      },
      params
    );

    // TODO (Phase 1): Remove board_object entry
    // const objects = await this.app.service('board-objects').find({
    //   query: { branch_id: id },
    // });
    // for (const obj of objects.data) {
    //   await this.app.service('board-objects').remove(obj.object_id);
    // }

    return branch;
  }

  /**
   * Custom method: Update environment status
   */
  async updateEnvironment(
    idOrData:
      | BranchID
      | {
          branch_id?: BranchID;
          branchId?: BranchID;
          environment_update?: BranchEnvironmentUpdate;
          environmentUpdate?: BranchEnvironmentUpdate;
        },
    environmentUpdateOrParams?: BranchEnvironmentUpdate | BranchParams,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    const isRpcEnvelope = typeof idOrData === 'object';
    const id = isRpcEnvelope ? (idOrData.branch_id ?? idOrData.branchId) : idOrData;
    const environmentUpdate = isRpcEnvelope
      ? (idOrData.environment_update ?? idOrData.environmentUpdate)
      : (environmentUpdateOrParams as BranchEnvironmentUpdate | undefined);
    const resolvedParams = isRpcEnvelope
      ? (environmentUpdateOrParams as BranchParams | undefined)
      : params;

    if (!id) {
      throw new Error('Branch ID is required to update environment status');
    }
    if (!environmentUpdate) {
      throw new Error('Environment update is required');
    }

    const existing = await this.withTenantDatabase(resolvedParams, () =>
      this.get(id, resolvedParams)
    );

    const updatedEnvironment = {
      ...existing.environment_instance,
      ...environmentUpdate,
    } as EnvironmentInstance;

    for (const key of BRANCH_ENVIRONMENT_CLEARABLE_FIELDS) {
      if (
        Object.hasOwn(environmentUpdate, key) &&
        (environmentUpdate[key] === undefined || environmentUpdate[key] === null)
      ) {
        delete updatedEnvironment[key];
      }
    }

    // Distinguish persisted observations from user-visible state changes. A
    // successful re-probe advances last_health_check.timestamp in storage, but
    // that bookkeeping alone must not emit a full `branches.patched` payload to
    // every authorized browser every five seconds.
    const hasPersistedChange =
      JSON.stringify(existing.environment_instance) !== JSON.stringify(updatedEnvironment);
    if (!hasPersistedChange) {
      return existing;
    }

    // For realtime publication, health status and message matter; the
    // observation timestamp does not.
    const oldState = { ...existing.environment_instance };
    const newState = { ...updatedEnvironment };

    // Remove timestamps for comparison - create new objects without timestamp
    if (oldState?.last_health_check) {
      const { timestamp, ...healthCheck } = oldState.last_health_check;
      oldState.last_health_check = healthCheck as typeof oldState.last_health_check;
    }
    if (newState?.last_health_check) {
      const { timestamp, ...healthCheck } = newState.last_health_check;
      newState.last_health_check = healthCheck as typeof newState.last_health_check;
    }

    const hasChanged = JSON.stringify(oldState) !== JSON.stringify(newState);

    // Observation-only persistence deliberately bypasses Feathers publication.
    // It also preserves branch.updated_at so health bookkeeping does not affect
    // branch ordering or modification semantics every five seconds.
    if (!hasChanged) {
      return this.withTenantDatabase(resolvedParams, () =>
        this.branchRepo.update(
          id,
          { environment_instance: updatedEnvironment },
          { preserveUpdatedAt: true }
        )
      );
    }

    const branch = await this.withTenantDatabase(resolvedParams, () =>
      this.patch(
        id,
        {
          environment_instance: updatedEnvironment,
          updated_at: new Date().toISOString(),
        },
        resolvedParams
      )
    );

    // this.patch() calls the raw implementation and bypasses Feathers event
    // dispatch, so the patched event is not automatically emitted. Emit it
    // manually — with a correctly-shaped publish context carrying the tenant
    // params — so the realtime publish handler can route it to the tenant's
    // browser clients. Background transitions (health-monitor start→running,
    // executor stop/nuke→stopped) fire outside any request scope, so the tenant
    // must come from `resolvedParams` here or the event is suppressed and the
    // env card spinner hangs until a manual refresh. See #1750 and
    // emitServiceEvent for why the hook shape matters.
    emitServiceEvent(this.app, {
      path: 'branches',
      event: 'patched',
      data: branch,
      params: resolvedParams,
      id,
    });

    return branch;
  }

  /**
   * Custom method: Start environment
   */
  async startEnvironment(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    const branch = await this.loadEnvironmentForAction(id, params, 'start branch environments');

    if (!branch.start_command) {
      throw new Error('No start command configured for this branch');
    }

    if (branch.environment_instance?.status === 'running') {
      throw new Error('Environment is already running');
    }

    const command = branch.start_command;
    const execution = await this.resolveEnvironmentCommand(command, 'start');
    const access_urls = branch.app_url ? [{ name: 'App', url: branch.app_url }] : undefined;

    await this.updateEnvironment(
      id,
      {
        status: 'starting',
        process: {
          ...branch.environment_instance?.process,
          started_at: new Date().toISOString(),
        },
        access_urls,
        last_health_check: undefined,
        last_error: undefined,
      },
      params
    );

    try {
      console.log(
        `🚀 Starting environment for branch ${branch.name}: ${
          execution.kind === 'webhook'
            ? redactManagedEnvWebhookUrlForAudit(execution.url)
            : execution.command
        }`
      );

      if (execution.kind === 'webhook') {
        await this.executeEnvironmentWebhook({
          url: execution.url,
          branch,
          commandType: 'start',
          triggeredBy: this.extractTriggeredBy(params),
          maxBytes: 16 * 1024,
        });
        console.log(`✅ Start webhook completed successfully for ${branch.name}`);
      } else {
        await this.dispatchEnvironmentExecutor({ branch, action: 'start', params });
      }

      // Keep status as 'starting' - let health checks transition to 'running'.
      return await this.withTenantDatabase(params, () => this.get(id, params));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const commandOutput =
        error instanceof Error
          ? (error as Error & { commandOutput?: string }).commandOutput
          : undefined;

      await this.updateEnvironment(
        id,
        {
          status: 'error',
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: errorMessage,
          },
          last_error: commandOutput || errorMessage,
        },
        params
      );

      throw error;
    }
  }

  /**
   * Custom method: Stop environment
   */
  async stopEnvironment(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    const branch = await this.loadEnvironmentForAction(id, params, 'stop branch environments');

    await this.updateEnvironment(id, { status: 'stopping' }, params);

    try {
      if (branch.stop_command) {
        const execution = await this.resolveEnvironmentCommand(branch.stop_command, 'stop');

        console.log(
          `🛑 Stopping environment for branch ${branch.name}: ${
            execution.kind === 'webhook'
              ? redactManagedEnvWebhookUrlForAudit(execution.url)
              : execution.command
          }`
        );

        if (execution.kind === 'webhook') {
          await this.executeEnvironmentWebhook({
            url: execution.url,
            branch,
            commandType: 'stop',
            triggeredBy: this.extractTriggeredBy(params),
            maxBytes: 16 * 1024,
          });
        } else {
          await this.dispatchEnvironmentExecutor({ branch, action: 'stop', params });
          return await this.withTenantDatabase(params, () => this.get(id, params));
        }
      } else {
        // No down command - kill the managed process if we have it. This is
        // only meaningful for daemon-local legacy managed processes.
        const managedProcess = this.processes.get(id);
        if (managedProcess) {
          managedProcess.process.kill('SIGTERM');
          this.processes.delete(id);
        } else if (branch.environment_instance?.process?.pid) {
          try {
            process.kill(branch.environment_instance.process.pid, 'SIGTERM');
          } catch (error) {
            console.warn(
              `Failed to kill process ${branch.environment_instance.process.pid}: ${error}`
            );
          }
        }
      }

      return await this.updateEnvironment(
        id,
        {
          status: 'stopped',
          process: undefined,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unknown',
            message: 'Environment stopped',
          },
        },
        params
      );
    } catch (error) {
      await this.updateEnvironment(
        id,
        {
          status: 'error',
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        },
        params
      );

      throw error;
    }
  }

  /**
   * Custom method: Restart environment
   */
  async restartEnvironment(
    id: BranchID,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    const branch = await this.loadEnvironmentForAction(id, params, 'restart branch environments');

    if (!branch.start_command) {
      throw new Error('No start command configured for this branch');
    }

    if (branch.environment_instance?.status !== 'running') {
      return await this.startEnvironment(id, params);
    }

    const startExecution = await this.resolveEnvironmentCommand(branch.start_command, 'start');

    const stopExecution = branch.stop_command
      ? await this.resolveEnvironmentCommand(branch.stop_command, 'stop')
      : undefined;

    if (!branch.stop_command || stopExecution?.kind === 'webhook') {
      await this.stopEnvironment(id, params);
      return await this.startEnvironment(id, params);
    }

    if (startExecution.kind === 'webhook') {
      await this.updateEnvironment(id, { status: 'stopping' }, params);
      await this.runEnvironmentExecutor({ branch, action: 'stop', params });
      return await this.startEnvironment(id, params);
    }

    await this.updateEnvironment(id, { status: 'stopping' }, params);

    try {
      await this.dispatchEnvironmentExecutor({ branch, action: 'restart', params });
      return await this.withTenantDatabase(params, () => this.get(id, params));
    } catch (error) {
      await this.updateEnvironment(
        id,
        {
          status: 'error',
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: error instanceof Error ? error.message : 'Unknown error during restart',
          },
        },
        params
      );
      throw error;
    }
  }

  /**
   * Custom method: Nuke environment (destructive operation)
   */
  async nukeEnvironment(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    const branch = await this.loadEnvironmentForAction(id, params, 'nuke branch environments');

    if (!branch.nuke_command) {
      throw new Error('No nuke_command configured for this branch');
    }

    await this.updateEnvironment(id, { status: 'stopping' }, params);

    try {
      const execution = await this.resolveEnvironmentCommand(branch.nuke_command, 'nuke');

      console.log(
        `💣 NUKING environment for branch ${branch.name}: ${
          execution.kind === 'webhook'
            ? redactManagedEnvWebhookUrlForAudit(execution.url)
            : execution.command
        }`
      );
      console.warn('⚠️  This is a destructive operation!');

      if (execution.kind === 'webhook') {
        await this.executeEnvironmentWebhook({
          url: execution.url,
          branch,
          commandType: 'nuke',
          triggeredBy: this.extractTriggeredBy(params),
          maxBytes: 16 * 1024,
        });
      } else {
        await this.dispatchEnvironmentExecutor({ branch, action: 'nuke', params });
        return await this.withTenantDatabase(params, () => this.get(id, params));
      }

      const managedProcess = this.processes.get(id);
      if (managedProcess) {
        this.processes.delete(id);
      }

      return await this.updateEnvironment(
        id,
        {
          status: 'stopped',
          process: undefined,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unknown',
            message: 'Environment nuked - all data and volumes destroyed',
          },
        },
        params
      );
    } catch (error) {
      await this.updateEnvironment(
        id,
        {
          status: 'error',
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: error instanceof Error ? error.message : 'Unknown error during nuke',
          },
        },
        params
      );

      throw error;
    }
  }

  /**
   * Custom method: Check health
   */
  async checkHealth(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    const branch = await this.withTenantDatabase(params, () => this.get(id, params));
    const _repo = await this.withTenantDatabase(
      params,
      () => this.app.service('repos').get(branch.repo_id, params) as Promise<Repo>
    );

    // Only check active environments, plus errored environments that may have been
    // started successfully out-of-band. Allowing explicit health checks to recover
    // from `error` prevents stale start failures from keeping a live environment red.
    const currentStatus = branch.environment_instance?.status;
    const canProbeHealth =
      currentStatus === 'running' || currentStatus === 'starting' || currentStatus === 'error';
    if (!canProbeHealth) {
      return branch;
    }

    // Check if we have a health check URL (static field, not template)
    if (!branch.health_check_url) {
      // No health check configured - stay in 'starting' forever (manual intervention required)
      // Don't auto-transition to 'running' without health check confirmation
      const managedProcess = this.processes.get(id);
      const isProcessAlive = managedProcess?.process && !managedProcess.process.killed;

      return await this.updateEnvironment(
        id,
        {
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: isProcessAlive ? 'healthy' : 'unknown',
            message: isProcessAlive ? 'Process running' : 'No health check configured',
          },
        },
        params
      );
    }

    // Use static health_check_url (initialized from template at branch creation)
    const healthUrl = branch.health_check_url;

    // Validate URL to prevent SSRF against cloud metadata or internal services
    if (!isAllowedHealthCheckUrl(healthUrl)) {
      console.warn(`⚠️ Blocked health check to disallowed URL: ${healthUrl}`);
      return await this.updateEnvironment(
        id,
        {
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: 'Health check URL blocked by security policy',
          },
        },
        params
      );
    }

    // Track previous health status to detect changes
    const previousHealthStatus = branch.environment_instance?.last_health_check?.status;

    try {
      // Perform HTTP health check with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ENVIRONMENT.HEALTH_CHECK_TIMEOUT_MS);

      const response = await fetch(healthUrl, {
        signal: controller.signal,
        method: 'GET',
      });

      clearTimeout(timeout);

      const isHealthy = response.ok;
      const newHealthStatus = isHealthy ? 'healthy' : 'unhealthy';

      // Only log if health status changed
      if (previousHealthStatus !== newHealthStatus) {
        console.log(
          `🏥 Health status changed for ${branch.name}: ${previousHealthStatus || 'unknown'} → ${newHealthStatus} (HTTP ${response.status})`
        );
      }

      // If health check succeeds and we're in 'starting' or 'error' state,
      // transition/recover to 'running'. The explicit 'error' recovery path matters
      // when a lifecycle command failed or raced but the configured app is now live.
      const shouldTransitionToRunning =
        isHealthy && (currentStatus === 'starting' || currentStatus === 'error');

      if (shouldTransitionToRunning) {
        console.log(`✅ Successful health check for ${branch.name} - transitioning to 'running'`);
      }

      return await this.updateEnvironment(
        id,
        {
          status: shouldTransitionToRunning ? 'running' : currentStatus,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: newHealthStatus,
            message: isHealthy
              ? `HTTP ${response.status}`
              : `HTTP ${response.status} ${response.statusText}`,
          },
        },
        params
      );
    } catch (error) {
      // Health check failed
      const message =
        error instanceof Error
          ? error.name === 'AbortError'
            ? 'Timeout'
            : error.message
          : 'Unknown error';

      // During 'starting' state, don't mark as unhealthy - keep retrying
      // Only mark as unhealthy when transitioning from healthy->unhealthy in 'running' state
      if (currentStatus === 'starting') {
        // Don't update health check during startup - wait for first success
        // This prevents the UI from showing unhealthy state while environment is still starting
        return branch;
      }

      const newHealthStatus = 'unhealthy';

      // Only log if health status changed or if this is an error
      if (previousHealthStatus !== newHealthStatus) {
        console.log(
          `🏥 Health status changed for ${branch.name}: ${previousHealthStatus || 'unknown'} → ${newHealthStatus} (${message})`
        );
      }

      return await this.updateEnvironment(
        id,
        {
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message,
          },
        },
        params
      );
    }
  }

  /**
   * Custom method: Get environment logs
   */
  async getLogs(
    id: BranchID,
    params?: BranchParams
  ): Promise<{
    logs: string;
    timestamp: string;
    error?: string;
    truncated?: boolean;
  }> {
    const branch = await this.loadEnvironmentForAction(id, params, 'fetch branch environment logs');

    // Check if static logs command is configured
    if (!branch.logs_command) {
      return {
        logs: '',
        timestamp: new Date().toISOString(),
        error: 'No logs command configured',
      };
    }

    try {
      // Use static logs_command (initialized from template at branch creation)
      const command = branch.logs_command;
      const execution = await this.resolveEnvironmentCommand(command, 'logs');

      console.log(
        `📋 Fetching logs for branch ${branch.name}: ${
          execution.kind === 'webhook'
            ? redactManagedEnvWebhookUrlForAudit(execution.url)
            : execution.command
        }`
      );

      const result =
        execution.kind === 'webhook'
          ? await this.executeEnvironmentWebhook({
              url: execution.url,
              branch,
              commandType: 'logs',
              triggeredBy: this.extractTriggeredBy(params),
              maxBytes: ENVIRONMENT.LOGS_MAX_BYTES,
            }).then(({ body, truncated }) => ({ stdout: body, stderr: '', truncated }))
          : await this.fetchEnvironmentLogsViaExecutor(branch, execution.command, params);

      // Process output: split into lines and keep last N lines
      const allLines = result.stdout.split('\n');
      let finalLines = allLines;
      let wasTruncatedByLines = false;

      if (allLines.length > ENVIRONMENT.LOGS_MAX_LINES) {
        finalLines = allLines.slice(-ENVIRONMENT.LOGS_MAX_LINES);
        wasTruncatedByLines = true;
      }

      const logs = finalLines.join('\n');
      const truncated = result.truncated || wasTruncatedByLines;

      console.log(
        `✅ Fetched ${allLines.length} lines (${logs.length} bytes) for ${branch.name}${truncated ? ' [truncated]' : ''}`
      );

      return {
        logs,
        timestamp: new Date().toISOString(),
        truncated,
      };
    } catch (error) {
      console.error(
        `❌ Failed to fetch logs for ${branch.name}:`,
        error instanceof Error ? error.message : String(error)
      );

      return {
        logs: '',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Custom method: Re-render environment commands from the repo's v2
   * `environment` config and persist the result onto the branch.
   *
   * When no `variant` is supplied, the repo's default variant is used.
   * Re-rendering and variant changes require effective `all` branch
   * permission or admin access because the rendered fields are executable command strings. Direct
   * field edits remain admin-only via `requireAdminForEnvConfig`.
   *
   * Returns the updated branch (with new `environment_variant`, `start_command`,
   * `stop_command`, etc).
   */
  async renderEnvironment(
    id: BranchID,
    data: { variant?: string } | undefined,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    const branch = await this.loadEnvironmentForAction(id, params, 'render branch environment');
    const reposService = this.app.service('repos');
    const repo = await this.withTenantDatabase(
      params,
      () => reposService.get(branch.repo_id, params) as Promise<Repo>
    );

    const env = repo.environment;
    if (!env) {
      throw new Error('Repo has no v2 environment config; nothing to render');
    }

    const requestedVariant = data?.variant ?? env.default;
    const currentVariant = branch.environment_variant;

    if (requestedVariant !== currentVariant) {
      // Refuse to swap variants while the env is live. The current process
      // was started with the old command strings; replacing them out from
      // under it would leave us unable to stop/restart cleanly. This guard
      // is the authoritative invariant for ALL callers (REST, UI, MCP).
      const envStatus = branch.environment_instance?.status;
      if (envStatus === 'running' || envStatus === 'starting') {
        throw new Error(
          `Cannot change environment variant to "${requestedVariant}" while the environment is ${envStatus} ` +
            `(currently configured for "${currentVariant || '(none)'}"). Stop the environment first.`
        );
      }
    }

    // Resolve host IP + unix GID (matches executor's renderEnvironmentTemplates).
    const config = await loadConfig();
    const hostIpAddress = resolveHostIpAddress(config.daemon?.host_ip_address);
    const unixGid = branch.unix_group ? getGidFromGroupName(branch.unix_group) : undefined;

    const snapshot = renderBranchSnapshot(
      { slug: repo.slug, environment: env },
      {
        branch_unique_id: branch.branch_unique_id,
        name: branch.name,
        path: branch.path,
        custom_context: branch.custom_context,
        unix_gid: unixGid,
        host_ip_address: hostIpAddress,
        base_ref: branch.base_ref,
        ref_type: branch.ref_type,
      },
      requestedVariant
    );
    if (!snapshot) {
      // Should be unreachable: env is non-null and renderBranchSnapshot only
      // returns null when env is absent. Defensive throw keeps types honest.
      throw new Error('Failed to render environment snapshot');
    }

    await this.validateRenderedEnvironmentActions(snapshot);
    validateRenderedManagedEnvUrlFields({
      health: snapshot.health,
      app: snapshot.app,
    });

    return await this.withTenantDatabase(params, () =>
      this.patch(
        id,
        {
          environment_variant: snapshot.variant,
          start_command: snapshot.start || undefined,
          stop_command: snapshot.stop || undefined,
          nuke_command: snapshot.nuke,
          logs_command: snapshot.logs,
          health_check_url: snapshot.health,
          app_url: snapshot.app,
          updated_at: new Date().toISOString(),
        },
        params
      )
    );
  }
}

/**
 * Service factory function
 */
export function createBranchesService(
  db: TenantScopeAwareDatabase,
  app: Application
): BranchesService {
  return new BranchesService(db, app);
}
