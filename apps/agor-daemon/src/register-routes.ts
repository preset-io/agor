/**
 * Authentication & Custom REST Routes Registration
 *
 * Registers authentication configuration, token refresh, custom REST
 * endpoints (prompt, stop, fork, spawn, upload, etc.), and the error handler.
 * Extracted from index.ts for maintainability.
 */

import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import type { SessionInitializationRequest } from '@agor/core/api';
import {
  type AgorConfig,
  ENV_VAR_CONSTRAINTS,
  isEnvVarAllowed,
  type ResolvedDeploymentConfig,
  type ResolvedExternalLaunchProvider,
  requireDeploymentId,
  resolveBranchStorageConfig,
  resolveIdentityAuthority,
  resolveMultiTenancyConfig,
  resolvePasswordPolicyRequirements,
  resolveSdkWatchdogConfig,
  resolveTeammateFrameworkRepoUrl,
  resolveTenantContext,
} from '@agor/core/config';
import {
  assertTenantWritable,
  BoardCommentsRepository,
  BoardRepository,
  BranchRepository,
  bindRepositoryToTenantUnitOfWork,
  generateId,
  getCurrentTenantId,
  getMCPEgressGatewayMode,
  MCPCatalogCandidateRepository,
  MCPServerRepository,
  MessagesRepository,
  MISSING_TASK_ACTOR_ERROR,
  resolveMcpMemberPolicy,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  ScheduleRepository,
  type SessionRepository,
  setMCPEgressGatewayMode,
  setMcpMemberPolicy,
  shortId,
  TaskRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UploadRepository,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { MANAGED_ENV_EXECUTION_MODE_DEFAULT } from '@agor/core/environment/webhook';
import type { Application } from '@agor/core/feathers';
import {
  AuthenticationService,
  BadRequest,
  Conflict,
  errorHandler,
  Forbidden,
  LocalStrategy,
  NotAuthenticated,
  NotFound,
} from '@agor/core/feathers';
import { isMCPServerUsableBy, MCPServerNotUsableError } from '@agor/core/mcp';
import type {
  AuthenticatedParams,
  BoardComment,
  BoardCommentReposition,
  BranchArchiveOrDeleteOptions,
  HookContext,
  MCPMemberPolicy,
  MCPMemberPolicySetting,
  MCPServer,
  MCPServerID,
  Message,
  MessageID,
  MessageSource,
  Params,
  ScheduleID,
  Session,
  SessionID,
  SessionMCPServer,
  SessionStopResult,
  StreamingEventType,
  Task,
  TaskID,
  TaskMetadata,
  User,
  UserID,
  UUID,
} from '@agor/core/types';
import {
  boardCommentZoneParentObjectKey,
  hasMinimumRole,
  isBranchArchiveOrDeleteOptions,
  isCanonicalFullUuid,
  isTaskPendingDispatch,
  MCP_MEMBER_POLICIES,
  MCP_MEMBER_POLICY_CHANGED_EVENT,
  MessageRole,
  ROLES,
  SessionStatus,
  TaskStatus,
} from '@agor/core/types';
import { isNotFoundError } from '@agor/core/utils/errors';
import type { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  gatewaySlackUploadExecutorCommandId,
  uploadMaterializeExecutorCommandId,
} from './auth/executor-command-ids.js';
import { getOrCreateExecutorConnectionRevocationFence } from './auth/executor-connection-admission.js';
import {
  authenticatedTaskExecutorRuntimeScope,
  matchesExecutorCommandRuntimeScope,
  matchesTaskExecutorRuntimeScope,
} from './auth/executor-runtime-scope.js';
import { createIssueBrowserTokensHook } from './auth/issue-browser-tokens-hook.js';
import { createLaunchAuthService, resolvePublicLaunchAuthSettings } from './auth/launch-auth.js';
import { createRefreshTokenService } from './auth/refresh-token-service.js';
import {
  issueRuntimeToken,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
} from './auth/runtime-tokens.js';
import {
  assertAuthenticationUserAuthMetadata,
  authCredentialGenerationClaim,
  authTokenIssuedAtClaim,
} from './auth/token-invalidation.js';
import type {
  BoardsServiceImpl,
  BranchesServiceImpl,
  ReposServiceImpl,
  SessionsServiceImpl,
  TasksServiceImpl,
} from './declarations.js';
import { registerExecutorResponseRoutes } from './executor-response-channel.js';
import { hasClaudeSubscriptionOAuthCapability } from './ha-support.js';
import { probeDatabase, probePendingMigrations } from './health/db-probe.js';
import {
  authenticatedHealthDb,
  healthMigrations,
  healthStatus,
  publicHealthDb,
} from './health/payload.js';
import { registerHealthProbeRoutes } from './health/routes.js';
import { issueMCPEgressCapability } from './mcp-egress/capability.js';
import {
  coordinateMCPEgressRolloutChange,
  coordinateSessionMCPRevocation,
} from './mcp-egress/coordination.js';
import {
  MCPEgressGateway,
  mcpEgressEligibility,
  mcpEgressMaterialHash,
  mcpOAuthGrantIdentity,
  projectMCPServerForExecutor,
  resolveMCPEgressEnvironment,
} from './mcp-egress/gateway.js';
import { createMCPEgressHttpHandler } from './mcp-egress/http-handler.js';
import { validateMCPEgressRolloutChange } from './mcp-egress/rollout.js';
import { createFeathersMetricsHook } from './metrics/feathers.js';
import { getDaemonMetrics } from './metrics/index.js';
import { resolveForUserIdWithGate } from './oauth-auth-helpers.js';
import {
  deliverPermissionDecision,
  type PermissionDecisionSubmission,
} from './permissions/deliver-permission-decision.js';
import { publicBoardCommentRepositionInput } from './services/board-comments.js';
import type { GatewayService } from './services/gateway.js';
import { createMCPCatalogConnectService } from './services/mcp-catalog-connect.js';
import { isMCPOAuthGrantAuthorizedForServer } from './services/mcp-oauth-grant-authority.js';
import {
  ScheduleBusyError,
  ScheduleNotReadyError,
  type SchedulerService,
} from './services/scheduler.js';
import { runSessionInitializationStages } from './services/session-initialization.js';
import {
  lockTenantAuthorizationFence,
  resolveCurrentTenantAuthorityActor,
} from './services/tenant-authorization-fence.js';
import type { TerminalsService } from './services/terminals.js';
import { createUserApiKeysService } from './services/user-api-keys.js';
import {
  isAuthenticationUserLookup,
  markAuthenticationUserLookup,
  markLocalAuthenticationLookup,
} from './services/users.js';
import { resolveWebTerminalCapability } from './terminal-capability.js';
import { forceFailUnverifiedTask } from './termination-coordinator.js';
import { createFeathersTracingHook } from './tracing/feathers.js';
import {
  REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE,
  requireActiveAgenticTool,
} from './utils/agentic-tool-runtime.js';
import { appendSystemMessage } from './utils/append-system-message.js';
import { buildAuthRateLimitKey } from './utils/auth-rate-limit-key.js';
import {
  ensureMinimumRole,
  registerAuthenticatedRoute as registerAuthenticatedRouteBase,
  requireMinimumRole,
} from './utils/authorization.js';
import { authorizeBranchArchiveDelete } from './utils/branch-archive-delete-authorization.js';
import {
  cacheBranchAccess,
  checkSessionOwnerOrAdmin,
  ensureBranchPermission,
  loadScheduleAndBranch,
  resolveSessionPromptAccess,
  sessionPromptDeniedMessage,
} from './utils/branch-authorization.js';
import { buildInitialUserMessage } from './utils/build-initial-user-message.js';
import { buildPrompterPrefixedPrompt } from './utils/build-prompter-prefix.js';
import { buildDatabaseHealthInfo } from './utils/database-health-diagnostics.js';
import { emitServiceEvent } from './utils/emit-service-event.js';
import {
  redactMCPServerSecrets,
  shouldExposeMCPServerSecrets,
} from './utils/mcp-header-secrets.js';
import { canConfigureMcpServers } from './utils/mcp-server-authorization.js';
import { patchUnlessRemoved } from './utils/patch-unless-removed.js';
import { resolvePromptOrigin } from './utils/prompt-origin.js';
import {
  buildPromptTaskMetadata,
  type InternalPromptTaskMetadataInput,
} from './utils/prompt-task-metadata.js';
import { ensureScheduleRunsAsCaller } from './utils/schedule-hooks.js';
import {
  deferWithSessionQueueTenantScope,
  runWithSessionQueueTenantScope,
} from './utils/session-queue-tenant-scope.js';
import { stopSessionPreserveQueue } from './utils/session-stop.js';
import {
  sessionCanStartTask,
  shouldReconcileSessionPromptState,
} from './utils/session-task-state.js';
import { findActiveTasksForSession } from './utils/session-tasks.js';
import { type SessionTurnLocks, withSessionTurnLock } from './utils/session-turn-lock.js';
import { bindStopRouteRepositories } from './utils/stop-route-repositories.js';
import { formatStructuredLog, structuredLogErrorCode } from './utils/structured-log.js';
import {
  shouldReconcileStableInitialMessage,
  stableInitialMessageIdForTask,
} from './utils/task-initial-message.js';
import { buildTaskLaunchState } from './utils/task-launch-state.js';
import { normalizeMessageSource, runExistingTask } from './utils/task-runner.js';
import { isAgenticToolEnabledForTenant } from './utils/tenant-agentic-tool-validation.js';
import {
  createTenantDatabaseScopeAroundHook,
  createTenantWriteAdmissionAroundHook,
  createTenantWriteGateAroundHook,
  deferWithTenantContext,
  withFreshTenantWrite,
} from './utils/tenant-db-scope.js';
import {
  createUploadMiddleware,
  enforceTotalUploadSize,
  getUploadLimits,
  type StagedMulterFile,
} from './utils/upload.js';
import { getUploadStagingStore } from './utils/upload-staging.js';
import { WidgetResolutionStore } from './widgets/resolution-store.js';
import { resolveWidget } from './widgets/submissions.js';

const DEBUG_AUTH_EVENTS =
  process.env.AGOR_DEBUG_AUTH_EVENTS === '1' || process.env.DEBUG?.includes('auth-events');

function authEventDebug(...args: unknown[]): void {
  if (DEBUG_AUTH_EVENTS) {
    console.debug(...args);
  }
}

const DEBUG_TASK_QUEUE =
  process.env.AGOR_DEBUG_TASK_QUEUE === '1' || process.env.DEBUG?.includes('task-queue');

function taskQueueDebug(...args: unknown[]): void {
  if (DEBUG_TASK_QUEUE) {
    console.debug(...args);
  }
}

export class AgorLocalStrategy extends LocalStrategy {
  async findEntity(username: string, params: Params) {
    markLocalAuthenticationLookup(params);
    return super.findEntity(username, params);
  }

  async getEntity(result: unknown, params: Params) {
    // Local login's final entity lookup also needs backend-only auth metadata
    // so freshly issued tokens can be bumped past a just-written invalidation
    // marker. The authentication hook redacts the metadata before returning.
    markAuthenticationUserLookup(params);
    const current = (await super.getEntity(result, params)) as {
      credential_generation?: unknown;
    };
    const verified = result as { credential_generation?: unknown };
    const verifiedGeneration =
      typeof verified.credential_generation === 'number' ? verified.credential_generation : 0;
    const currentGeneration =
      typeof current.credential_generation === 'number' ? current.credential_generation : 0;

    // The password comparison ran against `result`. If a password update won
    // while bcrypt was in flight, never mint claims from the re-fetched row as
    // though the newly stored credential had been verified.
    if (verifiedGeneration !== currentGeneration) {
      throw new NotAuthenticated('Invalid login');
    }
    return current;
  }
}

/**
 * Extended Params with route ID parameter.
 */
export interface RouteParams extends Params {
  route?: {
    id?: string;
    messageId?: string;
    mcpId?: string;
    name?: string;
  };
  user?: User;
  /** Trusted internal callback request, populated by MCP tooling only. */
  _taskCompletionCallback?: NonNullable<TaskMetadata['completion_callback']>;
}

/**
 * Authorize the executor-only read of effective MCP configuration.
 *
 * Returns false for ordinary browser/API callers so the route can apply its
 * existing Session owner/admin rule. A verified task executor is accepted only
 * for its exact signed Session/Task and immutable Task actor.
 */
export async function authorizeTaskExecutorSessionMcpRead(
  params: RouteParams,
  session: Session,
  findTask: (taskId: string) => Promise<Task | null>
): Promise<boolean> {
  const scope = authenticatedTaskExecutorRuntimeScope(params);
  if (!scope) return false;
  if (scope.sessionId !== session.session_id) {
    throw new Forbidden('Executor token is not scoped to this session');
  }
  const userId = params.user?.user_id;
  if (!userId) throw new NotAuthenticated('Executor MCP read requires a prompt actor');
  const task = await findTask(scope.taskId);
  if (
    !task ||
    task.task_id !== scope.taskId ||
    task.session_id !== session.session_id ||
    task.created_by !== userId
  ) {
    throw new Forbidden('Executor task scope is no longer current');
  }
  return true;
}

/**
 * Resolve the durable actor of a queued Task.
 *
 * Queue scheduling metadata is intentionally absent from this boundary: only
 * `Task.created_by` may select credentials, mounts, or private integrations.
 */
export async function resolveQueuedTaskActor(
  task: Pick<Task, 'created_by'>,
  findUser: (userId: string) => Promise<User | null | undefined>
): Promise<User | null> {
  if (!task.created_by) return null;
  return (await findUser(task.created_by)) ?? null;
}

/**
 * Bind an executor launch to the immutable actor recorded on the Task.
 *
 * A branch-scoped Session may be promptable by several collaborators, but an
 * existing Task is not transferable between them: `Task.created_by` selects
 * provider credentials, private MCP grants, and audit attribution. Callers
 * who want to run their own prompt must use the Session prompt endpoint so it
 * creates a Task in their identity. Keeping this check at the shared launch
 * boundary also protects queue and internal call paths from identity drift.
 */
export function assertTaskExecutorPrincipal(
  task: Pick<Task, 'created_by'>,
  params: Pick<RouteParams, 'user'>
): UserID {
  const principalUserId = params.user?.user_id as UserID | undefined;
  if (!principalUserId) {
    throw new NotAuthenticated('Authentication required to run tasks');
  }
  if (task.created_by !== principalUserId) {
    throw new Forbidden(
      'Only the user who created this task can run it. Submit a new prompt to run as yourself.'
    );
  }
  return principalUserId;
}

/** Compatibility tombstone retained for stale Claude CLI restart clients. */
export function rejectRemovedClaudeCliRestart(): never {
  throw new BadRequest(REMOVED_AGENTIC_TOOL_RUNTIME_MESSAGE);
}

function isServiceAccountRoute(params: RouteParams): boolean {
  return (params.user as { _isServiceAccount?: boolean } | undefined)?._isServiceAccount === true;
}

export function requireStreamingPublisherCapability(
  params: RouteParams,
  eventData: Record<string, unknown>
): void {
  if (isServiceAccountRoute(params)) return;

  const scope = authenticatedTaskExecutorRuntimeScope(params);
  if (!scope?.taskId || eventData.task_id !== scope.taskId) {
    throw new Forbidden('Streaming events require an executor-scoped token');
  }
  if (!matchesTaskExecutorRuntimeScope(scope, eventData)) {
    throw new Forbidden('Streaming event session does not match executor scope');
  }
}

/**
 * Interface for dependencies needed by route registration.
 */
export interface RegisterRoutesContext {
  db: TenantScopeAwareDatabase;
  app: Application & { io?: import('socket.io').Server };
  config: AgorConfig;
  externalLaunchProvider: ResolvedExternalLaunchProvider;
  jwtSecret: string;
  branchRbacEnabled: boolean;
  requireAuth: (context: HookContext) => Promise<HookContext>;
  enforcePasswordChange: (context: HookContext) => Promise<HookContext>;
  superadminOpts: { allowSuperadmin: boolean };
  DB_PATH: string;
  DAEMON_PORT: number;
  DAEMON_VERSION: string;
  /** User-facing agor-live release version advertised by protocol surfaces. */
  AGOR_VERSION: string;
  /**
   * Resolved build info (sha + builtAt). Surfaced on /health so the UI can
   * detect FE/BE drift after a deploy. The SHA is the canonical version
   * signal for the version-sync banner — see setup/build-info.ts.
   */
  DAEMON_BUILD_INFO: import('./setup/build-info.js').BuildInfo;
  /**
   * Resolved security config (CSP/CORS after defaults+extras+override merge).
   * Used by /health to surface the effective policy to admin users.
   */
  resolvedSecurity: import('@agor/core/config').ResolvedSecurity;
  realtimeRuntime?: Pick<
    import('./realtime/redis-realtime.js').RedisRealtimeRuntime,
    'health' | 'isReady'
  >;
  distributedWorkIdentity: import('@agor/core/coordination').DistributedWorkIdentity;
  deployment: ResolvedDeploymentConfig;

  // Service instances from registerServices()
  sessionsService: SessionsServiceImpl;
  boardsService: BoardsServiceImpl | undefined;
  branchRepository: BranchRepository;
  usersRepository: UsersRepository;
  sessionsRepository: SessionRepository;
  sessionMCPServersService: ReturnType<
    typeof import('./services/session-mcp-servers.js').createSessionMCPServersService
  >;
  sessionEnvSelectionsService: ReturnType<
    typeof import('./services/session-env-selections.js').createSessionEnvSelectionsService
  >;
  terminalsService: TerminalsService | null;
}

export async function authorizeTaskTerminalRoute(input: {
  id: string;
  params: RouteParams;
  tasksService: Pick<TasksServiceImpl, 'get'>;
}): Promise<RouteParams> {
  const internalParams = { ...input.params, provider: undefined };
  const userId = input.params.user?.user_id as UUID | undefined;
  if (!userId) throw new NotAuthenticated('Authentication required to update tasks');
  const task = await input.tasksService.get(input.id, internalParams);
  const isAdmin = hasMinimumRole(input.params.user?.role, ROLES.ADMIN);
  if (task.created_by !== userId && !isAdmin) {
    throw new Forbidden('Only the task creator or an admin can update this task');
  }
  return internalParams;
}

export function findMatchingUnverifiedTerminationTask(
  tasks: readonly Task[],
  expected: { taskId: string; terminationRequestedAt: string }
): Task | undefined {
  return tasks.find(
    (task) =>
      task.task_id === expected.taskId &&
      task.status === TaskStatus.STOPPING &&
      task.sdk_failure?.termination === 'unverified' &&
      task.termination_request?.requested_at === expected.terminationRequestedAt
  );
}

/** Build the required short database unit used by authenticated long-route dependencies. */
export function createRequiredTenantDatabaseRunner(db: TenantScopeAwareDatabase) {
  return <T>(work: () => Promise<T>): Promise<T> => {
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for database operation');
    return runWithTenantDatabaseScope(db, tenantId, work);
  };
}

/**
 * Register an authenticated custom route with the same tenant transaction and
 * write-freeze gate as ordinary tenant-owned Feathers services. Custom routes
 * are installed after `registerHooks()`, so this registrar—not a static path
 * list—is their authoritative database boundary.
 */
export function createTenantScopedAuthenticatedRouteRegistrar(options: {
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  jwtSecret: string;
}): typeof registerAuthenticatedRouteBase {
  const tenantDatabaseScopeAround = createTenantDatabaseScopeAroundHook(options);
  const tenantWriteGateAround = createTenantWriteGateAroundHook(options.db);
  return (routeApp, path, service, authConfig, routeRequireAuth, routeOptions = {}) =>
    registerAuthenticatedRouteBase(routeApp, path, service, authConfig, routeRequireAuth, {
      ...routeOptions,
      around: [tenantDatabaseScopeAround, tenantWriteGateAround, ...(routeOptions.around ?? [])],
    });
}

type BoardCommentRouteParams = Pick<AuthenticatedParams, 'provider' | 'user'>;

/**
 * Authorize one custom board-comment route without trusting its route id as an
 * access decision. PostgreSQL RLS handles tenant isolation; board RBAC handles
 * same-tenant private-board access. Missing, foreign-tenant, and inaccessible
 * comments intentionally produce the same result.
 */
export async function authorizeBoardCommentRouteAccess(input: {
  commentId: string;
  params: BoardCommentRouteParams;
  findComment: (commentId: string) => Promise<BoardComment | null>;
  findVisibleComment: (commentId: string, userId: UUID) => Promise<BoardComment | null>;
}): Promise<BoardComment> {
  const user = input.params.user;
  if (!user) throw new NotAuthenticated('Authentication required');
  const privileged = user._isServiceAccount || hasMinimumRole(user.role, ROLES.ADMIN);
  const comment = privileged
    ? await input.findComment(input.commentId)
    : await input.findVisibleComment(input.commentId, user.user_id as UUID);
  if (!comment) throw new NotFound('Board comment not found');
  return comment;
}

/** Caller-owned reaction identity; a submitted user_id is never authoritative. */
export function boardCommentReactionInput(
  data: { emoji?: unknown },
  params: BoardCommentRouteParams
): { user_id: string; emoji: string } {
  const userId = params.user?.user_id;
  if (!userId) throw new NotAuthenticated('Authentication required');
  if (typeof data.emoji !== 'string' || !data.emoji) throw new BadRequest('emoji required');
  return { user_id: userId, emoji: data.emoji };
}

/**
 * Replies inherit board/attachment authority from their parent. Project the
 * request onto the supported fields so callers cannot smuggle ownership,
 * reactions, resolution state, or a different parent/board reference.
 */
export function boardCommentReplyInput(
  data: Partial<BoardComment>,
  params: BoardCommentRouteParams
): Partial<BoardComment> {
  const userId = params.user?.user_id;
  if (!userId) throw new NotAuthenticated('Authentication required');
  if (typeof data.content !== 'string' || !data.content) {
    throw new BadRequest('content required');
  }
  return {
    content: data.content,
    created_by: userId as UserID,
    ...(Array.isArray(data.mentions) ? { mentions: data.mentions } : {}),
  };
}

/**
 * Authorize spatial movement without turning it into an audience mutation.
 * Branch/session attachment anchors remain immutable; relative parent IDs are
 * checked against those anchors, and zone IDs must belong to the same board.
 */
export async function authorizeBoardCommentReposition(input: {
  comment: BoardComment;
  data: BoardCommentReposition;
  params: BoardCommentRouteParams;
  findBoard: (boardId: string) => Promise<import('@agor/core/types').Board | null>;
  findVisibleBoard: (
    userId: UUID,
    boardId: string
  ) => Promise<import('@agor/core/types').Board | null>;
}): Promise<void> {
  const user = input.params.user;
  if (!user) throw new NotAuthenticated('Authentication required');
  const privileged = user._isServiceAccount || hasMinimumRole(user.role, ROLES.ADMIN);
  if (!privileged && input.comment.created_by !== user.user_id) {
    throw new Forbidden('Only the comment author may reposition this board comment');
  }

  const expectedBranchId = input.comment.branch_id ?? null;
  if (input.data.branch_id !== expectedBranchId) {
    throw new Forbidden('Board comment attachments cannot be changed while repositioning');
  }

  const relative = input.data.position.relative;
  if (!relative) return;
  if (relative.parent_type === 'branch' && relative.parent_id !== input.comment.branch_id) {
    throw new Forbidden('Board comment branch position does not match its attachment');
  }
  if (relative.parent_type === 'session' && relative.parent_id !== input.comment.session_id) {
    throw new Forbidden('Board comment session position does not match its attachment');
  }
  if (relative.parent_type === 'zone') {
    const board = privileged
      ? await input.findBoard(input.comment.board_id)
      : await input.findVisibleBoard(user.user_id as UUID, input.comment.board_id);
    if (board?.objects?.[boardCommentZoneParentObjectKey(relative.parent_id)]?.type !== 'zone') {
      throw new NotFound('Board resource not found');
    }
  }
}

/**
 * Build the catalog-connect service exactly as the production route registers it.
 * Kept as a named boundary so PostgreSQL integration coverage can exercise the
 * authenticated tenant-scoped grant lookup instead of substituting a test
 * implementation of that decisive dependency.
 */
export function createRegisteredMCPCatalogConnectService(
  app: Application,
  db: TenantScopeAwareDatabase
) {
  return createMCPCatalogConnectService(app, {
    async listCandidates(userId, params) {
      const tenantId =
        (params as { tenant?: { tenant_id?: string } }).tenant?.tenant_id ?? getCurrentTenantId();
      const read = async () => new MCPCatalogCandidateRepository(db).listForUser(userId);
      return tenantId ? runWithTenantDatabaseScope(db, tenantId, read) : read();
    },
    async getCandidate(userId, serverId, params) {
      const tenantId =
        (params as { tenant?: { tenant_id?: string } }).tenant?.tenant_id ?? getCurrentTenantId();
      const read = async () => new MCPCatalogCandidateRepository(db).getForUser(userId, serverId);
      return tenantId ? runWithTenantDatabaseScope(db, tenantId, read) : read();
    },
    async isGrantAuthorized(candidate, params) {
      const userId = params.user?.user_id as UserID | undefined;
      if (!userId) return false;
      const tenantId =
        (params as { tenant?: { tenant_id?: string } }).tenant?.tenant_id ?? getCurrentTenantId();
      const read = async () => {
        const grant = await new UserMCPOAuthTokenRepository(db).getCatalogGrantAuthority(
          userId,
          candidate.server.mcp_server_id
        );
        return Boolean(
          grant?.has_access_token &&
            (await isMCPOAuthGrantAuthorizedForServer(db, candidate.server, grant))
        );
      };
      return tenantId ? runWithTenantDatabaseScope(db, tenantId, read) : read();
    },
  });
}

interface BearerHttpAuthenticationService {
  create(
    data: { strategy: 'jwt'; accessToken: string },
    params: AuthenticatedParams
  ): Promise<{ user?: User; authentication?: { payload?: unknown } }>;
}

/**
 * Authenticate one raw HTTP bearer at the same tenant-aware boundary used by
 * Feathers REST middleware. The mutable params object passed into the strategy
 * is reused in the result so verified tenant context cannot be lost between
 * user lookup and the route's authorization checks.
 */
export async function authenticateBearerHttpRequest(input: {
  authentication: BearerHttpAuthenticationService;
  multiTenancy: ReturnType<typeof resolveMultiTenancyConfig>;
  headers: Record<string, unknown>;
  token: string;
}): Promise<AuthenticatedParams> {
  const authParams: AuthenticatedParams = { headers: input.headers };
  const result = await input.authentication.create(
    { strategy: 'jwt', accessToken: input.token },
    authParams
  );
  return {
    ...authParams,
    user: result.user,
    provider: 'rest',
    authentication: result.authentication,
    tenant:
      authParams.tenant ??
      resolveTenantContext(input.multiTenancy, {
        params: {
          authentication: result.authentication,
          headers: input.headers,
        },
        authPayload: result.authentication?.payload,
        headers: input.headers,
      }),
  };
}

export function createUploadAuthMiddleware(input: {
  authentication: {
    create(
      data: { strategy: 'jwt'; accessToken: string },
      params: AuthenticatedParams
    ): Promise<{ user?: User; authentication?: { payload?: unknown } }>;
  };
  multiTenancy: ReturnType<typeof resolveMultiTenancyConfig>;
}) {
  // biome-ignore lint/suspicious/noExplicitAny: Express 5 middleware request augmentation
  return async (req: any, res: any, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
      if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      req.feathers = await authenticateBearerHttpRequest({
        authentication: input.authentication,
        multiTenancy: input.multiTenancy,
        headers: req.headers,
        token,
      });
      next();
    } catch (error) {
      console.error('❌ [Upload Auth] Authentication failed:', error);
      res.status(401).json({ error: 'Authentication required' });
    }
  };
}

