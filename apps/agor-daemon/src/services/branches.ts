/**
 * Branches Service
 *
 * Provides REST + WebSocket API for branch management.
 * Uses DrizzleService adapter with BranchRepository.
 */

import type { ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { analyticsLogger } from '@agor/core/analytics';
import {
  createUserProcessEnvironment,
  ENVIRONMENT,
  ensureBranchCloneDepthAllowed,
  ensureBranchStorageModeAllowed,
  getBranchesDir,
  getBranchHomePath,
  PAGINATION,
  resolveBranchStorageConfig,
  resolveMultiTenancyConfig,
} from '@agor/core/config';
import {
  BoardRepository,
  BranchRepository,
  type BranchWithZoneAndSessions,
  type EnvironmentHealthObservation,
  EnvironmentHealthRepository,
  EnvironmentLifecycleConflictError,
  EnvironmentSyncRepository,
  generateId,
  getCurrentTenantId,
  KnowledgeNamespaceRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  TaskRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UsersRepository,
} from '@agor/core/db';
import {
  type EnvironmentLifecycleBudget,
  resolveEnvironmentLifecycleBudget,
  resolveEnvironmentStartBudget,
  resolveEnvironmentStartupTimeoutMs,
} from '@agor/core/environment/health-transition';
import {
  ENVIRONMENT_LIFECYCLE_SUPERSEDED_CODE,
  type EnvironmentLifecycleResult,
  lifecycleResultTemplateFacts,
  resolveEnvironmentHealthTarget,
  validateEnvironmentLifecycleResult,
  validateEnvironmentSourceRevision,
} from '@agor/core/environment/lifecycle-result';
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
import {
  type Application,
  BadRequest,
  Conflict,
  Forbidden,
  NotAuthenticated,
  NotFound,
} from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  BoardID,
  Branch,
  BranchArchiveOrDeleteOptions,
  BranchArchiveOrDeleteResult,
  BranchEnvironmentUpdate,
  BranchFsAccessLevel,
  BranchID,
  KnowledgeNamespace,
  QueryParams,
  Repo,
  UserID,
  UserRole,
  UUID,
} from '@agor/core/types';
import {
  BRANCH_ENVIRONMENT_CLEARABLE_FIELDS,
  getTeammateConfig,
  hasMinimumRole,
  isTeammate,
  ROLES,
  TEAMMATE_FRAMEWORK_REPO_URL,
} from '@agor/core/types';
import { resolveHostIpAddress } from '@agor/core/utils/host-ip';
import { createPinnedFetch } from '@agor/core/utils/pinned-fetch';
import { isAllowedHealthCheckUrl } from '@agor/core/utils/url';
import { DrizzleService, type Query } from '../adapters/drizzle';
import { matchesExecutorCommandRuntimeScope } from '../auth/executor-runtime-scope.js';
import { buildBranchCreatedAnalyticsProperties } from '../utils/analytics-payloads.js';
import { consumeBranchArchiveDeleteAuthorization } from '../utils/branch-archive-delete-authorization.js';
import { ensureCanControlBranchEnvironment } from '../utils/branch-authorization.js';
import { captureBranchRemovalRealtimeVisibility } from '../utils/branch-removal-realtime.js';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { shouldUseCloneReferencePath } from '../utils/clone-reference.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import { parseLastMessageTruncationLength } from '../utils/query-params.js';
import { resolveOwnerHomeStore, resolveSandboxStoragePaths } from '../utils/sandbox-context.js';
import {
  getDaemonUrl,
  requestExecutor,
  resolveExecutorResponseCommandCeilingMs,
  spawnExecutor,
} from '../utils/spawn-executor.js';
import { deferWithTenantContext } from '../utils/tenant-db-scope.js';
import { isKnowledgeAdmin } from './knowledge-access.js';
import {
  issueExecutorCommandToken,
  resolveExecutorCommandTokenCeilingMs,
} from './session-token-service.js';
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

