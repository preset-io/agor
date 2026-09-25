import type { ReposService } from './repos.js';
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
  assertAsyncEnvironmentCommandConfig,
  createUserProcessEnvironment,
  ENVIRONMENT,
  ensureBranchCloneDepthAllowed,
  ensureBranchStorageModeAllowed,
  environmentCommandCapabilities,
  getBranchesDir,
  getBranchHomePath,
  getTenantDataRoot,
  PAGINATION,
  resolveBranchStorageConfig,
  resolveMultiTenancyConfig,
  usesAsyncEnvironmentCommands,
} from '@agor/core/config';
import {
  BoardObjectRepository,
  BoardRepository,
  BranchMaintenanceRepository,
  BranchRepository,
  type BranchWithZoneAndSessions,
  BranchWorkspaceOperationRepository,
  CapabilityPolicyRepository,
  EnvironmentCommandRepository,
  type EnvironmentHealthObservation,
  EnvironmentHealthRepository,
  enqueueAfterTenantDatabaseCommit,
  generateId,
  getCurrentTenantId,
  KnowledgeNamespaceRepository,
  lockBranchReferenceMutation,
  RepoRepository,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  shortId,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UsersRepository,
} from '@agor/core/db';
import {
  type EnvironmentLifecycleResult,
  isAllowedDynamicEnvironmentHealthUrl,
  validateEnvironmentLifecycleResult,
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
import { stripGitUrlCredentials } from '@agor/core/git/pure';
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
  BRANCH_ARCHIVE_COMMAND,
  BRANCH_CLEANUP_COMMAND,
  BRANCH_DELETION_COMMAND,
  BRANCH_ENVIRONMENT_CLEARABLE_FIELDS,
  BRANCH_WORKSPACE_OPERATION_BUDGET_MS,
  type BranchCleanAccepted,
  type BranchWorkspaceRequest,
  branchCleanupCommandId,
  branchDeletionCommandId,
  ENVIRONMENT_COMMAND_BUDGET,
  type EnvironmentCommandAction,
  environmentCommandTokenId,
  getBranchCleanupBlockReason,
  getTeammateConfig,
  hasMinimumRole,
  isBranchProvisioningOutcome,
  isBranchProvisioningProvenance,
  isCanonicalTeammateFrameworkRepo,
  isTeammate,
  ROLES,
  resolveRepoCleanupPolicy,
  TEAMMATE_FRAMEWORK_REPO_URL,
} from '@agor/core/types';
import { resolveHostIpAddress } from '@agor/core/utils/host-ip';
import { createPinnedFetch } from '@agor/core/utils/pinned-fetch';
import { isAllowedHealthCheckUrl } from '@agor/core/utils/url';
import { DrizzleService, type Query } from '../adapters/drizzle';
import { matchesExecutorCommandRuntimeScope } from '../auth/executor-runtime-scope.js';
import {
  EXECUTOR_COMMAND_TOKEN_PURPOSE,
  isExecutorSessionTokenPayload,
} from '../auth/executor-session-token.js';
import { buildBranchCreatedAnalyticsProperties } from '../utils/analytics-payloads.js';
import { consumeBranchArchiveDeleteAuthorization } from '../utils/branch-archive-delete-authorization.js';
import {
  ensureCanControlBranchEnvironment,
  hasBranchPermission,
  isSuperAdmin,
} from '../utils/branch-authorization.js';
import { ensureBranchWorkspaceAccess } from '../utils/branch-workspace-path.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { dispatchEnvironmentCommand } from '../utils/environment-command-dispatch.js';
import { resolveDelegatedExecutionHomeKey } from '../utils/executor-delegated-home.js';
import { parseLastMessageTruncationLength } from '../utils/query-params.js';
import { resolveOwnerHomeStore, resolveSandboxStoragePaths } from '../utils/sandbox-context.js';
import { getDaemonUrl, requestExecutor, spawnExecutor } from '../utils/spawn-executor.js';
import { isKnowledgeAdmin } from './knowledge-access.js';
import { issueExecutorCommandToken } from './session-token-service.js';
import type { InternalEnrichmentParams, SessionsService } from './sessions';
import { ensureTeammateKnowledgeNamespace as ensureTeammateKnowledgeNamespaceForBranch } from './teammate-knowledge.js';
import {
  lockTenantAuthorizationFence,
  resolveCurrentTenantAuthorityActor,
} from './tenant-authorization-fence.js';