export async function authorizeForceFailRoute(input: {
  session: Pick<Session, 'session_id' | 'branch_id'>;
  params: RouteParams;
  body: Record<string, unknown>;
  findTask: (taskId: string) => Promise<Task | undefined>;
  isBranchOwner: (branchId: Session['branch_id'], userId: UUID) => Promise<boolean>;
}): Promise<{ task: Task; confirmation: string; terminationRequestedAt: string }> {
  const userId = input.params.user?.user_id;
  const isAdmin = hasMinimumRole(input.params.user?.role, ROLES.ADMIN);
  const isOwner =
    !isAdmin && !!userId && (await input.isBranchOwner(input.session.branch_id, userId as UUID));
  if (!isAdmin && !isOwner) {
    throw new Forbidden('Only a branch owner or administrator may force-fail a Task.');
  }
  if (typeof input.body.confirmation !== 'string') {
    throw new BadRequest('Type STOP to confirm force-fail.');
  }
  if (
    typeof input.body.task_id !== 'string' ||
    typeof input.body.termination_requested_at !== 'string'
  ) {
    throw new BadRequest('Force-fail requires the exact Task termination request.');
  }
  const candidate = await input.findTask(input.body.task_id);
  const task =
    candidate?.session_id === input.session.session_id
      ? findMatchingUnverifiedTerminationTask([candidate], {
          taskId: input.body.task_id,
          terminationRequestedAt: input.body.termination_requested_at,
        })
      : undefined;
  if (!task) {
    throw new Conflict(
      'The Task termination state changed. Review the current Task before force-failing.'
    );
  }
  return {
    task,
    confirmation: input.body.confirmation,
    terminationRequestedAt: input.body.termination_requested_at,
  };
}

/**
 * Register authentication configuration and custom REST routes.
 */