function shouldSqlPageBranchQuery(query?: Record<string, unknown>): boolean {
  if (!query) return true;
  const allowed = new Set([
    'archived',
    'board_id',
    'repo_id',
    'branch_id',
    '$limit',
    '$skip',
    '$sort',
  ]);
  if (Object.keys(query).some((key) => !allowed.has(key))) return false;
  for (const key of ['archived', 'board_id', 'repo_id']) {
    if (query[key] !== undefined && typeof query[key] !== 'boolean' && key === 'archived') {
      return false;
    }
    if (query[key] !== undefined && key !== 'archived' && typeof query[key] !== 'string') {
      return false;
    }
  }
  if (query.branch_id !== undefined) {
    const value = query.branch_id;
    if (typeof value !== 'string') {
      const ids = value && typeof value === 'object' ? (value as { $in?: unknown }).$in : undefined;
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return false;
    }
  }
  const sort = query.$sort as Record<string, unknown> | undefined;
  if (sort) {
    const columns = new Set(['branch_id', 'name', 'ref', 'created_at', 'updated_at']);
    if (
      Object.keys(sort).some(
        (field) => !columns.has(field) || (sort[field] !== 1 && sort[field] !== -1)
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Restart is not an executor verb. It is a bounded Stop whose exact settled
 * generation authorizes a separate, normally-credentialed Start.
 */
type EnvironmentLifecycleAction = 'start' | 'stop' | 'nuke' | 'sync';

/** Executor command name, also the key an operator can override a deadline under. */
const ENVIRONMENT_LIFECYCLE_COMMAND = 'environment.lifecycle';

interface EnvironmentLifecycleExecutorPayload extends Record<string, unknown> {
  command: 'environment.lifecycle';
  sessionToken: string;
  daemonUrl: string;
  env: Record<string, string>;
  params: {
    branchId: BranchID;
    branchPath: string;
    cwd: string;
    principalBranchAccess: Exclude<BranchFsAccessLevel, 'none'>;
    action: EnvironmentLifecycleAction;
    startCommand?: string;
    stopCommand?: string;
    nukeCommand?: string;
    syncCommand?: string;
    appUrl?: string;
    healthCheckUrl?: string;
    startupTimeoutMs?: number;
    commandTimeoutMs?: number;
    lifecycleGeneration?: number;
    desiredRevision?: string;
    syncClaimToken?: string;
  };
}

interface EnvironmentSyncRequestOptions {
  desiredRevision?: string;
  requestedByUserId?: UserID;
  /** Internal task trigger: variants without sync are an expected no-op. */
  skipIfUnavailable?: boolean;
}

class EnvironmentSyncUnavailableError extends Error {}

type EnvironmentInstance = NonNullable<Branch['environment_instance']>;
type EnvironmentSyncAttempt = NonNullable<
  NonNullable<EnvironmentInstance['source_sync']>['active_attempt']
>;

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
 * `@agor/core/environment/health-transition`, shared by both monitors so an
 * environment reaches the same status whichever one observes it.
 */

/**
 * Identifies whether a health observation was requested by a user-facing
 * status action or by the background lifecycle monitor.
 *
 * Explicit requests may bypass the periodic cooldown and may return an
 * ephemeral diagnostic for an errored environment. Automatic observations
 * are restricted to active lifecycle states.
 */
export type EnvironmentHealthCheckOptions =
  | { intent: 'automatic'; signal?: AbortSignal }
  | { intent: 'explicit'; signal?: AbortSignal };

/**
 * Extended branches service with custom methods
 */
export class BranchesService extends DrizzleService<Branch, Partial<Branch>, BranchParams> {
  private branchRepo: BranchRepository;
  private boardRepo: BoardRepository;
  private taskRepo: TaskRepository;
  private environmentSyncRepo: EnvironmentSyncRepository;
  private db: TenantScopeAwareDatabase;
  private app: Application;
  private processes = new Map<BranchID, ManagedProcess>();
  private readonly fetchDynamicEnvironmentHealth = createPinnedFetch({
    timeoutMs: ENVIRONMENT.HEALTH_CHECK_TIMEOUT_MS,
    maxBytes: 64 * 1024,
    // Health only needs the status. Stop consuming a streaming response after
    // its first body chunk; an empty response still completes on `end`.
    isBodyComplete: () => true,
  });
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
    this.taskRepo = new TaskRepository(db);
    this.environmentSyncRepo = new EnvironmentSyncRepository(db);
    this.db = db;
    this.app = app;
  }

  /** Refuse a metadata cascade that would orphan a live executor lease. */
  private async assertNoUnfinishedTasks(
    branchId: BranchID,
    taskRepo: TaskRepository = this.taskRepo
  ): Promise<void> {
    if (await taskRepo.hasNonterminalForBranch(branchId)) {
      throw new Conflict(
        `Cannot delete branch ${branchId} while it has unfinished tasks. Stop them first.`
      );
    }
  }

  private removalRepositories(scoped: TenantScopedDatabase): {
    branchRepo: BranchRepository;
    taskRepo: TaskRepository;
  } {
    // Lightweight service tests use one in-memory repository seam. Native
    // production transactions provide a distinct scoped handle, which must
    // own every query participating in the check-and-cascade invariant.
    if (Object.is(scoped, this.db)) {
      return { branchRepo: this.branchRepo, taskRepo: this.taskRepo };
    }
    return {
      branchRepo: new BranchRepository(scoped),
      taskRepo: new TaskRepository(scoped),
    };
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
    sync?: string;
  }): Promise<void> {
    const mode = await this.getManagedEnvExecutionMode();
    validateManagedEnvLifecyclePolicy(
      {
        start: snapshot.start,
        stop: snapshot.stop,
        nuke: snapshot.nuke,
        logs: snapshot.logs,
        sync: snapshot.sync,
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
  }): Promise<{ body: string; truncated: boolean; status: number; contentType?: string }> {
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

      return {
        body,
        truncated,
        status: response.status,
        contentType: response.headers.get('content-type') ?? undefined,
      };
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

  private parseEnvironmentWebhookLifecycleResult(response: {
    body: string;
    truncated: boolean;
    contentType?: string;
  }): EnvironmentLifecycleResult | undefined {
    const body = response.body.trim();
    if (!body) return undefined;
    const mediaType = response.contentType?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json' && !mediaType?.endsWith('+json')) return undefined;
    if (response.truncated) throw new Error('Environment webhook result exceeds the size limit');
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      throw new Error('Environment webhook returned invalid result JSON');
    }
    return validateEnvironmentLifecycleResult(decoded);
  }

  private requireEnvironmentGeneration(branch: Branch): number {
    const generation = branch.environment_generation;
    if (!Number.isSafeInteger(generation) || generation === undefined || generation < 0) {
      throw new Error(`Branch ${branch.branch_id} is missing lifecycle coordination metadata`);
    }
    return generation;
  }

  private isEnvironmentLifecycleSuperseded(error: unknown): boolean {
    return (
      error instanceof Conflict &&
      (error.data as { code?: unknown } | undefined)?.code === ENVIRONMENT_LIFECYCLE_SUPERSEDED_CODE
    );
  }

  /** Commit an async lifecycle result only while its originating boundary still owns the row. */
  private async commitEnvironmentLifecycle(
    id: BranchID,
    environmentUpdate: BranchEnvironmentUpdate,
    generation: number,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions | undefined> {
    try {
      return await this.updateEnvironment(id, environmentUpdate, params, {
        expectedEnvironmentGeneration: generation,
      });
    } catch (error) {
      if (this.isEnvironmentLifecycleSuperseded(error)) return undefined;
      throw error;
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

  private async resolveEnvironmentExecutionAuthority(
    branch: Branch,
    params?: BranchParams,
    requiredFsAccess: Exclude<BranchFsAccessLevel, 'none'> = 'write',
    executionUserIdOverride?: UserID
  ): Promise<{
    executionUserId: UserID;
    branchFsAccess: Exclude<BranchFsAccessLevel, 'none'>;
  }> {
    const config = this.app.get('config');
    return this.withTenantDatabase(params, async () => {
      const requestUser = (params as AuthenticatedParams | undefined)?.user;
      const executionUserId = (executionUserIdOverride ??
        requestUser?.user_id ??
        branch.primary_owner_user_id ??
        branch.created_by) as UserID;
      const executionUser = executionUserIdOverride
        ? await new UsersRepository(this.db).findById(executionUserId as string)
        : requestUser;
      if (executionUserIdOverride && !executionUser) {
        throw new Error(`Environment execution user ${executionUserId} no longer exists`);
      }
      const branchFsAccess = hasMinimumRole(executionUser?.role, ROLES.ADMIN)
        ? 'write'
        : await ensureBranchWorkspaceAccess(
            this.branchRepo,
            branch,
            executionUserId,
            executionUser?.role as UserRole | undefined,
            'all',
            requiredFsAccess,
            config.execution?.allow_superadmin === true
          );
      return { executionUserId, branchFsAccess };
    });
  }

  private async resolveEnvironmentExecutorContext(
    branch: Branch,
    params?: BranchParams,
    requiredFsAccess: Exclude<BranchFsAccessLevel, 'none'> = 'write',
    executionUserIdOverride?: UserID
  ): Promise<{
    delegatedHomeKey?: string;
    env: Record<string, string>;
    executionUserId: UserID;
    branchFsAccess: Exclude<BranchFsAccessLevel, 'none'>;
    // Authoritative sandbox mount inputs for the environment executor, mirroring
    // the session path (register-services). Empty when the fail-closed
    // filesystem sandbox or its per_user home overlay is off. Without these,
    // buildSandboxWrap resolves no owner home store and refuses to spawn under
    // `home_mode: per_user` — which is what broke env logs/start/stop/nuke.
    sandboxMounts: {
      sandboxHomeStore?: string;
      sandboxWorktreesRoot?: string;
      sandboxBaseRepoPath?: string;
    };
  }> {
    const config = this.app.get('config');
    const { executionUserId, branchFsAccess } = await this.resolveEnvironmentExecutionAuthority(
      branch,
      params,
      requiredFsAccess,
      executionUserIdOverride
    );
    return this.withTenantDatabase(params, async () => {
      const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(
        this.db,
        executionUserId,
        config
      );

      // Resolve the per-owner home store (and worktree / base-repo mounts) the
      // sandbox needs, keyed to the environment's execution user — the same
      // resolution the session executor path performs. Only the fail-closed
      // sandbox with a per_user home requires it; otherwise leave it empty.
      const sandboxCfg = config.execution?.sandbox;
      const sandboxMounts: {
        sandboxHomeStore?: string;
        sandboxWorktreesRoot?: string;
        sandboxBaseRepoPath?: string;
      } = {};
      if (sandboxCfg?.enabled === true && sandboxCfg?.home_mode === 'per_user') {
        const tenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();
        const filesystemHome =
          (
            await new UsersRepository(this.db).findById(executionUserId as string)
          )?.filesystem_home?.trim() || undefined;
        sandboxMounts.sandboxHomeStore = resolveOwnerHomeStore({
          config,
          tenantId,
          ownerUserId: executionUserId,
          filesystemHome,
        });
        sandboxMounts.sandboxWorktreesRoot = resolveSandboxStoragePaths(
          config,
          tenantId
        ).worktreesRoot;
        // Only linked worktrees need the shared git dir mounted; a clone-mode
        // branch carries its own `.git` (mirrors the session executor path).
        if (branch.storage_mode !== 'clone' && branch.repo_id) {
          const repo = await new RepoRepository(this.db).findById(branch.repo_id);
          sandboxMounts.sandboxBaseRepoPath = repo?.local_path ?? undefined;
        }
      }

      const env = await createUserProcessEnvironment(executionUserId, this.db);
      return { delegatedHomeKey, env, executionUserId, branchFsAccess, sandboxMounts };
    });
  }

  private async createEnvironmentExecutorPayload(options: {
    branch: Branch;
    action: EnvironmentLifecycleAction;
    params?: BranchParams;
    // Sync has no frozen branch column (unlike start/stop/nuke). It is rendered
    // fresh at dispatch time — with current facts — and passed through here.
    syncCommand?: string;
    desiredRevision?: string;
    syncClaimToken?: string;
    executionUserIdOverride?: UserID;
    /** Exact lifecycle boundary that owns every executor callback. */
    lifecycleGeneration?: number;
    /**
     * Budget the caller is already committed to, instead of the branch's
     * current snapshot. Sync passes the value its durable claim leased so a
     * re-render mid-attempt cannot give the executor a deadline that outlives
     * the lease its settlement will be checked against.
     */
    lifecycleTimeoutMsOverride?: number;
    /** The daemon awaits this command's result, so its waiter also bounds it. */
    awaitsResponse?: boolean;
  }): Promise<{
    payload: EnvironmentLifecycleExecutorPayload;
    delegatedHomeKey?: string;
    env: Record<string, string>;
    executionUserId: UserID;
    branchFsAccess: Exclude<BranchFsAccessLevel, 'none'>;
    /** Present for every non-Start action; Start is bounded by its own deadline. */
    lifecycleBudget?: EnvironmentLifecycleBudget;
  }> {
    const { branch, action, params } = options;
    const { delegatedHomeKey, env, executionUserId, branchFsAccess, sandboxMounts } =
      await this.resolveEnvironmentExecutorContext(
        branch,
        options.params,
        'write',
        options.executionUserIdOverride
      );
    const commandId =
      action === 'sync' && options.syncClaimToken
        ? `environment-sync:${options.syncClaimToken}`
        : `environment-${action}`;
    // One snapshotted budget decides the shell deadline, the credential, the
    // daemon's waiter, and (for Sync) the durable claim lease. Start keeps its
    // own persisted startup policy; every other verb is bounded per variant so
    // a provider that needs 20 minutes cannot force every ordinary local
    // command to demand a credential the operator's configured maximum refuses.
    //
    // Both operator ceilings are applied HERE rather than left to surprise the
    // command later: the token service refuses a credential longer than its
    // configured maximum, and a `by_command` response override outranks the
    // waiter this call would otherwise pass. Either one tighter than the
    // variant asked for shortens the command deadline instead of inverting the
    // nesting.
    const startBudget = resolveEnvironmentStartBudget(branch.startup_timeout_ms);
    const lifecycleBudget =
      action === 'start'
        ? undefined
        : resolveEnvironmentLifecycleBudget(
            options.lifecycleTimeoutMsOverride ?? branch.lifecycle_timeout_ms,
            {
              credentialCeilingMs: resolveExecutorCommandTokenCeilingMs(this.app),
              ...(options.awaitsResponse
                ? {
                    requestCeilingMs: resolveExecutorResponseCommandCeilingMs(
                      ENVIRONMENT_LIFECYCLE_COMMAND
                    ),
                  }
                : {}),
            }
          );
    const credentialLifetimeMs =
      lifecycleBudget?.credentialLifetimeMs ?? startBudget.credentialLifetimeMs;
    const sessionToken = await this.withTenantDatabase(params, () =>
      issueExecutorCommandToken(this.app, commandId, executionUserId, branch.branch_id, {
        expirationMs: credentialLifetimeMs,
      })
    );

    return {
      delegatedHomeKey,
      env,
      lifecycleBudget,
      payload: {
        command: ENVIRONMENT_LIFECYCLE_COMMAND,
        sessionToken,
        daemonUrl: getDaemonUrl(),
        env,
        params: {
          branchId: branch.branch_id,
          branchPath: branch.path,
          cwd: branch.path,
          principalBranchAccess: branchFsAccess,
          // Sandbox mount inputs consumed by spawn-executor → buildSandboxWrap.
          ...sandboxMounts,
          action,
          startCommand: branch.start_command,
          stopCommand: branch.stop_command,
          nukeCommand: branch.nuke_command,
          appUrl: branch.app_url,
          healthCheckUrl: branch.health_check_url,
          ...(action === 'start'
            ? { startupTimeoutMs: startBudget.startupTimeoutMs }
            : { commandTimeoutMs: lifecycleBudget?.commandTimeoutMs }),
          lifecycleGeneration: options.lifecycleGeneration,
          ...(options.syncCommand ? { syncCommand: options.syncCommand } : {}),
          ...(options.desiredRevision ? { desiredRevision: options.desiredRevision } : {}),
          ...(options.syncClaimToken ? { syncClaimToken: options.syncClaimToken } : {}),
        },
      },
      executionUserId,
      branchFsAccess,
    };
  }

  private async dispatchEnvironmentExecutor(options: {
    branch: Branch;
    action: EnvironmentLifecycleAction;
    params?: BranchParams;
    syncCommand?: string;
    lifecycleGeneration?: number;
  }): Promise<void> {
    const { branch, action, params } = options;
    const { payload, delegatedHomeKey, env, executionUserId, branchFsAccess } =
      await this.createEnvironmentExecutorPayload(options);
    const logPrefix = `[Environment.${action} ${branch.name}]`;

    const spawnLifecycleExecutor = async () => {
      try {
        spawnExecutor(payload, {
          logPrefix,
          delegatedHomeKey,
          preparedEnv: env,
          templateVariables: {
            branch_id: branch.branch_id,
            user_id: executionUserId,
            branch_fs_access: branchFsAccess,
          },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to spawn environment executor';
        const update = {
          status: 'error' as const,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy' as const,
            message,
          },
          last_error: message,
        };
        if (options.lifecycleGeneration !== undefined) {
          await this.commitEnvironmentLifecycle(
            branch.branch_id,
            update,
            options.lifecycleGeneration,
            params
          );
        } else {
          await this.updateEnvironment(branch.branch_id, update, params);
        }
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
    lifecycleGeneration?: number;
    syncCommand?: string;
    desiredRevision?: string;
    syncClaimToken?: string;
    executionUserIdOverride?: UserID;
    lifecycleTimeoutMsOverride?: number;
  }): Promise<Record<string, unknown> | undefined> {
    const { branch, action } = options;
    const { payload, delegatedHomeKey, env, executionUserId, branchFsAccess, lifecycleBudget } =
      await this.createEnvironmentExecutorPayload({ ...options, awaitsResponse: true });

    const result = await requestExecutor(payload, {
      logPrefix: `[Environment.${action} ${branch.name}]`,
      delegatedHomeKey,
      preparedEnv: env,
      // Restart and Sync need the daemon to observe the command's real outcome.
      // The waiter outlives the shell deadline AND the credential, so an
      // executor that fails at its own deadline still gets to record the fenced
      // failure the daemon is waiting to read. The budget above already
      // accounts for a `by_command` override that outranks this value.
      timeoutMs: lifecycleBudget?.requestTimeoutMs,
      templateVariables: {
        branch_id: branch.branch_id,
        user_id: executionUserId,
        branch_fs_access: branchFsAccess,
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
    return result.data as Record<string, unknown> | undefined;
  }

  private async fetchEnvironmentLogsViaExecutor(
    branch: Branch,
    logsCommand: string,
    params?: BranchParams
  ): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
    const { delegatedHomeKey, env, executionUserId, branchFsAccess, sandboxMounts } =
      await this.resolveEnvironmentExecutorContext(branch, params, 'read');
    const sessionToken = await this.withTenantDatabase(params, () =>
      issueExecutorCommandToken(this.app, 'environment-logs', executionUserId, branch.branch_id)
    );
    const result = await requestExecutor(
      {
        command: 'environment.logs',
        sessionToken,
        daemonUrl: getDaemonUrl(),
        env,
        params: {
          branchId: branch.branch_id,
          branchPath: branch.path,
          cwd: branch.path,
          principalBranchAccess: branchFsAccess,
          // Sandbox mount inputs consumed by spawn-executor → buildSandboxWrap.
          ...sandboxMounts,
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
          user_id: executionUserId,
          branch_fs_access: branchFsAccess,
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
   * The normalized board template remains the only stored authority while the
   * branch is aligned. The permissions service copies that complete package
   * when the user later switches to override mode.
   */
  private async applyBranchCreateDefaults(data: Partial<Branch>): Promise<Partial<Branch>> {
    const withDefaults: Partial<Branch> = { ...data };
    if (
      withDefaults.base_remote_url !== undefined &&
      withDefaults.base_remote_url !== TEAMMATE_FRAMEWORK_REPO_URL
    ) {
      throw new BadRequest(
        'base_remote_url is restricted to the canonical Agor teammate template repository.'
      );
    }
    const config = this.app.get('config');
    const { defaultMode } = resolveBranchStorageConfig(config);
    const storageMode = withDefaults.storage_mode ?? defaultMode;
    ensureBranchStorageModeAllowed(storageMode, config);
    if (
      storageMode === 'worktree' &&
      resolveMultiTenancyConfig(config).mode === 'required_from_auth'
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
        ensureBranchCloneDepthAllowed(withDefaults.clone_depth, config);
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
    withDefaults.permission_binding = 'inherit';

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
      if (Object.hasOwn(item, 'sdk_home')) {
        throw new BadRequest(
          'sdk_home is server-managed and cannot be set through the Branch API.'
        );
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
    const userId =
      (params?.user?.user_id as UserID | undefined) ??
      (branch.primary_owner_user_id as UserID | undefined) ??
      (branch.created_by as UserID);
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
      (params?.user?.user_id as UserID | undefined) ??
        (branch.primary_owner_user_id as UserID | undefined) ??
        (branch.created_by as UserID)
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
    if (Object.hasOwn(data, 'sdk_home')) {
      throw new BadRequest(
        'sdk_home is server-managed and cannot be changed through the Branch API.'
      );
    }
    if (Object.hasOwn(data, 'base_remote_url')) {
      throw new BadRequest('base_remote_url is immutable after branch creation.');
    }
    // Get current branch to check type/board changes
    const currentBranch = await super.get(id, params);
    await this.assertCanMutateTeammateKnowledgeConfig(currentBranch, data, params);
    this.assertTeammateKindIsStable(currentBranch, data);

    const oldBoardId = currentBranch.board_id;
    const boardIdProvided = Object.hasOwn(data, 'board_id');
    const newBoardId = data.board_id;
    const boardChanged = boardIdProvided && oldBoardId !== newBoardId;

    if (boardChanged && currentBranch.permission_binding === 'inherit') {
      throw new BadRequest(
        'Switch this branch to an explicit permission override before moving it to another board.'
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
      currentBranch.permission_binding === 'inherit'
    ) {
      throw new BadRequest(
        'Switch this branch to an explicit permission override before moving it to another board.'
      );
    }
    return super.update(id, data, params) as Promise<Branch>;
  }

  /**
   * Load the canonical branch shape without entering the Feathers method
   * wrapper. Internal-only operations use this deliberately when their caller
   * already owns the authority context and must not manufacture nested
   * `branches.get` requests.
   */
  private async getCanonicalBranch(
    id: BranchID,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
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
   * Override get to enrich with zone information.
   *
   * Session activity enrichment is opt-in via include_sessions query parameter
   */
  async get(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    return this.getCanonicalBranch(id, params);
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

    const query = findParams?.query as Record<string, unknown> | undefined;
    if (shouldSqlPageBranchQuery(query)) {
      const branchFilter = query?.branch_id;
      const branchIds =
        typeof branchFilter === 'string'
          ? [branchFilter as BranchID]
          : branchFilter &&
              typeof branchFilter === 'object' &&
              Array.isArray((branchFilter as { $in?: unknown }).$in)
            ? (branchFilter as { $in: BranchID[] }).$in
            : undefined;
      const requestedLimit =
        typeof query?.$limit === 'number' ? query.$limit : PAGINATION.DEFAULT_LIMIT;
      const limit = Math.min(requestedLimit, PAGINATION.MAX_LIMIT);
      const skip = typeof query?.$skip === 'number' ? query.$skip : 0;
      const page = await this.branchRepo.findPage({
        repo_id: typeof query?.repo_id === 'string' ? (query.repo_id as UUID) : undefined,
        board_id: typeof query?.board_id === 'string' ? (query.board_id as BoardID) : undefined,
        archived: typeof query?.archived === 'boolean' ? query.archived : undefined,
        branchIds,
        visibleToUserId: findParams?._agorSqlBranchAccessUserId,
        limit,
        offset: skip,
        sort: query?.$sort as Record<string, 1 | -1> | undefined,
      });
      const enriched = await this.branchRepo.enrichManyWithZoneInfo(page.data);
      return {
        total: page.total,
        limit,
        skip,
        data: enriched,
      };
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
    const requestUser = (params as AuthenticatedParams | undefined)?.user;

    // The active-task guard and metadata cascade are one native transaction on
    // both databases. Otherwise a task could start between the check and the
    // delete and leave a valid executor lease with no owning task row.
    const { branch, result, branchFsAccess } = await runWithTenantDatabaseTransaction(
      this.db,
      tenantId,
      async (scoped) => {
        const { branchRepo, taskRepo } = this.removalRepositories(scoped);
        const branch = await branchRepo.findById(id);
        if (!branch) throw new NotFound(`Branch not found: ${id}`);
        const branchFsAccess = deleteFromFilesystem
          ? await ensureBranchWorkspaceAccess(
              branchRepo,
              branch,
              requestUser?.user_id,
              requestUser?.role as UserRole | undefined,
              'all',
              'write',
              this.app.get('config').execution?.allow_superadmin === true
            )
          : undefined;
        await this.assertNoUnfinishedTasks(branch.branch_id, taskRepo);
        // Remove from database FIRST for instant UI feedback. CASCADE cleans
        // up related comments and terminal tasks.
        await branchRepo.delete(id);
        return { branch, result: branch, branchFsAccess };
      }
    );

    this.removeBranchSdkHomeAfterDelete(branch, tenantId);

    // Then remove from filesystem via a one-purpose executor (fire-and-forget).
    // The daemon owns metadata; the payload contains only authoritative paths.
    if (deleteFromFilesystem) {
      console.log(`🗑️  Spawning executor to remove branch from filesystem: ${branch.path}`);

      // Resolve the optional delegated execution-home key. Local execution
      // never selects or impersonates a host account.
      const delegatedHomeKey = await resolveDelegatedExecutionHomeKey(
        this.db,
        requestUser!.user_id,
        this.app.get('config')
      );
      spawnExecutor(
        {
          command: 'git.branch.remove',
          params: {
            branchId: branch.branch_id,
            branchPath: branch.path,
            branchesRoot: getBranchesDir(tenantId),
            // Clean up the branch if it was created by Agor.
            branch: branch.ref,
            deleteBranch: branch.new_branch,
            // Branch storage mode — executor needs this to pick the right
            // teardown path (clone-mode just rm -rf; worktree-mode also runs
            // `git worktree remove --force` against the base repo).
            storageMode: branch.storage_mode ?? 'worktree',
          },
        },
        {
          logPrefix: `[BranchesService.remove ${branch.name}]`,
          delegatedHomeKey,
          templateVariables: {
            branch_id: branch.branch_id,
            user_id: requestUser!.user_id,
            branch_fs_access: branchFsAccess,
          },
        }
      );
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
    const tenantId = removalParams.tenant?.tenant_id ?? getCurrentTenantId();
    const removedBranch = await runWithTenantDatabaseTransaction(
      this.db,
      tenantId,
      async (scoped) => {
        const { branchRepo, taskRepo } = this.removalRepositories(scoped);
        const branch = await branchRepo.findById(id);
        if (!branch) throw new NotFound(`Branch not found: ${id}`);
        await this.assertNoUnfinishedTasks(branch.branch_id, taskRepo);
        await captureBranchRemovalRealtimeVisibility({
          params: removalParams,
          branchRepository: branchRepo,
          branchId: branch.branch_id,
        });

        // This custom method deliberately bypasses Feathers' standard method
        // wrapper. The explicit event below is the single authoritative
        // tombstone and drains only after the transaction commits.
        await branchRepo.delete(branch.branch_id);
        const removedBranch = branch;
        emitServiceEvent(this.app, {
          path: 'branches',
          event: 'removed',
          data: removedBranch,
          params: removalParams,
          id: removedBranch.branch_id,
        });
        return removedBranch;
      }
    );
    this.removeBranchSdkHomeAfterDelete(removedBranch, tenantId);
    return removedBranch;
  }

  /** Best-effort cleanup for every hard-delete path; archives never call it. */
  private removeBranchSdkHomeAfterDelete(branch: Branch, tenantId: string | undefined): void {
    const branchHomeDir = getBranchHomePath(branch.branch_id, tenantId);
    void rm(branchHomeDir, { recursive: true, force: true }).catch((err) => {
      console.warn(
        `[BranchesService.delete ${branch.name}] Failed to remove branch SDK home ` +
          `${branchHomeDir}: ${err instanceof Error ? err.message : String(err)}`
      );
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
    const requestUser = (params as AuthenticatedParams).user!;
    const currentUserId = requestUser.user_id as UUID;
    const branchFsAccess =
      filesystemAction === 'preserved'
        ? undefined
        : await this.withTenantDatabase(params, () =>
            ensureBranchWorkspaceAccess(
              this.branchRepo,
              branch,
              requestUser.user_id,
              requestUser.role as UserRole | undefined,
              'all',
              'write',
              this.app.get('config').execution?.allow_superadmin === true
            )
          );

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

    // Prepare the one-purpose filesystem action now, but dispatch it only
    // after metadata succeeds. In particular, an unfinished-task delete guard
    // must fail before any branch directory can be removed.
    const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined;
    const delegatedHomeKey =
      filesystemAction === 'preserved'
        ? undefined
        : await resolveDelegatedExecutionHomeKey(
            this.db,
            userId ?? currentUserId,
            this.app.get('config')
          );
    const filesystemExecutionUserId = userId ?? currentUserId;
    const dispatchFilesystemAction = (): void => {
      if (filesystemAction === 'cleaned') {
        console.log(`🧹 Spawning executor to clean branch filesystem: ${branch.path}`);
        spawnExecutor(
          {
            command: 'git.branch.clean',
            params: {
              branchPath: branch.path,
              cwd: branch.path,
              principalBranchAccess: branchFsAccess,
            },
          },
          {
            logPrefix: `[BranchesService.clean ${branch.name}]`,
            delegatedHomeKey,
            templateVariables: {
              branch_id: branch.branch_id,
              user_id: filesystemExecutionUserId,
              branch_fs_access: branchFsAccess,
            },
          }
        );
        return;
      }
      if (filesystemAction !== 'deleted') return;

      console.log(`🗑️  Spawning executor to delete branch from filesystem: ${branch.path}`);
      const tenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();

      spawnExecutor(
        {
          command: 'git.branch.remove',
          params: {
            branchId: branch.branch_id,
            branchPath: branch.path,
            branchesRoot: getBranchesDir(tenantId),
            // Clean up the branch if it was created by Agor.
            branch: branch.ref,
            deleteBranch: branch.new_branch,
            // Branch storage mode — see sibling call site comment in
            // `BranchesService.remove` above for why this matters.
            storageMode: branch.storage_mode ?? 'worktree',
          },
        },
        {
          logPrefix: `[BranchesService.delete ${branch.name}]`,
          delegatedHomeKey,
          templateVariables: {
            branch_id: branch.branch_id,
            user_id: filesystemExecutionUserId,
            branch_fs_access: branchFsAccess,
          },
        }
      );
    };

    // Retire branch-scoped terminals only after the metadata transition wins.
    // The local event handles this replica; serverSideEmit carries only the
    // trusted tenant/branch lifecycle tuple to peers.
    const terminalTenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();
    if (!terminalTenantId) throw new Error('Missing tenant context for branch terminal cleanup');
    const retireBranchTerminals = (): void => {
      const terminalClose = {
        tenantId: String(terminalTenantId),
        branchId: branch.branch_id,
      };
      this.app.emit?.('terminal:close-branch', terminalClose);
      this.app.io?.serverSideEmit?.('terminal:close-branch', terminalClose);
    };

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

      retireBranchTerminals();
      dispatchFilesystemAction();
      return archivedBranch;
    } else {
      // Delete: Hard delete (CASCADE will remove sessions, messages, tasks)
      console.log(`🗑️  Permanently deleting branch: ${branch.name}`);

      await this.removeMetadataWithRealtime(id, params);

      console.log(`✅ Permanently deleted branch ${branch.name}`);
      retireBranchTerminals();
      dispatchFilesystemAction();
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

    const requestUser = params?.user;
    if (!requestUser) throw new NotAuthenticated('Authentication required');
    const branchFsAccess = await this.withTenantDatabase(params, () =>
      ensureBranchWorkspaceAccess(
        this.branchRepo,
        branch,
        requestUser.user_id,
        requestUser.role as UserRole | undefined,
        'all',
        'write',
        this.app.get('config').execution?.allow_superadmin === true
      )
    );

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
    const userId = requestUser.user_id;
    const statusToken = await issueExecutorCommandToken(
      this.app,
      'branch-filesystem-status',
      userId,
      branch.branch_id
    );
    const statusResult = await requestExecutor(
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
        templateVariables: {
          branch_id: branch.branch_id,
          user_id: userId,
          branch_fs_access: branchFsAccess,
        },
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
        const sessionToken = await issueExecutorCommandToken(
          this.app,
          'git.branch.add',
          userId,
          branch.branch_id
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
            delegatedHomeKey: await resolveDelegatedExecutionHomeKey(
              this.db,
              userId,
              this.app.get('config')
            ),
            templateVariables: {
              branch_id: branch.branch_id,
              user_id: userId,
              branch_fs_access: branchFsAccess,
            },
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
          expected_environment_generation?: number;
          expectedEnvironmentGeneration?: number;
          expected_environment_status?: EnvironmentInstance['status'];
          expectedEnvironmentStatus?: EnvironmentInstance['status'];
        },
    environmentUpdateOrParams?: BranchEnvironmentUpdate | BranchParams,
    params?: BranchParams,
    internalOptions?: {
      beginLifecycle?: boolean;
      expectedEnvironmentGeneration?: number;
      expectedEnvironmentStatus?: EnvironmentInstance['status'];
    }
  ): Promise<BranchWithZoneAndSessions> {
    const isRpcEnvelope = typeof idOrData === 'object';
    const id = isRpcEnvelope ? (idOrData.branch_id ?? idOrData.branchId) : idOrData;
    const environmentUpdate = isRpcEnvelope
      ? (idOrData.environment_update ?? idOrData.environmentUpdate)
      : (environmentUpdateOrParams as BranchEnvironmentUpdate | undefined);
    const resolvedParams = isRpcEnvelope
      ? (environmentUpdateOrParams as BranchParams | undefined)
      : params;
    const expectedEnvironmentGeneration = isRpcEnvelope
      ? (idOrData.expected_environment_generation ?? idOrData.expectedEnvironmentGeneration)
      : internalOptions?.expectedEnvironmentGeneration;
    const expectedEnvironmentStatus = isRpcEnvelope
      ? (idOrData.expected_environment_status ?? idOrData.expectedEnvironmentStatus)
      : internalOptions?.expectedEnvironmentStatus;
    const coordinatedLifecycleUpdate =
      internalOptions?.beginLifecycle === true || expectedEnvironmentGeneration !== undefined;

    if (!id) {
      throw new Error('Branch ID is required to update environment status');
    }
    if (!environmentUpdate) {
      throw new Error('Environment update is required');
    }
    if (
      isRpcEnvelope &&
      resolvedParams?.provider &&
      Object.hasOwn(environmentUpdate, 'source_sync') &&
      !matchesExecutorCommandRuntimeScope(resolvedParams, 'environment-nuke', id)
    ) {
      throw new Forbidden(
        'Environment source reconciliation state is daemon-owned and cannot be patched directly'
      );
    }
    if (
      expectedEnvironmentGeneration !== undefined &&
      (!Number.isSafeInteger(expectedEnvironmentGeneration) || expectedEnvironmentGeneration < 0)
    ) {
      throw new BadRequest('Expected environment generation must be a non-negative integer');
    }
    if (
      expectedEnvironmentStatus !== undefined &&
      !['stopped', 'starting', 'running', 'stopping', 'error'].includes(expectedEnvironmentStatus)
    ) {
      throw new BadRequest('Expected environment status is invalid');
    }
    if (expectedEnvironmentStatus !== undefined && expectedEnvironmentGeneration === undefined) {
      throw new BadRequest('Expected environment status requires an expected generation');
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
    if (!hasPersistedChange && !coordinatedLifecycleUpdate) {
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
    if (!hasChanged && !coordinatedLifecycleUpdate) {
      return this.withTenantDatabase(resolvedParams, () =>
        this.branchRepo.update(
          id,
          { environment_instance: updatedEnvironment },
          { preserveUpdatedAt: true }
        )
      );
    }

    let branch: BranchWithZoneAndSessions;
    try {
      branch = coordinatedLifecycleUpdate
        ? await this.withTenantDatabase(resolvedParams, async () => {
            await this.branchRepo.update(
              id,
              {
                environment_instance: updatedEnvironment,
                updated_at: new Date().toISOString(),
              },
              {
                invalidateEnvironmentObservation: internalOptions?.beginLifecycle === true,
                expectedEnvironmentGeneration,
                ...(expectedEnvironmentStatus !== undefined ? { expectedEnvironmentStatus } : {}),
              }
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
    } catch (error) {
      if (error instanceof EnvironmentLifecycleConflictError) {
        throw new Conflict(error.message, {
          code: ENVIRONMENT_LIFECYCLE_SUPERSEDED_CODE,
          branch_id: error.branchId,
          expected_environment_generation: error.expectedGeneration,
          current_environment_generation: error.currentGeneration,
          expected_status: error.expectedStatus,
          current_status: error.currentStatus,
        });
      }
      throw error;
    }

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

    if (branch.environment_instance?.status === 'running') {
      deferWithTenantContext(
        resolvedParams,
        () => this.reconcileEnvironmentSync(id, resolvedParams),
        (error) =>
          console.warn(
            `[Environment.sync ${id}] Reconciliation trigger failed: ${error instanceof Error ? error.message : String(error)}`
          )
      );
    }

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

    // Give obvious conflicts a fast user-facing error. The repository's
    // generation-and-status CAS below is the authoritative guard: two
    // concurrent starts can both reach this point, but only one can claim the
    // lifecycle boundary and dispatch an executor. Before that CAS existed,
    // two POSTs to /start returned 201 and two executors ran simultaneously.
    // For a remote backend that means two `gh codespace create` calls and TWO
    // billable Codespaces for one branch; here it only escaped because a
    // codespace already existed, so both invocations merely resumed it.
    //
    // A start wedged in `starting` cannot block forever: `checkHealth` demotes
    // it to `error` after the startup timeout, and Stop stays enabled meanwhile
    // (the UI allows stopping while starting), so recovery does not depend on
    // waiting that out.
    if (branch.environment_instance?.status === 'starting') {
      throw new Error('Environment is already starting');
    }
    if (branch.environment_instance?.status === 'stopping') {
      throw new Error('Environment is still stopping');
    }

    const command = branch.start_command;
    const execution = await this.resolveEnvironmentCommand(command, 'start');
    const access_urls = branch.app_url ? [{ name: 'App', url: branch.app_url }] : undefined;
    const startupTimeoutMs = resolveEnvironmentStartupTimeoutMs(branch.startup_timeout_ms);
    const startedAt = new Date();

    const startingBranch = await this.updateEnvironment(
      id,
      {
        status: 'starting',
        process: {
          ...branch.environment_instance?.process,
          started_at: startedAt.toISOString(),
        },
        startup_deadline_at: new Date(startedAt.getTime() + startupTimeoutMs).toISOString(),
        access_urls,
        facts: undefined,
        lifecycle_result: undefined,
        last_health_check: undefined,
        last_error: undefined,
      },
      params,
      {
        beginLifecycle: true,
        expectedEnvironmentGeneration: this.requireEnvironmentGeneration(branch),
        expectedEnvironmentStatus: branch.environment_instance?.status,
      }
    );
    const lifecycleGeneration = this.requireEnvironmentGeneration(startingBranch);

    try {
      console.log(
        `🚀 Starting environment for branch ${branch.name}: ${
          execution.kind === 'webhook'
            ? redactManagedEnvWebhookUrlForAudit(execution.url)
            : execution.command
        }`
      );

      if (execution.kind === 'webhook') {
        const response = await this.executeEnvironmentWebhook({
          url: execution.url,
          branch,
          commandType: 'start',
          triggeredBy: this.extractTriggeredBy(params),
          maxBytes: 16 * 1024,
        });
        const lifecycleResult = this.parseEnvironmentWebhookLifecycleResult(response);
        const effectiveHealthUrl = lifecycleResult?.health_url ?? branch.health_check_url;
        const completedAt = new Date().toISOString();
        const committed = await this.commitEnvironmentLifecycle(
          id,
          {
            ...(!effectiveHealthUrl
              ? {
                  status: 'running' as const,
                  last_health_check: {
                    timestamp: completedAt,
                    status: 'unknown' as const,
                    message: 'Start webhook completed; health is unavailable',
                  },
                }
              : {}),
            ...(lifecycleResult
              ? {
                  lifecycle_result: lifecycleResult,
                  access_urls: lifecycleResult.access_urls ?? access_urls,
                  facts: lifecycleResultTemplateFacts(lifecycleResult),
                }
              : {}),
            last_command: {
              action: 'start',
              status: 'succeeded',
              timestamp: completedAt,
              message: 'Start webhook completed',
            },
          },
          lifecycleGeneration,
          params
        );
        if (!committed) {
          return await this.withTenantDatabase(params, () => this.get(id, params));
        }
        console.log(`✅ Start webhook completed successfully for ${branch.name}`);
      } else {
        await this.dispatchEnvironmentExecutor({
          branch,
          action: 'start',
          params,
          lifecycleGeneration,
        });
      }

      // Keep status as 'starting' - let health checks transition to 'running'.
      return await this.withTenantDatabase(params, () => this.get(id, params));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const commandOutput =
        error instanceof Error
          ? (error as Error & { commandOutput?: string }).commandOutput
          : undefined;

      const committed = await this.commitEnvironmentLifecycle(
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
        lifecycleGeneration,
        params
      );

      if (!committed) {
        return await this.withTenantDatabase(params, () => this.get(id, params));
      }

      throw error;
    }
  }

  /**
   * Custom method: Stop environment
   */
  async stopEnvironment(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    const branch = await this.loadEnvironmentForAction(id, params, 'stop branch environments');

    const stoppingBranch = await this.updateEnvironment(
      id,
      { status: 'stopping', startup_deadline_at: undefined },
      params,
      {
        beginLifecycle: true,
        expectedEnvironmentGeneration: this.requireEnvironmentGeneration(branch),
        expectedEnvironmentStatus: branch.environment_instance?.status,
      }
    );
    const lifecycleGeneration = this.requireEnvironmentGeneration(stoppingBranch);

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
          await this.dispatchEnvironmentExecutor({
            branch,
            action: 'stop',
            params,
            lifecycleGeneration,
          });
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

      return (
        (await this.commitEnvironmentLifecycle(
          id,
          {
            status: 'stopped',
            process: undefined,
            startup_deadline_at: undefined,
            last_health_check: {
              timestamp: new Date().toISOString(),
              status: 'unknown',
              message: 'Environment stopped',
            },
          },
          lifecycleGeneration,
          params
        )) ?? (await this.withTenantDatabase(params, () => this.get(id, params)))
      );
    } catch (error) {
      const committed = await this.commitEnvironmentLifecycle(
        id,
        {
          status: 'error',
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        },
        lifecycleGeneration,
        params
      );

      if (!committed) {
        return await this.withTenantDatabase(params, () => this.get(id, params));
      }

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

    const stoppingBranch = await this.updateEnvironment(
      id,
      { status: 'stopping', startup_deadline_at: undefined },
      params,
      {
        beginLifecycle: true,
        expectedEnvironmentGeneration: this.requireEnvironmentGeneration(branch),
        expectedEnvironmentStatus: branch.environment_instance?.status,
      }
    );
    const lifecycleGeneration = this.requireEnvironmentGeneration(stoppingBranch);

    // A mixed shell-Stop → webhook-Start restart answers synchronously, because
    // the daemon itself owns the webhook call. A shell-to-shell restart answers
    // immediately and finishes in the background. Both run the SAME verified
    // hand-off: the Stop phase must prove it settled before a Start credential
    // is minted for the second phase.
    if (startExecution.kind === 'webhook') {
      const stopped = await this.runRestartStopPhase({ branch, params, lifecycleGeneration });
      if (!stopped) return await this.withTenantDatabase(params, () => this.get(id, params));
      return await this.startEnvironment(id, params);
    }

    deferWithTenantContext(
      params,
      async () => {
        const stopped = await this.runRestartStopPhase({ branch, params, lifecycleGeneration });
        if (!stopped) return;
        try {
          await this.startEnvironment(id, params);
        } catch {
          // startEnvironment claims its own lifecycle boundary and records its
          // own failure. Keep executor credentials and provider diagnostics out
          // of this process-level safety log.
          console.error(`[Environment.restart ${branch.name}] Start phase failed`);
        }
      },
      (error) => {
        console.error(
          `[Environment.restart ${branch.name}] Stop phase failed:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    );
    return await this.withTenantDatabase(params, () => this.get(id, params));
  }

  /**
   * Run Restart's Stop phase and decide whether a Start phase is authorized.
   *
   * Process exit is NOT completion: a delegated launcher may exit as soon as it
   * has handed the work off, so the Stop phase runs in request mode and is
   * judged on its authenticated result. Three facts must all hold before the
   * branch may be started again — the result is not superseded, the branch is
   * exactly `stopped`, and its generation is exactly the one that Stop settled.
   * Anything else means another lifecycle action owns the branch now, and its
   * recorded state stays authoritative.
   */
  private async runRestartStopPhase(options: {
    branch: Branch;
    params?: BranchParams;
    lifecycleGeneration: number;
  }): Promise<boolean> {
    const { branch, params, lifecycleGeneration } = options;
    let result: Record<string, unknown> | undefined;
    try {
      result = await this.runEnvironmentExecutor({
        branch,
        action: 'stop',
        params,
        lifecycleGeneration,
      });
    } catch (error) {
      // The executor records its own fenced failure when it got far enough to
      // reach the daemon. A request, spawn, or pre-executor setup failure
      // records nothing at all, so settle the exact generation this restart
      // claimed rather than leaving the branch stuck in `stopping`. A settlement
      // the executor already wrote advanced the generation and makes this a
      // no-op.
      await this.commitEnvironmentLifecycle(
        branch.branch_id,
        {
          status: 'error',
          startup_deadline_at: undefined,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: error instanceof Error ? error.message : 'Unknown error during restart',
          },
          last_error: error instanceof Error ? error.message : 'Unknown error during restart',
        },
        lifecycleGeneration,
        params
      );
      return false;
    }

    const logPrefix = `[Environment.restart ${branch.name}]`;
    if (result?.superseded === true) {
      console.warn(`${logPrefix} Stop was superseded; another lifecycle action owns this branch`);
      return false;
    }
    const stoppedGeneration = result?.lifecycleGeneration;
    if (!Number.isSafeInteger(stoppedGeneration)) {
      // The Stop may well have settled — its response just never proved it. Say
      // so, because the branch is now stopped and the user's Restart quietly
      // will not finish.
      console.warn(`${logPrefix} Stop reported no settled generation; not starting`);
      return false;
    }

    const settled = await this.withTenantDatabase(params, () => this.get(branch.branch_id, params));
    if (
      settled.environment_instance?.status !== 'stopped' ||
      this.requireEnvironmentGeneration(settled) !== stoppedGeneration
    ) {
      console.warn(
        `${logPrefix} Branch is ${settled.environment_instance?.status} at generation ` +
          `${settled.environment_generation}, not the stopped generation ${stoppedGeneration}; not starting`
      );
      return false;
    }
    return true;
  }

  /**
   * Custom method: Nuke environment (destructive operation)
   */
  async nukeEnvironment(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    const branch = await this.loadEnvironmentForAction(id, params, 'nuke branch environments');

    if (!branch.nuke_command) {
      throw new Error('No nuke_command configured for this branch');
    }

    const stoppingBranch = await this.updateEnvironment(
      id,
      { status: 'stopping', startup_deadline_at: undefined },
      params,
      {
        beginLifecycle: true,
        expectedEnvironmentGeneration: this.requireEnvironmentGeneration(branch),
        expectedEnvironmentStatus: branch.environment_instance?.status,
      }
    );
    const lifecycleGeneration = this.requireEnvironmentGeneration(stoppingBranch);

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
        await this.dispatchEnvironmentExecutor({
          branch,
          action: 'nuke',
          params,
          lifecycleGeneration,
        });
        return await this.withTenantDatabase(params, () => this.get(id, params));
      }

      const managedProcess = this.processes.get(id);
      if (managedProcess) {
        this.processes.delete(id);
      }

      return (
        (await this.commitEnvironmentLifecycle(
          id,
          {
            status: 'stopped',
            process: undefined,
            startup_deadline_at: undefined,
            facts: undefined,
            lifecycle_result: undefined,
            access_urls: undefined,
            source_sync: undefined,
            last_health_check: {
              timestamp: new Date().toISOString(),
              status: 'unknown',
              message: 'Environment nuked - all data and volumes destroyed',
            },
          },
          lifecycleGeneration,
          params
        )) ?? (await this.withTenantDatabase(params, () => this.get(id, params)))
      );
    } catch (error) {
      const committed = await this.commitEnvironmentLifecycle(
        id,
        {
          status: 'error',
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message: error instanceof Error ? error.message : 'Unknown error during nuke',
          },
        },
        lifecycleGeneration,
        params
      );

      if (!committed) {
        return await this.withTenantDatabase(params, () => this.get(id, params));
      }

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
  async syncEnvironment(
    id: BranchID,
    params?: BranchParams,
    requestOptions: EnvironmentSyncRequestOptions = {}
  ): Promise<BranchWithZoneAndSessions> {
    const branch = await this.loadEnvironmentForAction(id, params, 'sync branch environments');
    if (!requestOptions.desiredRevision) {
      throw new BadRequest('Environment sync requires an exact desired Git revision');
    }
    const desiredRevision = validateEnvironmentSourceRevision(requestOptions.desiredRevision);
    try {
      await this.renderEnvironmentSyncCommand(branch, desiredRevision, params);
    } catch (error) {
      if (requestOptions.skipIfUnavailable && error instanceof EnvironmentSyncUnavailableError) {
        return branch;
      }
      throw error;
    }

    const requestedByUserId = (requestOptions.requestedByUserId ??
      (params as AuthenticatedParams | undefined)?.user?.user_id ??
      branch.primary_owner_user_id ??
      branch.created_by) as UserID;
    await this.withTenantDatabase(params, () =>
      this.environmentSyncRepo.request({
        branchId: id,
        desiredRevision,
        requestedByUserId,
      })
    );
    await this.publishEnvironmentSyncState(id, params);
    await this.reconcileEnvironmentSync(id, params);
    return this.withTenantDatabase(params, () => this.get(id, params));
  }

  private async renderEnvironmentSyncCommand(
    branch: Branch,
    revision: string,
    params?: BranchParams
  ): Promise<string> {
    const reposService = this.app.service('repos');
    const repo = await this.withTenantDatabase(
      params,
      () => reposService.get(branch.repo_id, params) as Promise<Repo>
    );
    const env = repo.environment;
    if (!env) {
      throw new EnvironmentSyncUnavailableError(
        'Repo has no v2 environment config; nothing to sync'
      );
    }

    // Match the executor's render context and, crucially, pass the
    // environment's facts so a `sync` template referencing `{{env.*}}` resolves
    // to the running environment's real identity.
    const config = this.app.get('config');
    const hostIpAddress = resolveHostIpAddress(config.daemon?.host_ip_address);

    const snapshot = renderBranchSnapshot(
      { slug: repo.slug, remote_url: repo.remote_url, environment: env },
      {
        branch_id: branch.branch_id,
        branch_unique_id: branch.branch_unique_id,
        name: branch.name,
        ref: branch.ref,
        path: branch.path,
        custom_context: branch.custom_context,
        host_ip_address: hostIpAddress,
        base_ref: branch.base_ref,
        ref_type: branch.ref_type,
        facts: {
          ...(branch.environment_instance?.facts ?? {}),
          ...lifecycleResultTemplateFacts(branch.environment_instance?.lifecycle_result),
        },
        sync_revision: revision,
      },
      branch.environment_variant ?? undefined
    );
    if (!snapshot?.sync) {
      throw new EnvironmentSyncUnavailableError(
        `Environment variant "${branch.environment_variant ?? env.default}" defines no sync command`
      );
    }
    return snapshot.sync;
  }

  private async publishEnvironmentSyncState(
    id: BranchID,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    const current = await this.withTenantDatabase(params, () => this.get(id, params));
    emitServiceEvent(this.app, {
      path: 'branches',
      event: 'patched',
      data: current,
      params,
      id,
    });
    return current;
  }

  /** Internal durable worker admission. Intentionally omitted from transport methods. */
  async reconcileEnvironmentSync(id: BranchID, params?: BranchParams): Promise<void> {
    const identity = this.app.get('distributedWorkIdentity') ?? {
      instanceId: `branches-service-${process.pid}`,
      bootId: `branches-service-${process.pid}`,
    };
    const claim = await this.withTenantDatabase(params, () =>
      this.environmentSyncRepo.claim({
        branchId: id,
        claimToken: generateId(),
        identity,
      })
    );
    if (claim.outcome !== 'claimed') return;

    const current = await this.publishEnvironmentSyncState(id, params);
    deferWithTenantContext(
      params,
      () => this.runClaimedEnvironmentSync(id, claim.attempt, params, claim.lifecycle_timeout_ms),
      (error) => {
        console.error(`[Environment.sync ${current.name}] Reconciliation worker failed:`, error);
      }
    );
  }

  private async runClaimedEnvironmentSync(
    id: BranchID,
    attempt: EnvironmentSyncAttempt,
    params?: BranchParams,
    /** Exact budget the durable claim leased; see EnvironmentSyncClaimResult. */
    leasedLifecycleTimeoutMs?: number
  ): Promise<void> {
    let needsReconcile = false;
    try {
      const branch = await this.withTenantDatabase(params, () =>
        this.getCanonicalBranch(id, params)
      );
      const syncCommand = await this.renderEnvironmentSyncCommand(branch, attempt.revision, params);
      if (!attempt.requested_by_user_id) {
        throw new Error('Environment sync attempt has no execution user');
      }

      const execution = await this.resolveEnvironmentCommand(syncCommand, 'sync');
      console.log(
        `🔄 Syncing environment for branch ${branch.name} to ${attempt.revision.slice(0, 12)} via ${execution.kind}`
      );
      let appliedRevision: string;
      if (execution.kind === 'webhook') {
        await this.resolveEnvironmentExecutionAuthority(
          branch,
          params,
          'write',
          attempt.requested_by_user_id as UserID
        );
        const response = await this.executeEnvironmentWebhook({
          url: execution.url,
          branch,
          commandType: 'sync',
          triggeredBy: { user_id: attempt.requested_by_user_id },
          maxBytes: 16 * 1024,
        });
        appliedRevision = validateEnvironmentSourceRevision(
          this.parseEnvironmentWebhookLifecycleResult(response)?.applied_revision,
          'environment sync webhook acknowledgement'
        );
      } else {
        const result = await this.runEnvironmentExecutor({
          branch,
          action: 'sync',
          params,
          syncCommand: execution.command,
          desiredRevision: attempt.revision,
          syncClaimToken: attempt.token,
          lifecycleGeneration: attempt.environment_generation,
          executionUserIdOverride: attempt.requested_by_user_id as UserID,
          ...(leasedLifecycleTimeoutMs !== undefined
            ? { lifecycleTimeoutMsOverride: leasedLifecycleTimeoutMs }
            : {}),
        });
        appliedRevision = validateEnvironmentSourceRevision(
          result?.appliedRevision,
          'environment sync executor acknowledgement'
        );
      }
      if (appliedRevision !== attempt.revision) {
        throw new Error(
          `Environment sync acknowledged ${appliedRevision}, expected ${attempt.revision}`
        );
      }
      const settlement = await this.withTenantDatabase(params, () =>
        this.environmentSyncRepo.complete({
          branchId: id,
          claimToken: attempt.token,
          appliedRevision,
          environmentGeneration: attempt.environment_generation,
        })
      );
      needsReconcile = settlement.outcome === 'settled' && settlement.needs_reconcile;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const settlement = await this.withTenantDatabase(params, () =>
        this.environmentSyncRepo.fail({
          branchId: id,
          claimToken: attempt.token,
          revision: attempt.revision,
          environmentGeneration: attempt.environment_generation,
          message,
        })
      );
      needsReconcile = settlement.outcome === 'settled' && settlement.needs_reconcile;
      console.warn(`[Environment.sync ${id}] ${message}`);
    }

    await this.publishEnvironmentSyncState(id, params);
    if (needsReconcile) await this.reconcileEnvironmentSync(id, params);
  }

  /**
   * Custom method: Check health
   */
  async checkHealth(
    id: BranchID,
    params?: BranchParams,
    internalOptions?: EnvironmentHealthCheckOptions
  ): Promise<BranchWithZoneAndSessions> {
    // `checkHealth` is intentionally not a transport method. Automatic calls
    // originate only from the tenant-aware health monitor, so use the raw
    // canonical loader for that path. Calling `this.get` from a registered
    // Feathers service enters the standard get wrapper even though this custom
    // method itself is invoked directly; a normal successful observation used
    // to create two nested `branches.get` service requests in addition to the
    // monitor's own preflight get. Explicit user/MCP status requests retain the
    // wrapped get and its fail-closed authorization hooks.
    const loadCurrent = () =>
      internalOptions?.intent === 'automatic'
        ? this.getCanonicalBranch(id, params)
        : this.get(id, params);
    const branch = await this.withTenantDatabase(params, loadCurrent);

    const currentStatus = branch.environment_instance?.status;
    if (
      branch.archived ||
      (currentStatus !== 'running' && currentStatus !== 'starting' && currentStatus !== 'error')
    ) {
      return branch;
    }

    if (currentStatus === 'running') {
      await this.reconcileEnvironmentSync(id, params);
    }

    // An explicit status request may still diagnose an errored environment,
    // but an inactive lifecycle must not acquire monitoring ownership or be
    // revived by that observation. Return the observation ephemerally.
    if (currentStatus === 'error') {
      if (internalOptions?.intent === 'automatic') return branch;
      const observation = await this.fetchEnvironmentHealthObservation(
        branch,
        internalOptions?.signal
      );
      if (!observation) return branch;
      return {
        ...branch,
        environment_instance: {
          ...branch.environment_instance,
          status: currentStatus,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: observation.status,
            message: observation.message,
          },
        },
      };
    }

    // Active observations leave the database while doing HTTP. A durable
    // one-observation claim plus lifecycle generation fences the result from a
    // concurrent stop, archive, delete, URL change, daemon, or replica.
    const claimToken = generateId();
    const identity = this.app.get('distributedWorkIdentity') ?? {
      instanceId: `branches-service-${process.pid}`,
      bootId: `branches-service-${process.pid}`,
    };
    const claimResult = await this.withTenantDatabase(params, () =>
      new EnvironmentHealthRepository(this.db).claim({
        branchId: id,
        claimToken,
        leaseDurationMs: ENVIRONMENT.HEALTH_CHECK_TIMEOUT_MS + 5_000,
        identity,
        ignoreCooldown: internalOptions?.intent !== 'automatic',
      })
    );
    if (claimResult.outcome !== 'claimed') {
      return this.withTenantDatabase(params, loadCurrent);
    }

    try {
      const observation = await this.fetchEnvironmentHealthObservation(
        branch,
        internalOptions?.signal
      );
      if (!observation) {
        return this.withTenantDatabase(params, loadCurrent);
      }
      const commitResult = await this.withTenantDatabase(params, () =>
        new EnvironmentHealthRepository(this.db).commit({
          branchId: id,
          claimToken,
          environmentGeneration: claimResult.claim.environment_generation,
          observation,
        })
      );
      const current = await this.withTenantDatabase(params, loadCurrent);
      if (commitResult.outcome === 'committed' && commitResult.stateChanged) {
        emitServiceEvent(this.app, {
          path: 'branches',
          event: 'patched',
          data: current,
          params,
          id,
        });

        if (currentStatus === 'starting' && commitResult.environmentStatus === 'running') {
          await this.reconcileEnvironmentSync(id, params);
        }
      }
      return current;
    } finally {
      await this.withTenantDatabase(params, () =>
        new EnvironmentHealthRepository(this.db).release(id, claimToken)
      ).catch(() => undefined);
    }
  }

  private async fetchEnvironmentHealthObservation(
    branch: Branch,
    cancellationSignal?: AbortSignal
  ): Promise<EnvironmentHealthObservation | null> {
    // A remote environment may not have a reachable address until Start
    // completes. Its typed lifecycle result can therefore publish a dynamic
    // health URL. Provider output is untrusted and must pass the stricter
    // public-destination guard before the DNS-pinned request path uses it.
    // The facts fallback is transitional for instances started by the older
    // lifecycle output protocol and can be removed after adapters migrate.
    const { rawDynamicHealthUrl, healthUrl, isDynamicHealth } = resolveEnvironmentHealthTarget({
      configuredHealthUrl: branch.health_check_url,
      lifecycleResultHealthUrl: branch.environment_instance?.lifecycle_result?.health_url,
      legacyFactHealthUrl: branch.environment_instance?.facts?.health,
    });
    if (!healthUrl) {
      const managedProcess = this.processes.get(branch.branch_id);
      const isProcessAlive = Boolean(managedProcess?.process && !managedProcess.process.killed);
      return {
        status: 'unknown',
        message: rawDynamicHealthUrl
          ? 'Lifecycle health URL points at a disallowed destination; environment health is not observable'
          : isProcessAlive
            ? 'Process running; no health check configured'
            : 'No health check configured',
        recordWhileStarting: true,
      };
    }
    if (!isAllowedHealthCheckUrl(healthUrl)) {
      return {
        status: 'unhealthy',
        message: 'Health check URL blocked by security policy',
        recordWhileStarting: true,
      };
    }

    const controller = new AbortController();
    let timedOut = false;
    const cancel = () =>
      controller.abort(cancellationSignal?.reason ?? new Error('Health check cancelled'));
    if (cancellationSignal?.aborted) return null;
    cancellationSignal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Health check timeout'));
    }, ENVIRONMENT.HEALTH_CHECK_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await (isDynamicHealth ? this.fetchDynamicEnvironmentHealth : fetch)(
        healthUrl,
        {
          signal: controller.signal,
          method: 'GET',
          // Do not follow redirects: an otherwise-allowed health URL could 302 to
          // a link-local metadata endpoint (169.254.169.254), bypassing
          // isAllowedHealthCheckUrl. A 3xx returns not-ok and is reported
          // unhealthy. Mirrors the managed-env webhook fetch.
          redirect: 'manual',
        }
      );
      return {
        status: response.ok ? 'healthy' : 'unhealthy',
        message: response.ok
          ? `HTTP ${response.status}`
          : `HTTP ${response.status} ${response.statusText}`,
        recordWhileStarting: true,
      };
    } catch (error) {
      if (cancellationSignal?.aborted) return null;
      return {
        status: 'unhealthy',
        message: timedOut ? 'Timeout' : error instanceof Error ? error.message : 'Unknown error',
        recordWhileStarting: false,
      };
    } finally {
      clearTimeout(timeout);
      cancellationSignal?.removeEventListener('abort', cancel);
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
    const variantChanged = requestedVariant !== currentVariant;

    const envStatus = branch.environment_instance?.status;

    // Re-rendering rewrites the command strings AND bumps the lifecycle
    // generation, which supersedes any executor currently holding that
    // boundary. During `stopping` that executor is the one settling the branch:
    // its Stop returns superseded, nothing else writes, and the branch is left
    // in `stopping` with no health monitoring, no deadline, and Start refused.
    // A stop in flight is as unsafe to re-render under as a running one.
    if (envStatus === 'stopping') {
      throw new Error(
        'Cannot re-render the environment while it is stopping. Wait for the stop to settle first.'
      );
    }

    if (variantChanged) {
      // Refuse to swap variants while the env is live. The current process
      // was started with the old command strings; replacing them out from
      // under it would leave us unable to stop/restart cleanly. This guard
      // is the authoritative invariant for ALL callers (REST, UI, MCP).
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
      { slug: repo.slug, remote_url: repo.remote_url, environment: env },
      {
        branch_id: branch.branch_id,
        branch_unique_id: branch.branch_unique_id,
        name: branch.name,
        ref: branch.ref,
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
        facts: variantChanged
          ? undefined
          : {
              ...(branch.environment_instance?.facts ?? {}),
              ...lifecycleResultTemplateFacts(branch.environment_instance?.lifecycle_result),
            },
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
      app: snapshot.app,
    });

    // Persist configuration and outgoing runtime clears in ONE row-locked CAS.
    // The earlier implementation cleared runtime observations and patched the
    // new variant in two independent writes after a stale status check. Start
    // could claim the old variant between them, dispatch its command, and then
    // leave the branch stored as `starting` with the new variant's commands.
    const renderedUpdate = {
      environment_variant: snapshot.variant,
      startup_timeout_ms: snapshot.startup_timeout_ms,
      lifecycle_timeout_ms: snapshot.lifecycle_timeout_ms,
      start_command: snapshot.start || undefined,
      stop_command: snapshot.stop || undefined,
      // Coerce absent optional fields to null (not undefined) so switching
      // to a variant that omits a field CLEARS the previous variant's value.
      // deepMerge (repository update) treats null as "write NULL" and
      // undefined as "skip" — undefined would leave a stale command/URL.
      nuke_command: snapshot.nuke ?? null,
      logs_command: snapshot.logs ?? null,
      health_check_url: snapshot.health ?? null,
      app_url: snapshot.app ?? null,
      ...(variantChanged && branch.environment_instance
        ? {
            // These observations belong to the outgoing variant. Null is the
            // repository's explicit nested clear sentinel.
            environment_instance: {
              facts: null,
              lifecycle_result: null,
              access_urls: null,
              source_sync: null,
            },
          }
        : {}),
    } as Partial<Branch>;

    try {
      await this.withTenantDatabase(params, () =>
        this.branchRepo.update(id, renderedUpdate, {
          expectedEnvironmentGeneration: this.requireEnvironmentGeneration(branch),
          expectedEnvironmentStatus: branch.environment_instance?.status,
        })
      );
    } catch (error) {
      if (error instanceof EnvironmentLifecycleConflictError) {
        throw new Conflict(error.message, {
          code: ENVIRONMENT_LIFECYCLE_SUPERSEDED_CODE,
          branch_id: error.branchId,
          expected_environment_generation: error.expectedGeneration,
          current_environment_generation: error.currentGeneration,
          expected_status: error.expectedStatus,
          current_status: error.currentStatus,
        });
      }
      throw error;
    }

    const rendered = await this.withTenantDatabase(params, () => this.get(id, params));
    emitServiceEvent(this.app, {
      path: 'branches',
      event: 'patched',
      data: rendered,
      params,
      id,
    });
    return rendered;
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
