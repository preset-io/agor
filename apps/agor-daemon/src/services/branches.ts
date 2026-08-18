/**
 * Branches Service
 *
 * Provides REST + WebSocket API for branch management.
 * Uses DrizzleService adapter with BranchRepository.
 */

import type { ChildProcess } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { analyticsLogger } from '@agor/core/analytics';
import {
  createUserProcessEnvironment,
  ENVIRONMENT,
  ensureBranchCloneDepthAllowed,
  ensureBranchStorageModeAllowed,
  getBranchesDir,
  PAGINATION,
  resolveBranchStorageConfig,
  resolveMultiTenancyConfig,
} from '@agor/core/config';
import {
  BoardRepository,
  BranchRepository,
  type BranchWithZoneAndSessions,
  getCurrentTenantId,
  KnowledgeNamespaceRepository,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import {
  decideEnvironmentHealthTransition,
  ENVIRONMENT_STARTUP_TIMEOUT_MS,
  type EnvironmentObservationStatus,
} from '@agor/core/environment/health-transition';
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
import type {
  AuthenticatedParams,
  Board,
  BoardID,
  Branch,
  BranchArchiveOrDeleteOptions,
  BranchArchiveOrDeleteResult,
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
import { resolveHostIpAddress } from '@agor/core/utils/host-ip';
import { isAllowedFactProbeUrl, isAllowedHealthCheckUrl } from '@agor/core/utils/url';
import { DrizzleService, type Query } from '../adapters/drizzle';
import { buildBranchCreatedAnalyticsProperties } from '../utils/analytics-payloads.js';
import { consumeBranchArchiveDeleteAuthorization } from '../utils/branch-archive-delete-authorization.js';
import { ensureCanControlBranchEnvironment } from '../utils/branch-authorization.js';
import { captureBranchRemovalRealtimeVisibility } from '../utils/branch-removal-realtime.js';
import { shouldUseCloneReferencePath } from '../utils/clone-reference.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
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

type EnvironmentLifecycleAction = 'start' | 'stop' | 'restart' | 'nuke' | 'sync';

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
 * Health transition thresholds and the rule that applies them live in
 * `@agor/core/environment/health-transition`, shared with the distributed
 * monitor so an environment reaches the same status under either monitor.
 */

/**
 * Extended branches service with custom methods
 */
export class BranchesService extends DrizzleService<Branch, Partial<Branch>, BranchParams> {
  private branchRepo: BranchRepository;
  private boardRepo: BoardRepository;
  private db: TenantScopeAwareDatabase;
  private app: Application;
  private processes = new Map<BranchID, ManagedProcess>();
  /**
   * Branches with a health observation in flight. Recording an observation is a
   * read-modify-write on persisted state, and checkHealth has three callers, so
   * the guard belongs with the state rather than in one of them.
   */
  private healthChecksInFlight = new Set<BranchID>();
  /**
   * Tail of the per-branch sync queue. Syncs mutate one working tree inside the
   * environment, so they must not overlap; see syncEnvironment.
   */
  private syncChain = new Map<BranchID, Promise<unknown>>();
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
    const config = this.app.get('config');
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
    delegatedHomeKey?: string;
    env: Record<string, string>;
  }> {
    const config = this.app.get('config');
    return this.withTenantDatabase(params, async () => {
      const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(
        this.db,
        branch.created_by,
        config
      );

      const env = await createUserProcessEnvironment(branch.created_by, this.db);
      return { delegatedHomeKey, env };
    });
  }

  private async createEnvironmentExecutorPayload(options: {
    branch: Branch;
    action: EnvironmentLifecycleAction;
    params?: BranchParams;
    // Sync has no frozen branch column (unlike start/stop/nuke). It is rendered
    // fresh at dispatch time — with current facts — and passed through here.
    syncCommand?: string;
  }): Promise<{
    payload: EnvironmentLifecycleExecutorPayload;
    delegatedHomeKey?: string;
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

    const { delegatedHomeKey, env } = await this.resolveEnvironmentExecutorContext(
      branch,
      options.params
    );

    return {
      delegatedHomeKey,
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
          ...(options.syncCommand ? { syncCommand: options.syncCommand } : {}),
        },
      },
    };
  }

  private async dispatchEnvironmentExecutor(options: {
    branch: Branch;
    action: EnvironmentLifecycleAction;
    params?: BranchParams;
    syncCommand?: string;
    /**
     * Invoked when the executor PROCESS exits, not when it is spawned.
     *
     * Both dispatch and spawnExecutor return as soon as the process exists —
     * the lifecycle verbs deliberately answer early and let callers observe
     * `environment_instance` — so anything that must not overlap the real work
     * has to hang off this, not off either return value.
     */
    onSettled?: () => void;
  }): Promise<void> {
    const { branch, action, params } = options;
    const { payload, delegatedHomeKey, env } = await this.createEnvironmentExecutorPayload(options);
    const logPrefix = `[Environment.${action} ${branch.name}]`;

    const spawnLifecycleExecutor = async () => {
      try {
        spawnExecutor(payload, {
          logPrefix,
          delegatedHomeKey,
          preparedEnv: env,
          templateVariables: {
            branch_id: branch.branch_id,
          },
          // spawnExecutor returns as soon as the process exists, so the only
          // truthful completion signal is the process exiting. Chaining on the
          // spawn instead reports "done" immediately and serializes nothing.
          ...(options.onSettled ? { onExit: () => options.onSettled?.() } : {}),
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
      // Never strand a caller waiting on a run that never started.
      options.onSettled?.();
    });
  }

  private async runEnvironmentExecutor(options: {
    branch: Branch;
    action: EnvironmentLifecycleAction;
    params?: BranchParams;
  }): Promise<void> {
    const { branch, action } = options;
    const { payload, delegatedHomeKey, env } = await this.createEnvironmentExecutorPayload(options);

    const result = await runExecutorCommand(payload, {
      logPrefix: `[Environment.${action} ${branch.name}]`,
      delegatedHomeKey,
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

    const { delegatedHomeKey, env } = await this.resolveEnvironmentExecutorContext(branch, params);
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
        delegatedHomeKey,
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
    const { defaultMode } = resolveBranchStorageConfig();
    const storageMode = withDefaults.storage_mode ?? defaultMode;
    ensureBranchStorageModeAllowed(storageMode);
    if (
      storageMode === 'worktree' &&
      resolveMultiTenancyConfig(this.app.get('config')).mode === 'required_from_auth'
    ) {
      throw new BadRequest(
        "storage_mode='worktree' is unavailable in hosted multi-tenant mode; use clone storage."
      );
    }
    if (withDefaults.clone_depth !== undefined) {
      if (storageMode !== 'clone') {
        throw new BadRequest("clone_depth is only meaningful when storage_mode='clone'.");
      }
      if (!Number.isInteger(withDefaults.clone_depth) || withDefaults.clone_depth <= 0) {
        throw new BadRequest('clone_depth must be a positive integer when set.');
      }
      try {
        ensureBranchCloneDepthAllowed(withDefaults.clone_depth);
      } catch (error) {
        throw new BadRequest(error instanceof Error ? error.message : String(error));
      }
    }
    // Persist the effective mode so the executor never reconstructs a
    // configuration default at the filesystem boundary.
    withDefaults.storage_mode = storageMode;

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

    return withDefaults;
  }

  /**
   * Override create to inject board permission defaults.
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
    const tenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();

    // Get branch details before deletion
    const branch = await this.withTenantDatabase(params, () => this.get(id, params));
    // Remove from database FIRST for instant UI feedback
    // CASCADE will clean up related comments automatically
    const result = await super.remove(id, params);

    // Then remove from filesystem via executor (fire-and-forget)
    // Executor handles its own logging and error reporting via Feathers
    if (deleteFromFilesystem) {
      console.log(`🗑️  Spawning executor to remove branch from filesystem: ${branch.path}`);

      // Resolve the optional delegated execution-home key. Local execution
      // never selects or impersonates a host account.
      const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(
        this.db,
        branch.created_by,
        this.app.get('config')
      );

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
                branchesRoot: getBranchesDir(tenantId),
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
              delegatedHomeKey: delegatedHomeKey,
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
   * Internal metadata-only hard-delete primitive.
   *
   * The visibility snapshot, row deletion, and post-commit tombstone enqueue
   * share one tenant transaction. This method deliberately bypasses the
   * registered `remove` wrapper and its filesystem/Unix hooks; it is not listed
   * in the service's transport methods.
   */
  async removeMetadataWithRealtime(id: BranchID, params?: BranchParams): Promise<Branch> {
    const removalParams = params ?? ({} as BranchParams);
    return this.withTenantDatabase(removalParams, async () => {
      const branch = (await super.get(id, removalParams)) as Branch;
      await captureBranchRemovalRealtimeVisibility({
        params: removalParams,
        branchRepository: this.branchRepo,
        branchId: branch.branch_id,
      });

      // Feathers replaces registered standard methods with event-producing
      // wrappers. The adapter call performs only the metadata deletion; the
      // explicit event below is the single authoritative tombstone.
      const removedBranch = (await super.remove(branch.branch_id, removalParams)) as Branch;
      emitServiceEvent(this.app, {
        path: 'branches',
        event: 'removed',
        data: removedBranch,
        params: removalParams,
        id: removedBranch.branch_id,
      });
      return removedBranch;
    });
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
    options: BranchArchiveOrDeleteOptions,
    params?: BranchParams
  ): Promise<BranchArchiveOrDeleteResult> {
    if (!params) {
      throw new Forbidden(
        'Branch archive/delete must be invoked through the authorized archive-or-delete service'
      );
    }
    // This method coordinates external side effects, so a direct in-process
    // call must never be able to bypass the route's branch-control hook.
    consumeBranchArchiveDeleteAuthorization(params, id, options.metadataAction);

    const { metadataAction, filesystemAction } = options;
    const branch = await this.withTenantDatabase(params, () => this.get(id, params));
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
    // Use the executor so filesystem operations follow the selected substrate.
    const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined;
    const appWithToken = this.app as unknown as {
      sessionTokenService?: import('../services/session-token-service').SessionTokenService;
    };

    if (filesystemAction === 'cleaned') {
      console.log(`🧹 Spawning executor to clean branch filesystem: ${branch.path}`);

      // Infrastructure cleanup uses the canonical branch path supplied by the
      // daemon rather than reconstructing it from an execution home.

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
      const tenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();

      // Infrastructure cleanup uses the canonical branch path supplied by the
      // daemon rather than reconstructing it from an execution home.

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
                branchesRoot: getBranchesDir(tenantId),
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

    // Retire branch-scoped terminal attachments before archive/delete. The
    // local event handles this replica; serverSideEmit carries only trusted
    // tenant/branch lifecycle metadata (never terminal contents) to peer
    // replicas when the HA adapter is available.
    const terminalTenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();
    if (!terminalTenantId) throw new Error('Missing tenant context for branch terminal cleanup');
    const terminalClose = {
      tenantId: String(terminalTenantId),
      branchId: branch.branch_id,
    };
    this.app.emit?.('terminal:close-branch', terminalClose);
    this.app.io?.serverSideEmit?.('terminal:close-branch', terminalClose);

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

      // archiveOrDelete is a custom service method. Its internal this.patch()
      // call bypasses Feathers' standard-method event hook, so publish the
      // branch transition explicitly (with the request tenant/RBAC context).
      emitServiceEvent(this.app, {
        path: 'branches',
        event: 'patched',
        data: archivedBranch,
        params,
        id: archivedBranch.branch_id,
      });

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

      await this.removeMetadataWithRealtime(id, params);

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
    if (
      (branch.storage_mode ?? 'worktree') === 'worktree' &&
      resolveMultiTenancyConfig(this.app.get('config')).mode === 'required_from_auth'
    ) {
      throw new BadRequest(
        'Historical worktree branches cannot be restored in hosted multi-tenant mode.'
      );
    }

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
    emitServiceEvent(this.app, {
      path: 'branches',
      event: 'patched',
      data: unarchivedBranch,
      params,
      id: unarchivedBranch.branch_id,
    });

    // Recreate the git branch on filesystem if the directory is missing
    // (e.g., it was archived with filesystemAction: 'deleted')
    const statusToken = generateScopedServiceToken(
      this.app as unknown as { settings: { authentication?: { secret?: string } } }
    );
    const statusResult = await runExecutorCommand(
      {
        command: 'branch.filesystem.status',
        sessionToken: statusToken,
        daemonUrl: getDaemonUrl(),
        params: { branchId: branch.branch_id },
      },
      {
        logPrefix: `[BranchesService.unarchive.status ${branch.name}]`,
        delegatedHomeKey: await resolveDelegatedExecutionHomeKey(
          this.db,
          params?.user?.user_id,
          this.app.get('config')
        ),
      }
    );
    if (!statusResult.success) {
      throw new Error(
        `Failed to inspect branch filesystem before unarchive: ${statusResult.error?.message ?? 'unknown executor error'}`
      );
    }
    const branchPathExists =
      !!statusResult.data &&
      typeof statusResult.data === 'object' &&
      (statusResult.data as { exists?: unknown }).exists === true;

    if (!branchPathExists) {
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

      // The executor derives the materialization mode from this persisted row.
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

      try {
        // Use a service JWT so the executor can patch rendered env command
        // templates without tripping requireAdminForEnvConfig when unarchive
        // is performed by a non-admin user.
        const sessionToken = generateScopedServiceToken(
          this.app as unknown as { settings: { authentication?: { secret?: string } } },
          { command: 'git.branch.add', branch_id: branch.branch_id, repo_id: repo.repo_id }
        );
        spawnExecutor(
          {
            command: 'git.branch.add',
            sessionToken,
            daemonUrl: getDaemonUrl(),
            params: {
              branchId: branch.branch_id,
              repoId: repo.repo_id,
              // Use restore mode: checks if branch exists on remote via ls-remote,
              // checks out existing branch if found, otherwise creates new branch from base_ref.
              // This is safe because it only creates a new branch when ls-remote confirms
              // the branch doesn't exist on the remote (no risk of force-deleting existing branches).
              restoreMode: true,
              useReference:
                storageMode === 'clone' &&
                !!repo.local_path &&
                shouldUseCloneReferencePath(this.app.get('config')),
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
    params?: BranchParams,
    internalOptions?: { beginLifecycle?: boolean }
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

    // Normalize a requested clear to an explicit `null`, NOT a deleted key.
    //
    // This object is persisted via `patch`, and the repository deep-merges it
    // into the stored branch: the merge iterates the SOURCE keys, so a key that
    // is absent is PRESERVED from the existing row, while `null` is the
    // explicit clear sentinel (see deepMerge in repositories/merge-utils.ts).
    // Deleting the key therefore did the exact opposite of clearing it —
    // silently, for every clearable field. Observed live: after `stop`
    // (which passes `process: undefined`) the environment kept its previous
    // `process` with a dead pid, and `facts` documented as "cleared on nuke"
    // never actually cleared, so a deleted Codespace's URL stayed on the branch.
    //
    // `undefined` from an in-process caller and `null` from an executor
    // callback (which crosses a JSON boundary that drops undefined) both mean
    // "clear", and both must reach the repository as `null`.
    for (const key of BRANCH_ENVIRONMENT_CLEARABLE_FIELDS) {
      if (
        Object.hasOwn(environmentUpdate, key) &&
        (environmentUpdate[key] === undefined || environmentUpdate[key] === null)
      ) {
        (updatedEnvironment as unknown as Record<string, unknown>)[key] = null;
      }
    }

    // Distinguish persisted observations from user-visible state changes. A
    // successful re-probe advances last_health_check.timestamp in storage, but
    // that bookkeeping alone must not emit a full `branches.patched` payload to
    // every authorized browser every five seconds.
    const hasPersistedChange = !isDeepStrictEqual(
      existing.environment_instance,
      updatedEnvironment
    );
    if (!hasPersistedChange && !internalOptions?.beginLifecycle) {
      return existing;
    }

    // For realtime publication, health status and message matter; the
    // observation timestamp does not.
    const oldState = { ...existing.environment_instance };
    const newState = { ...updatedEnvironment };

    // Drop the observation's bookkeeping fields for this comparison. The
    // timestamp advances on every probe, and `consecutive` advances on every
    // probe that repeats a verdict — neither is a user-visible change, so
    // including them would send a `patched` payload to every authorized browser
    // every five seconds for an environment that is simply still up (or still
    // building).
    if (oldState?.last_health_check) {
      const { timestamp, consecutive, ...healthCheck } = oldState.last_health_check;
      oldState.last_health_check = healthCheck as typeof oldState.last_health_check;
    }
    if (newState?.last_health_check) {
      const { timestamp, consecutive, ...healthCheck } = newState.last_health_check;
      newState.last_health_check = healthCheck as typeof newState.last_health_check;
    }

    // PostgreSQL JSONB does not preserve object-key insertion order. Comparing
    // serialized objects can therefore report a change when the JSON values are
    // identical, sending every observation down the realtime patch path. Deep
    // equality preserves array ordering while treating object key order as
    // irrelevant, which matches the JSON semantics stored in the database.
    const hasChanged = !isDeepStrictEqual(oldState, newState);

    // Observation-only persistence deliberately bypasses Feathers publication.
    // It also preserves branch.updated_at so health bookkeeping does not affect
    // branch ordering or modification semantics every five seconds.
    if (!hasChanged && !internalOptions?.beginLifecycle) {
      return this.withTenantDatabase(resolvedParams, () =>
        this.branchRepo.update(
          id,
          { environment_instance: updatedEnvironment },
          { preserveUpdatedAt: true }
        )
      );
    }

    const branch = internalOptions?.beginLifecycle
      ? await this.withTenantDatabase(resolvedParams, async () => {
          await this.branchRepo.update(
            id,
            {
              environment_instance: updatedEnvironment,
              updated_at: new Date().toISOString(),
            },
            { invalidateEnvironmentObservation: true }
          );
          return this.get(id, resolvedParams);
        })
      : await this.withTenantDatabase(resolvedParams, () =>
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

    // Reject a start while one is already in flight. Without this, two
    // concurrent starts (an agent retry racing a human click, a double-submit)
    // BOTH pass the `running` check, both flip the status to `starting`, and
    // both spawn an executor — verified: two POSTs to /start returned 201 and
    // two agor-executor processes ran the lifecycle command simultaneously.
    // For a remote backend that means two `gh codespace create` calls and TWO
    // billable Codespaces for one branch; here it only escaped because a
    // codespace already existed, so both invocations merely resumed it.
    //
    // A start wedged in `starting` cannot block forever: `checkHealth` demotes
    // it to `error` after the startup timeout, and Stop stays enabled meanwhile
    // (the UI allows stopping while starting), so recovery does not depend on
    // waiting that out.
    // NOTE: deliberately does NOT guard `stopping`. `restartEnvironment` calls
    // stopEnvironment then startEnvironment, and the stop executor is async, so
    // the status is still `stopping` when the start runs — guarding it breaks
    // restart. The UI already disables Start while stopping, and the race that
    // actually costs money is two concurrent starts, which the check above stops.
    if (branch.environment_instance?.status === 'starting') {
      throw new Error('Environment is already starting');
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
      params,
      { beginLifecycle: true }
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
   * Custom method: Sync environment
   *
   * Push the branch's latest committed code into the already-running remote
   * environment (e.g. a Codespace, which shares no filesystem with Agor). The
   * variant's `sync` command is rendered FRESH here — with the environment's
   * reported facts (`{{env.*}}`) — rather than read from a frozen branch column,
   * so it always targets the current environment. Does not change status.
   *
   * Generic: any repo whose environment variant defines `sync` gets this for
   * free; variants without a `sync` command reject the call.
   */
  async syncEnvironment(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    // Authorize before queueing, so an unauthorized caller fails immediately
    // rather than after waiting behind someone else's sync.
    await this.loadEnvironmentForAction(id, params, 'sync branch environments');

    // Serialize syncs per branch. A sync force-pushes a scratch ref and then
    // drives `git reset --hard` plus a recursive submodule update inside the
    // environment; two at once are two git processes mutating ONE working tree
    // (index.lock contention, half-updated submodules), and each reports the
    // SHA it captured rather than the one that actually landed.
    //
    // Concurrency is routine, not exotic: task-completion auto-sync fires per
    // finished task and several sessions can share a branch, the readiness
    // catch-up sync fires on starting -> running, and either can race a manual
    // sync from the REST route or the MCP tool.
    //
    // Chained rather than dropped, because a later caller may carry commits the
    // in-flight run will not include — skipping it would silently leave the
    // environment behind. Each run re-reads the branch, so a queued sync pushes
    // HEAD as of when it actually starts.
    // The chain link must represent the EXECUTOR's lifetime, not the dispatch
    // call. Dispatch schedules the work and returns immediately (lifecycle
    // verbs answer early by design and callers watch `environment_instance`),
    // so chaining on it would serialize nothing — verified live: three
    // concurrent syncs still produced three overlapping executor runs.
    const previous = this.syncChain.get(id);
    let settle!: () => void;
    const executorFinished = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.syncChain.set(id, executorFinished);
    void executorFinished.finally(() => {
      // Only clear if nobody has chained behind us in the meantime.
      if (this.syncChain.get(id) === executorFinished) this.syncChain.delete(id);
    });

    try {
      if (previous) await previous.catch(() => {});
      return await this.runEnvironmentSync(id, params, settle);
    } catch (error) {
      // Never leave the chain wedged on a sync that failed before it spawned.
      settle();
      throw error;
    }
  }

  /** One sync run. Callers must go through syncEnvironment, which serializes these. */
  private async runEnvironmentSync(
    id: BranchID,
    params: BranchParams | undefined,
    onExecutorSettled: () => void
  ): Promise<BranchWithZoneAndSessions> {
    const branch = await this.loadEnvironmentForAction(id, params, 'sync branch environments');

    const reposService = this.app.service('repos');
    const repo = await this.withTenantDatabase(
      params,
      () => reposService.get(branch.repo_id, params) as Promise<Repo>
    );
    const env = repo.environment;
    if (!env) {
      throw new Error('Repo has no v2 environment config; nothing to sync');
    }

    // Match the executor's render context and, crucially, pass the
    // environment's facts so a `sync` template referencing `{{env.*}}` resolves
    // to the running environment's real identity.
    const config = this.app.get('config');
    const hostIpAddress = resolveHostIpAddress(config.daemon?.host_ip_address);

    const snapshot = renderBranchSnapshot(
      { slug: repo.slug, environment: env },
      {
        branch_unique_id: branch.branch_unique_id,
        name: branch.name,
        path: branch.path,
        custom_context: branch.custom_context,
        host_ip_address: hostIpAddress,
        base_ref: branch.base_ref,
        ref_type: branch.ref_type,
        facts: branch.environment_instance?.facts,
      },
      branch.environment_variant ?? undefined
    );
    if (!snapshot?.sync) {
      throw new Error(
        `Environment variant "${branch.environment_variant ?? env.default}" defines no sync command`
      );
    }

    // Shell-command execution only for now (the sync mechanism is a git push +
    // remote fast-forward). A webhook-shaped sync can be added alongside the
    // start/stop webhook path later if a backend needs it.
    console.log(`🔄 Syncing environment for branch ${branch.name}`);
    await this.dispatchEnvironmentExecutor({
      branch,
      action: 'sync',
      params,
      syncCommand: snapshot.sync,
      onSettled: onExecutorSettled,
    });

    return await this.withTenantDatabase(params, () => this.get(id, params));
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

    // Serialize observations per branch. checkHealth is reachable from the
    // health monitor's interval, `GET /branches/:id/health` and the MCP
    // environment tool; only the monitor held a guard, so the others could
    // overlap it. That matters because recording an observation is a
    // read-modify-write on persisted state — read the branch, probe for
    // seconds, write the new streak — so two overlapping callers both read the
    // same count and both write the same value, losing an observation and
    // letting the older probe's verdict land last.
    //
    // The guard sits AFTER the tenant-scoped get above, so every caller is
    // still authorized and scoped independently; only the probe-and-write is
    // shared. A caller arriving mid-observation gets the current state rather
    // than a second probe of the same window.
    if (this.healthChecksInFlight.has(id)) {
      return branch;
    }
    this.healthChecksInFlight.add(id);
    try {
      return await this.probeAndRecordHealth(branch, id, currentStatus, params);
    } finally {
      this.healthChecksInFlight.delete(id);
    }
  }

  /**
   * Probe the environment and record what came back. Callers must hold the
   * per-branch in-flight guard — see checkHealth.
   */
  private async probeAndRecordHealth(
    branch: BranchWithZoneAndSessions,
    id: BranchID,
    currentStatus: EnvironmentInstance['status'] | undefined,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    // Effective health probe target. Local envs freeze a `health_check_url` at
    // branch creation. Remote/managed envs (e.g. a Codespace) have no static URL
    // — their reachable address only exists after `start` — so we fall back to a
    // `health` fact the lifecycle command emits (AGOR_FACT health=<url>). Either
    // source feeds the same probe below, which is the real readiness signal:
    // during a long first build the probe fails and the env stays `starting`;
    // once the app answers it transitions to `running`.
    // A fact-sourced probe URL is UNTRUSTED input: it is parsed from a lifecycle
    // command's stdout, so whoever controls that script chooses the address the
    // daemon will GET every few seconds — with the status reflected back into
    // last_health_check.message. Validate it with the stricter rule that also
    // rejects loopback/private/internal destinations, rather than the permissive
    // one used for the admin-rendered health_check_url (local environments
    // legitimately probe localhost, so that path must stay permissive).
    const rawFactsHealthUrl = branch.environment_instance?.facts?.health;
    let factsHealthUrl: string | undefined;
    if (rawFactsHealthUrl) {
      if (isAllowedFactProbeUrl(rawFactsHealthUrl)) {
        factsHealthUrl = rawFactsHealthUrl;
      } else {
        console.warn(
          `⚠️ ${branch.name}: ignoring health fact pointing at a disallowed destination (${rawFactsHealthUrl})`
        );
      }
    }
    const effectiveHealthUrl = branch.health_check_url || factsHealthUrl;

    // No probe available at all (neither a frozen URL nor a health fact).
    if (!effectiveHealthUrl) {
      const managedProcess = this.processes.get(id);
      const isProcessAlive = managedProcess?.process && !managedProcess.process.killed;

      // Fallback for remote / managed environments (e.g. a Codespace) that
      // report NO health fact: Agor has nothing to poll, so the lifecycle
      // command is the source of truth — a start that SUCCEEDED and reported
      // facts (an address) means the environment is up, so transition
      // starting → running instead of spinning on 'starting' forever. This is
      // optimistic (it cannot confirm the app is actually serving); a variant
      // that DOES emit `AGOR_FACT health=<url>` skips this branch entirely and
      // gets true readiness gating via the probe below. Local envs always
      // render a health_check_url and never reach this branch either.
      const lastCommand = branch.environment_instance?.last_command;
      const facts = branch.environment_instance?.facts;
      const startReportedUp =
        !!facts &&
        Object.keys(facts).length > 0 &&
        (lastCommand?.action === 'start' || lastCommand?.action === 'restart') &&
        lastCommand?.status === 'succeeded';

      // `starting` MUST have an exit here too, in BOTH directions — the same
      // principle as the probe-based startup timeout further below. Without
      // one, an environment with no probe pins at `starting` forever while the
      // UI disables Start, leaving the user no way to recover. Observed live:
      // a branch stuck `starting` for ten days with no health_check_url, no
      // facts and a dead pid.
      //
      // Exit UP when there is positive evidence the environment is up: either
      // the lifecycle command reported success with facts, or the daemon still
      // owns a live process for it (which we already report as 'healthy'
      // below — pinning at `starting` while claiming healthy is incoherent).
      const shouldTransitionToRunning =
        currentStatus === 'starting' && (startReportedUp || !!isProcessAlive);

      // Exit DOWN once the startup window has elapsed with no such evidence.
      // Anchored on wall-clock rather than a probe streak because there are no
      // probes to count on this path, and because the anchor has to survive a
      // daemon restart — an in-memory streak would grant a fresh hour on every
      // restart and never fire for an already-stalled environment.
      const startedAt = branch.environment_instance?.process?.started_at ?? lastCommand?.timestamp;
      const startupElapsedMs = startedAt ? Date.now() - new Date(startedAt).getTime() : 0;
      const shouldDemoteStalledStart =
        currentStatus === 'starting' &&
        !shouldTransitionToRunning &&
        startupElapsedMs > ENVIRONMENT_STARTUP_TIMEOUT_MS;

      if (shouldTransitionToRunning) {
        console.log(
          `✅ ${branch.name}: ${
            startReportedUp ? 'start reported success with facts' : 'managed process is alive'
          } and no health probe configured - transitioning to 'running'`
        );
      } else if (shouldDemoteStalledStart) {
        console.warn(
          `🔌 ${branch.name}: never reported readiness and no health probe is configured - marking 'error' so it can be started again`
        );
      }

      return await this.updateEnvironment(
        id,
        {
          ...(shouldTransitionToRunning
            ? { status: 'running' as const }
            : shouldDemoteStalledStart
              ? { status: 'error' as const }
              : {}),
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: startReportedUp || isProcessAlive ? 'healthy' : 'unknown',
            message: startReportedUp
              ? 'Started (reported by lifecycle command; no health probe configured)'
              : isProcessAlive
                ? 'Process running'
                : shouldDemoteStalledStart
                  ? 'Environment never reported readiness (no health check configured)'
                  : 'No health check configured',
          },
        },
        params
      );
    }

    // Probe the effective URL: the frozen health_check_url for local envs, or the
    // `health` fact for remote envs like a Codespace.
    const healthUrl = effectiveHealthUrl;

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
      //
      // Requires CONSECUTIVE successes, mirroring the demotion below. A single
      // success is not trustworthy while a remote environment is coming up: a
      // resuming Codespace was observed answering one 200 through its tunnel and
      // then immediately 502-ing, which flipped the environment to `running`
      // while the app was in fact still booting.
      const decision = this.decideHealthTransition(branch, currentStatus, newHealthStatus);
      const shouldTransitionToRunning = decision.nextStatus === 'running';

      if (shouldTransitionToRunning) {
        console.log(`✅ Successful health check for ${branch.name} - transitioning to 'running'`);
        // Catch-up sync: the environment just became reachable for the first
        // time (or recovered from error). Commits that landed while it was still
        // building/starting were never pushed into it — the task-completion
        // auto-sync no-ops against an unreachable remote and nothing retries it.
        // Fire one sync now so the running env reflects the branch's latest
        // committed state. Fire-and-forget; syncEnvironment throws for variants
        // without a `sync` command (e.g. local), which we swallow. Reuses the
        // params the health monitor already runs under (tenant context, no
        // executor token), so no extra plumbing is required.
        void this.syncEnvironment(id, params).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('defines no sync command')) return;
          console.warn(`⚠️ Catch-up sync after readiness failed for ${branch.name}: ${message}`);
        });
      }

      // An HTTP error (e.g. the 404 GitHub serves for a shut-down Codespace)
      // does NOT throw, so unreachability has to be handled here too, not only
      // in the catch below.
      const shouldDemote = decision.nextStatus === 'error';
      if (shouldDemote) {
        console.warn(
          `🔌 ${branch.name}: environment ${
            currentStatus === 'starting' ? 'never became reachable' : 'unreachable'
          } (HTTP ${response.status}) - marking 'error' so it can be started again`
        );
      }

      return await this.updateEnvironment(
        id,
        {
          status: shouldTransitionToRunning ? 'running' : shouldDemote ? 'error' : currentStatus,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: newHealthStatus,
            message: isHealthy
              ? `HTTP ${response.status}`
              : `HTTP ${response.status} ${response.statusText}`,
            consecutive: decision.consecutive,
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

      // Count the failure BEFORE the `starting` early-return below, so a startup
      // that never succeeds can eventually time out instead of retrying forever.
      const decision = this.decideHealthTransition(branch, currentStatus, 'unhealthy');
      const shouldDemoteOnThrow = decision.nextStatus === 'error';

      // During 'starting', keep retrying quietly — an environment may legitimately
      // be building for many minutes and should not be flipped out of `starting`
      // meanwhile. The exception is the startup timeout, handled just above.
      //
      // The observation is still PERSISTED, because the streak that eventually
      // fires that timeout now lives in `last_health_check.consecutive` rather
      // than in daemon memory. Returning early without writing would leave the
      // count permanently at 1 and `starting` unbounded again — the bug the
      // timeout exists to prevent. Repeated identical failures do not publish
      // (updateEnvironment treats the count as bookkeeping, like the
      // timestamp), so this does not spam the realtime channel.
      if (currentStatus === 'starting' && !shouldDemoteOnThrow) {
        return await this.updateEnvironment(
          id,
          {
            last_health_check: {
              timestamp: new Date().toISOString(),
              status: 'unhealthy',
              message,
              consecutive: decision.consecutive,
            },
          },
          params
        );
      }

      if (shouldDemoteOnThrow) {
        console.warn(
          `🔌 ${branch.name}: environment ${
            currentStatus === 'starting' ? 'never became reachable' : 'unreachable'
          } (${message}) - marking 'error' so it can be started again`
        );
      }

      const newHealthStatus = 'unhealthy';

      // Only log if health status changed or if this is an error
      if (previousHealthStatus !== newHealthStatus) {
        console.log(
          `🏥 Health status changed for ${branch.name}: ${previousHealthStatus || 'unknown'} → ${newHealthStatus} (${message})`
        );
      }

      const shouldDemote = shouldDemoteOnThrow;

      return await this.updateEnvironment(
        id,
        {
          ...(shouldDemote ? { status: 'error' as const } : {}),
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: shouldDemote ? `Environment unreachable: ${message}` : message,
            consecutive: decision.consecutive,
          },
        },
        params
      );
    }
  }

  /**
   * Apply the shared transition rules to one observation.
   *
   * The streak comes from the PERSISTED previous observation rather than from
   * daemon memory, so it survives a restart and means the same thing to the
   * distributed monitor, which observes the same branch from another node.
   */
  private decideHealthTransition(
    branch: Branch,
    currentStatus: string | undefined,
    observation: EnvironmentObservationStatus
  ) {
    return decideEnvironmentHealthTransition({
      currentStatus,
      observation,
      previous: branch.environment_instance?.last_health_check,
      probeIntervalMs: ENVIRONMENT.HEALTH_CHECK_INTERVAL_MS,
    });
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
    const variantChanged = requestedVariant !== currentVariant;

    if (variantChanged) {
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

    // Resolve host IP for environment template rendering.
    const config = this.app.get('config');
    const hostIpAddress = resolveHostIpAddress(config.daemon?.host_ip_address);

    const snapshot = renderBranchSnapshot(
      { slug: repo.slug, environment: env },
      {
        branch_unique_id: branch.branch_unique_id,
        name: branch.name,
        path: branch.path,
        custom_context: branch.custom_context,
        host_ip_address: hostIpAddress,
        base_ref: branch.base_ref,
        ref_type: branch.ref_type,
        // Re-rendering while the environment is running resolves {{env.*}} to
        // the facts it reported (e.g. a Codespace URL that only exists after
        // start). Undefined for a never-started branch → {{env.url}} renders ''.
        //
        // On a variant SWITCH the old facts describe the other variant's
        // environment, so they must not leak into the new variant's templates —
        // otherwise `app: "{{env.url}}"` on the incoming variant renders the
        // outgoing one's address.
        facts: variantChanged ? undefined : branch.environment_instance?.facts,
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

    // Drop the outgoing variant's runtime observations. `facts` and the
    // `access_urls` derived from them describe the environment the OTHER
    // variant started, and nothing regenerates them until the new variant is
    // started — so leaving them behind means a `local` branch keeps serving a
    // Codespace link in the UI, and any variant that defines no health URL
    // falls through to the stale `health` fact and probes a foreign
    // environment. Safe to do here: switching variants is already refused
    // while the environment is running or starting.
    if (variantChanged && branch.environment_instance) {
      await this.updateEnvironment(id, { facts: null, access_urls: null }, params);
    }

    return await this.withTenantDatabase(params, () =>
      this.patch(
        id,
        {
          environment_variant: snapshot.variant,
          start_command: snapshot.start || undefined,
          stop_command: snapshot.stop || undefined,
          // Coerce absent optional fields to null (not undefined) so switching
          // to a variant that omits a field CLEARS the previous variant's value.
          // deepMerge (repository update) treats null as "write NULL" and
          // undefined as "skip" — undefined would leave a stale command/URL, e.g.
          // switching local → codespaces (no health) previously left the local
          // health_check_url, so the monitor probed a dead local port and the env
          // never left 'starting'. Branch types these columns as `string |
          // undefined` for readers (rows coerce NULL → undefined), so passing the
          // null clear-sentinel is a deliberate read/write asymmetry; cast at the
          // patch boundary rather than widening the reader type everywhere.
          nuke_command: snapshot.nuke ?? null,
          logs_command: snapshot.logs ?? null,
          health_check_url: snapshot.health ?? null,
          app_url: snapshot.app ?? null,
          updated_at: new Date().toISOString(),
        } as Partial<Branch>,
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