export async function registerRoutes(ctx: RegisterRoutesContext): Promise<void> {
  const {
    db,
    app,
    config,
    externalLaunchProvider,
    jwtSecret,
    branchRbacEnabled,
    requireAuth,
    enforcePasswordChange,
    superadminOpts,
    DB_PATH,
    DAEMON_PORT: _DAEMON_PORT,
    DAEMON_VERSION,
    AGOR_VERSION,
    DAEMON_BUILD_INFO,
    resolvedSecurity,
    realtimeRuntime,
    distributedWorkIdentity,
    deployment,
    sessionsService,
    boardsService,
    branchRepository,
    usersRepository: _usersRepository,
    sessionsRepository,
    sessionMCPServersService,
    sessionEnvSelectionsService,
    terminalsService: _terminalsService,
  } = ctx;

  registerExecutorResponseRoutes(app);

  // Health and launch auth share the exact startup-resolved provider. The
  // public DTO is immutable and contains no verification or exchange secrets.
  const publicLaunchAuth = Object.freeze(resolvePublicLaunchAuthSettings(externalLaunchProvider));

  const usersService = app.service('users');
  const tasksService = app.service('tasks') as unknown as TasksServiceImpl;
  const reposService = app.service('repos') as unknown as ReposServiceImpl;
  const mcpEgressGateway = new MCPEgressGateway({
    db,
    app,
    jwtSecret,
    branchRbacEnabled,
  });
  // Internal composition seam used by MCP mutation hooks. It is never exposed
  // as a Feathers service and carries no serializable credential material.
  (app as unknown as { mcpEgressGateway?: MCPEgressGateway }).mcpEgressGateway = mcpEgressGateway;

  const mcpEgressHttpHandler = createMCPEgressHttpHandler(mcpEgressGateway);
  // @ts-expect-error FeathersJS app extends Express.
  app.post('/mcp-egress/:serverId', mcpEgressHttpHandler);
  // @ts-expect-error FeathersJS app extends Express.
  app.delete('/mcp-egress/:serverId', mcpEgressHttpHandler);
  // Streamable HTTP GET opens a server-stream channel. This phase cannot
  // mediate it without unbounded buffering, so reject before capability or DNS work.
  // @ts-expect-error FeathersJS app extends Express.
  app.all('/mcp-egress/:serverId', (req: Request, res: Response) => {
    const safeServerId = String(req.params.serverId ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
    console.warn(
      `[MCP Egress] event=request_rejected server_id=${safeServerId || '<invalid>'} code=method_not_mediated`
    );
    res
      .status(405)
      .setHeader('allow', 'POST, DELETE')
      .json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32003,
          message: 'This MCP gateway phase mediates only bounded POST and DELETE requests',
          data: { code: 'method_not_mediated' },
        },
      });
  });
  const tenantIdentityAround = createTenantDatabaseScopeAroundHook({
    db,
    config,
    jwtSecret,
    transaction: false,
  });
  const tenantWriteAdmissionAround = createTenantWriteAdmissionAroundHook(db);
  const inTenantDatabaseScope = <T>(hook: (context: HookContext) => T) =>
    async function scopedHook(context: HookContext): Promise<Awaited<T>> {
      return runWithTenantDatabaseScope(db, context.params.tenant?.tenant_id, async () =>
        hook(context)
      ) as Promise<Awaited<T>>;
    };
  const inCurrentTenantDatabaseScope = createRequiredTenantDatabaseRunner(db);

  /** Schedule orchestration after commit with tenant identity but no open transaction. */
  function deferInFreshTenantScope(params: RouteParams, fn: () => Promise<void>): void {
    deferWithTenantContext(params, fn);
  }

  const registerAuthenticatedRoute = createTenantScopedAuthenticatedRouteRegistrar({
    db,
    config,
    jwtSecret,
  });

  const registerLongAuthenticatedRoute: typeof registerAuthenticatedRouteBase = (
    routeApp,
    path,
    service,
    authConfig,
    routeRequireAuth,
    options = {}
  ) =>
    registerAuthenticatedRouteBase(routeApp, path, service, authConfig, routeRequireAuth, {
      ...options,
      around: [tenantIdentityAround, tenantWriteAdmissionAround, ...(options.around ?? [])],
    });

  // Long routes carry tenant identity without holding a route-wide database
  // transaction. Admission checks the write gate in one short unit before
  // orchestration begins; direct repositories and hooked services re-check it
  // at their own short write boundaries.
  const stopRouteRepositories = bindStopRouteRepositories(db, {
    taskRepo: new TaskRepository(db),
    branchRepo: branchRepository,
  });

  // Helper: safely get a service (returns undefined if not registered due to tier=off)
  const safeService = (path: string) => {
    try {
      return app.service(path);
    } catch {
      return undefined;
    }
  };

  // Get sessionTokenService from app record
  const appRecord = app as unknown as Record<string, unknown>;
  const sessionTokenService = appRecord.sessionTokenService as
    | import('./services/session-token-service.js').SessionTokenService
    | undefined;

  // ============================================================================
  // Authentication Configuration
  // ============================================================================

  const authStrategiesArray = ['api-key', 'jwt', 'local'];
  const multiTenancy = resolveMultiTenancyConfig(config);
  const tenantTokenClaim = multiTenancy.auth_claim ?? 'tenant_id';

  // Access token TTL — short by design. The /authentication/refresh route
  // (and the after-hook below) issues a 30-day refresh token so users stay
  // logged in across browser restarts; the access token itself stays
  // short-lived so that a leaked one expires quickly. Both the auth-service
  // config AND the refresh endpoint MUST use this constant — if they drift,
  // the refresh path silently downgrades the security of the auth path.
  const ACCESS_TOKEN_TTL = '15m';
  const REFRESH_TOKEN_TTL = '30d';

  app.set('authentication', {
    secret: jwtSecret,
    entity: 'user',
    entityId: 'user_id',
    service: 'users',
    authStrategies: authStrategiesArray,
    jwtOptions: {
      header: { typ: 'access' },
      audience: RUNTIME_JWT_AUDIENCE,
      issuer: RUNTIME_JWT_ISSUER,
      algorithm: 'HS256',
      expiresIn: ACCESS_TOKEN_TTL,
    },
    local: {
      usernameField: 'email',
      passwordField: 'password',
    },
  });

  // Configure authentication
  const authentication = new AuthenticationService(app);

  // Register the runtime JWT strategy for user, executor, terminal, and daemon credentials.
  const { RuntimeJWTStrategy } = await import('./auth/runtime-jwt-strategy.js');

  // Register authentication strategies
  authentication.register(
    'jwt',
    new RuntimeJWTStrategy({
      sessionTokenService,
      executorRevocationFence: getOrCreateExecutorConnectionRevocationFence(app),
      multiTenancy,
    })
  );
  authentication.register('local', new AgorLocalStrategy());

  // Register API key authentication strategy
  const { ApiKeyStrategy } = await import('./auth/api-key-strategy.js');
  const apiKeyStrategy = new ApiKeyStrategy();
  authentication.register('api-key', apiKeyStrategy);

  // Initialize API key strategy with dependencies
  const { UserApiKeysRepository } = await import('@agor/core/db');
  const userApiKeysRepo = new UserApiKeysRepository(db);
  apiKeyStrategy.setDependencies(userApiKeysRepo, usersService);

  // SECURITY: Rate-limit the authentication + refresh endpoints.
  //
  // express-rate-limit gives us standardized response headers
  // (`RateLimit-Limit/Remaining/Reset`, IETF draft-7) and `Retry-After` for
  // free, plus battle-tested concurrency / clock-skew handling. The default
  // in-memory MemoryStore is fine for solo/team deployments; multi-instance
  // operators can plug in a distributed store (redis, memcached) later
  // without touching this call site.
  //
  // Mounted at `/authentication` so it covers BOTH the Feathers auth service
  // (POST /authentication) and the custom refresh endpoint
  // (POST /authentication/refresh) — Express's path-prefix matching means
  // a single middleware handles both, and the keyGenerator branches on the
  // sub-path to choose the right composite key.
  const AUTH_RATE_LIMIT_MAX = 50;
  const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

  const authRateLimiter = rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    limit: AUTH_RATE_LIMIT_MAX,
    // Modern IETF draft-7 headers (RateLimit-*) — clients can back off.
    standardHeaders: 'draft-7',
    // Drop the legacy X-RateLimit-* set; they're noisy and non-standard.
    legacyHeaders: false,
    // Composite key on (ip, email). For the refresh sub-path the body has
    // no email, so we bucket purely by IP. Trust only Express's resolved
    // `req.ip` (which respects `app.set('trust proxy', n)`) — never
    // X-Forwarded-For directly.
    // express-rate-limit can resolve Feathers' Express 4 declaration copy
    // alongside the daemon's Express 5 declarations. The runtime request is
    // the same object; infer the middleware signature and narrow at our edge.
    keyGenerator: (req): string => buildAuthRateLimitKey(req as unknown as Request),
    message: 'Too many authentication attempts. Please try again in 15 minutes.',
  });

  // Mount BEFORE the auth service so the limiter intercepts first. The same
  // middleware also covers /authentication/refresh below thanks to Express
  // path-prefix matching.
  // biome-ignore lint/suspicious/noExplicitAny: Feathers Application vs Express middleware overload
  app.use('/authentication', authRateLimiter as any);

  app.use('/authentication', authentication);

  // Initialize SessionTokenService with JWT secret
  if (sessionTokenService) {
    sessionTokenService.setJwtSecret(jwtSecret);
    console.log('✅ SessionTokenService initialized with JWT secret (will generate JWTs)');
  }

  // Configure docs for authentication service
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const authService = app.service('authentication') as any;
  authService.docs = {
    description: 'Authentication service for user login and token management',
    security: [],
  };

  // Hook: Issue browser access + refresh tokens with millisecond issue time.
  // Machine-token logins (executor-session / service) keep their original
  // token — see createIssueBrowserTokensHook for why.
  // Rate limiting is enforced by express-rate-limit middleware mounted on
  // `/authentication` above — by the time we reach this hook the limiter
  // has already 429'd any over-quota request.
  authService.hooks({
    after: {
      create: [
        createIssueBrowserTokensHook({
          jwtSecret,
          accessTokenTtl: ACCESS_TOKEN_TTL,
          refreshTokenTtl: REFRESH_TOKEN_TTL,
          tenantClaim: tenantTokenClaim,
          debug: authEventDebug,
        }),
      ],
    },
  });

  // ============================================================================
  // One-time launch-code authentication endpoint
  // ============================================================================

  // biome-ignore lint/suspicious/noExplicitAny: Feathers Application vs Express middleware overload
  app.use('/auth/launch', authRateLimiter as any);
  app.use(
    '/auth/launch',
    createLaunchAuthService({
      db,
      config,
      provider: externalLaunchProvider,
      jwtSecret,
      accessTokenTtl: ACCESS_TOKEN_TTL,
      refreshTokenTtl: REFRESH_TOKEN_TTL,
      usersService,
      onAuthorizationInvalidated: (tenantId) => {
        app.emit('realtime:authorization-invalidated', {
          tenantId,
          disconnectSockets: true,
        });
      },
    })
  );

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const launchAuthService = app.service('auth/launch') as any;
  launchAuthService.docs = {
    description: 'One-time launch-code authentication endpoint for trusted external launch issuers',
    security: [],
  };

  // ============================================================================
  // Refresh token endpoint
  // ============================================================================

  app.use(
    '/authentication/refresh',
    createRefreshTokenService({
      jwtSecret,
      accessTokenTtl: ACCESS_TOKEN_TTL,
      refreshTokenTtl: REFRESH_TOKEN_TTL,
      tenantClaim: tenantTokenClaim,
      usersService,
    })
  );

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const refreshService = app.service('authentication/refresh') as any;
  refreshService.docs = {
    description: 'Token refresh endpoint - obtain a new access token using a refresh token',
    security: [],
  };

  // ============================================================================
  // Impersonation endpoint
  // ============================================================================

  const MAX_IMPERSONATION_EXPIRY_MS = 3_600_000; // 1 hour hard cap

  app.use('/authentication/impersonate', {
    async create(data: { user_id?: string; expiry_ms?: number }, params?: Params) {
      // 1. Caller must be authenticated
      const authParams = params as AuthenticatedParams;
      if (!authParams?.user?.user_id) {
        throw new NotAuthenticated('Authentication required');
      }

      const caller = authParams.user;

      // 2. Caller must have role: superadmin
      if (!hasMinimumRole(caller.role, ROLES.SUPERADMIN)) {
        throw new Forbidden('Superadmin role required for impersonation');
      }

      // 3. Caller token must NOT be an impersonated token (block recursive impersonation)
      // biome-ignore lint/suspicious/noExplicitAny: JWT payload has dynamic fields
      const authPayload = (authParams as any).authentication?.payload;
      if (authPayload?.is_impersonated === true) {
        throw new Forbidden('Cannot impersonate from an already-impersonated token');
      }

      // 4. user_id must be provided
      if (!data?.user_id) {
        throw new BadRequest('user_id is required');
      }

      // 5. Validate expiry_ms if provided
      if (data.expiry_ms != null) {
        if (typeof data.expiry_ms !== 'number' || !Number.isFinite(data.expiry_ms)) {
          throw new BadRequest('expiry_ms must be a finite number');
        }
        if (data.expiry_ms <= 0) {
          throw new BadRequest('expiry_ms must be a positive number');
        }
      }

      // 6. Target user must exist (uses usersService for consistency with refresh endpoint)
      let targetUser: User;
      try {
        targetUser = await usersService.get(data.user_id as import('@agor/core/types').UUID);
      } catch {
        throw new NotFound(`User not found: ${data.user_id}`);
      }
      assertAuthenticationUserAuthMetadata(targetUser);

      // 8. Compute expiry (default 1h, capped at 1h)
      const configuredMax =
        config.daemon?.impersonation_token_expiry_ms ?? MAX_IMPERSONATION_EXPIRY_MS;
      const maxExpiry = Math.min(configuredMax, MAX_IMPERSONATION_EXPIRY_MS);
      const requestedExpiry = data.expiry_ms ?? maxExpiry;
      const expiryMs = Math.min(requestedExpiry, maxExpiry);

      // 9. Generate token
      const jti = generateId();
      const expiresAt = new Date(Date.now() + expiryMs);

      const accessToken = issueRuntimeToken(
        {
          sub: targetUser.user_id,
          type: 'access',
          impersonated_by: caller.user_id,
          is_impersonated: true,
          jti,
          ...authCredentialGenerationClaim(targetUser),
          ...authTokenIssuedAtClaim(Date.now(), targetUser),
        },
        jwtSecret,
        Math.ceil(expiryMs / 1000)
      );

      // 10. Audit log
      console.log(
        `[auth] impersonation issued: caller=${caller.user_id} target=${targetUser.user_id} jti=${jti} exp=${expiresAt.toISOString()}`
      );

      return {
        accessToken,
        user: {
          user_id: targetUser.user_id,
          email: targetUser.email,
          name: targetUser.name,
          emoji: targetUser.emoji,
          role: targetUser.role,
        },
      };
    },
  });

  // Apply auth hooks to impersonation endpoint
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const impersonateService = app.service('authentication/impersonate') as any;
  impersonateService.docs = {
    description:
      'Impersonation endpoint - superadmins can issue short-lived tokens scoped to any user',
  };
  impersonateService.hooks({
    before: {
      create: [requireAuth],
    },
  });

  // ============================================================================
  // Message streaming routes
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/messages/streaming',
    {
      async create(
        data: {
          event: StreamingEventType;
          data: Record<string, unknown>;
        },
        params: RouteParams
      ) {
        requireStreamingPublisherCapability(params, data.data);
        app.service('messages').emit(data.event, data.data);
        if (isServiceAccountRoute(params)) {
          const gatewayStreamingEvent =
            data.event === 'streaming:start' ||
            data.event === 'streaming:chunk' ||
            data.event === 'streaming:end' ||
            data.event === 'streaming:error'
              ? data.event
              : null;

          if (gatewayStreamingEvent) {
            deferInFreshTenantScope(params, async () => {
              await (
                app.service('gateway') as unknown as GatewayService
              ).handleMessageStreamingEvent(gatewayStreamingEvent, data.data);
            });
          }
        }
        return { success: true };
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'broadcast streaming events' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/tasks/streaming',
    {
      async create(
        data: {
          event: 'tool:start' | 'tool:complete' | 'thinking:chunk';
          data: Record<string, unknown>;
        },
        params: RouteParams
      ) {
        requireStreamingPublisherCapability(params, data.data);
        app.service('tasks').emit(data.event, data.data);
        if (isServiceAccountRoute(params) && data.event === 'tool:start') {
          const sessionId =
            typeof data.data.session_id === 'string' ? data.data.session_id : undefined;
          const toolName =
            typeof data.data.tool_name === 'string' ? data.data.tool_name : undefined;
          if (sessionId) {
            deferInFreshTenantScope(params, async () => {
              await (app.service('gateway') as unknown as GatewayService).updateProgress({
                session_id: sessionId,
                state: 'working',
                task_id: typeof data.data.task_id === 'string' ? data.data.task_id : undefined,
                tool_name: toolName,
              });
            });
          }
        }
        return { success: true };
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'broadcast task streaming events' },
    },
    requireAuth
  );

  // These routes re-emit canonical events onto the `messages` / `tasks`
  // services. Their own `{ success: true }` acknowledgements must not
  // broadcast as service events.
  app.service('/messages/streaming').publish(() => []);
  app.service('/tasks/streaming').publish(() => []);

  // ============================================================================
  // Sessions custom routes (fork, spawn, genealogy, prompt, stop, queue)
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/fork',
    {
      async create(data: { prompt: string; task_id?: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        console.log(`🔀 Forking session: ${shortId(id)}`);
        const forkedSession = await sessionsService.fork(id, data, params);
        console.log(`✅ Fork created: ${shortId(forkedSession.session_id)}`);

        // fork() persists through an internal service call, so emit the
        // standard event explicitly with its tenant/auth context. A raw
        // app.io.emit would bypass Feathers publication authorization and, in
        // HA, the Redis adapter would fan it out cluster-wide.
        emitServiceEvent(app, {
          path: 'sessions',
          event: 'created',
          data: forkedSession,
          params,
          id: forkedSession.session_id,
        });

        return forkedSession;
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'fork sessions' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/spawn',
    {
      async create(data: Partial<import('@agor/core/types').SpawnConfig>, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        console.log(`🌱 Spawning session from: ${shortId(id)}`);
        const spawnedSession = await sessionsService.spawn(id, data, params);
        console.log(`✅ Spawn created: ${shortId(spawnedSession.session_id)}`);

        emitServiceEvent(app, {
          path: 'sessions',
          event: 'created',
          data: spawnedSession,
          params,
          id: spawnedSession.session_id,
        });

        return spawnedSession;
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'spawn sessions' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/genealogy',
    {
      async find(params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        return sessionsService.getGenealogy(id, params);
      },
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS route handler type mismatch with Express RouteParams
    } as any,
    {
      find: { role: ROLES.MEMBER, action: 'view session genealogy' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/archive',
    {
      async create(data: { includeChildren?: boolean } | undefined, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        return sessionsService.archive(id, data, params);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'archive sessions' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/unarchive',
    {
      async create(data: { includeChildren?: boolean } | undefined, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        return sessionsService.unarchive(id, data, params);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'unarchive sessions' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/restart-cli',
    {
      async create() {
        return rejectRemovedClaudeCliRestart();
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'restart sessions' },
    },
    requireAuth
  );

  /**
   * Per-session local turn coalescing. This reduces redundant preparatory
   * reads and duplicate drain triggers inside one daemon; it is not a
   * correctness authority. Queue-position admission and the Session+Task
   * dispatch fence in PostgreSQL are authoritative across daemons.
   */
  const sessionTurnLocks: SessionTurnLocks = new Map();

  async function reconcileSessionPromptStateIfStuck(
    session: Session,
    taskRepo: TaskRepository,
    params: RouteParams,
    options: { ignoredTaskIds?: readonly string[] } = {}
  ): Promise<Session> {
    if (session.status !== SessionStatus.FAILED || session.ready_for_prompt === true) {
      return session;
    }

    const sessionTasks = await taskRepo.findBySession(session.session_id);
    if (!shouldReconcileSessionPromptState(session, sessionTasks, options)) return session;

    console.warn(
      `🧹 [PromptState] Repairing stuck session ${shortId(session.session_id)} ` +
        `(status=${session.status}, ready_for_prompt=${session.ready_for_prompt})`
    );
    return inCurrentTenantDatabaseScope(
      async () =>
        (await app.service('sessions').patch(
          session.session_id,
          {
            status: SessionStatus.IDLE,
            ready_for_prompt: true,
          },
          params
        )) as Session
    );
  }

  /**
   * Persist the first transcript row for a Task. Scheduled/idempotent prompts
   * pass a stable message ID, so a replacement daemon can repair a kill after
   * the dispatch claim without duplicating the prompt. Ordinary prompts retain
   * the historical best-effort/random-ID behavior and executor fallback.
   */
  async function ensureInitialUserMessage(
    task: Task,
    params: RouteParams,
    input: {
      messageStartIndex: number;
      startTimestamp: string;
      messageSource?: MessageSource;
      stableMessageId?: MessageID;
    }
  ): Promise<void> {
    if (config.execution?.daemon_writes_user_message === false) return;

    const messageRepo = bindRepositoryToTenantUnitOfWork(db, new MessagesRepository(db));
    if (input.stableMessageId) {
      const existing = await messageRepo.findById(input.stableMessageId);
      if (existing) {
        if (existing.session_id !== task.session_id || existing.task_id !== task.task_id) {
          throw new Conflict(
            `Stable initial message identity ${input.stableMessageId} is already in use`
          );
        }
        return;
      }
    }

    const isCallback = task.metadata?.is_agor_callback === true;
    const messageMetadata: Message['metadata'] = {};
    if (isCallback) messageMetadata.is_agor_callback = true;
    if (input.messageSource === 'gateway' || input.messageSource === 'agor') {
      messageMetadata.source = input.messageSource;
    }
    const userMessage = buildInitialUserMessage({
      messageId: input.stableMessageId,
      sessionId: task.session_id,
      taskId: task.task_id,
      index: input.messageStartIndex,
      timestamp: input.startTimestamp,
      content: task.full_prompt,
      type: isCallback ? 'system' : 'user',
      metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
    });

    try {
      await app.service('messages').create(userMessage, params);
    } catch (error) {
      if (input.stableMessageId) {
        const winner = await messageRepo.findById(input.stableMessageId);
        if (winner?.session_id === task.session_id && winner.task_id === task.task_id) return;
        throw error;
      }
      // Don't fail the spawn — the executor's createUserMessage fallback
      // (with skip-if-exists) will write the row when it connects.
      console.warn(
        formatStructuredLog('[messages.initial]', {
          event: 'write_failed',
          task_id: task.task_id,
          outcome: 'executor_retry',
          error_code: structuredLogErrorCode(error),
        })
      );
    }
  }

  /** Repair one stable initial transcript row from durable Task state. */
  async function reconcileStableInitialUserMessage(
    task: Task,
    params: RouteParams,
    stableMessageId: MessageID,
    fallback: {
      messageStartIndex?: number;
      startTimestamp?: string;
      messageSource?: MessageSource;
    } = {}
  ): Promise<void> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for message reconciliation');
    const persistedStartIndex = task.message_range?.start_index;
    const hasPersistedStartIndex =
      typeof persistedStartIndex === 'number' && persistedStartIndex >= 0;
    const fallbackStartIndex =
      typeof fallback.messageStartIndex === 'number' && fallback.messageStartIndex >= 0
        ? fallback.messageStartIndex
        : undefined;
    const messageStartIndex = hasPersistedStartIndex
      ? persistedStartIndex
      : (fallbackStartIndex ??
        (await runWithTenantDatabaseScope(db, tenantId, () =>
          sessionsRepository.countMessages(task.session_id)
        )));
    const startTimestamp =
      (hasPersistedStartIndex ? task.message_range?.start_timestamp : undefined) ??
      task.started_at ??
      fallback.startTimestamp ??
      new Date().toISOString();
    const persistedSource = task.metadata?.source ?? fallback.messageSource;
    const messageSource =
      persistedSource === 'gateway' || persistedSource === 'agor' ? persistedSource : undefined;

    await ensureInitialUserMessage(task, params, {
      messageStartIndex,
      startTimestamp,
      messageSource,
      stableMessageId,
    });
  }

  /**
   * spawnTaskExecutor — sole transition point for `tasks.status` going from
   * `created` / `queued` → `dispatching`.
   *
   * Both POST /sessions/:id/prompt's immediate queue-head attempt and the
   * queued-task drainer call this helper. Centralising the transition
   * guarantees that:
   *
   *   - `message_range.start_index`, `git_state.{ref,sha}_at_start`, and
   *     `started_at` are recomputed against fresh state right before the
   *     executor is spawned (sentinels on the stored row are only ever
   *     visible while `status='queued'`).
   *   - The initial user-message row is written by the daemon synchronously,
   *     before the executor process is forked. Without this, any crash
   *     during executor startup loses the prompt from the chat transcript
   *     even though `tasks.full_prompt` still has the text. Gated by
   *     `config.execution.daemon_writes_user_message` (kill switch — see
   *     §5.E of `docs/never-lose-prompt-design.md`).
   *   - `task.metadata.is_agor_callback` / `task.metadata.source` are
   *     re-stamped onto the new message so the UI's callback styling
   *     (`MessageBlock.tsx`) survives the queue → run transition.
   *   - Spawn failures synthesise a `type:'system'` error message so the
   *     chat surfaces *why* the assistant didn't respond, instead of silently
   *     leaving a ghost task in FAILED with no transcript trace.
   *
   * The session.tasks list is appended here too, so callers don't have to
   * remember to do it themselves.
   */
  async function spawnTaskExecutor(
    task: Task,
    options: {
      permissionMode?: import('@agor/core/types').PermissionMode;
      stream?: boolean;
      messageSource?: MessageSource;
      stableInitialMessageId?: MessageID;
    },
    params: RouteParams
  ): Promise<Task> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing active tenant context for task executor startup');
    const stableInitialMessageId = stableInitialMessageIdForTask(
      task,
      options.stableInitialMessageId
    );
    const persistedMessageSource = task.metadata?.source ?? options.messageSource;
    const runtimeMessageSource =
      persistedMessageSource === 'gateway' || persistedMessageSource === 'agor'
        ? persistedMessageSource
        : undefined;

    // A stable scheduled Task that has crossed the dispatch fence needs only
    // deterministic projection repair. Do not make that reconciliation depend
    // on mutable launch-time state (tool enablement, preset validity, or user
    // defaults): no new executor launch will occur on this path.
    if (shouldReconcileStableInitialMessage(task, stableInitialMessageId)) {
      await reconcileStableInitialUserMessage(task, params, stableInitialMessageId, {
        messageSource: runtimeMessageSource,
      });
      return task;
    }

    // The token minted below authenticates the executor as params.user, while
    // credential services resolve secrets from Task.created_by. Those must be
    // the same durable actor; Session/branch prompt authority alone must never
    // authorize consuming somebody else's provider credential.
    assertTaskExecutorPrincipal(task, params);

    const {
      agenticToolEnabled,
      messageStartIndex,
      session: loadedSession,
    } = await runWithTenantDatabaseScope(db, tenantId, async () => {
      const session = await sessionsService.get(task.session_id, params);
      const agenticTool = requireActiveAgenticTool(session.agentic_tool);
      return {
        session,
        agenticToolEnabled: await isAgenticToolEnabledForTenant(db, tenantId, agenticTool),
        // Recompute message_range.start_index against the live message count.
        messageStartIndex: await sessionsRepository.countMessages(task.session_id),
      };
    });
    if (!agenticToolEnabled) {
      throw new Forbidden(`${loadedSession.agentic_tool} is disabled for this workspace`);
    }
    const session = await runWithTenantDatabaseScope(db, tenantId, () =>
      sessionsService.materializeAgenticToolPreset(loadedSession, params)
    );
    const startTimestamp = new Date().toISOString();

    // The daemon persists launch intent and writes required sentinel git fields
    // before executor spawn. Executors claim DISPATCHING → RUNNING after
    // authenticating.
    const gitStateAtStart = 'unknown';
    const refAtStart = 'unknown';

    const launchState = buildTaskLaunchState(
      startTimestamp,
      config.execution?.executor_command_template ? 'templated' : 'local'
    );

    if (!isTaskPendingDispatch(task)) return task;

    // Atomically claim queued/created → launch status. Process-local session
    // locks reduce contention, but this expected-state transition is the
    // cross-daemon fence that prevents duplicate executor launches.
    const dispatchClaim = await runWithTenantDatabaseTransaction(db, tenantId, async (tenantDb) => {
      await lockTenantAuthorizationFence(tenantDb, params);
      await assertTenantWritable(tenantDb, tenantId);
      return tasksService.claimDispatchAndProjectSession(
        task.task_id,
        task.status,
        {
          ...launchState,
          ...(launchState.executor_mode
            ? { sdk_watchdog_mode: resolveSdkWatchdogConfig(config.execution).mode }
            : {}),
          queue_position: undefined,
          message_range: {
            start_index: messageStartIndex,
            end_index: messageStartIndex + 1,
            start_timestamp: startTimestamp,
            end_timestamp: startTimestamp,
          },
          git_state: {
            ref_at_start: refAtStart,
            sha_at_start: gitStateAtStart,
          },
        },
        { ...params, provider: undefined }
      );
    });
    if (dispatchClaim.outcome !== 'claimed') {
      const workIdentity = app.get('distributedWorkIdentity');
      console.info(
        formatStructuredLog('[distributed-work.task-dispatch]', {
          event: 'claim_lost',
          instance_id: workIdentity?.instanceId,
          boot_id: workIdentity?.bootId,
          tenant_id: tenantId,
          task_id: task.task_id,
          session_id: task.session_id,
          observed_status: dispatchClaim.task.status,
        })
      );
      if (shouldReconcileStableInitialMessage(dispatchClaim.task, stableInitialMessageId)) {
        await reconcileStableInitialUserMessage(
          dispatchClaim.task,
          params,
          stableInitialMessageId,
          {
            messageStartIndex,
            startTimestamp,
            messageSource: runtimeMessageSource,
          }
        );
      }
      return dispatchClaim.task;
    }
    const updatedTask = dispatchClaim.task;

    // Alt D — write the user-message row before spawning. Gated by kill switch.
    // The executor's createUserMessage has a skip-if-exists guard so a duplicate
    // write is harmless if the daemon path is enabled.
    // Prefer task.metadata.source (set when the task was queued) over the
    // request's messageSource — the latter applies only to this drain tick.
    if (stableInitialMessageId) {
      await reconcileStableInitialUserMessage(updatedTask, params, stableInitialMessageId, {
        messageStartIndex,
        startTimestamp,
        messageSource: runtimeMessageSource,
      });
    } else {
      await ensureInitialUserMessage(task, params, {
        messageStartIndex,
        startTimestamp,
        messageSource: runtimeMessageSource,
      });
    }

    // Re-apply the Session projection through Feathers so hooks/realtime see
    // the transition. TaskRepository.claimDispatchAndProjectSession already
    // committed the same projection atomically with the Task fence; this
    // service patch is no longer correctness-critical on SQLite and is
    // intentionally idempotent.
    //
    // The session-status flip used to fall out of `TasksService.create` when
    // the IDLE path created a task with `status: RUNNING` directly. Now the
    // IDLE path creates `status: CREATED` and we patch the task here, which
    // `TasksService.patch` does NOT mirror onto the session. Without this
    // explicit patch, `session.status` stays IDLE while a task is RUNNING,
    // causing the queue gate in the prompt route to wave subsequent prompts
    // through instead of queuing them.
    await runWithTenantDatabaseScope(db, tenantId, () =>
      app.service('sessions').patch(
        task.session_id,
        {
          status: SessionStatus.RUNNING,
          ready_for_prompt: false,
          tasks: [...session.tasks, task.task_id],
        },
        params
      )
    );

    // Tag the bytes shipped to the executor with `[Prompted by: ...]` when a
    // non-owner is prompting. The prompter identity comes from `task.created_by`
    // (NOT `params.user`): every persisted Task row requires `created_by`
    // (`createPending` for the prompt/queue/callback paths and `create` for
    // pre-created tasks run via `/tasks/:id/run`), so it survives the queue
    // / hook / drain hop intact. `params.user` can drop on hook-triggered drains
    // that don't carry `queued_by_user_id` and is therefore not authoritative.
    // See `./utils/build-prompter-prefix.ts` for the helper + tests.
    const { prompt: promptForExecutor } = await buildPrompterPrefixedPrompt({
      rawPrompt: task.full_prompt,
      sessionCreatedBy: session.created_by,
      prompterUserId: task.created_by,
      usersRepo: bindRepositoryToTenantUnitOfWork(db, new UsersRepository(db)),
    });

    const useStreaming = options.stream !== false;
    const sessionId = task.session_id;
    const taskId = task.task_id;
    const promptOrigin = resolvePromptOrigin(updatedTask, session);

    // Background spawn + failure handling. Returning the patched Task to the
    // caller before this resolves matches the previous behavior — the HTTP
    // response should not block on the executor process being live.
    // deferInFreshTenantScope uses a fresh DB connection and tenant RLS scope
    // instead of inheriting a stale committed transaction.
    deferInFreshTenantScope(params, async () => {
      try {
        console.log(
          `🚀 [Daemon] Routing ${session.agentic_tool} to Feathers/WebSocket executor (task ${shortId(taskId)})`
        );

        await sessionsService.executeTask(
          sessionId,
          {
            taskId,
            prompt: promptForExecutor,
            permissionMode: options.permissionMode,
            stream: useStreaming,
            messageSource: runtimeMessageSource,
            promptOrigin,
          },
          params
        );

        console.log(
          `✅ [Daemon] Executor spawned for session ${shortId(sessionId)}, waiting for task completion`
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // This is a daemon-owned lifecycle transition. Preserve the authenticated
        // actor and trusted tenant context for hooks/publication, but do not send
        // the originating transport provider back through server-managed write
        // guards: external callers cannot finalize Task or Message state.
        const failureParams = { ...params, provider: undefined };
        console.error(
          `❌ [Daemon] Executor spawn failed for session=${shortId(sessionId)} task=${shortId(taskId)} agent=${session.agentic_tool} unix_username=${session.unix_username ?? 'null'}: ${errorMessage}`,
          error
        );
        await patchUnlessRemoved(
          app,
          'tasks',
          taskId,
          {
            status: TaskStatus.FAILED,
            completed_at: new Date().toISOString(),
            error_message: errorMessage,
          },
          'Task',
          failureParams
        );

        // Synthesize a system message so the chat surfaces *why* the agent
        // didn't respond. Without this the transcript shows only the user
        // prompt and silence even though the task list reads FAILED.
        try {
          // Recompute the next index instead of trusting `messageStartIndex
          // + 1` — the daemon-write user-message above is wrapped in a
          // try/catch and may have been swallowed, leaving a gap at
          // `messageStartIndex`. countMessages always reports the live row
          // count, so it lands the system error at the true tail whether
          // the user-message row exists or not (no gap, no collision).
          const errorContent = `⚠️ The agent failed to start.\n\n${errorMessage}`;
          await appendSystemMessage({
            app,
            db,
            sessionId,
            taskId,
            content: errorContent,
            role: MessageRole.ASSISTANT,
            metadata: { is_meta: true },
            params: failureParams,
          });
        } catch (sysErr) {
          console.warn(
            '[Daemon] Failed to write system error message after spawn failure:',
            sysErr
          );
        }

        try {
          app.service('tasks').emit('failed', {
            task_id: taskId,
            session_id: sessionId,
            error_message: errorMessage,
          });
        } catch (emitErr) {
          console.warn('[Daemon] Failed to emit tasks:failed event:', emitErr);
        }
      }
    });

    return updatedTask;
  }

  // ============================================================================
  // Prompt endpoint
  // ============================================================================

  registerLongAuthenticatedRoute(
    app,
    '/sessions/:id/prompt',
    {
      async create(
        data: {
          prompt: string;
          permissionMode?: import('@agor/core/types').PermissionMode;
          stream?: boolean;
          messageSource?: MessageSource;
          /**
           * Internal-only task metadata merged onto the queued/created task.
           * Used by daemon callers (e.g. widget submissions) to stamp
           * traceability fields like `system_authored` / `widget_id`.
           * External transports are rejected, and the metadata builder also
           * strips every internal field defensively for untrusted callers.
           */
          metadata?: InternalPromptTaskMetadataInput;
          /**
           * Internal-only stable task identity for idempotent producers such
           * as the scheduler. External callers may not set this field.
           */
          idempotencyTaskId?: UUID;
        },
        params: RouteParams
      ) {
        console.log(
          `📨 [Daemon] Prompt request for session ${params.route?.id ? shortId(params.route.id) : 'unknown'}`
        );
        console.log(`   Permission mode: ${data.permissionMode || 'not specified'}`);
        console.log(`   Streaming: ${data.stream !== false}`);
        console.log(`   Message source: ${data.messageSource || 'not specified'}`);

        let id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!data.prompt) throw new Error('Prompt required');
        if (data.idempotencyTaskId && params.provider) {
          throw new Forbidden('idempotencyTaskId is internal-only');
        }
        if (data.metadata !== undefined && params.provider) {
          throw new Forbidden('Task metadata is internal-only');
        }
        const promptTenantId = getCurrentTenantId();
        if (!promptTenantId) throw new Error('Missing active tenant context for prompt admission');

        // Derive external provenance server-side. Only provider-less,
        // daemon-internal producers may preserve an explicit gateway source.
        const messageSource = normalizeMessageSource(data.messageSource, params);
        if (messageSource !== data.messageSource && data.messageSource !== undefined) {
          console.warn(
            `[Daemon] Ignored caller-supplied messageSource: ${data.messageSource}; using ${messageSource ?? 'no source'}`
          );
        }

        const requestedSessionId = id;
        let session = await runWithTenantDatabaseScope(db, promptTenantId, () =>
          sessionsService.get(requestedSessionId, params)
        );
        id = session.session_id;
        const taskRepo = bindRepositoryToTenantUnitOfWork(db, new TaskRepository(db));

        // Branch RBAC — fail fast before admitting a Task. This route creates
        // its Task via `taskRepo.createPending` (repository admission), which
        // deliberately bypasses `TasksService.create` and therefore its
        // `ensureCanPromptInSession` hook. Without this check a 'session'-tier
        // collaborator prompting ANOTHER user's session is admitted rather than
        // rejected: the Task queues and the executor then runs under the session
        // OWNER's identity/home (in `unix_user_mode: sandbox`, the owner's
        // per-user home store), so the prompt either silently impersonates the
        // owner or stalls into a hung task instead of returning a clean 403.
        // Mirrors the `/tasks/:id/run` (~L1832) and upload (~L2233) routes.
        // The same check runs again inside the durable Task-admission
        // transaction below; this first pass is only a low-latency rejection.
        const promptBranchId = session.branch_id;
        const isPromptServiceAccount =
          (params.user as { _isServiceAccount?: boolean } | undefined)?._isServiceAccount === true;
        const promptUserId = params.user?.user_id as UUID | undefined;
        const assertCurrentPromptAuthority = async (
          operationDb: TenantScopedDatabase,
          currentSession: Session
        ): Promise<void> => {
          if (!branchRbacEnabled || isPromptServiceAccount || !currentSession.branch_id) return;
          if (!promptUserId) {
            throw new NotAuthenticated('Authentication required to prompt a session');
          }
          const scopedBranchRepository = new BranchRepository(operationDb);
          const branch = await scopedBranchRepository.findById(currentSession.branch_id);
          if (!branch) {
            throw new NotFound(`Branch ${currentSession.branch_id} not found`);
          }
          const { allowed, denialReason } = await resolveSessionPromptAccess({
            branchRepository: scopedBranchRepository,
            branch,
            session: currentSession,
            userId: promptUserId,
          });
          if (!allowed) {
            throw new Forbidden(sessionPromptDeniedMessage({ denial_reason: denialReason }));
          }
        };
        if (branchRbacEnabled && !isPromptServiceAccount && promptBranchId) {
          await runWithTenantDatabaseScope(db, promptTenantId, (operationDb) =>
            assertCurrentPromptAuthority(operationDb, session)
          );
        }

        const reconcileDurablyDispatchedTask = async (): Promise<Task | null> => {
          if (!data.idempotencyTaskId) return null;
          const prior = await taskRepo.findById(data.idempotencyTaskId);
          if (!prior) return null;
          if (prior.session_id !== id) {
            throw new Conflict(`Task identity ${data.idempotencyTaskId} is already in use`);
          }
          const expectedCreator = params.user?.user_id ?? session.created_by;
          if (prior.created_by !== expectedCreator || prior.full_prompt !== data.prompt) {
            throw new Conflict(`Task identity ${data.idempotencyTaskId} is already in use`);
          }
          if (isTaskPendingDispatch(prior)) return null;

          await reconcileStableInitialUserMessage(
            prior,
            params,
            prior.metadata?.initial_message_id ?? (data.idempotencyTaskId as MessageID)
          );
          return prior;
        };

        // Scheduled recovery is reconciliation, not a fresh launch admission,
        // once its stable Task has crossed the durable dispatch fence. Return
        // that Task before consulting mutable tool/preset/user configuration.
        const durableTask = await reconcileDurablyDispatchedTask();
        if (durableTask) return durableTask;

        try {
          const activeAgenticTool = requireActiveAgenticTool(session.agentic_tool);
          if (!(await isAgenticToolEnabledForTenant(db, promptTenantId, activeAgenticTool))) {
            throw new Forbidden(`${activeAgenticTool} is disabled for this workspace`);
          }
          session = await runWithTenantDatabaseScope(db, promptTenantId, () =>
            sessionsService.materializeAgenticToolPreset(session, params)
          );
          if (
            session.agentic_tool_preset_id &&
            data.permissionMode !== undefined &&
            data.permissionMode !== session.permission_config?.mode
          ) {
            throw new Forbidden('Preset-backed sessions cannot override permission mode per task');
          }
        } catch (error) {
          // Another daemon can cross the dispatch fence between the first
          // stable-Task read and launch admission. Re-check before surfacing a
          // mutable configuration failure; the winner no longer needs launch.
          const concurrentlyDurableTask = await reconcileDurablyDispatchedTask();
          if (concurrentlyDurableTask) return concurrentlyDurableTask;
          throw error;
        }

        // Auto-unarchive on prompt
        if (session.archived) {
          console.log(
            `📦 [Prompt] Auto-unarchiving session ${shortId(id)} (was archived: ${session.archived_reason || 'unknown reason'})`
          );
          session = (await runWithTenantDatabaseScope(db, promptTenantId, () =>
            sessionsService.patch(id, { archived: false, archived_reason: undefined }, params)
          )) as typeof session;
        }

        if (session.status === SessionStatus.STOPPING) {
          throw new Error('Cannot send prompt: session is currently stopping');
        }

        // Every prompt first takes one durable queue position. The subsequent
        // Session+Task database claim decides whether this Task leaves the
        // queue immediately or remains queued. This avoids a split
        // read-session/create-CREATED race: two daemons can admit concurrently,
        // but only the durable head can claim the idle Session.
        if (!params.user?.user_id) {
          throw new NotAuthenticated('Authentication required to prompt a session');
        }
        const createdBy = params.user.user_id;

        return await withSessionTurnLock(
          sessionTurnLocks,
          id as SessionID,
          async () => {
            let lockedSession = await runWithTenantDatabaseScope(db, promptTenantId, () =>
              sessionsService.get(id, params)
            );
            if (lockedSession.status === SessionStatus.STOPPING) {
              // The earlier STOPPING check was against pre-lock state — re-check
              // here so a session that entered STOPPING while we waited for our
              // turn doesn't accept a prompt.
              throw new Error('Cannot send prompt: session is currently stopping');
            }
            lockedSession = await reconcileSessionPromptStateIfStuck(
              lockedSession,
              taskRepo,
              params
            );

            const prior = data.idempotencyTaskId
              ? await taskRepo.findById(data.idempotencyTaskId)
              : null;
            if (prior && prior.session_id !== id) {
              throw new Conflict(`Task identity ${data.idempotencyTaskId} is already in use`);
            }

            const taskMetadata = buildPromptTaskMetadata(data.metadata, messageSource, createdBy, {
              trustedInternalMetadata: !params.provider,
            });
            if (data.idempotencyTaskId) {
              taskMetadata.initial_message_id = data.idempotencyTaskId as MessageID;
            }
            if (params._taskCompletionCallback) {
              taskMetadata.completion_callback = params._taskCompletionCallback;
            }
            const task = await runWithTenantDatabaseTransaction(
              db,
              promptTenantId,
              async (operationDb) => {
                // Serialize against user/group and capability-policy mutations,
                // then re-authorize at the exact durable admission boundary.
                await lockTenantAuthorizationFence(operationDb, params);
                if (!isPromptServiceAccount) {
                  const current = await resolveCurrentTenantAuthorityActor(operationDb, params);
                  if (current.service || !hasMinimumRole(current.role, ROLES.MEMBER)) {
                    throw new Forbidden('Member access is required to prompt a session');
                  }
                }
                const admissionSession = (await sessionsService.get(id, params)) as Session;
                await assertCurrentPromptAuthority(operationDb, admissionSession);
                return new TaskRepository(operationDb).createPending({
                  task_id: data.idempotencyTaskId,
                  session_id: id as SessionID,
                  full_prompt: data.prompt,
                  created_by: createdBy,
                  status: TaskStatus.QUEUED,
                  metadata: Object.keys(taskMetadata).length > 0 ? taskMetadata : undefined,
                });
              }
            );
            await tasksService.autoTitleSession(task, params);

            if (!prior) {
              // Repository admission bypasses TasksService.create. Publish the
              // entity before its possible patched/dispatch event so reactive
              // clients observe a coherent lifecycle.
              emitServiceEvent(app, {
                path: 'tasks',
                event: 'created',
                data: task,
                params,
                id: task.task_id,
              });
            }

            const admitted = await spawnTaskExecutor(
              task,
              {
                permissionMode: data.permissionMode,
                stream: data.stream !== false,
                messageSource,
                ...(data.idempotencyTaskId
                  ? { stableInitialMessageId: data.idempotencyTaskId as MessageID }
                  : {}),
              },
              params
            );

            if (admitted.status === TaskStatus.QUEUED) {
              console.log(
                `📬 [Prompt] Queued task for session ${shortId(id)} at position ${admitted.queue_position} ` +
                  `(observed session status: ${lockedSession.status})`
              );
              app.service('tasks').emit('queued', admitted);

              // Immediate triggers are a latency hint. Durable all-daemon
              // discovery remains the recovery path if this process dies or
              // another claim changes the Session after our observation.
              deferInFreshTenantScope(params, async () => {
                try {
                  await sessionsService.triggerQueueProcessing(id as SessionID, params);
                } catch (error) {
                  console.error(`❌ [Prompt] Failed to trigger queued Task processing:`, error);
                }
              });
            }

            // Uniform response: QUEUED means durable wait; DISPATCHING/RUNNING
            // means this or another daemon already won the launch claim.
            return admitted;
          },
          { waiterTimeoutMs: 30_000 }
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'execute prompts' },
    },
    requireAuth
  );

  // ============================================================================
  // Task run endpoint
  //
  // Explicit executor trigger for an already-created task. Lets pure-REST
  // harnesses (Python, Go, shell+curl — anything without an MCP client) drive
  // the executor by POSTing a Task row first (`POST /tasks`) and then poking
  // it awake here. Wraps `spawnTaskExecutor` via `runExistingTask` (status
  // revalidation) under `withSessionTurnLock` — the same shared session-level
  // mutex that `/sessions/:id/prompt`'s idle branch and the queue drainer
  // also acquire — so the on-the-wire effect is identical to "create a task
  // and run it now."
  //
  // Only CREATED tasks on IDLE sessions are accepted. QUEUED tasks are
  // rejected with a hint to wait for the queue drainer (running them out of
  // order would violate the queue-position invariant); busy sessions are
  // rejected with a hint to use `POST /sessions/:id/prompt` (which owns the
  // atomic create-and-queue path). Splitting the two responsibilities keeps
  // this endpoint a narrow "run this thing now" trigger.
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/tasks/:id/run',
    {
      async create(
        data: {
          permissionMode?: import('@agor/core/types').PermissionMode;
          stream?: boolean;
          messageSource?: MessageSource;
        },
        params: RouteParams
      ) {
        const taskId = params.route?.id;
        if (!taskId) throw new BadRequest('Task ID required');

        const taskRepo = new TaskRepository(db);
        const task = await taskRepo.findById(taskId);
        if (!task) {
          throw new NotFound(`Task ${taskId} not found`);
        }

        // Only CREATED tasks may be triggered. QUEUED tasks must drain in
        // queue-position order via the queue processor — running them out of
        // order would violate the invariant documented in
        // `context/concepts/task-queueing.md`. Terminal/in-flight states are
        // rejected so the caller doesn't try to revive a finished task or
        // race a live executor.
        if (task.status !== TaskStatus.CREATED) {
          const hint =
            task.status === TaskStatus.QUEUED
              ? `Queued tasks drain automatically in queue-position order ` +
                `when the session becomes idle — wait for it, or stop the ` +
                `currently running task to free the queue.`
              : `Only 'created' tasks may be triggered.`;
          throw new Conflict(
            `Task ${shortId(taskId)} cannot be run: status is '${task.status}'. ${hint}`
          );
        }

        // Branch RBAC — defense in depth. Without this, a member with
        // 'view' permission could trigger execution; the eventual
        // `tasks.patch` inside spawnTaskExecutor would still 403 via the
        // `ensureCanPromptInSession` hook, but only after we'd done extra
        // work and emitted partial state. Mirrors the upload route's
        // pattern (~L1467) and `ensureCanPromptInSession` semantics —
        // including the service-account / no-provider bypasses so executor
        // callbacks aren't held to the same checks as user requests.
        const isInternalCall = !params.provider;
        const isServiceAccount =
          (params.user as { _isServiceAccount?: boolean } | undefined)?._isServiceAccount === true;
        if (!isInternalCall && !isServiceAccount) {
          // A collaborator may prompt this Session, but cannot take over a
          // pre-created Task whose credential/audit identity belongs to a
          // different user. `/sessions/:id/prompt` creates a caller-owned Task.
          assertTaskExecutorPrincipal(task, params);
        }
        if (branchRbacEnabled && task.session_id && !isInternalCall && !isServiceAccount) {
          const session = await sessionsService.get(task.session_id, params);
          if (!session.branch_id) {
            // Sessions without branches are out of RBAC scope; fall through.
          } else {
            const userId = params.user?.user_id as UUID | undefined;
            if (!userId) {
              throw new Forbidden('Authentication required to run tasks');
            }
            const wt = await branchRepository.findById(session.branch_id);
            if (!wt) {
              throw new NotFound(`Branch ${session.branch_id} not found`);
            }
            const { allowed, effectiveLevel, denialReason } = await resolveSessionPromptAccess({
              branchRepository,
              branch: wt,
              session,
              userId,
            });
            if (!allowed) {
              throw new Forbidden(
                `${sessionPromptDeniedMessage({ denial_reason: denialReason })} ` +
                  `(Current branch permission: '${effectiveLevel}'.)`
              );
            }
          }
        }

        // The local lock coalesces same-process contenders. The repository's
        // Session-first dispatch claim is authoritative against other daemons
        // and also refuses to jump a durable prompt queue.
        return await withSessionTurnLock(
          sessionTurnLocks,
          task.session_id,
          async () => {
            // Re-read session state inside the lock — it may have flipped to
            // RUNNING while we waited for our turn.
            const session = await reconcileSessionPromptStateIfStuck(
              await sessionsService.get(task.session_id, params),
              taskRepo,
              params,
              { ignoredTaskIds: [task.task_id] }
            );

            if (session.status === SessionStatus.STOPPING) {
              throw new BadRequest('Cannot run task: session is currently stopping');
            }
            if (!sessionCanStartTask(session.status, session.ready_for_prompt)) {
              throw new Conflict(
                `Cannot run task ${shortId(taskId)}: session is '${session.status}'. ` +
                  `To enqueue a prompt on a busy session, POST to /sessions/:id/prompt instead — ` +
                  `it creates and queues a task atomically.`
              );
            }

            const result = await runExistingTask(
              task,
              {
                permissionMode: data.permissionMode,
                stream: data.stream !== false,
                messageSource: normalizeMessageSource(data.messageSource, params),
              },
              params,
              {
                findTaskById: (id) => taskRepo.findById(id),
                spawnFn: spawnTaskExecutor,
              }
            );
            if (result.status === TaskStatus.CREATED) {
              throw new Conflict(
                `Cannot run task ${shortId(taskId)}: another Task or queued prompt owns the Session turn.`
              );
            }
            return result;
          },
          { waiterTimeoutMs: 30_000 }
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'execute prompts' },
    },
    requireAuth
  );

  // ============================================================================
  // Spawn-subsession prompt endpoint
  //
  // Renders the bundled spawn-subsession meta-prompt server-side and forwards
  // it to /sessions/:id/prompt in a single round-trip. Clients send raw
  // `{userPrompt, config}` instead of doing the render-then-prompt dance.
  // The daemon owns the meta-prompt template, so the UI bundle stays
  // Handlebars-free.
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/spawn-prompt',
    {
      async create(
        data: {
          userPrompt?: string;
          /**
           * Permission mode for the *parent* session's prompt. The spawn
           * config's `permissionMode` (child's intended mode) is rendered into
           * the meta-prompt; this field governs how the parent prompt is sent.
           */
          parentPermissionMode?: import('@agor/core/types').PermissionMode;
          // Remaining fields are spawn-subsession context (incl. the *child*
          // session's permissionMode/modelConfig/etc) — see
          // `SpawnSubsessionContext` in @agor/core for the shape.
          [key: string]: unknown;
        },
        params: RouteParams
      ) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        if (typeof data?.userPrompt !== 'string') {
          throw new BadRequest('userPrompt (string) is required');
        }

        const { renderSpawnSubsessionPrompt } = await import(
          '@agor/core/templates/spawn-subsession-template'
        );
        // Render the meta-prompt against the child-session config (the rest
        // of `data`). `parentPermissionMode` is intentionally excluded — it's
        // the parent's send-mode, not part of the template.
        const { parentPermissionMode, ...spawnContext } = data;
        const metaPrompt = renderSpawnSubsessionPrompt(
          spawnContext as unknown as import('@agor/core/templates/spawn-subsession-template').SpawnSubsessionContext
        );

        const promptService = app.service('/sessions/:id/prompt');
        return promptService.create(
          {
            prompt: metaPrompt,
            permissionMode: parentPermissionMode,
            messageSource: 'agor',
            metadata: { system_authored: true },
          },
          { ...params, provider: undefined, route: { id } }
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'send spawn-subsession prompts' },
    },
    requireAuth
  );

  // ============================================================================
  // Zone-trigger fire endpoint (always_new behaviour)
  //
  // Daemon is the source of truth for the zone's trigger template / agent /
  // label — the UI only sends the zone id. The shared
  // `fireAlwaysNewZoneTrigger` helper (also used by the MCP
  // `agor_branches_set_zone(triggerTemplate: true)` always_new branch)
  // does render → validate → resolve defaults → create session → attach MCPs
  // → prompt in one round-trip.
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/branches/:id/fire-zone-trigger',
    {
      async create(data: { zoneId?: string }, params: RouteParams) {
        const branchId = params.route?.id;
        if (!branchId) throw new BadRequest('Branch ID required');
        if (typeof data?.zoneId !== 'string' || !data.zoneId.trim()) {
          throw new BadRequest('zoneId (string) is required');
        }

        const branch = await app.service('branches').get(branchId, params);
        if (!branch.board_id) {
          throw new BadRequest('Branch is not on a board; cannot resolve zone');
        }
        const board = await app.service('boards').get(branch.board_id, params);

        // Zones live on `board.objects` keyed by zone id; type === 'zone'.
        const zoneObj = (board as { objects?: Record<string, unknown> }).objects?.[data.zoneId] as
          | {
              type?: string;
              label?: string;
              status?: string;
              trigger?: {
                template?: string;
                agent?: import('@agor/core/types').AgenticToolName;
                behavior?: string;
              };
            }
          | undefined;
        if (zoneObj?.type !== 'zone') {
          throw new BadRequest(`Zone ${data.zoneId} not found on board ${branch.board_id}`);
        }
        if (zoneObj.trigger?.behavior !== 'always_new') {
          // This endpoint is the always_new server-side action. show_picker
          // zones flow through the modal-driven explicit-target path, not this
          // route — refuse instead of silently creating a session.
          throw new BadRequest(
            `Zone "${zoneObj.label}" trigger behaviour is "${zoneObj.trigger?.behavior}", expected "always_new"`
          );
        }

        const userId = params.user?.user_id;
        if (!userId) throw new BadRequest('Authenticated user required');
        const user = await app.service('users').get(userId, params);

        const { fireAlwaysNewZoneTrigger } = await import('./services/zone-trigger.js');
        try {
          return await fireAlwaysNewZoneTrigger({
            app,
            params,
            branch,
            board,
            zone: zoneObj,
            user,
            userId: userId as string,
          });
        } catch (err) {
          // Surface helper validation errors as BadRequest for HTTP semantics.
          const message = err instanceof Error ? err.message : String(err);
          throw new BadRequest(message);
        }
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'fire zone triggers' },
    },
    requireAuth
  );

  // ============================================================================
  // File upload endpoint
  // ============================================================================

  const branchRepo = new BranchRepository(db);
  const uploadRepo = new UploadRepository(db);
  const uploadMiddleware = createUploadMiddleware(getUploadStagingStore());

  // Executor-only data plane for staged upload materialization. The bounded
  // delegated-user command token stays in the Authorization header (never
  // URL/query/logs) and binds exactly one tenant + branch + session + handle.
  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on FeathersJS Application type
  (app as any).get('/executor/uploads/:uploadRef/content', async (req: any, res: any) => {
    try {
      const authHeader = req.headers.authorization;
      if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const params = await authenticateBearerHttpRequest({
        authentication: app.service('authentication'),
        multiTenancy,
        headers: req.headers,
        token: authHeader.slice(7),
      });
      const claims = params.authentication?.payload as Record<string, unknown> | undefined;
      const uploadRef = req.params.uploadRef;
      const sessionId = String(req.headers['x-agor-session-id'] ?? '');
      const branchId = claims?.branch_id;
      const tenant = params.tenant;
      if (
        typeof branchId !== 'string' ||
        !tenant?.tenant_id ||
        !sessionId ||
        !matchesExecutorCommandRuntimeScope(
          params,
          uploadMaterializeExecutorCommandId(sessionId, uploadRef),
          branchId
        )
      ) {
        return res.status(403).json({ error: 'Upload transfer capability denied' });
      }
      const store = getUploadStagingStore();
      const owner = {
        tenantId: tenant.tenant_id,
        sessionId: sessionId as SessionID,
        branchId: branchId as import('@agor/core/types').BranchID,
        ref: uploadRef as import('@agor/core/types').UploadRef,
      };
      const metadata = await store.inspect(owner);
      const stream = await store.read(owner);
      res.status(200);
      res.setHeader('Content-Type', metadata.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', String(metadata.size));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      stream.once('error', (error) => {
        if (!res.headersSent) res.status(500);
        res.destroy(error as Error);
      });
      res.once('close', () =>
        (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
      );
      stream.pipe(res);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 404;
      if (!res.headersSent) res.status(status).json({ error: 'Upload transfer unavailable' });
      else res.destroy();
    }
  });

  // Raw streaming executor -> daemon Slack upload data plane. Metadata is
  // bounded in headers; file bytes never enter Feathers/JSON/base64.
  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on FeathersJS Application type
  (app as any).post('/executor/gateway/slack-file-upload', async (req: any, res: any) => {
    try {
      const authHeader = req.headers.authorization;
      if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const params = await authenticateBearerHttpRequest({
        authentication: app.service('authentication'),
        multiTenancy,
        headers: req.headers,
        token: authHeader.slice(7),
      });
      const claims = params.authentication?.payload as Record<string, unknown> | undefined;
      const gatewayChannelId = String(req.headers['x-agor-gateway-channel-id'] ?? '');
      const channel = String(req.headers['x-agor-slack-channel-id'] ?? '');
      const size = Number.parseInt(String(req.headers['content-length'] ?? ''), 10);
      const branchId = claims?.branch_id;
      if (
        typeof branchId !== 'string' ||
        !matchesExecutorCommandRuntimeScope(
          params,
          gatewaySlackUploadExecutorCommandId(gatewayChannelId, channel),
          branchId
        ) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > getUploadLimits().maxFileBytes
      ) {
        return res.status(403).json({ error: 'Slack upload capability denied' });
      }
      let received = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.byteLength;
          if (received > size || received > getUploadLimits().maxFileBytes) {
            callback(new Error('Slack upload stream exceeds its authorized size'));
            return;
          }
          callback(null, chunk);
        },
        flush(callback) {
          callback(received === size ? undefined : new Error('Slack upload stream size mismatch'));
        },
      });
      req.pipe(limiter);
      const uploaded = await (
        app.service(
          'gateway-channels'
        ) as unknown as import('./services/gateway-channels.js').GatewayChannelsService
      ).uploadFileStreamFromExecutor(
        {
          gatewayChannelId,
          channel,
          size,
          filename: decodeURIComponent(String(req.headers['x-agor-filename'] ?? 'upload')),
          ...(req.headers['x-agor-thread-ts']
            ? { threadTs: String(req.headers['x-agor-thread-ts']) }
            : {}),
          ...(req.headers['x-agor-comment']
            ? { comment: decodeURIComponent(String(req.headers['x-agor-comment'])) }
            : {}),
        },
        limiter,
        params
      );
      res.json({ uploaded });
    } catch (error) {
      const status = (error as { code?: number }).code ?? 400;
      res.status(status).json({ error: error instanceof Error ? error.message : 'Upload failed' });
    }
  });
  const DEBUG_UPLOAD = process.env.AGOR_DEBUG_UPLOAD === 'true';

  // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
  const authorizeUpload: any = async (req: any, res: any, next: any) => {
    try {
      const { sessionId } = req.params;
      const params = req.feathers as AuthenticatedParams;

      ensureMinimumRole(params, ROLES.MEMBER, 'upload files');

      const session = await runWithTenantDatabaseScope(db, params.tenant?.tenant_id, () =>
        sessionsService.get(sessionId, params)
      );
      if (!session) {
        console.error(`❌ [Upload Authz] Session not found: ${shortId(sessionId)}`);
        return res.status(404).json({ error: 'Session not found' });
      }

      // Branch RBAC: mirror ensureCanPromptInSession semantics.
      // - 'prompt'/'all' → upload to any session
      // - 'session'      → upload only to own sessions
      // - 'view'/'none'  → denied
      // Fail-closed: if RBAC is enabled but branch can't be resolved, deny.
      // When RBAC is disabled, any authenticated member can upload.
      if (branchRbacEnabled) {
        const userId = params.user?.user_id as UUID;
        if (!session.branch_id) {
          return res.status(403).json({ error: 'Not authorized to upload to this session' });
        }
        const access = await runWithTenantDatabaseScope(db, params.tenant?.tenant_id, async () => {
          const wt = await branchRepo.findById(session.branch_id);
          if (!wt) return null;
          return { wt };
        });
        if (!access) {
          return res.status(404).json({ error: 'Branch not found' });
        }
        const { wt } = access;
        const { allowed, effectiveLevel } = await resolveSessionPromptAccess({
          branchRepository: branchRepo,
          branch: wt,
          session,
          userId,
        });

        if (!allowed) {
          console.error(
            `❌ [Upload Authz] User ${shortId(userId)} has '${effectiveLevel}' permission, cannot upload to branch ${shortId(wt.branch_id)}`
          );
          return res.status(403).json({ error: 'Not authorized to upload to this session' });
        }
      }

      if (!params.tenant?.tenant_id || !params.user?.user_id || !session.branch_id) {
        return res.status(403).json({ error: 'Upload ownership context unavailable' });
      }
      req._uploadOwner = {
        tenantId: params.tenant.tenant_id,
        sessionId: session.session_id,
        branchId: session.branch_id,
        createdBy: params.user.user_id,
      };
      next();
    } catch (error) {
      next(error);
    }
  };

  // biome-ignore lint/suspicious/noExplicitAny: Express 5 + multer type compatibility
  const uploadHandler: any = async (req: any, res: any, next: any) => {
    try {
      if (DEBUG_UPLOAD) {
        console.log('🚀 [Upload Handler] Request received');
        console.log('   Headers:', {
          contentType: req.headers['content-type'],
          authorization: req.headers.authorization ? 'present' : 'missing',
          cookie: req.headers.cookie ? 'present' : 'missing',
        });
      }

      const { sessionId } = req.params;
      const { notifyAgent, message } = req.body;
      const files = req.files as StagedMulterFile[];

      if (DEBUG_UPLOAD) {
        console.log(
          `📎 [Upload Handler] Processing for session ${sessionId ? shortId(sessionId) : 'unknown'}`
        );
        console.log(`   Notify agent: ${notifyAgent === 'true' || notifyAgent === true}`);
        console.log(`   Files received: ${files?.length || 0}`);
      }

      const params = req.feathers as AuthenticatedParams;
      if (DEBUG_UPLOAD) {
        console.log(`   Auth params:`, {
          hasUser: !!params?.user,
          userId: params?.user?.user_id ? shortId(params.user.user_id) : undefined,
          provider: params?.provider,
        });
      }

      if (!files || files.length === 0) {
        console.error('❌ [Upload Handler] No files in request');
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const uploadedFiles = files.map((staged) => ({
        ref: staged.ref,
        filename: staged.name,
        size: staged.size,
        mimeType: staged.mimeType,
        createdAt: staged.createdAt,
        expiresAt: staged.expiresAt,
      }));

      if (DEBUG_UPLOAD) {
        console.log(`   Uploaded ${uploadedFiles.length} file(s):`);
        console.log(`   Total bytes: ${uploadedFiles.reduce((sum, f) => sum + f.size, 0)}`);
      }

      let notificationError: string | null = null;
      if ((notifyAgent === 'true' || notifyAgent === true) && message) {
        try {
          const handles = uploadedFiles.map((f) => f.ref).join(', ');
          const promptText = message.replace(/\{filepath\}/g, handles);

          if (DEBUG_UPLOAD) {
            console.log('   Sending upload notification to agent');
          }

          const promptService = app.service('/sessions/:id/prompt');
          // biome-ignore lint/suspicious/noExplicitAny: Express 5 + FeathersJS type mismatch
          const promptParams: any = {
            route: { id: sessionId },
            user: params.user,
            authentication: params.authentication,
            tenant: params.tenant,
          };
          // This provider-less nested service call represents text submitted
          // by the authenticated uploader, not daemon-authored automation.
          await promptService.create({ prompt: promptText, messageSource: 'agor' }, promptParams);
        } catch (_error) {
          console.error('❌ [Upload Handler] Failed to notify agent');
          notificationError = 'Failed to send notification to agent';
        }
      }

      res.json({
        success: true,
        files: uploadedFiles,
        ...(notificationError && { warning: notificationError }),
      });
    } catch (error) {
      next(error);
    }
  };

  // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
  const uploadLogger: any = (req: any, res: any, next: any) => {
    if (DEBUG_UPLOAD) {
      console.log('📥 [Upload Route] Request received');
      console.log('   Method:', req.method);
      console.log('   Route: session upload');
      console.log('   Content-Type:', req.headers['content-type']);
      console.log('   Has auth header:', !!req.headers.authorization);
      console.log(
        '   Session ID param:',
        req.params.sessionId ? shortId(req.params.sessionId) : 'unknown'
      );
    }
    next();
  };

  const uploadAuthMiddleware = createUploadAuthMiddleware({
    authentication: app.service('authentication'),
    multiTenancy,
  });

  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on FeathersJS Application type
  (app as any).post(
    '/sessions/:sessionId/upload',
    uploadLogger,
    uploadAuthMiddleware,
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    ((req: any, res: any, next: any) => {
      if (DEBUG_UPLOAD) {
        console.log('✅ [Upload Route] Authentication passed');
        console.log(
          '   User:',
          req.feathers?.user?.user_id ? shortId(req.feathers.user.user_id) : 'unknown'
        );
      }
      next();
      // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    }) as any,
    // Cheap pre-multer Content-Length check — short-circuits before we spend
    // time writing oversize uploads to disk.
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    enforceTotalUploadSize() as any,
    authorizeUpload,
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 + multer type compatibility
    uploadMiddleware.array('files', 10) as any,
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    ((req: any, res: any, next: any) => {
      if (DEBUG_UPLOAD) {
        console.log('✅ [Upload Route] Multer processing complete');
        console.log('   Files parsed:', req.files?.length || 0);
      }
      next();
      // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    }) as any,
    uploadHandler,
    // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    ((err: any, req: any, res: any, next: any) => {
      console.error('❌ [Upload Route] Upload failed');
      res.status(err.status || 500).json({
        error: 'Upload failed',
      });
      // biome-ignore lint/suspicious/noExplicitAny: Express 5 type compatibility
    }) as any
  );

  type UploadHttpRequest = Request & {
    feathers?: AuthenticatedParams;
    params: { uploadRef: string };
  };
  const loadAuthorizedUpload = async (req: UploadHttpRequest) => {
    const params = req.feathers as AuthenticatedParams;
    const tenantId = params.tenant?.tenant_id;
    const userId = params.user?.user_id as UUID | undefined;
    if (!tenantId || !userId) throw new NotAuthenticated('Authentication required');
    const ref = req.params.uploadRef as import('@agor/core/types').UploadRef;
    const upload = await runWithTenantDatabaseScope(db, tenantId, () =>
      uploadRepo.findOwned(tenantId, ref)
    );
    if (upload?.status !== 'active') throw new NotFound('Upload unavailable');
    if (upload.expiresAt && Date.parse(upload.expiresAt) <= Date.now()) {
      throw new NotFound('Upload unavailable');
    }
    if (upload.createdBy === userId) return upload;
    if (!branchRbacEnabled) return upload;
    const allowed = await runWithTenantDatabaseScope(db, tenantId, async () => {
      const branch = await branchRepo.findById(upload.branchId);
      if (!branch) return false;
      const access = await branchRepo.resolveUserAccess(branch, userId);
      return access.is_owner || access.can !== 'none';
    });
    if (
      !allowed &&
      !(superadminOpts.allowSuperadmin && hasMinimumRole(params.user?.role, ROLES.SUPERADMIN))
    ) {
      throw new NotFound('Upload unavailable');
    }
    return upload;
  };

  // User Settings: owner-scoped logical upload inventory.
  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on Feathers Application
  (app as any).get(
    '/uploads',
    uploadAuthMiddleware,
    async (req: UploadHttpRequest, res: Response, next: NextFunction) => {
      try {
        const params = req.feathers as AuthenticatedParams;
        if (!params.tenant?.tenant_id || !params.user?.user_id) {
          throw new NotAuthenticated('Authentication required');
        }
        const tenantId = params.tenant.tenant_id;
        const userId = params.user.user_id as UUID;
        const uploads = await runWithTenantDatabaseScope(db, tenantId, () =>
          uploadRepo.listByUploader(tenantId, userId)
        );
        res.json({ uploads });
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on Feathers Application
  (app as any).get(
    '/uploads/:uploadRef/content',
    uploadAuthMiddleware,
    async (req: UploadHttpRequest, res: Response, next: NextFunction) => {
      try {
        const upload = await loadAuthorizedUpload(req);
        const store = getUploadStagingStore();
        const readOwner = {
          tenantId: upload.tenantId,
          sessionId: upload.sessionId,
          branchId: upload.branchId,
          ref: upload.ref,
        };
        let offset = 0;
        let length: number | undefined;
        const range = req.headers.range;
        if (typeof range === 'string') {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (!match) return res.status(416).end();
          offset = Number(match[1]);
          const end = match[2] ? Number(match[2]) : upload.size - 1;
          if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(end) ||
            end < offset ||
            offset >= upload.size
          ) {
            return res.status(416).end();
          }
          length = Math.min(end, upload.size - 1) - offset + 1;
          res.status(206);
          res.setHeader('Content-Range', `bytes ${offset}-${offset + length - 1}/${upload.size}`);
        }
        const stream = await store.read({ ...readOwner, offset, ...(length ? { length } : {}) });
        res.setHeader('Content-Type', upload.mimeType || 'application/octet-stream');
        res.setHeader('Content-Length', String(length ?? upload.size));
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const safeInline = new Set([
          'image/png',
          'image/jpeg',
          'image/gif',
          'image/webp',
          'application/pdf',
        ]);
        res.setHeader(
          'Content-Disposition',
          `${safeInline.has(upload.mimeType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(upload.displayName)}`
        );
        stream.once('error', (error) => res.destroy(error as Error));
        res.once('close', () =>
          (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
        );
        stream.pipe(res);
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on Feathers Application
  (app as any).delete(
    '/uploads/:uploadRef',
    uploadAuthMiddleware,
    async (req: UploadHttpRequest, res: Response, next: NextFunction) => {
      try {
        const upload = await loadAuthorizedUpload(req);
        const params = req.feathers as AuthenticatedParams;
        if (
          upload.createdBy !== params.user?.user_id &&
          !hasMinimumRole(params.user?.role, ROLES.ADMIN)
        ) {
          throw new NotFound('Upload unavailable');
        }
        await getUploadStagingStore().delete({
          tenantId: upload.tenantId,
          sessionId: upload.sessionId,
          branchId: upload.branchId,
          ref: upload.ref,
        });
        await runWithTenantDatabaseScope(db, upload.tenantId, () =>
          uploadRepo.remove(upload.tenantId, upload.ref)
        );
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on Feathers Application
  (app as any).patch(
    '/uploads/:uploadRef',
    uploadAuthMiddleware,
    async (req: UploadHttpRequest, res: Response, next: NextFunction) => {
      try {
        const upload = await loadAuthorizedUpload(req);
        const params = req.feathers as AuthenticatedParams;
        if (
          upload.createdBy !== params.user?.user_id &&
          !hasMinimumRole(params.user?.role, ROLES.ADMIN)
        ) {
          throw new NotFound('Upload unavailable');
        }
        const displayName =
          typeof req.body?.displayName === 'string'
            ? req.body.displayName
                .split('')
                .filter((character: string) => {
                  const code = character.charCodeAt(0);
                  return code >= 32 && code !== 127;
                })
                .join('')
                .trim()
                .slice(0, 200)
            : '';
        if (!displayName) throw new BadRequest('displayName is required');
        const updated = await runWithTenantDatabaseScope(db, upload.tenantId, () =>
          uploadRepo.rename(upload.tenantId, upload.ref, displayName)
        );
        res.json({ upload: updated });
      } catch (error) {
        next(error);
      }
    }
  );

  // ============================================================================
  // Stop endpoint
  // ============================================================================

  // Stop coordinates durable state with an external executor and may wait for
  // its socket acknowledgement. It must not hold the route-wide tenant DB
  // transaction while waiting: emitServiceEvent correctly defers realtime
  // publication until commit, so a long transaction here would withhold the
  // Stop event until after the cooperative grace expired and containment had
  // already fallen back to SIGTERM. Internal service calls still use their
  // normal short tenant transactions.
  registerLongAuthenticatedRoute(
    app,
    '/sessions/:id/stop',
    {
      async create(data: unknown, params: RouteParams): Promise<SessionStopResult> {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
        const sessionsServiceWithHooks = app.service('sessions') as unknown as SessionsServiceImpl;
        const terminationTenantId = getCurrentTenantId();
        const runInFreshTerminationTenantWriteDatabase = <T>(work: () => Promise<T>) =>
          withFreshTenantWrite(db, terminationTenantId, work);
        const session = await inCurrentTenantDatabaseScope(() =>
          app.service('sessions').get(id, params)
        );

        // Stop is Session lifecycle control. Managers may stop any Session on
        // the branch; collaborators may stop a foreign branch Session only
        // when the workspace and branch sharing switches allow them to prompt
        // it. Force-fail deliberately skips this check and applies its narrower
        // owner-or-admin policy below.
        if (
          body.force_unverified !== true &&
          branchRbacEnabled &&
          params.provider &&
          !(params.user as { _isServiceAccount?: boolean } | undefined)?._isServiceAccount
        ) {
          const stopUserId = params.user?.user_id as UUID | undefined;
          if (!stopUserId) {
            throw new NotAuthenticated('Authentication required to stop a session');
          }
          if (!session.branch_id) {
            throw new Forbidden('Not authorized to stop this session');
          }
          const access = await inCurrentTenantDatabaseScope(async () => {
            const branch = await branchRepository.findById(session.branch_id);
            if (!branch) return null;
            const branchAccess = await branchRepository.resolveUserAccess(branch, stopUserId);
            const { allowed: hasPromptAuthority } = await resolveSessionPromptAccess({
              branchRepository,
              branch,
              session,
              userId: stopUserId,
            });
            return { branchAccess, hasPromptAuthority };
          });
          if (!access) {
            throw new NotFound(`Branch ${session.branch_id} not found`);
          }
          const { hasPromptAuthority } = access;
          const isManager = access.branchAccess.can === 'all';
          const isGlobalSuperadmin =
            superadminOpts.allowSuperadmin && hasMinimumRole(params.user?.role, ROLES.SUPERADMIN);
          if (!hasPromptAuthority && !isManager && !isGlobalSuperadmin) {
            throw new Forbidden(
              session.created_by === stopUserId
                ? `Collaborator access is required to stop this session.`
                : `Manager access or permission from the session owner is required to stop this session.`
            );
          }
        }
        const triggerPreservedQueue = () => {
          deferInFreshTenantScope(params, async () => {
            try {
              await sessionsServiceWithHooks.triggerQueueProcessing(id as SessionID, params);
            } catch (error) {
              console.error(
                `❌ [Stop] Failed to process queue after stopping session ${shortId(id)}:`,
                error
              );
            }
          });
        };
        if (body.force_unverified === true) {
          const result = await withSessionTurnLock(sessionTurnLocks, id as SessionID, async () => {
            const target = await inCurrentTenantDatabaseScope(async () => {
              const session = await app.service('sessions').get(id, params);
              return authorizeForceFailRoute({
                session,
                params,
                body,
                findTask: async (taskId) => {
                  try {
                    return await app.service('tasks').get(taskId, params);
                  } catch (error) {
                    if (isNotFoundError(error)) return undefined;
                    throw error;
                  }
                },
                isBranchOwner: (branchId, userId) =>
                  stopRouteRepositories.branchRepo.isOwner(branchId, userId),
              });
            });
            const forceFail = await runInFreshTerminationTenantWriteDatabase(() =>
              forceFailUnverifiedTask({
                app,
                taskId: target.task.task_id,
                terminationRequestedAt: target.terminationRequestedAt,
                confirmation: target.confirmation,
                params,
              })
            );
            if (forceFail.outcome === 'already_terminal') {
              return {
                success: false as const,
                outcome: 'condition_changed' as const,
                reason: 'Task completed before force-fail could be applied.',
                stoppedTaskId: forceFail.task.task_id,
              };
            }
            return {
              success: true as const,
              outcome: 'force_failed' as const,
              status: TaskStatus.FAILED,
              stoppedTaskId: forceFail.task.task_id,
            };
          });
          triggerPreservedQueue();
          return result;
        }

        const stopReason = typeof body.reason === 'string' ? body.reason : undefined;
        if (body.expected_task_id !== undefined && !isCanonicalFullUuid(body.expected_task_id)) {
          throw new BadRequest('expected_task_id must be a canonical Task ID.');
        }
        const expectedTaskId = body.expected_task_id as TaskID | undefined;
        const result = await withSessionTurnLock(sessionTurnLocks, id as SessionID, async () =>
          stopSessionPreserveQueue(
            {
              app,
              taskRepo: stopRouteRepositories.taskRepo,
              sessionsService: sessionsServiceWithHooks,
              findActiveTasks: findActiveTasksForSession,
              runInTenantDatabaseScope: inCurrentTenantDatabaseScope,
              runInFreshTenantWriteDatabase: runInFreshTerminationTenantWriteDatabase,
            },
            id as SessionID,
            params,
            { reason: stopReason, expectedTaskId }
          )
        );

        if (result.success) {
          triggerPreservedQueue();
        }

        return result;
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'stop sessions' },
    },
    requireAuth
  );

  // ============================================================================
  // Queue listing — task-centric (was message-centric pre-never-lose-prompt).
  // The queue is the set of tasks with status='queued', ranked by
  // queue_position. Each queued task carries the full prompt + metadata; on
  // drain it transitions queued → dispatching via spawnTaskExecutor.
  //
  // Enqueueing goes through `POST /sessions/:id/prompt`: every admission first
  // takes a durable position, then the database claim decides whether it may
  // leave the queue immediately and reports the actual status to the caller.
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/tasks/queue',
    {
      async find(params: RouteParams) {
        const sessionId = params.route?.id;
        if (!sessionId) throw new Error('Session ID required');

        const taskQueueRepo = new TaskRepository(db);
        const queued = await taskQueueRepo.findQueued(sessionId as SessionID);

        return {
          total: queued.length,
          data: queued,
        };
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      find: { role: ROLES.MEMBER, action: 'view queue' },
    },
    requireAuth
  );

  // Queue processing implementation — task-centric. `sessionTurnLocks` and
  // `queueRetryScheduled` only coalesce duplicate work inside this daemon.
  // They may disappear on process death without losing correctness: the
  // durable queue head plus Session-first dispatch claim are authoritative,
  // and the all-daemon queue worker rediscovers missed work.
  const queueRetryScheduled = new Set<SessionID>();

  async function processNextQueuedTask(sessionId: SessionID, params: RouteParams): Promise<void> {
    await runWithSessionQueueTenantScope(
      {
        db,
        config,
        sessionId,
        params,
        label: 'processNextQueuedTask',
      },
      async (scopedParams) => processNextQueuedTaskInTenantScope(sessionId, scopedParams)
    );
  }

  async function processNextQueuedTaskInTenantScope(
    sessionId: SessionID,
    params: RouteParams
  ): Promise<void> {
    const existingLock = sessionTurnLocks.get(sessionId);
    if (existingLock) {
      console.log(`⏳ [Queue] Session turn in progress for ${shortId(sessionId)}, waiting...`);

      // Race the lock against a timeout. A half-open TCP connection can leave
      // a DB query pending forever, which holds the lock indefinitely and
      // deadlocks all subsequent prompts for this session. statement_timeout
      // (60s) handles normal cases; this is the client-side backstop.
      const LOCK_WAIT_TIMEOUT_MS = 65_000;
      const outcome = await Promise.race([
        existingLock.catch(() => undefined).then(() => 'released' as const),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), LOCK_WAIT_TIMEOUT_MS)
        ),
      ]);

      if (outcome === 'timeout') {
        console.error(
          `❌ [Queue] Session ${shortId(sessionId)}: turn lock held >${LOCK_WAIT_TIMEOUT_MS / 1000}s — ` +
            `holder may be stuck on a broken DB connection. Skipping this drain trigger; ` +
            `the next natural trigger (user prompt or task completion) will retry.`
        );
        return;
      }

      if (!queueRetryScheduled.has(sessionId)) {
        queueRetryScheduled.add(sessionId);
        deferWithSessionQueueTenantScope(
          {
            db,
            config,
            sessionId,
            params,
            label: 'processNextQueuedTask retry',
          },
          async (retryParams) => {
            queueRetryScheduled.delete(sessionId);
            try {
              await processNextQueuedTask(sessionId, retryParams);
            } catch (error) {
              console.error(`❌ [Queue] Retry failed for session ${shortId(sessionId)}:`, error);
            }
          },
          (error) => {
            queueRetryScheduled.delete(sessionId);
            console.error(`❌ [Queue] Retry failed for session ${shortId(sessionId)}:`, error);
          }
        );
      } else {
        console.log(
          `⏭️  [Queue] Retry already scheduled for session ${shortId(sessionId)}, not queueing another`
        );
      }
      return;
    }

    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    sessionTurnLocks.set(sessionId, lockPromise);

    // Race the drain against a holder timeout. A half-open TCP connection can
    // keep spawnTaskExecutor waiting indefinitely on a DB query that never
    // completes on the Node.js side (statement_timeout only fires if Postgres
    // actually received the query). Releasing the lock after 30s lets waiting
    // prompts make progress; the background drain will eventually fail and DB
    // state will be reconciled by reconcileSessionPromptStateIfStuck.
    const HOLDER_TIMEOUT_MS = 30_000;
    try {
      await Promise.race([
        processNextQueuedTaskInternal(sessionId, params),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `processNextQueuedTaskInternal timed out for ${shortId(sessionId)} after ${HOLDER_TIMEOUT_MS / 1000}s`
                )
              ),
            HOLDER_TIMEOUT_MS
          )
        ),
      ]);
    } catch (err) {
      console.error(
        `❌ [Queue] processNextQueuedTask holder error for ${shortId(sessionId)}:`,
        err instanceof Error ? err.message : err
      );
    } finally {
      sessionTurnLocks.delete(sessionId);
      resolveLock();
    }
  }

  async function processNextQueuedTaskInternal(
    sessionId: SessionID,
    params: RouteParams
  ): Promise<void> {
    const taskRepo = bindRepositoryToTenantUnitOfWork(db, new TaskRepository(db));
    const nextTask = await taskRepo.getNextQueued(sessionId);

    if (!nextTask) {
      taskQueueDebug(`📭 No queued tasks for session ${shortId(sessionId)}`);
      return;
    }

    // Recovery triggers carry trusted tenant routing but no request user.
    // `Task.created_by` is the canonical prompt actor and credential identity;
    // callback scheduling metadata is provenance only and must never select
    // another user's token, environment, mounts, or private MCP servers.
    const userRepo = bindRepositoryToTenantUnitOfWork(db, new UsersRepository(db));
    let queuedByUser = await resolveQueuedTaskActor(nextTask, (userId) =>
      userRepo.findById(userId)
    );
    if (!queuedByUser) {
      const actorCheck = await runWithTenantDatabaseTransaction(
        db,
        getCurrentTenantId(),
        async (operationDb) => {
          await lockTenantAuthorizationFence(operationDb, params);
          return new TaskRepository(operationDb).failQueuedTaskIfCreatorMissing(nextTask.task_id);
        }
      );
      if (actorCheck.outcome === 'condition_changed') return;
      if (actorCheck.outcome === 'actor_available') {
        queuedByUser = await userRepo.findById(nextTask.created_by);
        if (queuedByUser) {
          // Continue below; the final dispatch admission rechecks this actor
          // under the same tenant fence as hard deletion.
        } else {
          deferWithSessionQueueTenantScope(
            { db, config, sessionId, params, label: 'processNextQueuedTask actor race' },
            async (retryParams) => processNextQueuedTask(sessionId, retryParams),
            (error) => console.error('❌ [Queue] Actor-race continuation failed:', error)
          );
          return;
        }
      } else {
        emitServiceEvent(app, {
          path: 'tasks',
          event: 'patched',
          data: actorCheck.task,
          params,
          id: actorCheck.task.task_id,
        });
        console.warn(
          `[task-queue] event=actor_missing task_id=${JSON.stringify(nextTask.task_id)} actor_id=${JSON.stringify(nextTask.created_by)}`
        );
        // A missing actor must not strand later valid work behind this queue
        // head. Re-enter through the ordinary drain coalescer after returning.
        deferWithSessionQueueTenantScope(
          { db, config, sessionId, params, label: 'processNextQueuedTask missing actor' },
          async (retryParams) => processNextQueuedTask(sessionId, retryParams),
          (error) => console.error('❌ [Queue] Missing-actor continuation failed:', error)
        );
        return;
      }
    }
    if (!queuedByUser) return;
    const taskParams = { ...params, user: queuedByUser } as RouteParams;

    const queuedSession = await runWithTenantDatabaseScope(db, getCurrentTenantId(), () =>
      sessionsService.get(sessionId, taskParams)
    );
    const session = await reconcileSessionPromptStateIfStuck(queuedSession, taskRepo, taskParams);

    if (!sessionCanStartTask(session.status, session.ready_for_prompt)) {
      return;
    }

    // Re-read the task — defend against the case where it was already drained
    // by a concurrent caller, or removed by an admin via DELETE /tasks/:id.
    const stillQueued = await taskRepo.findById(nextTask.task_id);
    if (!stillQueued || stillQueued.status !== TaskStatus.QUEUED) {
      console.log(`⚠️  Queued task ${shortId(nextTask.task_id)} no longer queued, skipping`);
      return;
    }

    // spawnTaskExecutor handles the QUEUED → DISPATCHING claim (recomputes
    // message_range/git_state, writes the user-message row, appends to
    // session.tasks, spawns the executor). We pass the messageSource from
    // task.metadata so callback styling survives the queue → run hop.
    const persistedSource = nextTask.metadata?.source;
    const source =
      persistedSource === 'gateway' || persistedSource === 'agor' ? persistedSource : undefined;
    const scheduledInitialTaskId = queuedSession.custom_context?.scheduled_run?.initial_task_id;
    const stableInitialMessageId = stableInitialMessageIdForTask(
      stillQueued,
      scheduledInitialTaskId === stillQueued.task_id
        ? (scheduledInitialTaskId as MessageID)
        : undefined
    );
    const admitted = await spawnTaskExecutor(
      stillQueued,
      {
        stream: true,
        messageSource: source,
        ...(stableInitialMessageId ? { stableInitialMessageId } : {}),
      },
      taskParams
    );
    if (admitted.status === TaskStatus.QUEUED) {
      taskQueueDebug(
        `⏸️  Queue head ${shortId(admitted.task_id)} remains queued after a lost/changed claim`
      );
      return;
    }
    if (
      admitted.status === TaskStatus.FAILED &&
      admitted.error_message === MISSING_TASK_ACTOR_ERROR
    ) {
      deferWithSessionQueueTenantScope(
        { db, config, sessionId, params, label: 'processNextQueuedTask actor revoked' },
        async (retryParams) => processNextQueuedTask(sessionId, retryParams),
        (error) => console.error('❌ [Queue] Actor-revoked continuation failed:', error)
      );
      return;
    }
    console.log(
      `[task-queue] event=dispatched session_id=${JSON.stringify(sessionId)} task_id=${JSON.stringify(admitted.task_id)} status=${JSON.stringify(admitted.status)}`
    );
  }

  // Inject queue processor into sessions service.
  sessionsService.setQueueProcessor(async (sessionId: SessionID, params?: RouteParams) => {
    try {
      await processNextQueuedTask(sessionId, params || {});
    } catch (error) {
      console.error(`❌ [Sessions] Failed to process queued task:`, error);
    }
  });

  // ============================================================================
  // Permission decision endpoint
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/permission-decision',
    {
      async create(data: PermissionDecisionSubmission, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        return deliverPermissionDecision({
          app,
          sessionId: id as SessionID,
          data,
          params,
          authorization: {
            branchRbacEnabled,
            branchRepository,
            allowSuperadmin: superadminOpts.allowSuperadmin,
          },
        });
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'respond to permission requests' },
    },
    requireAuth
  );

  // ============================================================================
  // Widget submission / dismissal endpoints
  //
  // See `docs/internal/in-conversation-widgets-design-2026-05-19.md`. The
  // resolver handles auth, idempotency, registry dispatch, message patching,
  // auto-resume task queueing, and the `widget:resolved` broadcast.
  // ============================================================================

  const widgetResolutionMessages = bindRepositoryToTenantUnitOfWork(db, new MessagesRepository(db));
  const widgetResolutionBranches = bindRepositoryToTenantUnitOfWork(db, new BranchRepository(db));
  const widgetResolverDeps = {
    // biome-ignore lint/suspicious/noExplicitAny: Feathers Application shape
    app: app as any,
    runInTenantDatabaseScope: inCurrentTenantDatabaseScope,
    resolutionStore: new WidgetResolutionStore(widgetResolutionMessages, (message) =>
      emitServiceEvent(app, {
        path: 'messages',
        event: 'patched',
        data: message,
        id: message.message_id,
      })
    ),
    publishResolved: (payload: Record<string, unknown>) =>
      emitServiceEvent(app, {
        path: 'messages',
        event: 'widget:resolved',
        data: payload,
        method: 'patch',
        id: payload.widget_id as string,
      }),
    resolveSessionPromptAuthority: async (
      branchId: string,
      callerUserId: UUID,
      sessionOwnerUserId: UUID,
      sessionSdkHomeScope: import('@agor/core/types').SessionSdkHomeScope
    ) =>
      widgetResolutionBranches.resolveSessionPromptAuthority(
        branchId as import('@agor/core/types').BranchID,
        callerUserId,
        sessionOwnerUserId,
        sessionSdkHomeScope
      ),
  };

  registerLongAuthenticatedRoute(
    app,
    '/widgets/:id/submit',
    {
      async create(data: Record<string, unknown>, params: RouteParams) {
        const widgetId = params.route?.id;
        if (!widgetId) throw new Error('Widget ID required');
        if (!params.user?.user_id) {
          throw new NotAuthenticated('Authentication required to submit a widget');
        }
        return resolveWidget(
          widgetId,
          { kind: 'submit', body: data ?? {} },
          { user_id: params.user.user_id as UUID, role: params.user.role as string | undefined },
          widgetResolverDeps
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'submit widgets' },
    },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/widgets/:id/dismiss',
    {
      async create(_data: unknown, params: RouteParams) {
        const widgetId = params.route?.id;
        if (!widgetId) throw new Error('Widget ID required');
        if (!params.user?.user_id) {
          throw new NotAuthenticated('Authentication required to dismiss a widget');
        }
        return resolveWidget(
          widgetId,
          { kind: 'dismiss' },
          { user_id: params.user.user_id as UUID, role: params.user.role as string | undefined },
          widgetResolverDeps
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'dismiss widgets' },
    },
    requireAuth
  );

  // ============================================================================
  // Tasks custom routes
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/tasks/:id/complete',
    {
      async create(
        data: { git_state?: { sha_at_end?: string; commit_message?: string } },
        params: RouteParams
      ) {
        const id = params.route?.id;
        if (!id) throw new Error('Task ID required');
        const internalParams = await authorizeTaskTerminalRoute({
          id,
          params,
          tasksService,
        });
        return tasksService.complete(id, data, internalParams);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'complete tasks' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/tasks/:id/fail',
    {
      async create(data: { error?: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Task ID required');
        const internalParams = await authorizeTaskTerminalRoute({
          id,
          params,
          tasksService,
        });
        return tasksService.fail(id, data, internalParams);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'fail tasks' },
    },
    requireAuth
  );

  // ============================================================================
  // Repos custom routes
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/repos/local',
    {
      async create(data: { path: string; slug?: string }, params: RouteParams) {
        return reposService.addLocalRepository(data, params);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'add local repositories' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/clone',
    {
      async create(
        data: { url: string; name?: string; slug?: string; default_branch?: string },
        params: RouteParams
      ) {
        return reposService.cloneRepository(data, params);
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'clone repositories' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/:id/branches',
    {
      async create(
        data: {
          name: string;
          ref: string;
          createBranch?: boolean;
          refType?: 'branch' | 'tag';
          pullLatest?: boolean;
          sourceBranch?: string;
          /** Remote that owns sourceBranch when it differs from the destination repo. */
          sourceRemoteUrl?: string;
          issue_url?: string;
          pull_request_url?: string;
          boardId: string;
          /** Explicit board position. Omit to let the service compute a
           *  smart default — preferred for MCP/agent callers. The UI
           *  passes the viewport center so the new card lands where the
           *  user invoked the dialog. */
          position?: { x: number; y: number };
          // Branch storage model — see context/explorations/clone-redesign.md.
          storage_mode?: 'worktree' | 'clone';
          clone_depth?: number;
        },
        params: RouteParams
      ) {
        const id = params.route?.id;
        if (!id) throw new Error('Repo ID required');
        return reposService.createBranch(
          id,
          { ...data, refType: data.refType ?? 'branch' },
          params
        );
      },
    },
    {
      create: { role: ROLES.MEMBER, action: 'create branches' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/:id/branches/:name',
    {
      async remove(_id: unknown, params: RouteParams & { route?: { name?: string } }) {
        const id = params.route?.id;
        const name = params.route?.name;
        if (!id) throw new Error('Repo ID required');
        if (!name) throw new Error('Branch name required');
        return reposService.removeBranch(id, name, params);
      },
    },
    {
      remove: { role: ROLES.MEMBER, action: 'remove branches' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/:id/import-agor-yml',
    {
      async create(data: { branch_id: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Repo ID required');
        if (!data?.branch_id) throw new Error('branch_id is required');
        return reposService.importFromAgorYml(id, data, params);
      },
    },
    {
      create: { role: ROLES.ADMIN, action: 'import environment config from .agor.yml' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/repos/:id/export-agor-yml',
    {
      async create(data: { branch_id: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Repo ID required');
        if (!data?.branch_id) throw new Error('branch_id is required');
        return reposService.exportToAgorYml(id, data, params);
      },
    },
    {
      // Admin-only, matching Import and repo.environment edit. Export writes a
      // file to the branch working tree, so even though the content is
      // derivable, the side effect warrants the same permission bar as import.
      create: { role: ROLES.ADMIN, action: 'export .agor.yml' },
    },
    requireAuth
  );

  // ============================================================================
  // User API Keys routes
  // ============================================================================

  const userApiKeysService = createUserApiKeysService(userApiKeysRepo);

  registerAuthenticatedRoute(
    app,
    '/api/v1/user/api-keys',
    {
      async find(params: AuthenticatedParams) {
        return userApiKeysService.find(params);
      },
      async create(data: { name: string }, params: AuthenticatedParams) {
        return userApiKeysService.create(data, params);
      },
      async patch(id: string, data: { name?: string }, params: AuthenticatedParams) {
        if (!id) throw new BadRequest('API key ID required');
        return userApiKeysService.patch(id, data, params);
      },
      async remove(id: string, params: AuthenticatedParams) {
        if (!id) throw new BadRequest('API key ID required');
        return userApiKeysService.remove(id, params);
      },
    },
    {
      find: { role: ROLES.MEMBER, action: 'list API keys' },
      create: { role: ROLES.MEMBER, action: 'create API keys' },
      patch: { role: ROLES.MEMBER, action: 'update API keys' },
      remove: { role: ROLES.MEMBER, action: 'delete API keys' },
    },
    requireAuth
  );

  // ============================================================================
  // Board comments custom routes (threading + reactions)
  // ============================================================================

  const boardCommentRouteRepository = new BoardCommentsRepository(db);
  const boardCommentBoardRepository = new BoardRepository(db);
  const authorizeBoardCommentRoute = (id: string, params: RouteParams) =>
    authorizeBoardCommentRouteAccess({
      commentId: id,
      params,
      findComment: (commentId) => boardCommentRouteRepository.findById(commentId),
      findVisibleComment: (commentId, userId) =>
        boardCommentRouteRepository.findVisibleById(userId, commentId),
    });
  const boardCommentsService = safeService('board-comments') as unknown as {
    toggleReaction: (
      id: string,
      data: { user_id: string; emoji: string },
      params?: unknown
    ) => Promise<import('@agor/core/types').BoardComment>;
    createReply: (
      parentId: string,
      data: Partial<import('@agor/core/types').BoardComment>,
      params?: unknown
    ) => Promise<import('@agor/core/types').BoardComment>;
    reposition: (
      id: string,
      data: BoardCommentReposition,
      params?: unknown
    ) => Promise<import('@agor/core/types').BoardComment>;
  };

  if (boardCommentsService)
    registerAuthenticatedRoute(
      app,
      '/board-comments/:id/toggle-reaction',
      {
        async create(data: { user_id?: string; emoji?: string }, params: RouteParams) {
          const id = params.route?.id;
          if (!id) throw new Error('Comment ID required');
          const comment = await authorizeBoardCommentRoute(id, params);
          const updated = await boardCommentsService.toggleReaction(
            comment.comment_id,
            boardCommentReactionInput(data, params),
            params
          );
          emitServiceEvent(app, {
            path: 'board-comments',
            event: 'patched',
            data: updated,
            params,
            id: updated.comment_id,
          });
          return updated;
        },
      },
      {
        create: { role: ROLES.MEMBER, action: 'react to board comments' },
      },
      requireAuth
    );

  if (boardCommentsService)
    registerAuthenticatedRoute(
      app,
      '/board-comments/:id/reply',
      {
        async create(data: Partial<import('@agor/core/types').BoardComment>, params: RouteParams) {
          const id = params.route?.id;
          if (!id) throw new Error('Comment ID required');
          const parent = await authorizeBoardCommentRoute(id, params);
          const reply = await boardCommentsService.createReply(
            parent.comment_id,
            boardCommentReplyInput(data, params),
            params
          );
          emitServiceEvent(app, {
            path: 'board-comments',
            event: 'created',
            data: reply,
            params,
            id: reply.comment_id,
          });
          return reply;
        },
      },
      {
        create: { role: ROLES.MEMBER, action: 'reply to board comments' },
      },
      requireAuth
    );

  if (boardCommentsService)
    registerAuthenticatedRoute(
      app,
      '/board-comments/:id/reposition',
      {
        async create(data: unknown, params: RouteParams) {
          const id = params.route?.id;
          if (!id) throw new Error('Comment ID required');
          const comment = await authorizeBoardCommentRoute(id, params);
          const reposition = publicBoardCommentRepositionInput(data);
          await authorizeBoardCommentReposition({
            comment,
            data: reposition,
            params,
            findBoard: (boardId) => boardCommentBoardRepository.findById(boardId),
            findVisibleBoard: (userId, boardId) =>
              boardCommentBoardRepository.findVisibleById(userId, boardId),
          });
          const updated = await boardCommentsService.reposition(
            comment.comment_id,
            reposition,
            params
          );
          emitServiceEvent(app, {
            path: 'board-comments',
            event: 'patched',
            data: updated,
            params,
            id: updated.comment_id,
          });
          return updated;
        },
      },
      {
        create: { role: ROLES.MEMBER, action: 'reposition board comments' },
      },
      requireAuth
    );

  // ============================================================================
  // Branch environment management routes
  // ============================================================================

  const branchesService = app.service('branches') as unknown as BranchesServiceImpl;

  registerLongAuthenticatedRoute(
    app,
    '/branches/:id/start',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Branch ID required');
        return branchesService.startEnvironment(id as import('@agor/core/types').BranchID, params);
      },
    },
    {
      // Branch `all`/admin control is enforced at the service layer. This
      // route-level gate is just "authenticated" so the service remains
      // the single source of truth across REST, WebSocket, and MCP.
      create: { role: ROLES.VIEWER, action: 'start branch environments' },
    },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/branches/:id/stop',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Branch ID required');
        return branchesService.stopEnvironment(id as import('@agor/core/types').BranchID, params);
      },
    },
    {
      // Branch `all`/admin control is enforced at the service layer.
      create: { role: ROLES.VIEWER, action: 'stop branch environments' },
    },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/branches/:id/restart',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Branch ID required');
        return branchesService.restartEnvironment(
          id as import('@agor/core/types').BranchID,
          params
        );
      },
    },
    {
      // Branch `all`/admin control is enforced at the service layer.
      create: { role: ROLES.VIEWER, action: 'restart branch environments' },
    },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/branches/:id/nuke',
    {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Branch ID required');
        return branchesService.nukeEnvironment(id as import('@agor/core/types').BranchID, params);
      },
    },
    {
      // Branch `all`/admin control is enforced at the service layer.
      create: { role: ROLES.VIEWER, action: 'nuke branch environments' },
    },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/branches/:id/render-environment',
    {
      async create(data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Branch ID required');
        return branchesService.renderEnvironment(
          id as import('@agor/core/types').BranchID,
          data as { variant?: string } | undefined,
          params
        );
      },
    },
    {
      // Branch `all`/admin control is enforced at the service layer.
      create: { role: ROLES.VIEWER, action: 'render branch environment' },
    },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/branches/:id/health',
    {
      async find(params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Branch ID required');
        return branchesService.checkHealth(id as import('@agor/core/types').BranchID, params);
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      find: { role: ROLES.VIEWER, action: 'check branch health' },
    },
    requireAuth
  );

  // Archive/delete branch
  app.use('/branches/:id/archive-or-delete', {
    async create(data: unknown, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new Error('Branch ID required');
      if (!isBranchArchiveOrDeleteOptions(data)) {
        throw new BadRequest('Invalid branch archive/delete options');
      }
      const options: BranchArchiveOrDeleteOptions = data;
      return branchesService.archiveOrDelete(
        id as import('@agor/core/types').BranchID,
        options,
        params
      );
    },
  });

  app.service('/branches/:id/archive-or-delete').hooks({
    around: { all: [tenantIdentityAround] },
    before: {
      create: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'archive or delete branches'),
        inTenantDatabaseScope((context: HookContext) =>
          authorizeBranchArchiveDelete(context, {
            branchRepository,
            branchRbacEnabled,
            superadminOpts,
          })
        ),
      ],
    },
  });

  // Unarchive branch
  app.use('/branches/:id/unarchive', {
    async create(data: unknown, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new Error('Branch ID required');
      const options = data as { boardId?: import('@agor/core/types').BoardID };
      return branchesService.unarchive(id as import('@agor/core/types').BranchID, options, params);
    },
  });

  app.service('/branches/:id/unarchive').hooks({
    around: { all: [tenantIdentityAround] },
    before: {
      create: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'unarchive branches'),
        inTenantDatabaseScope(async (context: HookContext) => {
          const id = context.params.route?.id;
          if (!id) throw new Error('Branch ID required');

          const branch = await branchRepository.findById(id);
          if (!branch) {
            throw new Forbidden(`Branch not found: ${id}`);
          }

          await cacheBranchAccess(context.params, branchRepository, branch);

          return context;
        }),
        branchRbacEnabled
          ? ensureBranchPermission('all', 'unarchive branches', superadminOpts)
          : (context: HookContext) => {
              const isOwner = context.params.isBranchOwner;
              const userRole = context.params.user?.role;

              if (!isOwner && !hasMinimumRole(userRole, ROLES.ADMIN)) {
                throw new Forbidden(
                  'You must be the branch owner or a global admin to unarchive branches'
                );
              }
              return context;
            },
      ],
    },
  });

  // ============================================================================
  // Run-now (canonical): manually trigger a scheduled run for a schedule.
  // ============================================================================
  // Reuses the scheduler's spawn code path so scheduled and manual triggers
  // produce indistinguishable sessions (beyond a triggered_manually marker).
  // Requires branch-level 'all' permission on the schedule's parent branch
  // (same tier as editing the schedule); see §4.4 of the design doc.
  const scheduleRepository = new ScheduleRepository(db);

  app.use('/schedules/:id/run-now', {
    async create(_data: unknown, params: RouteParams) {
      const id = params.route?.id;
      if (!id) throw new BadRequest('Schedule ID required');

      const scheduler = app.get('scheduler') as SchedulerService | undefined;
      if (!scheduler) {
        throw new NotFound('Scheduler service is not enabled on this instance.');
      }

      const triggeredBy = params.user?.user_id;
      if (!triggeredBy) {
        throw new NotAuthenticated('Authentication required to trigger schedule.');
      }

      try {
        const session = await scheduler.executeScheduleNow({
          scheduleId: id as ScheduleID,
          triggeredBy: triggeredBy as UUID,
        });
        return {
          session_id: session.session_id,
          schedule_id: session.schedule_id,
          branch_id: session.branch_id,
          scheduled_run_at: session.scheduled_run_at,
          triggered_manually: true,
        };
      } catch (err) {
        if (err instanceof ScheduleBusyError) {
          throw new Conflict(err.message, { code: err.code });
        }
        if (err instanceof ScheduleNotReadyError) {
          throw new BadRequest(err.message, { code: err.code });
        }
        throw err;
      }
    },
  });

  app.service('/schedules/:id/run-now').hooks({
    around: { all: [tenantIdentityAround] },
    before: {
      create: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'run schedule'),
        // Reuse the canonical hook so caching semantics (params.schedule
        // / params.branch / params.isBranchOwner) match every other
        // schedule-touching path.
        inTenantDatabaseScope(loadScheduleAndBranch(scheduleRepository, branchRepository)),
        ensureScheduleRunsAsCaller(superadminOpts),
        branchRbacEnabled
          ? ensureBranchPermission('all', 'run schedule', superadminOpts)
          : (context: HookContext) => {
              const isOwner = context.params.isBranchOwner;
              const userRole = context.params.user?.role;
              if (!isOwner && !hasMinimumRole(userRole, ROLES.ADMIN)) {
                throw new Forbidden(
                  'You must be the branch owner or a global admin to run schedules'
                );
              }
              return context;
            },
      ],
    },
  });

  // ============================================================================
  // Back-compat shim: POST /branches/:id/execute-schedule-now
  // ============================================================================
  // Pre-#1253 callers fired a single per-branch schedule via this route.
  // Now that a branch can have N schedules, the unambiguous case is "exactly
  // one schedule on this branch" — we forward to that schedule's run-now.
  // Zero or multiple → 400 with a pointer to /schedules/:id/run-now.
  app.use('/branches/:id/execute-schedule-now', {
    async create(_data: unknown, params: RouteParams) {
      const branchId = params.route?.id;
      if (!branchId) throw new BadRequest('Branch ID required');

      const scheduler = app.get('scheduler') as SchedulerService | undefined;
      if (!scheduler) {
        throw new NotFound('Scheduler service is not enabled on this instance.');
      }

      const triggeredBy = params.user?.user_id;
      if (!triggeredBy) {
        throw new NotAuthenticated('Authentication required to trigger schedule.');
      }

      const { branch, branchSchedules } = await runWithTenantDatabaseScope(
        db,
        (params as AuthenticatedParams).tenant?.tenant_id,
        async () => {
          const branch = await branchRepository.findById(branchId);
          if (!branch) throw new NotFound(`Branch not found: ${branchId}`);
          const branchSchedules = await scheduleRepository.findByBranchId(branch.branch_id);
          return { branch, branchSchedules };
        }
      );
      if (branchSchedules.length === 0) {
        throw new BadRequest(
          `Branch "${branch.name}" has no schedules. Create one and call POST /schedules/:id/run-now instead.`,
          { code: 'no_schedules' }
        );
      }
      if (branchSchedules.length > 1) {
        throw new BadRequest(
          `Branch "${branch.name}" has ${branchSchedules.length} schedules. ` +
            `This route is back-compat only for the single-schedule case. ` +
            `Pick one and call POST /schedules/:id/run-now.`,
          { code: 'ambiguous_schedule' }
        );
      }

      try {
        const session = await scheduler.executeScheduleNow({
          scheduleId: branchSchedules[0].schedule_id,
          triggeredBy: triggeredBy as UUID,
        });
        return {
          session_id: session.session_id,
          schedule_id: session.schedule_id,
          branch_id: session.branch_id,
          scheduled_run_at: session.scheduled_run_at,
          triggered_manually: true,
        };
      } catch (err) {
        if (err instanceof ScheduleBusyError) {
          throw new Conflict(err.message, { code: err.code });
        }
        if (err instanceof ScheduleNotReadyError) {
          throw new BadRequest(err.message, { code: err.code });
        }
        throw err;
      }
    },
  });

  app.service('/branches/:id/execute-schedule-now').hooks({
    around: { all: [tenantIdentityAround] },
    before: {
      create: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'execute scheduled runs'),
        inTenantDatabaseScope(async (context: HookContext) => {
          const id = context.params.route?.id;
          if (!id) throw new BadRequest('Branch ID required');

          const branch = await branchRepository.findById(id);
          if (!branch) {
            throw new NotFound(`Branch not found: ${id}`);
          }

          await cacheBranchAccess(context.params, branchRepository, branch);
          return context;
        }),
        branchRbacEnabled
          ? ensureBranchPermission('all', 'execute scheduled runs', superadminOpts)
          : (context: HookContext) => {
              const isOwner = context.params.isBranchOwner;
              const userRole = context.params.user?.role;
              if (!isOwner && !hasMinimumRole(userRole, ROLES.ADMIN)) {
                throw new Forbidden(
                  'You must be the branch owner or a global admin to execute scheduled runs'
                );
              }
              return context;
            },
      ],
    },
  });

  // Branch logs
  registerLongAuthenticatedRoute(
    app,
    '/branches/logs',
    {
      async find(params: Params) {
        const id = params?.query?.branch_id;

        if (!id) {
          throw new Error('branch_id query parameter required');
        }

        return branchesService.getLogs(id as import('@agor/core/types').BranchID, params);
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      // Branch `all`/admin control is enforced at the service layer.
      find: { role: ROLES.VIEWER, action: 'view branch logs' },
    },
    requireAuth
  );

  // ============================================================================
  // Boards custom routes
  // ============================================================================

  if (boardsService) {
    registerAuthenticatedRoute(
      app,
      '/boards/:id/sessions',
      {
        async create(data: { sessionId: string }, params: RouteParams) {
          const id = params.route?.id;
          if (!id) throw new Error('Board ID required');
          if (!data.sessionId) throw new Error('Session ID required');
          return boardsService.addSession(id, data.sessionId, params);
        },
      },
      {
        create: { role: ROLES.MEMBER, action: 'modify board sessions' },
      },
      requireAuth
    );
  }

  // Route-side mutation wrapper for session-scoped runtime configuration.
  // These settings can influence what a session process receives, so only the
  // Session owner or a global admin/superadmin may mutate them.
  const requireSessionScopedConfigOwnerOrAdmin = async (
    sessionId: string,
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type
    params: any
  ): Promise<Session> => {
    const user = params?.user;
    if (!user) {
      throw new NotAuthenticated('Authentication required');
    }
    const session = await sessionsService.get(sessionId, { provider: undefined });
    if (!session) {
      throw new NotFound(`Session not found: ${sessionId}`);
    }
    if (!user._isServiceAccount) checkSessionOwnerOrAdmin(user, session, superadminOpts);
    return session as Session;
  };

  /**
   * A selection must name an existing session-scoped variable owned by this
   * Session's creator. Keeping the check at the route boundary prevents an
   * admin, provider-less caller, or malformed import from wiring arbitrary
   * metadata that a later execution path might reinterpret as a secret grant.
   */
  const assertSelectableSessionEnvVarNames = async (
    session: Session,
    envVarNames: string[]
  ): Promise<void> => {
    const owner = (await usersService.get(session.created_by as UserID, {
      provider: undefined,
    })) as User;
    for (const name of envVarNames) {
      if (!ENV_VAR_CONSTRAINTS.NAME_PATTERN.test(name) || !isEnvVarAllowed(name)) {
        throw new BadRequest(`Invalid session environment variable name: ${name}`);
      }
      if (owner.env_vars?.[name]?.scope !== 'session') {
        throw new BadRequest(
          `Environment variable ${name} is not a session-scoped variable owned by this session creator`
        );
      }
    }
  };

  // Human/API reads retain the owner/admin rule. The sole exception is the
  // executor projection read for the exact signed Task, Session, and actor.
  const authorizeAndLoadSessionForMcpConfig = async (
    sessionId: string,
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS params type
    params: any
  ): Promise<Session> => {
    const user = params?.user;
    if (!user) throw new NotAuthenticated('Authentication required');
    const session = (await sessionsService.get(sessionId, { provider: undefined })) as
      | Session
      | undefined;
    if (!session) throw new NotFound(`Session not found: ${sessionId}`);
    const tenantId = (params as AuthenticatedParams).tenant?.tenant_id ?? getCurrentTenantId();
    const executorAuthorized = await authorizeTaskExecutorSessionMcpRead(
      params,
      session,
      async (taskId) => {
        if (!tenantId) throw new NotAuthenticated('Executor MCP read requires tenant identity');
        return runWithTenantDatabaseScope(db, tenantId, (tenantDb) =>
          new TaskRepository(tenantDb).findById(taskId)
        );
      }
    );
    if (executorAuthorized) {
      return session;
    }
    if (!user._isServiceAccount) checkSessionOwnerOrAdmin(user, session, superadminOpts);
    return session;
  };

  const projectMcpServersForExecutor = async (
    servers: MCPServer[],
    session: Session,
    params: RouteParams
  ): Promise<MCPServer[]> => {
    const executorScope = authenticatedTaskExecutorRuntimeScope(params);
    const tenantId =
      (params as RouteParams & { tenant?: { tenant_id?: string } }).tenant?.tenant_id ??
      getCurrentTenantId();
    if (!tenantId) throw new NotAuthenticated('MCP gateway projection requires tenant identity');
    const mode = await getMCPEgressGatewayMode(db);
    if (!executorScope) {
      if (mode === 'compatibility' || mode === 'enforced') {
        throw new Forbidden(
          'MCP credentials are available only through a live task-scoped daemon capability'
        );
      }
      return servers;
    }
    if (mode === 'off') return servers;
    if (mode === 'observe') {
      for (const server of servers) {
        console.info(
          `[MCP Egress] event=direct_client_observed transport=${server.transport} server_id=${server.mcp_server_id}`
        );
      }
      return servers;
    }
    const gatewayBaseUrl =
      config.daemon?.public_url ?? config.daemon?.base_url ?? `http://localhost:${_DAEMON_PORT}`;
    return runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
      const task = await new TaskRepository(tenantDb).findById(executorScope.taskId);
      if (
        !task ||
        executorScope.sessionId !== session.session_id ||
        task.session_id !== session.session_id ||
        task.created_by !== params.user?.user_id
      ) {
        throw new Forbidden('Executor task scope is no longer current');
      }
      // The native conversation/home belongs to the Session owner, but every
      // credential projection belongs to the actor who created this Task.
      const credentialUserId = task.created_by;
      const resolvedEnv = await resolveMCPEgressEnvironment(tenantDb, credentialUserId, session);
      const projected: MCPServer[] = [];
      for (const server of servers) {
        const eligibility = mcpEgressEligibility(server);
        if (!eligibility.eligible) {
          console.info(
            `[MCP Egress] event=projection_excluded reason=${eligibility.reason} transport=${server.transport} server_id=${server.mcp_server_id}`
          );
          continue;
        }
        let grantIdentity: string | undefined;
        if (server.auth?.type === 'oauth') {
          const tokenUserId =
            (server.auth.oauth_mode ?? 'per_user') === 'shared'
              ? null
              : (credentialUserId as import('@agor/core/types').UserID);
          const grant = await new UserMCPOAuthTokenRepository(tenantDb).getToken(
            tokenUserId,
            server.mcp_server_id
          );
          grantIdentity = mcpOAuthGrantIdentity(grant);
          if (!grantIdentity) {
            console.info(
              `[MCP Egress] event=projection_excluded reason=oauth_reauth_required server_id=${server.mcp_server_id}`
            );
            continue;
          }
        }
        const capability = issueMCPEgressCapability(
          {
            tid: tenantId,
            task_id: task.task_id,
            session_id: session.session_id,
            principal_user_id: task.created_by,
            credential_user_id: credentialUserId,
            mcp_server_id: server.mcp_server_id,
            config_version: server.config_version ?? 1,
            material_hash: mcpEgressMaterialHash(server, resolvedEnv, jwtSecret),
            grant_identity: grantIdentity,
            rollout_mode: mode,
            jti: randomUUID(),
          },
          jwtSecret
        );
        projected.push(
          projectMCPServerForExecutor(
            server,
            new URL(
              `/mcp-egress/${encodeURIComponent(server.mcp_server_id)}`,
              gatewayBaseUrl
            ).toString(),
            capability
          )
        );
      }
      return projected;
    });
  };

  // Relationship mutation is authoritative in its existing transaction. New
  // calls re-check attachment state in PostgreSQL/SQLite. Local cancellation is
  // an availability accelerator only; already-admitted calls may complete.
  const coordinateSessionMcpRevocation = async <T>(
    _sessionId: string,
    serverIds: string[],
    params: RouteParams,
    mutate: () => Promise<T>
  ): Promise<T> => {
    const tenantId = (params as AuthenticatedParams).tenant?.tenant_id ?? getCurrentTenantId();
    return coordinateSessionMCPRevocation({
      db,
      gateway: mcpEgressGateway,
      tenantId,
      serverIds,
      mutate,
    });
  };

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/mcp-servers',
    {
      async find(params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        const session = await authorizeAndLoadSessionForMcpConfig(id, params);
        const enabledOnly =
          params.query?.enabledOnly === 'true' || params.query?.enabledOnly === true;
        const includeGlobal =
          params.query?.includeGlobal === 'true' || params.query?.includeGlobal === true;
        const includeMetadata =
          params.query?.includeMetadata === 'true' || params.query?.includeMetadata === true;
        const mcpService = app.service('mcp-servers');
        const queryForUserId =
          typeof params.query?.forUserId === 'string' ? params.query.forUserId : undefined;
        const routeUser = params.user as
          | (NonNullable<RouteParams['user']> & { _isServiceAccount?: boolean })
          | undefined;
        const userId = resolveForUserIdWithGate({
          queryForUserId,
          isServiceAccount: routeUser?._isServiceAccount,
          callerUserId: params.user?.user_id,
        });
        // Personal session sharing preserves the Session owner/home but runs
        // each prompt with the Task creator's Agor credentials. A private MCP
        // server owned by the Session owner must therefore disappear when a
        // different prompt actor executes the turn.
        const credentialUserId = userId ?? session.created_by;
        const rawLookupParams = {
          ...params,
          provider: undefined,
          query: {
            ...(userId ? { forUserId: userId } : {}),
          },
        };
        if (includeMetadata) {
          const linksResult = await app.service('session-mcp-servers').find({
            ...params,
            provider: undefined,
            query: {
              session_id: id,
              ...(enabledOnly ? { enabled: true } : {}),
              $limit: 1000,
            },
          });
          const links = (Array.isArray(linksResult) ? linksResult : linksResult.data) as Array<
            SessionMCPServer & { added_at: Date | string | number }
          >;
          const withMetadata = await Promise.all(
            links.map(async (link) => {
              try {
                const server = await mcpService.get(link.mcp_server_id, rawLookupParams);
                return {
                  server,
                  added_at: new Date(link.added_at).getTime(),
                  enabled: Boolean(link.enabled),
                };
              } catch (_error) {
                return null;
              }
            })
          );
          const entries = withMetadata
            .filter(
              (entry): entry is Exclude<(typeof withMetadata)[number], null> => entry !== null
            )
            .filter((entry) => isMCPServerUsableBy(entry.server, credentialUserId));
          if (
            shouldExposeMCPServerSecrets(params, {
              allowSessionToken: true,
              sessionId: id,
            })
          ) {
            // Project the full set once: mode/task/environment authority is
            // shared by this response, and omitted servers must not leave
            // protocol-incomplete `{ server: undefined }` list entries.
            const projectedServers = await projectMcpServersForExecutor(
              entries.map((entry) => entry.server),
              session,
              params
            );
            const projectedById = new Map(
              projectedServers.map((server) => [server.mcp_server_id, server])
            );
            return entries.flatMap((entry) => {
              const server = projectedById.get(entry.server.mcp_server_id);
              return server ? [{ ...entry, server }] : [];
            });
          }
          return entries.map((entry) => ({
            ...entry,
            server: redactMCPServerSecrets(entry.server),
          }));
        }
        const sessionServerRefs = await sessionMCPServersService.listServers(
          id as import('@agor/core/types').SessionID,
          enabledOnly,
          params
        );
        const sessionServers = await Promise.all(
          sessionServerRefs.map(async (server) => {
            try {
              return await mcpService.get(server.mcp_server_id, rawLookupParams);
            } catch (_error) {
              return server;
            }
          })
        );
        const globalQuery = {
          scope: 'global',
          ...(enabledOnly ? { enabled: true } : {}),
          ...(userId ? { forUserId: userId } : {}),
          // Private global servers belong to the current prompt actor. Shared
          // rows remain available and resolve per-user OAuth for this same ID.
          usableByUserId: credentialUserId,
          $limit: 1000,
        };
        const globalResult = includeGlobal
          ? await mcpService.find({
              ...params,
              provider: undefined,
              query: globalQuery,
            })
          : [];
        const globalServers = Array.isArray(globalResult) ? globalResult : globalResult.data;
        const servers = (
          includeGlobal
            ? [
                ...new Map(
                  [...globalServers, ...sessionServers].map((server) => [
                    server.mcp_server_id,
                    server,
                  ])
                ).values(),
              ]
            : sessionServers
        ).filter((server) => isMCPServerUsableBy(server, credentialUserId));
        return shouldExposeMCPServerSecrets(params, {
          allowSessionToken: true,
          sessionId: id,
        })
          ? projectMcpServersForExecutor(servers, session, params)
          : servers.map(redactMCPServerSecrets);
      },
      async create(data: { mcpServerId: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!data.mcpServerId) throw new Error('MCP Server ID required');
        await requireSessionScopedConfigOwnerOrAdmin(id, params);

        try {
          await sessionMCPServersService.addServer(
            id as import('@agor/core/types').SessionID,
            data.mcpServerId as import('@agor/core/types').MCPServerID,
            params
          );
        } catch (error) {
          if (error instanceof MCPServerNotUsableError) {
            throw new Forbidden('That MCP server is private to another user');
          }
          throw error;
        }

        const relationship = {
          session_id: id,
          mcp_server_id: data.mcpServerId,
          enabled: true,
          added_at: new Date(),
        };
        emitServiceEvent(app, {
          path: 'session-mcp-servers',
          event: 'created',
          data: relationship,
          params,
        });

        return relationship;
      },
      async update(_id: string | null, data: { mcpServerIds?: unknown }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!Array.isArray(data?.mcpServerIds)) {
          throw new BadRequest('mcpServerIds (array) required');
        }
        if (
          !data.mcpServerIds.every((serverId): serverId is string => typeof serverId === 'string')
        ) {
          throw new BadRequest('mcpServerIds must contain strings');
        }

        await requireSessionScopedConfigOwnerOrAdmin(id, params);
        const serverIds = [...new Set(data.mcpServerIds)] as Array<
          import('@agor/core/types').MCPServerID
        >;
        const existing = await sessionMCPServersService.listServers(
          id as import('@agor/core/types').SessionID,
          false,
          params
        );
        const removedServerIds = existing
          .map((item) => item.mcp_server_id)
          .filter((serverId) => !serverIds.includes(serverId));
        try {
          await coordinateSessionMcpRevocation(id, removedServerIds, params, () =>
            sessionMCPServersService.setServers(
              id as import('@agor/core/types').SessionID,
              serverIds,
              params
            )
          );
        } catch (error) {
          if (error instanceof MCPServerNotUsableError) {
            throw new Forbidden('That MCP server is private to another user');
          }
          throw error;
        }

        const replacement = {
          session_id: id,
          mcp_server_ids: serverIds,
        };
        emitServiceEvent(app, {
          path: 'session-mcp-servers',
          event: 'patched',
          data: replacement,
          params,
        });
        return replacement;
      },
      async remove(mcpId: string, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!mcpId) throw new Error('MCP Server ID required');
        await requireSessionScopedConfigOwnerOrAdmin(id, params);

        await coordinateSessionMcpRevocation(id, [mcpId], params, () =>
          sessionMCPServersService.removeServer(
            id as import('@agor/core/types').SessionID,
            mcpId as import('@agor/core/types').MCPServerID,
            params
          )
        );

        const relationship = {
          session_id: id,
          mcp_server_id: mcpId,
        };
        emitServiceEvent(app, {
          path: 'session-mcp-servers',
          event: 'removed',
          data: relationship,
          params,
        });

        return relationship;
      },
      async patch(mcpId: string, data: { enabled: boolean }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Session ID required');
        if (!mcpId) throw new Error('MCP Server ID required');
        if (typeof data.enabled !== 'boolean') throw new Error('enabled field required');
        await requireSessionScopedConfigOwnerOrAdmin(id, params);
        const toggle = () =>
          sessionMCPServersService.toggleServer(
            id as import('@agor/core/types').SessionID,
            mcpId as import('@agor/core/types').MCPServerID,
            data.enabled,
            params
          );
        return data.enabled
          ? toggle()
          : coordinateSessionMcpRevocation(id, [mcpId], params, toggle);
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      find: { role: ROLES.MEMBER, action: 'view session MCP servers' },
      create: { role: ROLES.MEMBER, action: 'modify session MCP servers' },
      update: { role: ROLES.MEMBER, action: 'replace session MCP servers' },
      remove: { role: ROLES.MEMBER, action: 'modify session MCP servers' },
      patch: { role: ROLES.MEMBER, action: 'modify session MCP servers' },
    },
    requireAuth
  );

  // ============================================================================
  // MCP member policy
  //
  // Routes:
  //   GET   /mcp-member-policy   — the policy in force for the caller
  //   PATCH /mcp-member-policy   — set the tenant-wide value (admin)
  // ============================================================================

  registerAuthenticatedRoute(
    app,
    '/mcp-member-policy',
    {
      async find(params: RouteParams): Promise<MCPMemberPolicySetting> {
        const policy = await resolveMcpMemberPolicy(db, params.user?.user_id, getCurrentTenantId());
        // The policy alone does not answer "may I add one?" — the role floor
        // beneath it does too. Answering here keeps a client from rebuilding
        // the rule out of `isAdmin` and a policy value, which is the shape that
        // loses the floor. Advisory: the write path still decides.
        return {
          policy,
          can_configure: canConfigureMcpServers(params.user?.role, policy),
        };
      },
      async patch(
        _id: unknown,
        data: { policy: MCPMemberPolicy },
        params: RouteParams
      ): Promise<MCPMemberPolicySetting> {
        if (!MCP_MEMBER_POLICIES.includes(data?.policy)) {
          throw new BadRequest(`policy must be one of: ${MCP_MEMBER_POLICIES.join(', ')}`);
        }
        await setMcpMemberPolicy(db, data.policy, getCurrentTenantId(), params.user?.user_id);
        // Do not publish the caller-shaped endpoint response: `can_configure`
        // differs by role. An empty tenant-scoped invalidation makes every
        // connected browser refetch its own authoritative answer. The event is
        // queued until the tenant DB unit of work commits by emitServiceEvent.
        emitServiceEvent(app, {
          path: 'mcp-servers',
          event: MCP_MEMBER_POLICY_CHANGED_EVENT,
          data: {},
          params,
          method: 'patch',
        });
        return {
          policy: data.policy,
          can_configure: canConfigureMcpServers(params.user?.role, data.policy),
        };
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      // Readable by any authenticated caller, because what it answers is
      // partly about the caller: `can_configure` is their own capability, and
      // the role floor means the interesting answer is the one a below-member
      // caller gets. Gating this at member would leave that answer unreachable
      // by the only people it refuses, who would then be shown a control that
      // fails instead of a reason it is off.
      find: { role: ROLES.VIEWER, action: 'read the MCP member policy' },
      patch: { role: ROLES.ADMIN, action: 'change the MCP member policy' },
    },
    requireAuth
  );

  registerAuthenticatedRoute(
    app,
    '/mcp-egress/status',
    {
      async find(params: RouteParams) {
        const tenantId = (params as AuthenticatedParams).tenant?.tenant_id ?? getCurrentTenantId();
        if (!tenantId) throw new NotAuthenticated('MCP gateway status requires tenant identity');
        const mode = await getMCPEgressGatewayMode(db);
        const runtime = mcpEgressGateway.status(tenantId);
        const mediated = mode === 'compatibility' || mode === 'enforced';
        const visibleServerPage = params.user?.user_id
          ? await new MCPServerRepository(db).findAll({
              enabled: true,
              usableByUserId: params.user.user_id,
              limit: 101,
            })
          : [];
        const excludedServersTruncated = visibleServerPage.length > 100;
        const visibleServers = visibleServerPage.slice(0, 100);
        const excludedServers = (
          await Promise.all(
            visibleServers.map(async (server) => {
              const eligibility = mcpEgressEligibility(server);
              if (!eligibility.eligible) {
                return {
                  mcp_server_id: server.mcp_server_id,
                  name: server.display_name ?? server.name,
                  reason: eligibility.reason,
                  recovery:
                    eligibility.reason === 'approval_not_mediated'
                      ? 'Change ask rules to allow/deny, or wait for task-bound approval receipts.'
                      : eligibility.reason === 'template_configuration'
                        ? 'Use only static user.env.KEY references with balanced supported helpers; relative, lookup, and scoped templates are excluded.'
                        : 'Configure bounded Streamable HTTP; stdio, legacy SSE, and WebSocket are unavailable in mediated modes.',
                };
              }
              if (server.auth?.type === 'oauth') {
                const tokenUserId =
                  (server.auth.oauth_mode ?? 'per_user') === 'shared'
                    ? null
                    : (params.user!.user_id as import('@agor/core/types').UserID);
                const grant = await new UserMCPOAuthTokenRepository(db).getToken(
                  tokenUserId,
                  server.mcp_server_id
                );
                if (!mcpOAuthGrantIdentity(grant)) {
                  return {
                    mcp_server_id: server.mcp_server_id,
                    name: server.display_name ?? server.name,
                    reason: 'oauth_reauth_required' as const,
                    recovery: 'Reconnect this MCP server to create a current OAuth grant.',
                  };
                }
              }
              return undefined;
            })
          )
        ).filter((entry) => entry !== undefined);
        return {
          mode,
          supported_transports: mediated ? ['streamable-http-buffered'] : [],
          unsupported_transports: [
            'stdio',
            'legacy-sse-endpoint-handoff',
            'websocket',
            'unbounded-streaming-response',
            'servers-requiring-ask-approval',
          ],
          in_flight_requests: runtime.activeRequests,
          provider_in_flight_requests: runtime.providerInFlightRequests,
          reserved_requests: runtime.reservedRequests,
          oldest_request_ms: runtime.oldestRequestMs,
          excluded_servers: excludedServers,
          excluded_servers_truncated: excludedServersTruncated,
          // The status read proves this database request succeeded; it is not
          // an independent admission-path availability probe.
          admission_available: null,
          operator: hasMinimumRole(params.user?.role, ROLES.ADMIN),
          guarantee: mediated
            ? 'No request hop is admitted after a committed config, grant, task, attachment, role, or rollout change. Requests admitted before that commit may complete.'
            : 'Direct mode has no gateway admission or revocation guarantee.',
        };
      },
      async patch(
        _id: unknown,
        data: {
          mode?: unknown;
          acknowledge_raw_secret_downgrade?: unknown;
          verified_legacy_executors_fenced?: unknown;
        },
        params: RouteParams
      ) {
        if (!['off', 'observe', 'compatibility', 'enforced'].includes(String(data?.mode))) {
          throw new BadRequest('mode must be off, observe, compatibility, or enforced');
        }
        const nextMode = data.mode as import('@agor/core/types').MCPEgressGatewayMode;
        const currentMode = await getMCPEgressGatewayMode(db);
        if (currentMode === nextMode) return { mode: nextMode };
        const violation = validateMCPEgressRolloutChange({
          currentMode,
          nextMode,
          acknowledgeRawSecretDowngrade: data.acknowledge_raw_secret_downgrade === true,
          verifiedLegacyExecutorsFenced: data.verified_legacy_executors_fenced === true,
        });
        // Emergency rollback remains available even with active calls. It is an
        // explicit restoration of direct credential projection, not revocation.
        if (violation === 'raw_secret_downgrade_acknowledgement_required') {
          throw new BadRequest(
            'acknowledge_raw_secret_downgrade must be true because rollback restores direct credential egress'
          );
        }
        if (violation === 'legacy_executor_fence_attestation_required') {
          throw new BadRequest(
            'verified_legacy_executors_fenced must be true after pre-gateway executors are terminated'
          );
        }
        const tenantId = (params as AuthenticatedParams).tenant?.tenant_id ?? getCurrentTenantId();
        await coordinateMCPEgressRolloutChange({
          gateway: mcpEgressGateway,
          tenantId,
          mutate: async () => {
            await setMCPEgressGatewayMode(db, nextMode, params.user?.user_id);
            console.warn(
              `[SECURITY] event=mcp_egress_rollout_changed tenant_id=${(params as AuthenticatedParams).tenant?.tenant_id ?? '<unknown>'} actor_user_id=${params.user?.user_id ?? '<unknown>'} previous_mode=${currentMode} next_mode=${nextMode} raw_secret_downgrade_acknowledged=${data.acknowledge_raw_secret_downgrade === true}`
            );
          },
        });
        return { mode: nextMode };
      },
      // biome-ignore lint/suspicious/noExplicitAny: custom Feathers route method shape
    } as any,
    {
      find: { role: ROLES.MEMBER, action: 'view MCP gateway status' },
      patch: { role: ROLES.ADMIN, action: 'configure MCP gateway rollout' },
    },
    requireAuth
  );

  // ============================================================================
  // MCP marketplace connect
  // ============================================================================

  // A "long" route: it probes a remote endpoint before writing anything, so it
  // carries tenant identity without holding a transaction open across the
  // network call. Every write it makes goes through a service that opens its
  // own unit of work.
  registerLongAuthenticatedRoute(
    app,
    '/mcp-catalog/connect',
    createRegisteredMCPCatalogConnectService(app, db),
    { create: { role: ROLES.MEMBER, action: 'connect MCP catalog entries' } },
    requireAuth
  );

  // A connect result is an answer to the caller, not tenant news, so it is
  // published to nobody.
  //
  // The daemon's global publisher (`utils/realtime-publish.ts`) has no path
  // allowlist: every service that emits `created` fans out to the whole
  // tenant's authenticated channel unless it says otherwise. That put a
  // `{ mcp_server, session }` payload on every socket in the tenant, and now
  // that an install can carry an API key in `mcp_server.auth.token`, this is a
  // second route out for it — one the `mcp-servers` redaction hook does not
  // cover, because that hook is registered on `mcp-servers` and this is a
  // different service forwarding the same object.
  //
  // It happens to be redacted today: connect obtains the row from
  // `mcp-servers` with the caller's own params, so the after hook has already
  // replaced the token by the time it lands in this result. That is a property
  // of where the object came from rather than of where it is going, and the
  // next person to change what connect returns has no reason to know a
  // broadcast depends on it.
  //
  // Nothing is lost by silence. The rows this creates are announced by their
  // own services — `mcp-servers` emits `created`/`patched` for the install and
  // `sessions` for the session, both through hooks that redact — so a client
  // watching for either still learns about them, from the service that owns
  // them.
  app.service('mcp-catalog/connect').publish(() => []);

  // ============================================================================
  // Session env selections (v0.5 env-var-access)
  //
  // Routes:
  //   GET    /sessions/:id/env-selections           — list selected env var names
  //   POST   /sessions/:id/env-selections           — add one: { envVarName }
  //   DELETE /sessions/:id/env-selections/:name     — remove one
  //   PATCH  /sessions/:id/env-selections           — replace all: { envVarNames: [] }
  //
  // RBAC: only the session's creator or a global admin/superadmin may mutate.
  // Branch `all` permission does NOT grant access — selections expose the
  // creator's private credentials to the executor process.
  // ============================================================================

  // Validate + normalize an `envVarNames` payload: every entry must be a
  // non-empty string, with leading/trailing whitespace trimmed and duplicates
  // removed (first occurrence wins).
  const normalizeEnvVarNames = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
      throw new BadRequest('envVarNames (array of strings) required');
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') {
        throw new BadRequest('envVarNames entries must be strings');
      }
      const trimmed = entry.trim();
      if (!trimmed) {
        throw new BadRequest('envVarNames entries must be non-empty');
      }
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
    return out;
  };

  registerAuthenticatedRoute(
    app,
    '/sessions/:id/env-selections',
    {
      // GET returns the selected env var names as a plain `string[]` — both
      // the comment above and the UI consumer expect names, not full rows.
      async find(params: RouteParams): Promise<string[]> {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        // Read permission: session creator OR admin (no branch tier).
        await requireSessionScopedConfigOwnerOrAdmin(id, params);
        const rows = await sessionEnvSelectionsService.list(id as SessionID, params);
        return rows.map((r) => r.env_var_name);
      },
      async create(data: { envVarName: string }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        if (!data?.envVarName || typeof data.envVarName !== 'string') {
          throw new BadRequest('envVarName required');
        }
        const name = data.envVarName.trim();
        if (!name) throw new BadRequest('envVarName must be non-empty');
        const session = await requireSessionScopedConfigOwnerOrAdmin(id, params);
        await assertSelectableSessionEnvVarNames(session, [name]);
        await sessionEnvSelectionsService.add(id as SessionID, name, params);
        const relationship = {
          session_id: id,
          env_var_name: name,
        };
        try {
          emitServiceEvent(app, {
            path: 'session-env-selections',
            event: 'created',
            data: relationship,
            params,
          });
        } catch {
          // Event emission is non-fatal
        }
        return relationship;
      },
      async remove(name: string, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        if (!name) throw new BadRequest('env var name required');
        await requireSessionScopedConfigOwnerOrAdmin(id, params);
        await sessionEnvSelectionsService.remove(id as SessionID, name, params);
        const relationship = {
          session_id: id,
          env_var_name: name,
        };
        try {
          emitServiceEvent(app, {
            path: 'session-env-selections',
            event: 'removed',
            data: relationship,
            params,
          });
        } catch {
          // Event emission is non-fatal
        }
        return relationship;
      },
      async patch(_nullId: null, data: { envVarNames: string[] }, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        const envVarNames = normalizeEnvVarNames(data?.envVarNames);
        const session = await requireSessionScopedConfigOwnerOrAdmin(id, params);
        await assertSelectableSessionEnvVarNames(session, envVarNames);
        await sessionEnvSelectionsService.setAll(id as SessionID, envVarNames, params);
        try {
          emitServiceEvent(app, {
            path: 'session-env-selections',
            event: 'patched',
            data: { session_id: id, env_var_names: envVarNames },
            params,
          });
        } catch {
          // Event emission is non-fatal
        }
        return { session_id: id, env_var_names: envVarNames };
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      find: { role: ROLES.MEMBER, action: 'view session env selections' },
      create: { role: ROLES.MEMBER, action: 'modify session env selections' },
      remove: { role: ROLES.MEMBER, action: 'modify session env selections' },
      patch: { role: ROLES.MEMBER, action: 'modify session env selections' },
    },
    requireAuth
  );

  // ============================================================================
  // Session initialization
  //
  // Session creation and browser file upload remain separate because uploads
  // are multipart and require a durable session id. This route owns the
  // remaining orchestration: commit MCP/environment setup atomically, then use
  // the normal prompt admission path. If admission fails, the configured blank
  // session remains usable and the browser can put the prompt in its ordinary
  // composer without retaining a second retry protocol.
  // ============================================================================

  registerLongAuthenticatedRoute(
    app,
    '/sessions/:id/initialize',
    {
      async create(data: SessionInitializationRequest, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new BadRequest('Session ID required');
        if (!data || typeof data !== 'object') {
          throw new BadRequest('Session initialization data required');
        }
        if (typeof data.expectedUserId !== 'string' || !data.expectedUserId) {
          throw new BadRequest('expectedUserId required');
        }
        if (data.prompt !== undefined && typeof data.prompt !== 'string') {
          throw new BadRequest('prompt must be a string');
        }
        const callerId = params.user?.user_id;
        if (!callerId || data?.expectedUserId !== callerId) {
          throw new Forbidden('Session initialization caller changed');
        }
        const session = await inCurrentTenantDatabaseScope(async () => {
          await requireSessionScopedConfigOwnerOrAdmin(id, params);
          const current = await sessionsService.get(id, { provider: undefined });
          if (!current) throw new NotFound(`Session not found: ${id}`);
          return current as Session;
        });
        let configuredMcpServerIds: MCPServerID[] | undefined;
        let configuredEnvVarNames: string[] | undefined;

        if (data.mcpServerIds !== undefined) {
          if (
            !Array.isArray(data.mcpServerIds) ||
            !data.mcpServerIds.every((serverId) => typeof serverId === 'string' && serverId)
          ) {
            throw new BadRequest('mcpServerIds must contain non-empty strings');
          }
          configuredMcpServerIds = [...new Set(data.mcpServerIds)] as MCPServerID[];
        }

        if (data.envVarNames !== undefined) {
          configuredEnvVarNames = normalizeEnvVarNames(data.envVarNames);
        }

        const prompt = data.prompt?.trim();
        const task = await runSessionInitializationStages({
          db,
          mcpServerIds: configuredMcpServerIds,
          envVarNames: configuredEnvVarNames,
          setMcpServers: async (serverIds) => {
            try {
              await sessionMCPServersService.setServers(session.session_id, serverIds, params);
            } catch (error) {
              if (error instanceof MCPServerNotUsableError) {
                throw new Forbidden('An MCP server is private to another user');
              }
              throw error;
            }
          },
          setEnvVarNames: (envVarNames) =>
            assertSelectableSessionEnvVarNames(session, envVarNames).then(() =>
              sessionEnvSelectionsService.setAll(session.session_id, envVarNames, params)
            ),
          publishMcpServersChanged: (serverIds) =>
            emitServiceEvent(app, {
              path: 'session-mcp-servers',
              event: 'patched',
              data: { session_id: session.session_id, mcp_server_ids: serverIds },
              params,
            }),
          publishEnvVarNamesChanged: (envVarNames) =>
            emitServiceEvent(app, {
              path: 'session-env-selections',
              event: 'patched',
              data: { session_id: session.session_id, env_var_names: envVarNames },
              params,
            }),
          admitPrompt: prompt
            ? () =>
                app.service('/sessions/:id/prompt').create(
                  {
                    prompt: data.prompt,
                    permissionMode: data.permissionMode,
                  },
                  { ...params, route: { id: session.session_id } }
                )
            : undefined,
        });

        return { sessionId: session.session_id, task };
      },
      // biome-ignore lint/suspicious/noExplicitAny: Service type not compatible with Express
    } as any,
    {
      create: { role: ROLES.MEMBER, action: 'initialize sessions' },
    },
    requireAuth
  );

  // ============================================================================
  // Health endpoint
  // ============================================================================

  app.use('/health', {
    async find(params?: AuthenticatedParams) {
      const identityAuthority = resolveIdentityAuthority(config);
      const passwordPolicy = identityAuthority.capabilities.users.passwordWrite
        ? resolvePasswordPolicyRequirements(config.identity?.password_policy)
        : undefined;
      // `/health` stays 200 always (pre-login UI fetches must not throw), so the
      // DB signal rides on `status`: ok | degraded. /readyz is the one that 503s.
      // Only { ok, latencyMs } is public; the raw error is authenticated-only below.
      const dbProbe = await probeDatabase(db);
      const publicResponse = {
        service: 'agor-daemon',
        deploymentId: requireDeploymentId(config),
        // Present only for daemons detached by `agor daemon start`. The CLI
        // compares this opaque ID with its local ownership record before it
        // sends a signal, preventing a stale/recycled PID from being killed.
        managedInstanceId: process.env.AGOR_MANAGED_DAEMON_INSTANCE_ID,
        status:
          healthStatus(dbProbe) === 'ok' && (!realtimeRuntime || realtimeRuntime.isReady())
            ? 'ok'
            : 'degraded',
        db: publicHealthDb(dbProbe),
        timestamp: Date.now(),
        version: DAEMON_VERSION,
        // Build identity for the version-sync banner (apps/agor-ui ConnectionStatus).
        // SHA precedence is resolved at startup — see setup/build-info.ts.
        // Tabs capture this SHA on first connect and prompt a refresh whenever
        // a later handshake reports a different value. 'dev' disables the check.
        buildSha: DAEMON_BUILD_INFO.sha,
        builtAt: DAEMON_BUILD_INFO.builtAt,
        auth: {
          requireAuth: true,
          externalLaunch: publicLaunchAuth,
          identity: identityAuthority,
          passwordPolicy,
        },
        instance: {
          label: config.daemon?.instanceLabel,
          description: config.daemon?.instanceDescription,
        },
        realtime: realtimeRuntime
          ? { required: true, ready: realtimeRuntime.isReady() }
          : { required: false, ready: true },
        features: {
          teammateFrameworkRepoUrl: resolveTeammateFrameworkRepoUrl(config),
          // Web terminal availability: UI should hide terminal buttons when false.
          // Server-side gate in register-hooks.ts is the source of truth; this
          // flag exists so the UI can skip rendering buttons that would fail.
          // Defaults to true when the config key is unset.
          webTerminal: resolveWebTerminalCapability({ config, deployment }).enabled,
          webTerminalCapability: resolveWebTerminalCapability({ config, deployment }),
          // How managed environment lifecycle fields execute. In
          // webhook-only mode the UI/MCP may still show env controls, but
          // non-URL rendered commands are rejected server-side.
          managedEnvsExecutionMode:
            config.execution?.managed_envs_execution_mode ?? MANAGED_ENV_EXECUTION_MODE_DEFAULT,
          // True when the daemon runs in a multi-user Unix isolation mode
          // (sandbox). UI hides "trust everyone on this instance"
          // surfaces when true. Server-side gates (e.g. ArtifactsService.
          // grantTrust) are the source of truth and reject regardless.
          multiUser: (config.execution?.unix_user_mode ?? 'simple') !== 'simple',
          // Tenant agentic-tool settings provide the authoritative availability gate.
          cursorSdk: true,
          // Provider-policy release boundary. Absence is false; the daemon
          // independently rejects the OAuth service when disabled.
          claudeSubscriptionOAuth: hasClaudeSubscriptionOAuthCapability(config, deployment),
          // Resolved branch storage policy. The daemon still enforces this at
          // create time; the UI uses it to pick the right default and disable
          // unavailable storage modes before submit.
          branchStorage: resolveBranchStorageConfig(config),
          uploadPolicy: getUploadLimits(),
          // Normalized board/branch policies are independently feature-gated.
          // This is safe to advertise before login so the UI can avoid
          // rendering controls that the daemon will reject. Authorization
          // remains enforced server-side.
          branchRbac: config.execution?.branch_rbac === true,
        },
      };

      const isAuthenticated = params?.user !== undefined;

      if (isAuthenticated) {
        const dialect = process.env.AGOR_DB_DIALECT === 'postgresql' ? 'postgresql' : 'sqlite';
        const databaseInfo = buildDatabaseHealthInfo(dialect, DB_PATH);

        // Diagnostic only; not in the public payload, doesn't gate readiness.
        // Gated behind auth like the rest of this block (any authenticated
        // user, matching the existing `database`/`execution` fields below —
        // not admin-only).
        const healthTenantId =
          (params as AuthenticatedParams | undefined)?.tenant?.tenant_id ?? getCurrentTenantId();
        if (!healthTenantId) {
          throw new NotAuthenticated('Missing tenant context for authenticated health');
        }
        const migrations = await probePendingMigrations(db);
        const mcpEgressMode = await runWithTenantDatabaseScope(db, healthTenantId, (tenantDb) =>
          getMCPEgressGatewayMode(tenantDb)
        );
        const mcpEgressRuntime = mcpEgressGateway.status(healthTenantId);

        return {
          ...publicResponse,
          // Full DB probe detail, including the raw error, is authenticated-only
          // (never in the public payload).
          db: authenticatedHealthDb(dbProbe),
          migrations: healthMigrations(migrations),
          database: databaseInfo,
          auth: {
            ...publicResponse.auth,
            user: params?.user?.email,
            role: params?.user?.role,
          },
          encryption: {
            enabled: !!process.env.AGOR_MASTER_SECRET,
            method: process.env.AGOR_MASTER_SECRET ? 'AES-256-GCM' : null,
          },
          mcp: {
            enabled: config.daemon?.mcpEnabled !== false,
            egress: {
              mode: mcpEgressMode,
              // A health read cannot prove the next admission. Keep this
              // explicitly unknown rather than turning DB reachability into a
              // false 99.99% gateway availability claim.
              admissionAvailable: null,
              // Backward-compatible name; this is the same truthful total as
              // activeRequests, not provider-only transport work.
              inFlightRequests: mcpEgressRuntime.inFlightRequests,
              activeRequests: mcpEgressRuntime.activeRequests,
              providerInFlightRequests: mcpEgressRuntime.providerInFlightRequests,
              reservedRequests: mcpEgressRuntime.reservedRequests,
              oldestRequestMs: mcpEgressRuntime.oldestRequestMs,
            },
          },
          // Execution mode surfaced so admins can confirm which security tier
          // the daemon booted under. Docker env overrides (AGOR_SET_RBAC_FLAG,
          // AGOR_SET_UNIX_MODE) are written into ~/.agor/config.yaml by the
          // entrypoint before boot, so `config.execution` reflects them.
          execution: {
            branchRbac: config.execution?.branch_rbac === true,
            unixUserMode: config.execution?.unix_user_mode ?? 'simple',
            managedEnvsExecutionMode:
              config.execution?.managed_envs_execution_mode ?? MANAGED_ENV_EXECUTION_MODE_DEFAULT,
          },
          deployment: {
            mode: deployment.mode,
            ...(deployment.mode === 'ha'
              ? {
                  // @agor/core's source owns these fields. The daemon package's
                  // no-build typecheck can temporarily see the previous core
                  // dist declaration while watch mode catches up.
                  supportProfile: (deployment as typeof deployment & { supportProfile: string })
                    .supportProfile,
                  capabilities: (
                    deployment as typeof deployment & {
                      capabilities: Record<string, boolean>;
                    }
                  ).capabilities,
                }
              : {}),
            instanceId: distributedWorkIdentity.instanceId,
            bootId: distributedWorkIdentity.bootId,
            realtime: realtimeRuntime?.health() ?? { required: false, ready: true },
          },
          // Resolved security posture — admins can confirm in Settings → About
          // which CSP/CORS policy the daemon booted with, without tailing logs
          // or reading response headers by hand. Keep the shape tight: the
          // full CSP header value is the one piece operators actually need
          // when debugging a blocked resource.
          security: {
            csp: {
              enabled: !resolvedSecurity.csp.disabled,
              reportOnly: resolvedSecurity.csp.reportOnly,
              reportUri: resolvedSecurity.csp.reportUri,
              header: resolvedSecurity.csp.headerValue,
            },
            cors: {
              mode: resolvedSecurity.cors.mode,
              credentials: resolvedSecurity.cors.credentials,
              originCount: resolvedSecurity.cors.origins.length,
              allowSandpack: resolvedSecurity.cors.allowSandpack,
            },
          },
        };
      }

      return publicResponse;
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service type not fully typed
  const healthService = app.service('health') as any;
  healthService.docs = {
    description: 'Health check endpoint (always public)',
    security: [],
  };

  // Liveness (/livez) and readiness (/readyz) probes — see health/routes.ts.
  registerHealthProbeRoutes(app, db, [
    ...(realtimeRuntime ? [{ name: 'redis', isReady: () => realtimeRuntime.isReady() }] : []),
    ...(deployment.mode === 'ha'
      ? [
          {
            name: 'environment-health-monitor',
            isReady: () => {
              const monitor = app.get('environmentHealthMonitor') as
                | { isReady?: () => boolean }
                | undefined;
              return monitor?.isReady?.() === true;
            },
          },
        ]
      : []),
  ]);

  // ============================================================================
  // MCP routes
  // ============================================================================

  if (config.daemon?.mcpEnabled !== false) {
    const { setupMCPRoutes } = await import('./mcp/server.js');
    const toolSearchEnabled = config.daemon?.mcpToolSearch !== false;
    setupMCPRoutes(app, db, toolSearchEnabled, config, { serverVersion: AGOR_VERSION });
    console.log(
      `✅ MCP server enabled at POST /mcp${toolSearchEnabled ? ' (tool search mode)' : ''}`
    );
  } else {
    console.log('🔒 MCP server disabled via config (daemon.mcpEnabled=false)');
  }

  // ============================================================================
  // Global app hooks + error handler
  // ============================================================================

  // Health probes already have HTTP metrics/spans; auth strategies preserve the
  // provider for the serialized-entity lookup even though it is framework work.
  // Both instrumentation hooks skip the same set for a consistent boundary.
  const feathersInstrumentationOptions = {
    excludedServicePaths: ['health'],
    isInternalCall: (context: HookContext) => isAuthenticationUserLookup(context.params),
  };

  // Outermost: open the APM span first so it encloses the metrics timing and
  // every child (Postgres, Redis) span. Registered only when enabled, so
  // metrics.apm.trace_services=off adds nothing to the hook chain.
  const apmTraceDepth = config.metrics?.apm?.trace_services ?? 'off';
  const aroundAll =
    apmTraceDepth === 'off'
      ? [createFeathersMetricsHook(getDaemonMetrics(app), feathersInstrumentationOptions)]
      : [
          createFeathersTracingHook(apmTraceDepth, feathersInstrumentationOptions),
          createFeathersMetricsHook(getDaemonMetrics(app), feathersInstrumentationOptions),
        ];

  app.hooks({
    around: {
      all: aroundAll,
    },
    before: {
      all: [enforcePasswordChange],
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS app.use expects service path, but errorHandler is Express middleware
  (app as any).use(errorHandler());
}