// Only repos.createBranch owns materialization. A Symbol cannot be supplied by
// REST/WebSocket JSON, unlike a string-keyed "trusted" parameter or ready status.
export const BRANCH_MATERIALIZATION_INTENT = Symbol('branchMaterializationIntent');

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
    [BRANCH_MATERIALIZATION_INTENT]?: true;
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
    'zone_id',
    '$limit',
    '$skip',
    '$sort',
  ]);
  if (Object.keys(query).some((key) => !allowed.has(key))) return false;
  // An empty virtual filter historically goes through the generic adapter;
  // do not turn it into an unrestricted SQL page.
  if (query.zone_id === '') return false;
  for (const key of ['archived', 'board_id', 'repo_id', 'zone_id']) {
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

type EnvironmentInstance = NonNullable<Branch['environment_instance']>;
const MAX_ENVIRONMENT_RESULT_BYTES = 8 * 1024;

function parseStartWebhookResult(options: {
  body: string;
  contentType: string | null;
  truncated: boolean;
}): EnvironmentLifecycleResult | undefined {
  const mediaType = options.contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json' && !mediaType?.endsWith('+json')) return undefined;
  if (!options.body.trim()) return undefined;
  if (options.truncated || Buffer.byteLength(options.body, 'utf8') > MAX_ENVIRONMENT_RESULT_BYTES) {
    throw new Error('environment webhook result exceeds the size limit');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(options.body);
  } catch {
    throw new Error('environment start webhook returned invalid result JSON');
  }
  return validateEnvironmentLifecycleResult(decoded);
}

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

  private async runReportedEnvironmentAction(
    branch: Branch,
    action: EnvironmentCommandAction,
    params?: BranchParams,
    confirmationOf?: string,
    options?: { awaitResult?: boolean }
  ): Promise<BranchWithZoneAndSessions> {
    const config = this.app.get('config');
    assertAsyncEnvironmentCommandConfig(config);
    const asynchronous = usesAsyncEnvironmentCommands(config);
    const commandBudgetMs = asynchronous
      ? ENVIRONMENT_COMMAND_BUDGET.commandMs
      : ENVIRONMENT_COMMAND_BUDGET.standaloneCommandMs;
    const command =
      action === 'start'
        ? branch.start_command
        : action === 'stop'
          ? branch.stop_command
          : branch.nuke_command;
    if (!command) throw new BadRequest(`No ${action} command configured`);
    const execution = await this.resolveEnvironmentCommand(command, action);
    const context =
      execution.kind === 'command'
        ? await this.resolveEnvironmentExecutorContext(branch, params)
        : undefined;
    const commandCredentialMs =
      ENVIRONMENT_COMMAND_BUDGET.launchMs +
      ENVIRONMENT_COMMAND_BUDGET.claimMs +
      commandBudgetMs +
      ENVIRONMENT_COMMAND_BUDGET.cleanupMs +
      ENVIRONMENT_COMMAND_BUDGET.reportMs;
    if (
      context &&
      (config.execution?.session_token_expiration_ms ?? 86_400_000) < commandCredentialMs
    ) {
      throw new BadRequest(
        `execution.session_token_expiration_ms must be at least ${commandCredentialMs} for managed environment commands`
      );
    }
    const userId = ((params as AuthenticatedParams | undefined)?.user?.user_id ??
      branch.created_by) as UserID;
    const attemptId = generateId();
    // Preparation precedes admission; the row lock rechecks the current snapshot.
    const sessionToken = context
      ? await this.withTenantDatabase(params, () =>
          issueExecutorCommandToken(
            this.app,
            environmentCommandTokenId(action, attemptId),
            userId,
            branch.branch_id,
            commandCredentialMs
          )
        )
      : undefined;
    const environment = await this.withTenantDatabase(params, () =>
      new EnvironmentCommandRepository(this.db).admit({
        branch,
        action,
        attemptId,
        userId,
        commandBudgetMs,
        confirmationOf,
      })
    );
    const publish = async () => {
      const current = await this.withTenantDatabase(params, () =>
        this.get(branch.branch_id, params)
      );
      emitServiceEvent(this.app, {
        path: 'branches',
        event: 'patched',
        data: current,
        params,
        id: branch.branch_id,
      });
      return current;
    };
    await publish();
    try {
      if (execution.kind === 'webhook') {
        const scope = { branch_id: branch.branch_id, attempt_id: attemptId, action };
        await this.withTenantDatabase(params, () =>
          new EnvironmentCommandRepository(this.db).report({ ...scope, kind: 'claim' })
        );
        try {
          const result = await this.executeEnvironmentWebhook({
            url: execution.url,
            branch,
            commandType: action,
            triggeredBy: this.extractTriggeredBy(params),
            maxBytes: ENVIRONMENT_COMMAND_BUDGET.outputBytes,
          });
          const lifecycleResult = action === 'start' ? parseStartWebhookResult(result) : undefined;
          await this.withTenantDatabase(params, () =>
            new EnvironmentCommandRepository(this.db).report({
              ...scope,
              kind: 'result',
              outcome: 'succeeded',
              message: `${action} webhook succeeded; remote resource cleanup/readiness is not certified`,
              ...(lifecycleResult ? { lifecycle_result: lifecycleResult } : {}),
              ...(!lifecycleResult && result.body ? { output: result.body } : {}),
              truncated: result.truncated,
            })
          );
        } catch {
          await this.withTenantDatabase(params, () =>
            new EnvironmentCommandRepository(this.db).report({
              ...scope,
              kind: 'result',
              outcome: 'unknown',
              message: `${action} webhook failed or timed out; remote outcome is unknown`,
            })
          );
        }
      } else {
        const payload = {
          command: 'environment.lifecycle' as const,
          sessionToken: sessionToken!,
          daemonUrl: getDaemonUrl(),
          env: context!.env,
          params: {
            branchId: branch.branch_id,
            branchPath: branch.path,
            cwd: branch.path,
            principalBranchAccess: context!.branchFsAccess,
            ...context!.sandboxMounts,
            action,
            startCommand: action === 'start' ? command : undefined,
            stopCommand: action === 'stop' ? command : undefined,
            nukeCommand: action === 'nuke' ? command : undefined,
            attempt: {
              id: attemptId,
              claimDeadline: environment.command_attempt!.claim_deadline,
              commandDeadline: environment.command_attempt!.command_deadline,
              resultDeadline: environment.command_attempt!.result_deadline,
              externalJobDeadlineMs:
                config.execution!.environment_command_job_deadline_ms ??
                ENVIRONMENT_COMMAND_BUDGET.commandMs + ENVIRONMENT_COMMAND_BUDGET.cleanupMs,
            },
          },
        };
        const executorOptions = {
          delegatedHomeKey: context!.delegatedHomeKey,
          preparedEnv: context!.env,
          logPrefix: `[Environment.${action} ${branch.branch_id}]`,
          templateVariables: {
            branch_id: branch.branch_id,
            user_id: userId,
            branch_fs_access: context!.branchFsAccess,
          },
        };
        if (asynchronous) {
          await dispatchEnvironmentCommand(payload, executorOptions);
        } else if (options?.awaitResult) {
          await requestExecutor(payload, {
            ...executorOptions,
            timeoutMs:
              ENVIRONMENT_COMMAND_BUDGET.claimMs +
              commandBudgetMs +
              ENVIRONMENT_COMMAND_BUDGET.cleanupMs +
              ENVIRONMENT_COMMAND_BUDGET.reportMs,
          });
        } else {
          spawnExecutor(payload, executorOptions);
        }
      }
    } catch {
      await this.withTenantDatabase(params, () =>
        new EnvironmentCommandRepository(this.db).dispatchFailed(branch.branch_id, attemptId)
      );
    }
    return publish();
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
  }): Promise<{ body: string; truncated: boolean; status: number; contentType: string | null }> {
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
        contentType: response.headers.get('content-type'),
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
    params?: BranchParams,
    requiredFsAccess: Exclude<BranchFsAccessLevel, 'none'> = 'write'
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
    return this.withTenantDatabase(params, async () => {
      const requestUser = (params as AuthenticatedParams | undefined)?.user;
      const executionUserId = (requestUser?.user_id ??
        branch.primary_owner_user_id ??
        branch.created_by) as UserID;
      // Environment control historically permits tenant admins even when they
      // do not have an explicit branch entry. Preserve that hierarchy, while
      // ordinary Managers remain constrained by the separate filesystem
      // dimension selected in the policy form.
      const branchFsAccess = hasMinimumRole(requestUser?.role, ROLES.ADMIN)
        ? 'write'
        : await ensureBranchWorkspaceAccess(
            this.branchRepo,
            branch,
            executionUserId,
            requestUser?.role as UserRole | undefined,
            'all',
            requiredFsAccess,
            config.execution?.allow_superadmin === true
          );
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

  private async fetchEnvironmentLogsViaExecutor(
    branch: Branch,
    logsCommand: string,
    params?: BranchParams
  ): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
    const capability = environmentCommandCapabilities(this.app.get('config'));
    if (!capability.shellLogs) throw new BadRequest(capability.shellLogsReason);
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
  private async applyBranchCreateDefaults(
    data: Partial<Branch>,
    params?: BranchParams
  ): Promise<Partial<Branch>> {
    const withDefaults: Partial<Branch> = { ...data };
    if (
      withDefaults.base_remote_url !== undefined &&
      withDefaults.base_remote_url !== TEAMMATE_FRAMEWORK_REPO_URL
    ) {
      throw new BadRequest(
        'base_remote_url is restricted to the canonical Agor teammate template repository.'
      );
    }
    for (const key of ['teammate', 'assistant', 'agent']) {
      const value = data.custom_context?.[key];
      if (value && typeof value === 'object' && Object.hasOwn(value, 'localHome')) {
        throw new BadRequest('localHome is server-managed at teammate creation.');
      }
    }
    const config = this.app.get('config');
    if (isTeammate(data)) {
      const repo = await this.app.service('repos').get(data.repo_id!, params);
      if (isCanonicalTeammateFrameworkRepo(repo)) {
        if (!params?.[BRANCH_MATERIALIZATION_INTENT]) {
          throw new BadRequest(
            'Create local teammate homes through repos.createBranch so their files are materialized.'
          );
        }
        const storage = config.execution?.executor_storage?.branch_workspace;
        if (
          (config.execution?.unix_user_mode === 'delegated' ||
            config.execution?.executor_command_template?.trim()) &&
          storage !== 'shared' &&
          storage !== 'persistent-per-branch'
        ) {
          throw new BadRequest(
            'Local teammate homes require operator-configured persistent branch storage.'
          );
        }
        withDefaults.storage_mode = 'clone';
        withDefaults.clone_depth = undefined;
        withDefaults.custom_context = {
          ...data.custom_context,
          teammate: { ...getTeammateConfig(data)!, localHome: true },
        };
      }
    }
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
      if (Object.hasOwn(item, 'cleanup_protected')) {
        throw new BadRequest(
          'Set cleanup protection through the Manager-authorized branch patch after creation'
        );
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
        data.map((item) => this.applyBranchCreateDefaults(item, params))
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
    const withDefaults = await this.applyBranchCreateDefaults(data, params);
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

  private async validateCleanupProtectionWrite(
    branch: Branch,
    data: Partial<Branch>,
    params?: BranchParams
  ): Promise<void> {
    if (!Object.hasOwn(data, 'cleanup_protected')) return;
    if (typeof data.cleanup_protected !== 'boolean')
      throw new BadRequest('cleanup_protected must be a boolean');
    const user = params?.user;
    if (!user) throw new NotAuthenticated('Authentication required');
    const access = await this.branchRepo.resolveUserAccess(branch, user.user_id as UserID);
    if (!access.is_owner && access.can !== 'all') {
      throw new Forbidden('Branch Manager access is required to change cleanup protection');
    }
    const repo = await new RepoRepository(this.db).findById(branch.repo_id);
    if (!repo) throw new NotFound('Repository not found');
    if (!resolveRepoCleanupPolicy(repo.cleanup_policy).allow_branch_protection) {
      throw new Forbidden(
        'Repository policy currently overrides branch protection; the saved preference is preserved'
      );
    }
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
    if (
      getTeammateConfig(currentBranch)?.localHome !== getTeammateConfig(wouldBeBranch)?.localHome
    ) {
      throw new BadRequest('localHome is immutable after teammate creation.');
    }
    for (const key of ['teammate', 'assistant', 'agent']) {
      const value = patchData.custom_context?.[key];
      if (
        value &&
        typeof value === 'object' &&
        Object.hasOwn(value, 'localHome') &&
        (value as Record<string, unknown>).localHome !== getTeammateConfig(currentBranch)?.localHome
      ) {
        throw new BadRequest('localHome is immutable after teammate creation.');
      }
    }
    if (
      getTeammateConfig(currentBranch)?.localHome &&
      (wouldBeBranch.storage_mode !== 'clone' || wouldBeBranch.clone_depth != null)
    ) {
      throw new BadRequest('Local teammate homes require full-history clone storage.');
    }
    if (isTeammate(currentBranch) === isTeammate(wouldBeBranch)) return;

    throw new BadRequest(
      'Branches cannot be converted between teammate and non-teammate types. Create a new branch or AI teammate instead.'
    );
  }

  private async maintainPrimaryTeammateAfterPatch(
    previousBranch: Branch,
    updatedBranch: Branch,
    params?: BranchParams,
    strict = false
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
      if (strict) throw error;
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
    return this.patchWithBoardMovement(id, data, params);
  }

  private async patchWithBoardMovement(
    id: BranchID,
    data: Partial<Branch>,
    params?: BranchParams
  ): Promise<BranchWithZoneAndSessions> {
    if (Object.hasOwn(data, 'board_id')) {
      return runWithTenantDatabaseTransaction(this.db, params?.tenant?.tenant_id, async (db) => {
        // Moving changes effective authority. Serialize with policy writers and
        // re-check the actor and both boards before any metadata/placement writes.
        await lockTenantAuthorizationFence(db, params);
        // Reference reconciliation locks User rows too. Take its lock before
        // resolving/locking the actor, even when custom_context accompanies a move.
        await lockBranchReferenceMutation(db);
        return this.patchBranch(id, data, params, db);
      });
    }
    return this.patchBranch(id, data, params);
  }

  private async patchBranch(
    id: BranchID,
    data: Partial<Branch>,
    params?: BranchParams,
    operationDb?: TenantScopedDatabase
  ): Promise<BranchWithZoneAndSessions> {
    if (
      Object.hasOwn(data, 'provisioning_attempt_id') &&
      !Object.hasOwn(data, 'filesystem_status')
    ) {
      const { provisioning_attempt_id: attemptId, ...provenance } = data;
      const authenticated = params as AuthenticatedParams | undefined;
      const token = authenticated?.authentication?.payload;
      if (
        !params?.provider ||
        !matchesExecutorCommandRuntimeScope(params, 'git.branch.add', id) ||
        typeof attemptId !== 'string' ||
        !attemptId ||
        token?.provisioning_attempt_id !== attemptId ||
        !authenticated?.user ||
        token?.sub !== authenticated.user.user_id ||
        !params.tenant?.tenant_id ||
        token?.tenant_id !== params.tenant.tenant_id ||
        getCurrentTenantId() !== params.tenant.tenant_id
      ) {
        throw new Forbidden(
          'Source resolution requires this tenant, branch and provisioning attempt executor.'
        );
      }
      if (
        !isBranchProvisioningProvenance(provenance) ||
        (provenance.base_source &&
          stripGitUrlCredentials(provenance.base_source.remote_url) !==
            provenance.base_source.remote_url)
      ) {
        throw new BadRequest(
          'Source resolution must contain only valid, credential-free provenance.'
        );
      }
      const branch = await super.get(id, params);
      await ensureBranchWorkspaceAccess(
        this.branchRepo,
        branch,
        authenticated.user.user_id,
        authenticated.user.role as UserRole,
        'all',
        'write',
        this.app.get('config').execution?.allow_superadmin === true
      );
      const saved = await this.branchRepo.recordProvisioningProvenance(id, provenance, attemptId);
      return (await this.branchRepo.enrichWithZoneInfo(saved)) as BranchWithZoneAndSessions;
    }
    if (params?.provider && Object.hasOwn(data, 'provisioning_operation'))
      throw new BadRequest('Provisioning ownership is server-managed.');
    if (params?.provider && Object.hasOwn(data, 'filesystem_status')) {
      const token = (params as AuthenticatedParams).authentication?.payload;
      if (
        !isExecutorSessionTokenPayload(token) ||
        token.purpose !== EXECUTOR_COMMAND_TOKEN_PURPOSE ||
        token.session_id !== 'git.branch.add' ||
        token.branch_id !== id ||
        (token.provisioning_attempt_id !== undefined &&
          token.provisioning_attempt_id !== data.provisioning_attempt_id) ||
        !['ready', 'failed'].includes(String(data.filesystem_status))
      ) {
        throw new BadRequest('filesystem_status is managed by branch materialization.');
      }
    }
    if (
      [
        'workspace_snapshot',
        'workspace_operation',
        'cleanup_last_error',
        'last_cleanup_succeeded_at',
        'last_cleanup_operation_id',
      ].some((key) => Object.hasOwn(data, key))
    )
      throw new BadRequest('Workspace operation state is server-managed');
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
    await this.validateCleanupProtectionWrite(currentBranch, data, params);
    await this.assertCanMutateTeammateKnowledgeConfig(currentBranch, data, params);
    this.assertTeammateKindIsStable(currentBranch, data);
    if (data.filesystem_status === 'ready' || data.filesystem_status === 'failed') {
      const expectedAttemptId = data.provisioning_attempt_id;
      const { provisioning_attempt_id: _attempt, ...acknowledgement } = data;
      if (
        !isBranchProvisioningOutcome(acknowledgement) ||
        (expectedAttemptId !== undefined && typeof expectedAttemptId !== 'string')
      ) {
        throw new BadRequest(
          'Provisioning acknowledgement must contain only a terminal outcome. Patch metadata separately.'
        );
      }
      const result = await this.branchRepo.acknowledgeProvisioningAttempt(
        id,
        acknowledgement,
        expectedAttemptId
      );
      if (!result.applied) {
        console.warn(
          `[branch-provisioning ${shortId(id)}] discarded terminal acknowledgement for a stale or inactive attempt`
        );
      }
      return (await this.branchRepo.enrichWithZoneInfo(result.branch)) as BranchWithZoneAndSessions;
    }

    const oldBoardId = currentBranch.board_id;
    const boardIdProvided = Object.hasOwn(data, 'board_id');
    const newBoardId = data.board_id;
    const boardChanged = boardIdProvided && oldBoardId !== newBoardId;

    if (boardChanged) {
      if (!newBoardId && currentBranch.permission_binding === 'inherit') {
        throw new BadRequest(
          'An inherited branch must belong to a board. Choose a destination board.'
        );
      }
      const targetBoard = newBoardId ? await this.boardRepo.findById(newBoardId) : null;
      if (newBoardId && !targetBoard) throw new NotFound('Destination board not found');
      const current = await resolveCurrentTenantAuthorityActor(operationDb!, params, {
        allowActorlessTrusted: true,
      });
      if (current && !current.service) {
        const policies = new CapabilityPolicyRepository(operationDb!);
        const branchAccess = await policies.resolveBranchAccess(
          currentBranch.branch_id,
          current.user_id
        );
        // Only a branch Manager (or its immutable owner) can transfer its data.
        // Board Editor on both sides is additionally required; visibility alone
        // must never permit attaching a private branch to a more public board.
        if (
          !branchAccess.capabilities.includes('branch.manage') &&
          !isSuperAdmin(current.role, this.app.get('config').execution?.allow_superadmin === true)
        ) {
          throw new Forbidden('Branch Manager access is required to move this branch');
        }
        if (!hasMinimumRole(current.role, ROLES.ADMIN)) {
          for (const boardId of [oldBoardId, newBoardId]) {
            if (!boardId) continue;
            const access = await policies.resolveBoardAccess(boardId, current.user_id);
            if (!access.capabilities.includes('board.attach_branch')) {
              throw new Forbidden(
                'Board Editor or Manager access is required on both boards to move a branch'
              );
            }
          }
        }
      }
    }

    // Call parent patch
    const updatedBranch = (await super.patch(id, data, params)) as Branch;
    await this.maintainPrimaryTeammateAfterPatch(
      currentBranch,
      updatedBranch,
      params,
      boardChanged
    );

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
      const boardObjects = new BoardObjectRepository(operationDb!);

      try {
        // First, check if a board_object already exists
        const existingObject = await boardObjects.findByBranchId(currentBranch.branch_id);

        if (existingObject) {
          // Board object exists - delete it first
          await boardObjects.remove(existingObject.object_id);
          emitServiceEvent(this.app, {
            path: 'board-objects',
            event: 'removed',
            data: existingObject,
            params,
            id: existingObject.object_id,
          });
        }

        // Now create new board_object if board_id is set
        if (newBoardId) {
          const position = await this.computeDefaultBoardPositionForBranch(newBoardId, id, params);
          const createdObject = await boardObjects.create({
            board_id: newBoardId,
            branch_id: currentBranch.branch_id,
            position,
          });
          emitServiceEvent(this.app, {
            path: 'board-objects',
            event: 'created',
            data: createdObject,
            params,
            id: createdObject.object_id,
          });
        }
      } catch (error) {
        console.error(
          `❌ Failed to manage board_objects for branch ${id}:`,
          error instanceof Error ? error.message : String(error)
        );
        // The enclosing move transaction rolls back branch, pointers and placement.
        throw error;
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
    // The adapter's update is a merge too. Use the same authorization and
    // relocation path instead of bypassing canvas and teammate maintenance.
    return this.patchWithBoardMovement(id, data, params);
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

    // Simple inventory pages can correlate zone membership in SQL rather than
    // materializing every matching ID. Preserve the generic adapter fallback.
    if (zoneId && !shouldSqlPageBranchQuery(params?.query)) {
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
      const { limit, skip } = this.pageWindow(query ?? {});
      const page = await this.branchRepo.findPage({
        repo_id: typeof query?.repo_id === 'string' ? (query.repo_id as UUID) : undefined,
        board_id: typeof query?.board_id === 'string' ? (query.board_id as BoardID) : undefined,
        zone_id: typeof query?.zone_id === 'string' ? query.zone_id : undefined,
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
    const retained: unknown = params?.query?.deleteFromFilesystem;
    if (retained === false || retained === 'false') {
      throw new BadRequest(
        'Permanent deletion always removes owned files. Archive to retain data; metadata-only deletion is no longer supported.'
      );
    }
    return this.requestPermanentDeletion(id, params);
  }

  /** Internal callers converge on the same durable operation; no metadata bypass. */
  async removeMetadataWithRealtime(id: BranchID, params?: BranchParams): Promise<Branch> {
    return this.requestPermanentDeletion(id, params);
  }

  /** Public command: input cannot override execution identity, target, or policy. */
  async clean(input: { branchId: BranchID }, params?: BranchParams): Promise<BranchCleanAccepted> {
    if (
      !input ||
      Object.keys(input).some((key) => key !== 'branchId') ||
      typeof input.branchId !== 'string'
    )
      throw new BadRequest('Cleanup accepts only branchId');
    return this.requestWorkspaceOperation(input.branchId, { action: 'clean' }, params);
  }

  /** Explicit retirement always preserves files; it never grants deletion authority. */
  async retireTeammate(id: BranchID, params?: BranchParams): Promise<BranchCleanAccepted> {
    return this.requestWorkspaceOperation(
      id,
      { action: 'archive', filesystemAction: 'preserved' },
      params,
      true
    );
  }

  private async requestWorkspaceOperation(
    id: BranchID,
    request: BranchWorkspaceRequest,
    params?: BranchParams,
    retireTeammate = false
  ): Promise<BranchCleanAccepted> {
    const { action } = request;
    const filesystemAction = request.action === 'clean' ? 'cleaned' : request.filesystemAction;
    const user = params?.user;
    const tenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();
    if (!user || !tenantId)
      throw new NotAuthenticated(
        'Authenticated tenant and branch management authority are required'
      );
    const config = this.app.get('config');
    const needsFiles = filesystemAction !== 'preserved';
    if (
      needsFiles &&
      (config.execution?.unix_user_mode === 'delegated' ||
        config.execution?.executor_command_template ||
        (config.deployment?.mode === 'ha' &&
          config.deployment.ha?.execution_topology === 'external'))
    )
      throw new Conflict(
        'Workspace maintenance requires supported local executor containment; delegated execution is not supported'
      );
    const branch = await this.withTenantDatabase(params, () => this.get(id, params));
    const authorize = async (repository: BranchRepository, current: Branch) => {
      if (needsFiles)
        return ensureBranchWorkspaceAccess(
          repository,
          current,
          user.user_id,
          user.role as UserRole,
          'all',
          'write',
          config.execution?.allow_superadmin === true
        );
      const access = await repository.resolveUserAccess(current, user.user_id as UserID);
      if (
        !hasBranchPermission(
          current,
          user.user_id as UserID,
          access.is_owner,
          'all',
          user.role as UserRole,
          config.execution?.allow_superadmin === true,
          access.can
        )
      )
        throw new Forbidden('Branch Manager authority is required to archive');
    };
    id = branch.branch_id;
    await this.withTenantDatabase(params, () => authorize(this.branchRepo, branch));
    const repo = await this.withTenantDatabase(params, () =>
      new RepoRepository(this.db).findById(branch.repo_id)
    );
    if (!repo || (needsFiles && !repo.local_path))
      throw new Conflict('Authoritative base repository location is unavailable');
    const policy =
      filesystemAction === 'cleaned' ? resolveRepoCleanupPolicy(repo.cleanup_policy) : undefined;
    const validate = async (tx: import('@agor/core/db').Database) => {
      const repository = new BranchRepository(tx);
      const current = await repository.findById(id);
      if (!current || current.path !== branch.path || current.repo_id !== branch.repo_id)
        throw new Conflict('Branch location changed; refresh before maintenance');
      await authorize(repository, current);
      if (policy) {
        const currentRepo = await new RepoRepository(tx).findById(current.repo_id);
        const reason = getBranchCleanupBlockReason(
          currentRepo?.cleanup_policy,
          current.cleanup_protected ?? false
        );
        if (reason) throw new Conflict(reason);
        if (!isDeepStrictEqual(resolveRepoCleanupPolicy(currentRepo?.cleanup_policy), policy))
          throw new Conflict('Cleanup policy changed; refresh before maintenance');
      }
    };
    if (policy) {
      const reason = getBranchCleanupBlockReason(policy, branch.cleanup_protected ?? false);
      if (reason) throw new Conflict(reason);
    }
    const admission = retireTeammate
      ? await runWithTenantDatabaseTransaction(this.db, tenantId, async (db) => {
          // Retirement clears User preferences under reference/Branch locks.
          // Enter the same authority fence as board designation BEFORE any of
          // those locks, so its human-actor lock cannot form the reverse edge.
          // Only this metadata admission belongs in the transaction, not the
          // subsequent session archival or external workspace work.
          await lockTenantAuthorizationFence(db, params);
          return new BranchMaintenanceRepository(db).claimForTeammateRetirement(
            id,
            user.user_id as UserID,
            validate
          );
        })
      : await this.withTenantDatabase(params, () =>
          new BranchMaintenanceRepository(this.db).claim(
            id,
            'cleanup',
            user.user_id as UserID,
            validate
          )
        );
    if (!admission.acquired)
      throw new Conflict('Branch maintenance is already active or requires reconciliation');
    let invocationStarted = false;
    try {
      const now = new Date();
      await this.withTenantDatabase(params, () =>
        new BranchWorkspaceOperationRepository(this.db).prepare(
          admission.claim,
          {
            operation_id: admission.claim.operation_id,
            action,
            filesystem_action: filesystemAction,
            status: 'accepted',
            requested_by: user.user_id as UserID,
            requested_at: now.toISOString(),
            deadline_at: new Date(
              now.getTime() + BRANCH_WORKSPACE_OPERATION_BUDGET_MS
            ).toISOString(),
          },
          { repo_id: branch.repo_id, path: branch.path, repo_path: repo.local_path ?? '', policy }
        )
      );
      const context = needsFiles
        ? await this.resolveEnvironmentExecutorContext(branch, params)
        : undefined;
      if (needsFiles) {
        // Read-only executor preflight. No daemon filesystem access or fallback mkdir.
        const statusToken = await this.withTenantDatabase(params, () =>
          issueExecutorCommandToken(this.app, 'branch-filesystem-status', user.user_id, id)
        );
        const status = await requestExecutor(
          {
            command: 'branch.filesystem.status',
            sessionToken: statusToken,
            daemonUrl: getDaemonUrl(),
            params: { branchId: id },
          },
          {
            preparedEnv: context!.env,
            templateVariables: { branch_id: id, user_id: user.user_id, branch_fs_access: 'write' },
          }
        );
        if (
          !status.success ||
          !status.data ||
          typeof status.data !== 'object' ||
          (status.data as { exists?: boolean }).exists !== true
        )
          throw new Conflict('Branch workspace is unavailable; nothing was cleaned');
      }
      if (action === 'archive') {
        await this.withTenantDatabase(params, () =>
          new BranchWorkspaceOperationRepository(this.db).archiveMetadata(admission.claim)
        );
        const sessionsService = this.app.service('sessions') as unknown as SessionsService;
        await this.withTenantDatabase(params, () =>
          sessionsService.archiveBranchSessions(id, { ...params, provider: undefined })
        );
      }
      if (!needsFiles) {
        await this.withTenantDatabase(params, () =>
          new BranchWorkspaceOperationRepository(this.db).finishPreserve(admission.claim)
        );
        this.closeBranchTerminals(id, String(tenantId));
        const current = await this.withTenantDatabase(params, () => this.get(id, params));
        emitServiceEvent(this.app, {
          path: 'branches',
          event: 'patched',
          data: current,
          params,
          id,
        });
        return { branch_id: id, operation_id: admission.claim.operation_id, status: 'accepted' };
      }
      const executionId = await this.withTenantDatabase(params, () =>
        new BranchMaintenanceRepository(this.db).beginExecution(admission.claim)
      );
      invocationStarted = true;
      const sessionToken = await this.withTenantDatabase(params, () =>
        issueExecutorCommandToken(this.app, branchCleanupCommandId(executionId), user.user_id, id)
      );
      const dispatch = () => {
        this.closeBranchTerminals(id, String(tenantId));
        spawnExecutor(
          {
            command: action === 'clean' ? BRANCH_CLEANUP_COMMAND : BRANCH_ARCHIVE_COMMAND,
            daemonUrl: getDaemonUrl(),
            sessionToken,
            params: {
              branchId: id,
              operationId: admission.claim.operation_id,
              generation: admission.claim.generation,
              executionId,
              ...(filesystemAction === 'deleted'
                ? {
                    filesystemAction: 'deleted' as const,
                    removal: {
                      branchPath: branch.path,
                      repoPath: repo.local_path!,
                      branchesRoot: getBranchesDir(tenantId),
                      storageMode: branch.storage_mode ?? 'worktree',
                    },
                  }
                : {
                    filesystemAction: 'cleaned' as const,
                    cwd: branch.path,
                    principalBranchAccess: 'write' as const,
                    ...context!.sandboxMounts,
                    cleanup: { command: policy!.command },
                  }),
              deadlineAt: now.getTime() + BRANCH_WORKSPACE_OPERATION_BUDGET_MS,
            },
          },
          {
            preparedEnv: context!.env,
            logPrefix: '[Branch workspace maintenance]',
            templateVariables: { branch_id: id, user_id: user.user_id, branch_fs_access: 'write' },
          }
        );
      };
      if (!enqueueAfterTenantDatabaseCommit(dispatch)) dispatch();
      const current = await this.withTenantDatabase(params, () => this.get(id, params));
      emitServiceEvent(this.app, { path: 'branches', event: 'patched', data: current, params, id });
      return { branch_id: id, operation_id: admission.claim.operation_id, status: 'accepted' };
    } catch (error) {
      // Once dispatch intent exists, an exception is not absence proof.
      if (!invocationStarted)
        await this.withTenantDatabase(params, () =>
          new BranchWorkspaceOperationRepository(this.db).failBeforeExecution(admission.claim)
        );
      throw error;
    }
  }

  /** Best-effort attachment closure shared by archive and permanent deletion. */
  private closeBranchTerminals(branchId: BranchID, tenantId: string): void {
    const event = { tenantId, branchId };
    this.app.emit?.('terminal:close-branch', event);
    this.app.io?.serverSideEmit?.('terminal:close-branch', event);
  }

  private async requestPermanentDeletion(id: BranchID, params?: BranchParams): Promise<Branch> {
    const user = (params as AuthenticatedParams | undefined)?.user;
    if (!user) throw new NotAuthenticated('Authenticated branch management authority is required');
    const config = this.app.get('config');
    const externalExecutor =
      config.execution?.unix_user_mode === 'delegated' ||
      Boolean(config.execution?.executor_command_template) ||
      (config.deployment?.mode === 'ha' && config.deployment.ha?.execution_topology === 'external');
    if (externalExecutor && config.execution?.delegated_branch_deletion !== true) {
      throw new Conflict(
        'Permanent deletion requires a supported local storage executor. Delegated/external deletion containment is not available.'
      );
    }
    const branch = await this.withTenantDatabase(params, () => this.get(id, params));
    const tenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();
    if (!tenantId) throw new Forbidden('Deletion tenant context is required');
    await this.withTenantDatabase(params, () =>
      ensureBranchWorkspaceAccess(
        this.branchRepo,
        branch,
        user.user_id,
        user.role as UserRole,
        'all',
        'write',
        config.execution?.allow_superadmin === true
      )
    );
    const context = await this.resolveEnvironmentExecutorContext(branch, params);
    const repo = await this.withTenantDatabase(params, () =>
      new RepoRepository(this.db).findById(branch.repo_id)
    );
    if (!repo?.local_path)
      throw new Conflict('Authoritative base repository location is unavailable');
    const admission = await this.withTenantDatabase(params, () =>
      new BranchMaintenanceRepository(this.db).claim(
        branch.branch_id,
        'delete',
        user.user_id as UserID,
        async (tx) => {
          const repository = new BranchRepository(tx);
          const current = await repository.findById(branch.branch_id);
          if (
            !current ||
            current.path !== branch.path ||
            current.ref !== branch.ref ||
            current.repo_id !== branch.repo_id
          )
            throw new Conflict('Branch location changed; refresh before deleting');
          await ensureBranchWorkspaceAccess(
            repository,
            current,
            user.user_id,
            user.role as UserRole,
            'all',
            'write',
            config.execution?.allow_superadmin === true
          );
        }
      )
    );
    if (admission.acquired) {
      const executionId = await this.withTenantDatabase(params, () =>
        new BranchMaintenanceRepository(this.db).beginExecution(admission.claim)
      );
      const sessionToken = await this.withTenantDatabase(params, () =>
        issueExecutorCommandToken(
          this.app,
          branchDeletionCommandId(executionId),
          user.user_id,
          branch.branch_id
        )
      );
      const dispatch = () => {
        this.closeBranchTerminals(branch.branch_id, String(tenantId));
        // No daemon waits for completion; the executor drives scoped DB steps.
        // Unacknowledged dispatch is diagnosed by runtime reconciliation.
        spawnExecutor(
          {
            command: BRANCH_DELETION_COMMAND,
            daemonUrl: getDaemonUrl(),
            sessionToken,
            params: {
              branchId: branch.branch_id,
              operationId: admission.claim.operation_id,
              generation: admission.claim.generation,
              executionId,
              branchPath: branch.path,
              branchesRoot: getBranchesDir(tenantId),
              repoPath: repo.local_path,
              branchHome: getBranchHomePath(branch.branch_id, tenantId),
              tenantDataRoot: getTenantDataRoot(tenantId),
              storageMode: branch.storage_mode ?? 'worktree',
              verifyDelegatedStorageMounts: externalExecutor,
            },
          },
          {
            preparedEnv: context.env,
            logPrefix: `[Branch.delete ${branch.branch_id}]`,
            templateVariables: {
              branch_id: branch.branch_id,
              user_id: user.user_id,
              branch_fs_access: context.branchFsAccess,
            },
          }
        );
      };
      if (!enqueueAfterTenantDatabaseCommit(dispatch)) dispatch();
    }
    const current = await this.withTenantDatabase(params, () => this.get(branch.branch_id, params));
    emitServiceEvent(this.app, {
      path: 'branches',
      event: 'patched',
      data: current,
      params,
      id: branch.branch_id,
    });
    return current;
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
    if (metadataAction === 'delete') {
      if (filesystemAction !== 'deleted')
        throw new BadRequest(
          'Permanent deletion removes all owned files; select Delete completely or archive instead.'
        );
      return this.requestPermanentDeletion(id, params);
    }

    await this.requestWorkspaceOperation(id, { action: 'archive', filesystemAction }, params);
    return this.withTenantDatabase(params, () => this.get(id, params));
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

    const requestUser = params?.user;
    if (!requestUser) throw new NotAuthenticated('Authentication required');
    await this.withTenantDatabase(params, () =>
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
    const reposService = this.app.service('repos') as unknown as ReposService;
    const admit = async () => {
      return reposService.retryBranchProvisioning(branch.branch_id, params, true);
    };
    const restored = boardIdExplicitlyProvided
      ? await runWithTenantDatabaseTransaction(this.db, params?.tenant?.tenant_id, async (db) => {
          // Use the same lock order as board movement before reading placement.
          // A preflight comparison can race a move and silently ignore the
          // requested destination. Real moves still use patch's authorization,
          // commit-deferred events and eviction; refused admission rolls it back.
          await lockTenantAuthorizationFence(db, params);
          await lockBranchReferenceMutation(db);
          const current = await this.get(id, params);
          if (current.board_id !== options?.boardId) {
            await this.patch(id, { board_id: options?.boardId }, params);
          }
          // Same-board requests still undergo locked recovery authorization and
          // validation, but must not emit an ACL patch that disconnects the
          // requesting socket before the outer unarchive acknowledgement.
          return admit();
        })
      : await admit();
    await this.withTenantDatabase(params, () =>
      this.maintainPrimaryTeammateAfterPatch(branch, restored, params)
    );

    // Ensure a board object exists when unarchiving to a board.
    // Older archived branches may have had their board object removed.
    const targetBoardId = restored.board_id;
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

    // Restore only sessions whose independent cause was branch archival.
    const sessionsService = this.app.service('sessions') as unknown as SessionsService;
    const unarchivedSessions = await this.withTenantDatabase(params, () =>
      sessionsService.unarchiveBranchSessions(id, { ...params, provider: undefined })
    );

    console.log(`✅ Unarchived branch ${branch.name} and ${unarchivedSessions.count} session(s)`);
    return this.withTenantDatabase(params, () => this.get(id, params));
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

  /** Internal helper for health observations and local lifecycle transitions. */
  async updateEnvironment(
    id: BranchID,
    environmentUpdate: BranchEnvironmentUpdate,
    params?: BranchParams,
    internalOptions?: { beginLifecycle?: boolean }
  ): Promise<BranchWithZoneAndSessions> {
    const existing = await this.withTenantDatabase(params, () => this.get(id, params));

    const updatedEnvironment = {
      ...existing.environment_instance,
      ...environmentUpdate,
    } as EnvironmentInstance;

    // Keep explicit clears in the repository patch. Omitting a field means
    // preserve during its atomic deep merge, not delete. The normalized copy
    // remains tombstone-free for state-change comparison.
    const environmentPatch = { ...updatedEnvironment };
    for (const key of BRANCH_ENVIRONMENT_CLEARABLE_FIELDS) {
      if (
        Object.hasOwn(environmentUpdate, key) &&
        (environmentUpdate[key] === undefined || environmentUpdate[key] === null)
      ) {
        delete updatedEnvironment[key];
        environmentPatch[key] = undefined;
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

    // Remove timestamps for comparison - create new objects without timestamp
    if (oldState?.last_health_check) {
      const { timestamp, ...healthCheck } = oldState.last_health_check;
      oldState.last_health_check = healthCheck as typeof oldState.last_health_check;
    }
    if (newState?.last_health_check) {
      const { timestamp, ...healthCheck } = newState.last_health_check;
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
      return this.withTenantDatabase(params, () =>
        this.branchRepo.update(
          id,
          { environment_instance: environmentPatch },
          { preserveUpdatedAt: true }
        )
      );
    }

    const branch = internalOptions?.beginLifecycle
      ? await this.withTenantDatabase(params, async () => {
          await this.branchRepo.update(
            id,
            {
              environment_instance: environmentPatch,
              updated_at: new Date().toISOString(),
            },
            { invalidateEnvironmentObservation: true }
          );
          return this.get(id, params);
        })
      : await this.withTenantDatabase(params, () =>
          this.patch(
            id,
            {
              environment_instance: environmentPatch,
              updated_at: new Date().toISOString(),
            },
            params
          )
        );

    // this.patch() calls the raw implementation and bypasses Feathers event
    // dispatch, so the patched event is not automatically emitted. Emit it
    // manually — with a correctly-shaped publish context carrying the tenant
    // params — so the realtime publish handler can route it to the tenant's
    // browser clients. Background transitions (health-monitor start→running,
    // executor stop/nuke→stopped) fire outside any request scope, so the tenant
    // must come from `params` here or the event is suppressed and the
    // env card spinner hangs until a manual refresh. See #1750 and
    // emitServiceEvent for why the hook shape matters.
    emitServiceEvent(this.app, {
      path: 'branches',
      event: 'patched',
      data: branch,
      params,
      id,
    });

    return branch;
  }

  /**
   * Custom method: Start environment
   */
  async startEnvironment(
    id: BranchID,
    params?: BranchParams,
    confirmationOf?: string
  ): Promise<BranchWithZoneAndSessions> {
    const branch = await this.loadEnvironmentForAction(id, params, 'start branch environments');
    return this.runReportedEnvironmentAction(branch, 'start', params, confirmationOf);
  }

  /**
   * Custom method: Stop environment
   */
  async stopEnvironment(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    const branch = await this.loadEnvironmentForAction(id, params, 'stop branch environments');
    if (branch.stop_command) {
      return this.runReportedEnvironmentAction(branch, 'stop', params);
    }

    await this.updateEnvironment(id, { status: 'stopping' }, params, { beginLifecycle: true });

    try {
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

      return await this.updateEnvironment(
        id,
        {
          status: 'stopped',
          process: undefined,
          health_url: undefined,
          access_urls: branch.app_url ? [{ name: 'App', url: branch.app_url }] : undefined,
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
    if (usesAsyncEnvironmentCommands(this.app.get('config')))
      throw new BadRequest(
        'Restart is unavailable for asynchronous environments. Request Stop, inspect its outcome, then explicitly Start.'
      );

    if (!branch.start_command) {
      throw new Error('No start command configured for this branch');
    }

    if (branch.environment_instance?.status !== 'running') {
      return await this.startEnvironment(id, params);
    }

    if (!branch.stop_command) {
      await this.stopEnvironment(id, params);
      return await this.startEnvironment(id, params);
    }

    const stopped = await this.runReportedEnvironmentAction(branch, 'stop', params, undefined, {
      awaitResult: true,
    });
    if (
      stopped.environment_instance?.status !== 'stopped' ||
      stopped.environment_instance.last_command?.status !== 'succeeded'
    ) {
      throw new Error('Restart stopped because the Stop command did not complete successfully');
    }
    return this.startEnvironment(id, params);
  }

  /**
   * Custom method: Nuke environment (destructive operation)
   */
  async nukeEnvironment(id: BranchID, params?: BranchParams): Promise<BranchWithZoneAndSessions> {
    const branch = await this.loadEnvironmentForAction(id, params, 'nuke branch environments');
    return this.runReportedEnvironmentAction(branch, 'nuke', params);
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
    let branch = await this.withTenantDatabase(params, loadCurrent);
    if (
      branch.environment_instance?.command_attempt &&
      (await this.withTenantDatabase(params, () =>
        new EnvironmentCommandRepository(this.db).expire(id)
      ))
    ) {
      branch = await this.withTenantDatabase(params, loadCurrent);
      emitServiceEvent(this.app, { path: 'branches', event: 'patched', data: branch, params, id });
    }

    const currentStatus = branch.environment_instance?.status;
    if (
      branch.archived ||
      (currentStatus !== 'running' && currentStatus !== 'starting' && currentStatus !== 'error')
    ) {
      return branch;
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
    const dynamicHealthUrl = branch.environment_instance?.health_url;
    const healthUrl = dynamicHealthUrl ?? branch.health_check_url;
    if (!healthUrl) {
      const managedProcess = this.processes.get(branch.branch_id);
      const isProcessAlive = Boolean(managedProcess?.process && !managedProcess.process.killed);
      return {
        status: 'unknown',
        message: isProcessAlive
          ? 'Process running; no health check configured'
          : 'No health check configured',
        recordWhileStarting: true,
      };
    }
    const isDynamicHealth = dynamicHealthUrl !== undefined;
    if (
      isDynamicHealth
        ? !isAllowedDynamicEnvironmentHealthUrl(healthUrl)
        : !isAllowedHealthCheckUrl(healthUrl)
    ) {
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
        message: timedOut
          ? 'Timeout'
          : isDynamicHealth
            ? 'Health endpoint unreachable'
            : error instanceof Error
              ? error.message
              : 'Unknown error',
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
