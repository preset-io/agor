/**
 * Service Hooks Registration
 *
 * Registers all FeathersJS service hooks (before/after/error)
 * for authentication, authorization, RBAC, and business logic.
 * Extracted from index.ts for maintainability.
 */

import { AGENTIC_TOOL_DISPLAY_NAMES } from '@agor/agentic-tools';
import { projectClaudeResultResponse, projectNormalizedSdkResponse } from '@agor/core';
import { analyticsLogger } from '@agor/core/analytics';
import {
  type AgorConfig,
  type ResolvedDeploymentConfig,
  resolveExecutionSecurityMode,
  resolveMultiTenancyConfig,
  resolveMultiTenancyDatabaseDialect,
  resolveTenantContext,
  TenantResolutionError,
  type UnknownJson,
  validateRepoEnvironment,
  wrapV1AsV2,
} from '@agor/core/config';
import {
  ArtifactRepository,
  assertTenantWritable,
  BoardCommentsRepository,
  BoardObjectRepository,
  BoardRepository,
  type BranchRepository,
  CapabilityPolicyRepository,
  CardRepository,
  getMCPEgressGatewayMode,
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  ScheduleRepository,
  type SessionRepository,
  shortId,
  TaskRepository,
  type TenantScopeAwareDatabase,
  TenantWriteGateActiveError,
  type UsersRepository,
} from '@agor/core/db';
import {
  MANAGED_ENV_EXECUTION_MODE_DEFAULT,
  validateManagedEnvLifecyclePolicy,
  validateRenderedManagedEnvUrlFields,
  validateRepoEnvironmentLifecyclePolicy,
} from '@agor/core/environment/webhook';
import type { Application, FeathersService } from '@agor/core/feathers';
import {
  BadRequest,
  Forbidden,
  NotAuthenticated,
  NotFound,
  Unavailable,
} from '@agor/core/feathers';
import { redactGatewayChannelSecrets } from '@agor/core/gateway';
import {
  boardCommentQueryValidator,
  boardObjectQueryValidator,
  boardQueryValidator,
  branchQueryValidator,
  mcpCatalogQueryValidator,
  mcpServerQueryValidator,
  messageQueryValidator,
  repoQueryValidator,
  sessionQueryValidator,
  taskQueryValidator,
  typedValidateQuery,
  userQueryValidator,
} from '@agor/core/lib/feathers-validation';
import { assertValidMCPServerWrite, isMCPServerUsableBy } from '@agor/core/mcp';
import type {
  AuthenticatedParams,
  Board,
  BoardID,
  Branch,
  DeepReadonly,
  GatewayChannel,
  HookContext,
  MCPServer,
  MessageID,
  Paginated,
  Params,
  Session,
  Task,
  User,
  UserID,
  UUID,
} from '@agor/core/types';
import {
  assertPublicMCPOAuthCompatibilityMode,
  GATEWAY_CHANNEL_WRITE_FIELDS,
  GATEWAY_REDACTED_SENTINEL,
  hasMinimumRole,
  ROLES,
  SCHEDULE_CREATE_WRITE_FIELDS,
  SCHEDULE_PATCH_WRITE_FIELDS,
  TaskStatus,
} from '@agor/core/types';
import {
  isTaskScopedExecutorRequest,
  requireExecutorBranchReadScope,
  requireTaskScopedExecutorRuntimeToken,
  requireWorkloadCompletionReceipt,
} from './auth/executor-runtime-scope.js';
import type {
  BoardsServiceImpl,
  MessagesServiceImpl,
  SessionsServiceImpl,
  TasksServiceImpl,
} from './declarations.js';
import { rejectInConstrainedHa } from './ha-support.js';
import {
  classifyMissingCredentialFailure,
  protectExternalProviderFailureMetadata,
} from './hooks/classify-missing-credential.js';
import { gatewayRouteHook } from './hooks/gateway-route.js';
import { validateMessageCreate } from './hooks/validate-message-create.js';
import { coordinateMCPServerMutationAfterWrite } from './mcp-egress/coordination.js';
import { protectExternalPermissionMessageWrites } from './permissions/permission-message-boundary.js';
import type { RedisRealtimeRuntime } from './realtime/redis-realtime.js';
import type { ArtifactsService } from './services/artifacts.js';
import {
  publicBoardCommentCreateInput,
  publicBoardCommentPatchInput,
  rejectPublicBoardCommentUpdate,
} from './services/board-comments.js';
import { CODEX_AUTH_DEFER_USER_REALTIME } from './services/codex-auth-shared.js';
import type { GatewayService } from './services/gateway.js';
import { groupMembershipsHooks, groupsHooks } from './services/groups.js';
import { presentMCPServerOAuthPolicies } from './services/mcp-server-presentation.js';
import {
  isRemoteRelationshipsEnrichedResult,
  markRemoteRelationshipsEnrichedResult,
} from './services/sessions.js';
import { isAuthenticationUserLookup, isLocalAuthenticationLookup } from './services/users.js';
import { resolveWebTerminalCapability } from './terminal-capability.js';
import { buildSessionCreatedAnalyticsProperties } from './utils/analytics-payloads.js';
import {
  ensureMinimumRole,
  registerAuthenticatedRoute,
  requireAdminForEnvConfig,
  requireMinimumRole,
} from './utils/authorization.js';
import {
  cacheBranchAccess,
  ensureBranchOwnerOrAdmin,
  ensureBranchPermission,
  ensureCanCreateSession,
  ensureCanModifySchedule,
  ensureCanPromptInSession,
  ensureCanPromptTargetSession,
  ensureCanView,
  ensureSessionImmutability,
  loadBranch,
  loadBranchFromSession,
  loadScheduleAndBranch,
  loadSession,
  loadSessionBranch,
  resolveSessionContext,
  scopeFindToAccessibleBoardsSql,
  scopeFindToAccessibleBranchesSql,
  scopeFindToAccessibleSessionsSql,
  scopeReadToAccessibleBoardsSql,
  scopeScheduleQuery,
  setSessionUnixUsername,
  validateSessionUnixUsername,
} from './utils/branch-authorization.js';
import { captureBranchRemovalRealtimeVisibility as captureBranchRemovalVisibility } from './utils/branch-removal-realtime.js';
import { emitServiceEvent } from './utils/emit-service-event.js';
import { bindPrimaryOwnerToCreatedBy, injectCreatedBy } from './utils/inject-created-by.js';
import {
  captureMarketplaceInvalidationTargets as captureMarketplaceTargets,
  publishCapturedMarketplaceInvalidation,
} from './utils/marketplace-invalidation.js';
import {
  redactMCPServerSecrets,
  shouldExposeMCPServerSecrets,
} from './utils/mcp-header-secrets.js';
import { createMcpServerWriteAuthorizationHook } from './utils/mcp-server-authorization.js';
import { realignRepoOriginAfterPatchHook } from './utils/realign-repo-origin.js';
import {
  bindRealtimeAccessCacheInvalidation,
  type RealtimeAccessBranchRepository,
  RealtimeAccessCache,
  type RealtimeAccessSessionRepository,
} from './utils/realtime-access-cache.js';
import {
  configureRealtimePublish,
  type RealtimeAccessBoardRepository,
  setBoardRemovalRealtimeVisibility,
} from './utils/realtime-publish.js';
import {
  resolveSandboxProtectedDataRoots,
  validateFilesystemHomeOverride,
} from './utils/sandbox-context.js';
import {
  ensureCurrentScheduleLoaded,
  ensureScheduleRunsAsCaller,
  recomputeNextRunAt,
  validateScheduleConfig,
} from './utils/schedule-hooks.js';
import { createSessionMcpTokenAfterHooks } from './utils/session-mcp-token-hook.js';
import { deferWithSessionQueueTenantScope } from './utils/session-queue-tenant-scope.js';
import {
  isTerminalQueueProcessingSuppressed,
  sessionCanStartTask,
} from './utils/session-task-state.js';
import {
  createTenantDatabaseScopeAroundHook,
  deferWithTenantContext,
  enforceTenantWriteGateForHook,
} from './utils/tenant-db-scope.js';
import { enforcePublicWriteFields, markWriteDataPrepared } from './utils/write-data-boundary.js';
import { protectExternalWidgetMessageWrites } from './widgets/message-boundary.js';

const DEBUG_MCP_TOKENS =
  process.env.AGOR_DEBUG_MCP_TOKENS === '1' || process.env.DEBUG?.includes('mcp-tokens');

function mcpTokenDebug(...args: unknown[]): void {
  if (DEBUG_MCP_TOKENS) {
    console.debug(...args);
  }
}

const BRANCH_ENV_FIELDS = [
  'start_command',
  'stop_command',
  'nuke_command',
  'logs_command',
  'health_check_url',
  'app_url',
] as const;

function itemHasAnyField(item: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some((field) => Object.hasOwn(item, field));
}

export function shouldValidateRepoEnvironmentPayload(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function getManagedEnvExecutionMode(config: DeepReadonly<AgorConfig>) {
  return config.execution?.managed_envs_execution_mode ?? MANAGED_ENV_EXECUTION_MODE_DEFAULT;
}

function validateRepoEnvPolicyHook(config: DeepReadonly<AgorConfig>) {
  return async (context: HookContext) => {
    const mode = getManagedEnvExecutionMode(config);
    const items = Array.isArray(context.data) ? context.data : [context.data];

    for (const item of items as Array<Record<string, unknown>>) {
      if (
        Object.hasOwn(item, 'environment') &&
        shouldValidateRepoEnvironmentPayload(item.environment)
      ) {
        try {
          const env = validateRepoEnvironment(item.environment);
          validateRepoEnvironmentLifecyclePolicy(env, mode);
        } catch (error) {
          throw new BadRequest(error instanceof Error ? error.message : 'Invalid repo environment');
        }
      }

      if (
        Object.hasOwn(item, 'environment_config') &&
        shouldValidateRepoEnvironmentPayload(item.environment_config)
      ) {
        try {
          const env = wrapV1AsV2(item.environment_config as Parameters<typeof wrapV1AsV2>[0]);
          if (env) validateRepoEnvironmentLifecyclePolicy(env, mode, 'legacy repo environment');
        } catch (error) {
          throw new BadRequest(
            error instanceof Error ? error.message : 'Invalid legacy repo environment'
          );
        }
      }
    }

    return context;
  };
}

function branchEnvFieldsFromItem(item: Partial<Branch>) {
  return {
    start: item.start_command,
    stop: item.stop_command,
    nuke: item.nuke_command,
    logs: item.logs_command,
  };
}

export function validateBranchEnvPolicyHook(config: DeepReadonly<AgorConfig>) {
  return async (context: HookContext) => {
    const items = Array.isArray(context.data) ? context.data : [context.data];
    const shouldValidate = (items as Array<Record<string, unknown>>).some((item) =>
      itemHasAnyField(item, BRANCH_ENV_FIELDS)
    );
    if (!shouldValidate) return context;

    const mode = getManagedEnvExecutionMode(config);
    for (const raw of items as Array<Partial<Branch>>) {
      let item = raw;
      if (context.method === 'patch' && context.id !== null && context.id !== undefined) {
        const existing = (await context.service.get(context.id, context.params)) as Branch;
        item = { ...existing, ...raw };
      }

      try {
        validateManagedEnvLifecyclePolicy(
          branchEnvFieldsFromItem(item),
          mode,
          'branch environment'
        );
        // The app URL is rendered metadata consumed directly by clients, so it
        // must be safe before persistence. The health URL is outbound runtime
        // configuration: validate it at the observation boundary instead of
        // making branch materialization depend on an inactive environment.
        validateRenderedManagedEnvUrlFields({
          app: item.app_url,
        });
      } catch (error) {
        throw new BadRequest(error instanceof Error ? error.message : 'Invalid branch environment');
      }
    }

    return context;
  };
}

/**
 * Session fields written as runtime bookkeeping during the prompt/execution
 * lifecycle, on behalf of the session's authenticated user. These are NOT
 * session metadata (name, model_config, permission_config, callback_config).
 *
 * Sources:
 *   - `/sessions/:id/prompt`  → `tasks`, `archived`, `archived_reason`
 *   - `/sessions/:id/stop`    → `status`, `ready_for_prompt`
 *   - executor status updates → `status`, `ready_for_prompt`
 *     (claude/copilot permission-hooks, see packages/executor)
 *   - executor opencode init   → `sdk_session_id` (SDK session handle)
 *
 * When a `patch` touches ONLY these fields, the sessions hook chain downgrades
 * the required branch permission from `'all'` to the same tier that
 * {@link ensureCanPromptInSession} enforces:
 *   - `'prompt'` or `'all'` → can patch any session's prompt-flow fields
 *   - `'session'`           → can patch own session's prompt-flow fields
 *   - `'view'` or `'none'`  → denied
 *
 * Any mixed-field patch (e.g. `{ tasks: [...], name: 'x' }`) fails the
 * `isPromptFlowPatchOnly` check and falls through to the strict `'all'` path,
 * so widening the whitelist here cannot accidentally leak metadata writes.
 *
 * NOTE: `sdk_session_id` is on this list because a task executor authenticates
 * as the initiating user and reports the SDK handle during that user's prompt
 * lifecycle. This exception does not grant service-account access; task result
 * writes are independently bound to the exact signed task context.
 */
export const PROMPT_FLOW_PATCH_FIELDS: readonly string[] = [
  'tasks',
  'archived',
  'archived_reason',
  'status',
  'ready_for_prompt',
  'sdk_session_id',
];

export function isPromptFlowPatchOnly(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const keys = Object.keys(data);
  if (keys.length === 0) return false;
  return keys.every((key) => PROMPT_FLOW_PATCH_FIELDS.includes(key));
}

export function shouldRunSessionPostTurnHooks(
  session: Pick<Session, 'status' | 'ready_for_prompt'>
): boolean {
  return sessionCanStartTask(session.status, session.ready_for_prompt);
}

export function shouldDrainQueueAfterSessionPostTurnPatch(
  session: Pick<Session, 'status' | 'ready_for_prompt'>,
  params?: Params
): boolean {
  return (
    shouldRunSessionPostTurnHooks(session) &&
    session.ready_for_prompt === true &&
    !isTerminalQueueProcessingSuppressed(params)
  );
}

export function getTrustedSessionTenantId(session: unknown): string | undefined {
  const tenantId = (session as { tenant_id?: unknown } | undefined)?.tenant_id;
  return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : undefined;
}

export async function enrichSessionFindResultWithRemoteRelationships(
  result: Paginated<Session> | Session[],
  sessionsService: Pick<SessionsServiceImpl, 'enrichRemoteRelationships'>
): Promise<Paginated<Session> | Session[]> {
  if (isRemoteRelationshipsEnrichedResult(result)) return result;

  if (Array.isArray(result)) {
    return markRemoteRelationshipsEnrichedResult(
      await sessionsService.enrichRemoteRelationships(result)
    );
  }

  return markRemoteRelationshipsEnrichedResult({
    ...result,
    data: await sessionsService.enrichRemoteRelationships(result.data),
  });
}

/**
 * Extended Params with route ID parameter (needed by artifact routes in hooks).
 */
interface RouteParams extends Params {
  route?: {
    id?: string;
    messageId?: string;
    mcpId?: string;
    requestId?: string;
  };
  user?: User;
}

/**
 * Interface for dependencies needed by hook registration.
 */
export interface RegisterHooksContext {
  db: TenantScopeAwareDatabase;
  app: Application & { io?: import('socket.io').Server };
  config: AgorConfig;
  jwtSecret: string;
  requireAuth: (context: HookContext) => Promise<HookContext>;
  superadminOpts: { allowSuperadmin: boolean };
  realtimeRelay?: Pick<RedisRealtimeRuntime, 'relay' | 'setRelayHandler'>;
  deployment: ResolvedDeploymentConfig;

  // Service instances from registerServices()
  sessionsService: SessionsServiceImpl;
  messagesService: MessagesServiceImpl;
  boardsService: BoardsServiceImpl | undefined;
  /** Test seam; production constructs one repository over the trusted scoped DB. */
  boardRepository?: BoardRepository & RealtimeAccessBoardRepository;
  branchRepository: BranchRepository;
  usersRepository: UsersRepository;
  sessionsRepository: SessionRepository;
}

/**
 * RBAC services whose authorization hooks consume the authenticated principal.
 *
 * Socket.IO supplies `params.user` from immutable connection authority, while
 * REST supplies only `params.authentication` until the shared authentication
 * hook runs. Keep that transport normalization at one boundary so nested RBAC
 * services cannot accidentally work over Socket.IO while rejecting or running
 * without tenant authority over REST.
 */
export const AUTHENTICATED_RBAC_SERVICE_PATHS = [
  'groups',
  'group-memberships',
  'branches/:id/permissions',
  'branches/:id/effective-access',
  'branches/:id/fs-access-users',
  'boards/:id/permissions',
  'boards/:id/aligned-branches',
  'workspace-preferences',
] as const;

/**
 * Register all FeathersJS service hooks.
 */
export const TENANT_OWNED_SERVICE_PATHS = [
  'sessions',
  'sessions/:id/mcp-servers',
  'session-relationships',
  'tasks',
  'messages',
  'boards',
  'boards/:id/archive',
  'boards/:id/unarchive',
  'repos',
  'branches',
  'schedules',
  'users',
  ...AUTHENTICATED_RBAC_SERVICE_PATHS,
  'app-variables',
  'agentic-tool-settings',
  'agentic-tool-presets',
  'mcp-servers',
  'mcp-servers/oauth-attempt-status',
  'mcp-servers/oauth-disconnect',
  'mcp-servers/oauth-status',
  'mcp-catalog/readiness',
  'mcp-marketplace',
  'mcp-marketplace/remove-unattached',
  'mcp-marketplace/tool-permission',
  'card-types',
  'cards',
  'artifacts',
  'artifact-trust-grants',
  'board-objects',
  'session-mcp-servers',
  'user-mcp-oauth-tokens',
  'board-comments',
  'gateway',
  'thread-session-map',
  'gateway-outbound-messages',
  'session-env-selections',
  'kb/namespaces',
  'kb/documents',
  'kb/graph',
  'kb/document-edits',
  'kb/versions',
  'kb/search',
  'kb/settings',
  'kb/indexing/status',
  'kb/indexing/reindex',
  'leaderboard',
];

// These endpoints perform network/process work after their tenant DB reads,
// so they carry tenant identity for the full request and open short database
// units of work at the call site instead of holding an HTTP-long transaction.
export const TENANT_IDENTITY_ONLY_SERVICE_PATHS = [
  'check-auth',
  // This command-scoped capability opens one short owner-bound read after
  // verifying the executor token; it must not inherit an HTTP-long DB scope.
  'executor-git-environment',
  // File browsing delegates to the executor after bounded repository reads.
  // Keep request-wide tenant identity while each service opens only a short
  // database unit of work before crossing the executor boundary.
  'file',
  'files',
  // Global catalog: no tenant column to scope, no writes to stamp.
  'mcp-catalog',
  'codex-auth/device',
  'codex-auth/import',
  'codex-auth/logout',
  'opencode-auth',
  'opencode-models',
  'claude-models',
  'copilot-models',
  'cursor-models',
  'terminals',
  // These OAuth/discovery endpoints perform provider network I/O or wait for
  // a browser callback. Their durable one-shot claim must commit before any
  // authorization-code exchange, so they must never inherit an HTTP-long
  // tenant transaction. Each DB access opens a short tenant unit of work.
  'mcp-servers/discover',
  'mcp-servers/oauth-complete',
  'mcp-servers/oauth-start',
  'mcp-servers/oauth-auth-headers',
  'mcp-servers/oauth-refresh',
  'mcp-servers/test-oauth',
  // Gateway channel authority writes may probe a provider. The service opens
  // short tenant DB units around metadata phases and never holds one across
  // that provider call.
  'gateway-channels',
] as const;

/**
 * Closed MCP-server transport contract. Public REST/Socket.IO callers receive
 * the narrow editor schema; trusted in-process catalog/import/discovery calls
 * use the explicit internal schema that includes provenance/capabilities.
 */
export function validateMcpServerWriteInput(context: HookContext, create: boolean): HookContext {
  const items = Array.isArray(context.data) ? context.data : [context.data];
  const catalogEntryName = (
    context.params as typeof context.params & {
      mcpCatalogInstall?: { entry_name?: string };
    }
  ).mcpCatalogInstall?.entry_name;
  try {
    for (const item of items) {
      // Marketplace connect is a public request that deliberately calls this
      // service through a daemon-owned params capability. Validate the exact
      // provenance stamp that the following authorization hook will inject;
      // ordinary REST/Socket.IO callers cannot manufacture params fields.
      const validatedItem =
        catalogEntryName && item && typeof item === 'object' && !Array.isArray(item)
          ? { ...item, catalog_entry_name: catalogEntryName }
          : item;
      assertValidMCPServerWrite(validatedItem, {
        operation: create ? 'create' : 'mutation',
        // Lack of a transport provider is not itself an authorization
        // capability: built-in MCP tools and other in-process callers still
        // operate on behalf of a user. The catalog's daemon-owned stamp is the
        // only current path that may write protected provenance fields.
        trusted: Boolean(catalogEntryName),
        requireConfiguredCredentials: create && !catalogEntryName,
      });
    }
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : 'Invalid MCP server input');
  }
  return context;
}

/** Caller-specific Knowledge command responses must never become service events. */
export function suppressKnowledgeCommandRealtimeEvent(context: HookContext): HookContext {
  context.event = null;
  return context;
}

/**
 * Service endpoints whose implementation retains process-local credentials,
 * provider handshakes, or native runtime state. Keep this inventory exported
 * so the constrained HA fail-closed boundary has direct regression coverage.
 * MCP discovery is deliberately absent: its ordinary capability probe is HA
 * safe, while its optional OAuth escalation is stopped inside the endpoint
 * before provider discovery or flow creation.
 */
export const CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES = [
  ['codex-auth/device', 'codexDeviceAuth'],
  ['codex-auth/import', 'codexAuth'],
  ['codex-auth/logout', 'codexAuth'],
  ['opencode-auth', 'openCodeAuth'],
  ['opencode-models', 'openCodeAuth'],
] as const satisfies ReadonlyArray<readonly [string, Parameters<typeof rejectInConstrainedHa>[1]]>;

const taskFieldSet = (...fields: (keyof Task)[]) => new Set<string>(fields);

const EXECUTOR_TASK_PATCH_FIELDS = taskFieldSet(
  'status',
  'completed_at',
  'git_state',
  'message_range',
  'model',
  'raw_sdk_response',
  'normalized_sdk_response',
  'computed_context_window',
  'tool_use_count',
  'duration_ms',
  'agent_session_id',
  'error_message',
  'report',
  'permission_request'
);

const EXTERNAL_TASK_CREATE_FIELDS = taskFieldSet('session_id', 'full_prompt', 'status');

/** Keep the documented two-step create/run API dormant until the explicit run call. */
export function protectExternalTaskCreate(context: HookContext): HookContext {
  if (!context.params.provider) return context;

  const data =
    context.data && typeof context.data === 'object' && !Array.isArray(context.data)
      ? (context.data as Record<string, unknown>)
      : undefined;
  if (!data) throw new BadRequest('Task creation requires one task');

  const unsupported = Object.keys(data).find((field) => !EXTERNAL_TASK_CREATE_FIELDS.has(field));
  if (unsupported) throw new BadRequest(`Task create field is not client-managed: ${unsupported}`);
  if (typeof data.session_id !== 'string' || !data.session_id) {
    throw new BadRequest('session_id is required when creating a task');
  }
  if (typeof data.full_prompt !== 'string') {
    throw new BadRequest('full_prompt is required when creating a task');
  }
  if (data.status !== undefined && data.status !== TaskStatus.CREATED) {
    throw new BadRequest('Externally created tasks must use status created');
  }

  data.status = TaskStatus.CREATED;
  return context;
}

/** Prevent callers on a Feathers transport from forging executor-owned task state. */
export async function protectServerManagedTaskWrites(context: HookContext): Promise<HookContext> {
  if (!context.params.provider) return context;

  if (typeof context.id !== 'string' || !isTaskScopedExecutorRequest(context, context.id)) {
    throw new Forbidden('Task patches require an executor token scoped to this task');
  }

  const write =
    context.data && typeof context.data === 'object' && !Array.isArray(context.data)
      ? (context.data as Record<string, unknown>)
      : undefined;
  if (!write || Object.keys(write).some((field) => !EXECUTOR_TASK_PATCH_FIELDS.has(field))) {
    throw new Forbidden('Task patch contains fields that are not executor-managed');
  }

  return context;
}

/**
 * Defense in depth at the executor -> daemon persistence/realtime boundary.
 * The executor projects Claude results first, but an old or compromised
 * executor must not be able to reintroduce provider result/error prose or SDK
 * extension objects into Task state.
 */
export function projectExecutorTaskSdkResponse(
  tasks: Pick<TaskRepository, 'findById'>,
  sessions: Pick<SessionRepository, 'findById'>
) {
  return async (context: HookContext): Promise<HookContext> => {
    if (!context.params.provider || typeof context.id !== 'string') return context;
    const write =
      context.data && typeof context.data === 'object' && !Array.isArray(context.data)
        ? (context.data as Record<string, unknown>)
        : undefined;
    if (!write) return context;

    // Normalized responses are independently executor-owned input. An old or
    // compromised executor can omit raw_sdk_response entirely, so close this
    // object before any persistence/realtime path without conditioning it on
    // agent type or a raw response being present.
    if (Object.hasOwn(write, 'normalized_sdk_response')) {
      const projected = projectNormalizedSdkResponse(write.normalized_sdk_response);
      if (projected) write.normalized_sdk_response = projected;
      else delete write.normalized_sdk_response;
    }

    if (!Object.hasOwn(write, 'raw_sdk_response')) return context;

    const task = await tasks.findById(context.id as Task['task_id']);
    if (!task) throw new NotFound('Task not found');
    const session = await sessions.findById(task.session_id);
    if (!session) throw new NotFound('Session not found');

    if (session.agentic_tool === 'claude-code') {
      write.raw_sdk_response = projectClaudeResultResponse(write.raw_sdk_response) ?? {
        type: 'result',
        subtype: 'unknown',
      };
    }
    return context;
  };
}

/** Run an identity-only service's database-reading before hooks in one short unit of work. */
export function createTenantScopedBeforeHookChain(
  db: TenantScopeAwareDatabase,
  ...hooks: Array<(context: HookContext) => HookContext | Promise<HookContext>>
) {
  return async (context: HookContext): Promise<HookContext> => {
    const tenantId = requireCurrentTenantId(
      `Missing active tenant context for ${context.path} authorization`
    );
    return runWithTenantDatabaseScope(db, tenantId, async () => {
      let current = context;
      for (const hook of hooks) current = await hook(current);
      return current;
    });
  };
}

export function authorizeUsersGet(context: HookContext): HookContext {
  const params = context.params as AuthenticatedParams;

  if (isAuthenticationUserLookup(params)) {
    return context;
  }

  // The user directory is a tenant-owned read model used by every workspace
  // surface for attribution. Viewers already receive its redacted realtime
  // events tenant-wide, so the initial find/get must use the same read floor or
  // a legitimate read-only login can never hydrate the application.
  ensureMinimumRole(params, ROLES.VIEWER, 'view users');
  return context;
}

/** Protect and canonicalize the admin-owned host path used for sandbox homes. */
export function protectFilesystemHomeWrite(context: HookContext, config: AgorConfig): HookContext {
  const records = Array.isArray(context.data) ? context.data : [context.data];
  const writesFilesystemHome = records.some(
    (record) => record && Object.hasOwn(record as object, 'filesystem_home')
  );
  if (!writesFilesystemHome) return context;

  const params = context.params as AuthenticatedParams;
  if (params.provider && !hasMinimumRole(params.user?.role, ROLES.ADMIN)) {
    throw new Forbidden('Only admins can modify filesystem_home');
  }

  const protectedDataRoots = resolveSandboxProtectedDataRoots(config);
  for (const record of records) {
    if (!record || !Object.hasOwn(record as object, 'filesystem_home')) continue;
    const writable = record as Record<string, unknown>;
    const value = writable.filesystem_home;
    if (value === null) continue;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequest('filesystem_home must be a non-empty absolute path or null');
    }
    try {
      let validated = value.trim();
      for (const root of protectedDataRoots) {
        validated = validateFilesystemHomeOverride(validated, root);
      }
      writable.filesystem_home = validated;
    } catch (error) {
      throw new BadRequest(error instanceof Error ? error.message : String(error));
    }
  }
  return context;
}

/**
 * Strip the owner-only fields from one user row. Pure.
 *
 * `agentic_tools_public_values` is decrypted plaintext that `rowToUser` fills
 * in ONLY when `requesterId === row.user_id` (`services/users.ts`). The
 * contract on `AGENTIC_TOOLS_PUBLIC_FIELDS` is explicit that it goes to the
 * field's owner and to nobody else — not even to an admin reading someone
 * else's profile — because a base URL can name an internal host.
 */
// biome-ignore lint/suspicious/noExplicitAny: hook results are untyped payloads
function redactUserOwnerOnlyFields(user: any): any {
  if (!user || typeof user !== 'object' || user.agentic_tools_public_values === undefined) {
    return user;
  }
  const { agentic_tools_public_values: _ownerOnly, ...rest } = user;
  return rest;
}

/** Apply the user redaction to whatever shape the payload arrived in. */
// biome-ignore lint/suspicious/noExplicitAny: hook results are untyped payloads
function redactUserPayload(result: any): any {
  if (Array.isArray(result)) return result.map(redactUserOwnerOnlyFields);
  if (result?.data && Array.isArray(result.data)) {
    return { ...result, data: result.data.map(redactUserOwnerOnlyFields) };
  }
  if (result?.user_id) return redactUserOwnerOnlyFields(result);
  return result;
}

/**
 * Keep owner-only user fields out of the realtime broadcast.
 *
 * `users` is a tenant-wide fan-out path — `useAgorData` keeps the whole
 * directory current so any row can be named in attribution — and Feathers
 * dispatches `context.dispatch ?? context.result`. Without this hook a
 * SELF-patch satisfies `requesterId === row.user_id`, so the result carries
 * decrypted `agentic_tools_public_values`, and that object is what every other
 * socket in the tenant receives. `GET /users/:id` by those same users returns
 * the field as `undefined`, so the socket was handing over precisely what the
 * REST path withholds.
 *
 * Same split as `redactMCPServerSecretFields`: `context.result` is the CALLER's
 * copy and stays intact, because the caller is the owner and legitimately asked
 * for their own value. `context.dispatch` is by definition everyone else, so
 * redacting it is unconditional.
 *
 * Keyed off `context.event` so it only fires for the methods Feathers actually
 * broadcasts (`created`/`updated`/`patched`/`removed`; `null` for find/get) —
 * leaving find/get alone keeps the owner's own reads working.
 *
 * Module scope rather than a closure inside `registerHooks` so tests can drive
 * the real hook instead of reproducing its body.
 */
export const redactUserOwnerOnlyFieldsForBroadcast = async (context: HookContext) => {
  if (context.event) {
    context.dispatch = redactUserPayload(context.result);
  }
  return context;
};

/**
 * Redact every MCP server row in a service payload, whatever shape it arrived
 * in. Pure — callers decide what to do with the copy.
 */
// biome-ignore lint/suspicious/noExplicitAny: hook results are untyped payloads
function redactMCPServerPayload(result: any): any {
  if (Array.isArray(result)) return result.map(redactMCPServerSecrets);
  if (result?.data && Array.isArray(result.data)) {
    return { ...result, data: result.data.map(redactMCPServerSecrets) };
  }
  if (result?.mcp_server_id) return redactMCPServerSecrets(result);
  return result;
}

/**
 * Strip secret-bearing MCP server fields from anything on its way out.
 *
 * `result` and `dispatch` answer different questions and get different
 * answers:
 *
 * - `context.result` is what the CALLER receives. An in-process call, explicit
 *   daemon service account, or exact task-executor scope may legitimately need
 *   raw values to start servers and resolve templates, which is what
 *   `shouldExposeMCPServerSecrets` decides.
 * - `context.dispatch` is what EVERYONE ELSE receives — Feathers builds the
 *   channel broadcast from `dispatch ?? result`, and `mcp-servers` events go
 *   to the tenant-wide authenticated channel. Its audience is by definition
 *   not the caller, so no fact about the caller can entitle it to secrets.
 *   Redacting it is therefore unconditional.
 *
 * Without that split, an internal or service-account write fanned the raw row
 * out to every connected socket precisely because the caller was trusted.
 *
 * Only set for methods Feathers actually emits an event for — `context.event`
 * is `created`/`updated`/`patched`/`removed` there and `null` for find/get.
 * Keying off it rather than a hard-coded method list keeps this from drifting
 * out of step with what gets broadcast, and leaves find/get alone: those emit
 * nothing, so a redacted `dispatch` there would only strip the values out of
 * the executor's own socket reads and break execution.
 *
 * Module scope rather than a closure inside `registerHooks` so tests can drive
 * the real hook against a real service instead of reproducing its body — a
 * replica passes whatever the replica does, which is exactly the wrong
 * property for a redaction gate. Which methods it is registered on is pinned
 * separately in `register-hooks.mcp-headers-redaction.test.ts`.
 */
export const redactMCPServerSecretFields = async (context: HookContext) => {
  if (context.event) {
    context.dispatch = redactMCPServerPayload(context.result);
  }

  if (shouldExposeMCPServerSecrets(context.params)) return context;

  context.result = redactMCPServerPayload(context.result);

  return context;
};

/** Redact gateway channel results for both REST callers and realtime dispatch. */
export function redactGatewayChannelResultsForTransport(context: HookContext): HookContext {
  const redact = (channel: Record<string, unknown>) =>
    Object.assign(channel, redactGatewayChannelSecrets(channel as unknown as GatewayChannel));
  const result = context.result as
    | Record<string, unknown>[]
    | { data?: Record<string, unknown>[] }
    | Record<string, unknown>
    | undefined;
  if (Array.isArray(result)) {
    for (const item of result) redact(item);
  } else if (Array.isArray(result?.data)) {
    for (const item of result.data) redact(item);
  } else if (result) {
    redact(result);
  }
  // Feathers realtime and the Redis relay prefer dispatch over result.
  context.dispatch = context.result;
  return context;
}

export type RealtimeAuthorizationInvalidationMode = 'none' | 'cache' | 'evict';

const PRIMARY_TEAMMATE_INVALIDATION_MODE = Symbol('primaryTeammateInvalidationMode');

type PrimaryTeammateAuthorizationState = Pick<Board, 'board_id' | 'primary_teammate_id'>;
type PrimaryTeammateBranchState = Pick<Branch, 'branch_id' | 'board_id'>;

/**
 * Decide whether replacing/clearing a primary-teammate pointer can revoke the
 * board visibility it currently provides.
 *
 * A null pointer is additive/no-op. An attached primary is redundant with the
 * branch's normal board reference, so removing the pointer cannot narrow
 * access. A detached or unresolved primary can be the caller's only remaining
 * visibility anchor and must therefore trigger full capability eviction.
 */
export function classifyPrimaryTeammateAuthorizationInvalidation(
  board: PrimaryTeammateAuthorizationState,
  primaryBranch: PrimaryTeammateBranchState | null
): Exclude<RealtimeAuthorizationInvalidationMode, 'none'> {
  if (!board.primary_teammate_id) return 'cache';
  return primaryBranch?.branch_id === board.primary_teammate_id &&
    primaryBranch.board_id === board.board_id
    ? 'cache'
    : 'evict';
}

/**
 * Classify authorization mutations by the capability they can stale.
 *
 * True record creates are usually additive. Group membership is the exception:
 * joining a group creates a match, which suppresses Others and can therefore
 * reduce access when that group's role is lower. Membership changes always
 * evict; other revocation-capable writes do the same.
 */
export function classifyRealtimeAuthorizationInvalidation(
  context: Pick<HookContext, 'path' | 'method' | 'data'>
): RealtimeAuthorizationInvalidationMode {
  if (!['create', 'update', 'patch', 'remove'].includes(context.method)) return 'none';

  if (context.path === 'group-memberships') {
    return 'evict';
  }

  if (['branches/:id/permissions', 'boards/:id/permissions'].includes(context.path)) {
    return 'evict';
  }

  if (context.path === 'groups') {
    // An empty group has no authority. Later membership/grant writes carry
    // their own distributed invalidation.
    return context.method === 'create' ? 'none' : 'evict';
  }

  // Board-object rows are authorized through their referenced board/branch;
  // creating or removing a spatial representation does not change either ACL.
  if (context.path === 'board-objects') return 'none';

  const data =
    context.data && typeof context.data === 'object' && !Array.isArray(context.data)
      ? (context.data as Record<string, unknown>)
      : {};

  if (context.path === 'branches') {
    if (context.method === 'create') return 'none';
    if (context.method === 'remove') return 'evict';
    return ['board_id', 'permission_binding'].some((field) => Object.hasOwn(data, field))
      ? 'evict'
      : 'none';
  }

  if (context.path === 'boards') {
    if (context.method === 'create') return 'none';
    if (context.method === 'remove') return 'evict';
    return [
      'access_mode',
      'primary_teammate_id',
      'default_others_can',
      'default_others_fs_access',
      // Archiving removes a board from active presence subscriptions. Evict
      // passive room capabilities across replicas so stale tabs cannot retain
      // or publish an archived board association.
      'archived',
    ].some((field) => Object.hasOwn(data, field))
      ? 'evict'
      : 'none';
  }

  if (context.path === 'users') {
    if (context.method === 'create') return 'none';
    if (context.method === 'remove') return 'evict';
    return ['password', 'role', 'tokens_valid_after', 'must_change_password'].some((field) =>
      Object.hasOwn(data, field)
    )
      ? 'evict'
      : 'none';
  }

  return 'none';
}

export function registerHooks(ctx: RegisterHooksContext): void {
  const {
    db,
    app,
    config,
    jwtSecret,
    requireAuth,
    superadminOpts,
    sessionsService,
    messagesService,
    boardsService,
    branchRepository,
    usersRepository,
    sessionsRepository,
    realtimeRelay,
    deployment,
  } = ctx;
  const redactMCPServerSecretFieldsForGatewayMode = async (context: HookContext) => {
    if (
      context.params.provider &&
      context.params.tenant?.tenant_id &&
      ['compatibility', 'enforced'].includes(await getMCPEgressGatewayMode(db))
    ) {
      if (context.event) context.dispatch = redactMCPServerPayload(context.result);
      context.result = redactMCPServerPayload(context.result);
      return context;
    }
    return redactMCPServerSecretFields(context);
  };
  const abortMcpInFlightAfterWrite = async (context: HookContext) => {
    const gateway = (
      app as unknown as {
        mcpEgressGateway?: {
          abortServer(
            tenantId: string,
            serverId: string,
            reason?: 'server_detached' | 'stale_capability'
          ): number;
        };
      }
    ).mcpEgressGateway;
    coordinateMCPServerMutationAfterWrite(context, gateway);
    return context;
  };

  // Used by classifyMissingCredentialFailure to look up the acting user for
  // a failed task (no service-layer equivalent already in ctx).
  const taskRepository = new TaskRepository(db);

  // Helper: safely get a service (returns undefined if not registered due to tier=off)
  const safeService = (path: string) => {
    try {
      return app.service(path);
    } catch {
      return undefined;
    }
  };

  if (deployment.mode === 'ha') {
    for (const [path, feature] of CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES) {
      safeService(path)?.hooks({ before: { all: [rejectInConstrainedHa(deployment, feature)] } });
    }
  }

  const multiTenancy = resolveMultiTenancyConfig(config);
  const tenantColumnsEnabled = resolveMultiTenancyDatabaseDialect(config) === 'postgresql';
  const executionMode = resolveExecutionSecurityMode(config);
  const sessionMcpTokenAfterHooks = createSessionMcpTokenAfterHooks({
    app,
    config,
    onGetAttached: (session) =>
      mcpTokenDebug(`🔄 Resolved MCP token for session ${shortId(session.session_id)}`),
    onCreateAttached: (session) =>
      console.log(`🎫 MCP token issued for session ${shortId(session.session_id)}`),
  });

  const tenantOwnedServicePaths = TENANT_OWNED_SERVICE_PATHS;

  const stripTenantData = (data: unknown): unknown => {
    if (Array.isArray(data)) return data.map(stripTenantData);
    if (!data || typeof data !== 'object') return data;
    const clone = { ...(data as Record<string, unknown>) };
    delete clone.tenant_id;
    return clone;
  };

  const resultBelongsToTenant = (result: unknown, tenantId: string): boolean => {
    if (Array.isArray(result)) return result.every((item) => resultBelongsToTenant(item, tenantId));
    if (!result || typeof result !== 'object') return true;
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.data))
      return record.data.every((item) => resultBelongsToTenant(item, tenantId));
    if (!('tenant_id' in record)) return true;
    return record.tenant_id === tenantId;
  };

  const tenantDatabaseScopeAround = createTenantDatabaseScopeAroundHook({
    db,
    config,
    jwtSecret,
  });
  const tenantIdentityAround = createTenantDatabaseScopeAroundHook({
    db,
    config,
    jwtSecret,
    transaction: false,
  });

  const ensureTenantContext = async (context: HookContext): Promise<HookContext> => {
    try {
      context.params.tenant = resolveTenantContext(multiTenancy, { params: context.params });
      return context;
    } catch (error) {
      if (error instanceof TenantResolutionError) {
        throw new NotAuthenticated(error.message);
      }
      throw error;
    }
  };

  const scopeTenantBefore = async (context: HookContext): Promise<HookContext> => {
    await ensureTenantContext(context);
    const tenantId = context.params.tenant?.tenant_id;
    if (!tenantId) return context;

    if (context.method === 'update' || context.method === 'patch') {
      context.data = stripTenantData(context.data) as typeof context.data;
    }

    // Do not inject tenant_id into Feathers find queries. Several services
    // intentionally omit tenant_id from their public DTOs; the generic in-memory
    // adapter would then filter every row out after RLS already did the DB-level
    // isolation. Tenant isolation for reads is enforced by the transaction-local
    // Postgres RLS setting plus the after-hook assertion below.
    return context;
  };

  const assertTenantAfter = async (context: HookContext): Promise<HookContext> => {
    const tenantId = context.params.tenant?.tenant_id;
    if (tenantId && !resultBelongsToTenant(context.result, tenantId)) {
      throw new NotAuthenticated('Tenant isolation check failed');
    }
    return context;
  };

  // This shared gate is also installed by the custom-route registrar. Custom
  // routes are registered after this function and therefore cannot rely on the
  // static service-path loop below to receive tenant write fencing.
  const writeGateBefore = (context: HookContext) => enforceTenantWriteGateForHook(db, context);

  const registerTenantHooks = (): void => {
    for (const path of tenantOwnedServicePaths) {
      const service = safeService(path);
      if (!service) continue;
      service.hooks({
        around: { all: [path === 'gateway' ? tenantIdentityAround : tenantDatabaseScopeAround] },
        before: { all: [scopeTenantBefore, writeGateBefore] },
        after: { all: [assertTenantAfter] },
      });
    }
  };

  const registerTenantIdentityHooks = (): void => {
    for (const path of TENANT_IDENTITY_ONLY_SERVICE_PATHS) {
      safeService(path)?.hooks({ around: { all: [tenantIdentityAround] } });
    }
  };

  // Without tenant columns (SQLite / single-tenant), tenant-owned services skip
  // the full RLS-transaction hooks — but they must still carry ambient tenant
  // identity for tenant-aware call sites. MCP session-token issuance can
  // resolve the configured tenant without ambient identity in static mode,
  // while required_from_auth remains fail-closed. Identity only: no data
  // stamping or DB transaction, which are Postgres tenant-column mechanics.
  const registerTenantIdentityForOwnedServices = (): void => {
    for (const path of tenantOwnedServicePaths) {
      safeService(path)?.hooks({ around: { all: [tenantIdentityAround] } });
    }
  };

  const realtimeAccessCache = new RealtimeAccessCache({
    branchRepository: branchRepository as unknown as RealtimeAccessBranchRepository,
    sessionsRepository: sessionsRepository as unknown as RealtimeAccessSessionRepository,
  });
  bindRealtimeAccessCacheInvalidation(app, realtimeAccessCache);
  const boardRepository =
    ctx.boardRepository ??
    (new BoardRepository(db) as BoardRepository & RealtimeAccessBoardRepository);
  const boardCommentsRepository = new BoardCommentsRepository(db);
  const boardObjectsRepository = new BoardObjectRepository(db);
  const cardRepository = new CardRepository(db);

  const authorizeExternalBoard = async (
    context: HookContext,
    boardId: string | undefined,
    mode: 'view' | 'mutate',
    action: string
  ): Promise<HookContext> => {
    if (!executionMode.appRbacEnabled || !context.params.provider) return context;
    const user = context.params.user;
    if (!user) throw new NotAuthenticated('Authentication required');
    if (user._isServiceAccount || hasMinimumRole(user.role, ROLES.ADMIN)) return context;
    let allowed = false;
    if (boardId) {
      try {
        allowed =
          mode === 'view'
            ? await boardRepository.canView(boardId, user.user_id as UUID)
            : await boardRepository.canMutate(boardId, user.user_id as UUID);
      } catch {
        // Preserve the same non-enumerating denial for missing, foreign-tenant,
        // and inaccessible boards.
      }
    }
    if (!allowed) throw new Forbidden(`Board resource is unavailable to ${action}`);
    return context;
  };

  const boardObjectAccess =
    (action: string) =>
    async (context: HookContext): Promise<HookContext> => {
      if (!executionMode.appRbacEnabled || !context.params.provider) return context;
      const user = context.params.user;
      if (!user) throw new NotAuthenticated('Authentication required');
      if (user._isServiceAccount || hasMinimumRole(user.role, ROLES.ADMIN)) return context;

      const data = context.data as
        | { board_id?: BoardID; branch_id?: import('@agor/core/types').BranchID }
        | undefined;
      if (context.method === 'create') {
        if (!data?.board_id || !data.branch_id) {
          throw new Forbidden(`Board resource is unavailable to ${action}`);
        }
        const [canMutateBoard, canViewBranch] = await Promise.all([
          boardRepository.canMutate(data.board_id, user.user_id as UUID).catch(() => false),
          boardObjectsRepository
            .canViewBranchReference(user.user_id as UUID, data.branch_id)
            .catch(() => false),
        ]);
        if (!canMutateBoard || !canViewBranch) {
          throw new Forbidden(`Board resource is unavailable to ${action}`);
        }
        return context;
      }

      const existing =
        typeof context.id === 'string'
          ? await boardObjectsRepository.findVisibleByObjectId(user.user_id as UUID, context.id)
          : null;
      if (!existing) throw new Forbidden(`Board resource is unavailable to ${action}`);
      await authorizeExternalBoard(context, existing.board_id, 'mutate', action);
      return context;
    };

  const boardCommentAccess =
    (mode: 'view' | 'author', action: string) =>
    async (context: HookContext): Promise<HookContext> => {
      const user = context.params.user;
      if (!executionMode.appRbacEnabled || !context.params.provider) return context;
      if (!user) throw new NotAuthenticated('Authentication required');
      if (user._isServiceAccount || hasMinimumRole(user.role, ROLES.ADMIN)) return context;

      const data = context.data as Partial<import('@agor/core/types').BoardComment> | undefined;
      const existing =
        typeof context.id === 'string'
          ? await boardCommentsRepository.findVisibleById(user.user_id as UUID, context.id)
          : undefined;
      if (typeof context.id === 'string' && !existing) {
        throw new Forbidden(`Board resource is unavailable to ${action}`);
      }
      if (existing) context.id = existing.comment_id;
      if (context.method === 'create') {
        const allowed = data
          ? await boardCommentsRepository.canViewReferences(user.user_id as UUID, data)
          : false;
        if (!allowed) throw new Forbidden(`Board resource is unavailable to ${action}`);
      }

      // A comment's authorization anchor is immutable. Moving an existing
      // thread to a different board/branch/session/task/message would turn an
      // author-only content edit into an ACL mutation and risks publication to
      // a resource the caller could not previously address.
      if (existing && data) {
        for (const field of [
          'board_id',
          'branch_id',
          'session_id',
          'task_id',
          'message_id',
          'parent_comment_id',
        ] as const) {
          if (Object.hasOwn(data, field) && data[field] !== existing[field]) {
            throw new Forbidden(
              `Board comment attachments cannot be changed while trying to ${action}`
            );
          }
        }
      }
      if (mode === 'author' && existing?.created_by !== user.user_id) {
        throw new Forbidden(`Only the comment author may ${action}`);
      }
      return context;
    };

  const enforcePublicBoardCommentCreate = async (context: HookContext): Promise<HookContext> => {
    if (context.params.provider) {
      context.data = publicBoardCommentCreateInput(context.data) as typeof context.data;
    }
    return context;
  };

  const enforcePublicBoardCommentPatch = async (context: HookContext): Promise<HookContext> => {
    if (context.params.provider) {
      context.data = publicBoardCommentPatchInput(context.data) as typeof context.data;
    }
    return context;
  };

  const rejectExternalBoardCommentUpdate = async (context: HookContext): Promise<HookContext> => {
    if (context.params.provider) {
      // Complete row replacement has no public use case and would require a
      // client to submit server-owned identity/audience/reaction state.
      rejectPublicBoardCommentUpdate();
    }
    return context;
  };

  const cardAccess =
    (mode: 'view' | 'mutate', action: string) =>
    async (context: HookContext): Promise<HookContext> => {
      const requestedBoardId = (context.data as { board_id?: string } | undefined)?.board_id;
      const user = context.params.user;
      const requiresVisibleResolution =
        executionMode.appRbacEnabled &&
        Boolean(context.params.provider) &&
        user &&
        !user._isServiceAccount &&
        !hasMinimumRole(user.role, ROLES.ADMIN);
      const existing =
        typeof context.id === 'string'
          ? requiresVisibleResolution
            ? await cardRepository.findVisibleById(user.user_id as UUID, context.id)
            : await cardRepository.findById(context.id)
          : undefined;
      if (typeof context.id === 'string' && requiresVisibleResolution && !existing) {
        throw new Forbidden(`Board resource is unavailable to ${action}`);
      }
      if (existing) context.id = existing.card_id;
      const existingBoardId = existing?.board_id;
      await authorizeExternalBoard(context, existingBoardId ?? requestedBoardId, mode, action);
      if (existingBoardId && requestedBoardId && requestedBoardId !== existingBoardId) {
        await authorizeExternalBoard(context, requestedBoardId, mode, action);
      }
      return context;
    };

  const invalidateRealtimeBranchAccess = async (branchId: unknown): Promise<void> => {
    if (typeof branchId !== 'string' || branchId.length === 0) return;
    realtimeAccessCache.invalidateBranch(branchId);
    try {
      const branch = await branchRepository.findById(branchId);
      if (branch) realtimeAccessCache.invalidateBranch(branch.branch_id);
    } catch {
      // Best-effort cache invalidation only.
    }
  };

  const invalidateRealtimeBranchFromResult = async (context: HookContext): Promise<HookContext> => {
    const branchId =
      (context.result as { branch_id?: unknown } | undefined)?.branch_id ?? context.id;
    await invalidateRealtimeBranchAccess(branchId);
    return context;
  };

  const captureBranchRemovalRealtimeVisibility = async (
    context: HookContext
  ): Promise<HookContext> => {
    const loadedBranch = (context.params as AuthenticatedParams & { branch?: Branch }).branch;
    const branch =
      loadedBranch ??
      (typeof context.id === 'string' ? await branchRepository.findById(context.id) : null);
    if (!branch) {
      throw new NotFound(`Branch not found: ${String(context.id)}`);
    }

    await captureBranchRemovalVisibility({
      params: context.params,
      branchRepository,
      branchId: branch.branch_id,
      branchRbacEnabled: executionMode.appRbacEnabled,
      realtimeAccessCache,
    });
    return context;
  };

  const captureBoardRemovalRealtimeVisibility = async (
    context: HookContext
  ): Promise<HookContext> => {
    if (typeof context.id !== 'string') throw new BadRequest('Board ID is required');
    const board = await boardRepository.findBySlugOrId(context.id);
    if (!board) throw new NotFound(`Board not found: ${String(context.id)}`);
    if (!executionMode.appRbacEnabled) {
      setBoardRemovalRealtimeVisibility(context.params, board.board_id as BoardID, {
        mode: 'allAuthenticated',
      });
      return context;
    }

    const visibleUserIds = new Set<UserID>(
      (await boardRepository.findRealtimeViewUserIds(board.board_id as BoardID)) as UserID[]
    );
    setBoardRemovalRealtimeVisibility(context.params, board.board_id as BoardID, {
      mode: 'explicitUsers',
      userIds: visibleUserIds,
    });
    return context;
  };

  safeService('agentic-tool-settings')?.hooks({
    before: {
      patch: [requireMinimumRole(ROLES.ADMIN, 'manage workspace agentic tools')],
    },
  });

  safeService('agentic-tool-presets')?.hooks({
    before: {
      create: [requireMinimumRole(ROLES.ADMIN, 'manage agentic tool presets')],
      patch: [requireMinimumRole(ROLES.ADMIN, 'manage agentic tool presets')],
      remove: [requireMinimumRole(ROLES.ADMIN, 'manage agentic tool presets')],
    },
  });

  const invalidateRealtimeBranchFromRoute = async (context: HookContext): Promise<HookContext> => {
    await invalidateRealtimeBranchAccess(context.params.route?.id);
    return context;
  };

  const clearRealtimeBranchVisibility = (context: HookContext): HookContext => {
    realtimeAccessCache.clearVisibility();
    return context;
  };

  const scheduleRealtimeAuthorizationInvalidation = (
    context: HookContext,
    mode: Exclude<RealtimeAuthorizationInvalidationMode, 'none'>
  ): HookContext => {
    deferWithTenantContext(
      context.params,
      async () => {
        app.emit('realtime:authorization-invalidated', {
          tenantId: requireCurrentTenantId(),
          disconnectSockets: mode === 'evict',
        });
      },
      () => console.warn('[realtime] Failed to schedule authorization eviction')
    );
    return context;
  };

  const evictStaleRealtimeAuthorization = (context: HookContext): HookContext => {
    const mode = classifyRealtimeAuthorizationInvalidation(context);
    return mode === 'none' ? context : scheduleRealtimeAuthorizationInvalidation(context, mode);
  };

  for (const path of [
    'branches/:id/permissions',
    'boards/:id/permissions',
    'groups',
    'group-memberships',
    'board-objects',
    'branches',
    'boards',
    'users',
  ]) {
    safeService(path)?.hooks({
      after: {
        create: [evictStaleRealtimeAuthorization],
        update: [evictStaleRealtimeAuthorization],
        patch: [evictStaleRealtimeAuthorization],
        remove: [evictStaleRealtimeAuthorization],
      },
    });
  }

  /**
   * Snapshot tenant principals before an authority-changing write. Publication
   * after the write cannot use the new branch audience: the principal who was
   * just removed is precisely the browser that must clear its old rows. The
   * ID-only repository projection keeps this control signal independent of
   * user credential/profile material.
   */
  const captureMarketplaceInvalidationTargets = async (
    context: HookContext
  ): Promise<HookContext> => captureMarketplaceTargets(context, usersRepository, app);
  const publishMarketplaceInvalidation = (context: HookContext): HookContext =>
    publishCapturedMarketplaceInvalidation(context, app);
  const captureBoardAlignedBranchMarketplaceTargets = async (
    context: HookContext
  ): Promise<HookContext> => {
    const items = Array.isArray(context.data) ? context.data : [context.data];
    const changesAlignedBranchVisibility = items.some(
      (item) =>
        item &&
        typeof item === 'object' &&
        itemHasAnyField(item as Record<string, unknown>, ['access_mode', 'default_others_can'])
    );
    return changesAlignedBranchVisibility
      ? captureMarketplaceInvalidationTargets(context)
      : context;
  };

  /**
   * Authorization chain shared by the two externally-initiated prompt writes,
   * `messages.create` and `tasks.create`.
   *
   * Two independently configured properties put hooks in here, and each hook
   * is gated on the one that makes it load-bearing rather than on whichever
   * flag happens to be nearby:
   *
   *  - `branch_rbac` decides whether the caller may prompt in this branch.
   *  - `unix_user_mode` decides whether the session may execute as the
   *    execution-home key it was stamped with. Only `delegated` consumes the
   *    stamp; `simple` and `sandbox` do not. Once the creator's key changes,
   *    the stamp names an identity the user no longer has and the SDK state
   *    lives in a home directory this instance cannot reach, so the prompt is
   *    refused. Branch permissions have no bearing on that: an open-access
   *    instance can be running delegated, and an RBAC instance can be running
   *    simple, where refusing would only lock a user out of their own sessions
   *    over an identity nothing executes as.
   *
   * The session load is the precondition of both, and is memoised per request.
   */
  const promptWriteGuards = [
    ...(executionMode.appRbacEnabled || executionMode.requiresExecutionHomeKey
      ? [resolveSessionContext(), loadSession(sessionsRepository)]
      : []),
    ...(executionMode.requiresExecutionHomeKey
      ? [validateSessionUnixUsername(usersRepository)]
      : []),
    ...(executionMode.appRbacEnabled
      ? [
          loadBranchFromSession(branchRepository),
          ensureCanPromptInSession({ ...superadminOpts, branchRepository }), // Require 'prompt' (or 'session' for own sessions)
        ]
      : []),
  ];

  // ============================================================================
  // Messages hooks
  // ============================================================================

  const protectWidgetMessageWrites = protectExternalWidgetMessageWrites((messageId) =>
    messagesService.findByIdForScopeCheck(messageId as MessageID)
  );
  const protectProviderFailureMetadata = protectExternalProviderFailureMetadata((messageId) =>
    messagesService.findByIdForScopeCheck(messageId as MessageID)
  );
  const protectPermissionMessageWrites = protectExternalPermissionMessageWrites((messageId) =>
    messagesService.findByIdForScopeCheck(messageId as MessageID)
  );

  app.service('messages').hooks({
    before: {
      all: [typedValidateQuery(messageQueryValidator), requireAuth],
      find: [
        // RBAC: Scope messages.find() to sessions the caller can access.
        // Without this backstop, any authenticated member could list messages
        // across every session/branch by omitting the session_id filter.
        ...(executionMode.appRbacEnabled ? [scopeFindToAccessibleSessionsSql(superadminOpts)] : []),
      ],
      get: [
        ...(executionMode.appRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsRepository),
              loadBranchFromSession(branchRepository),
              ensureCanView(superadminOpts), // Require 'view' permission
            ]
          : []),
      ],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create messages'),
        validateMessageCreate,
        protectProviderFailureMetadata,
        protectWidgetMessageWrites,
        protectPermissionMessageWrites,
        ...promptWriteGuards,
        // Reclassify executor-scoped credential and narrow provider-credit
        // failures structurally, never by matching arbitrary provider text.
        classifyMissingCredentialFailure(
          db,
          taskRepository,
          sessionsRepository,
          AGENTIC_TOOL_DISPLAY_NAMES
        ),
      ],
      update: [
        protectProviderFailureMetadata,
        protectWidgetMessageWrites,
        protectPermissionMessageWrites,
      ],
      patch: [
        requireMinimumRole(ROLES.MEMBER, 'update messages'),
        protectProviderFailureMetadata,
        ...(executionMode.appRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsRepository),
              loadBranchFromSession(branchRepository),
              ensureCanPromptInSession({ ...superadminOpts, branchRepository }), // Require 'prompt' (or 'session' for own sessions)
            ]
          : []),
        protectWidgetMessageWrites,
        protectPermissionMessageWrites,
      ],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete messages'),
        ...(executionMode.appRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsRepository),
              loadBranchFromSession(branchRepository),
              ensureCanPromptInSession({ ...superadminOpts, branchRepository }), // Require 'prompt' (or 'session' for own sessions)
            ]
          : []),
        protectWidgetMessageWrites,
        protectPermissionMessageWrites,
      ],
    },
    after: {
      create: [gatewayRouteHook],
      patch: [
        async (context: HookContext<Board>) => {
          // Detect permission resolution and notify executor via IPC
          const message = context.result as import('@agor/core/types').Message;

          // Only process permission_request messages
          if (message.type !== 'permission_request') {
            return context;
          }

          // Check if the message content has approval status
          const content = message.content;
          if (typeof content !== 'object' || !content || Array.isArray(content)) {
            return context;
          }

          const contentObj = content as unknown as Record<string, unknown>;
          const status = contentObj.status;
          if (status !== 'approved' && status !== 'denied') {
            return context;
          }

          // Permission was resolved! Notify the executor via IPC
          console.log(`[daemon] Permission ${status} for request ${contentObj.request_id}`);

          // NOTE: Permission decisions are handled by the executor listening to WebSocket permission events
          // No IPC needed - executor subprocess watches for permission message updates via WebSocket
          console.log('[daemon] Permission decision will be delivered to executor via WebSocket');

          return context;
        },
      ],
    },
  });

  // ============================================================================
  // Board objects hooks
  // ============================================================================
  safeService('board-objects')?.hooks({
    before: {
      all: [typedValidateQuery(boardObjectQueryValidator), requireAuth],
      // Board-objects may reference a branch or may be loose board/card/layout
      // rows. The service composes this marker into an object-specific SQL
      // predicate: branch-bound rows require branch access; loose rows require
      // board visibility.
      find: [
        ...(executionMode.appRbacEnabled ? [scopeReadToAccessibleBoardsSql(superadminOpts)] : []),
      ],
      get: [
        ...(executionMode.appRbacEnabled ? [scopeReadToAccessibleBoardsSql(superadminOpts)] : []),
      ],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create board objects'),
        boardObjectAccess('create board objects'),
      ],
      update: [
        requireMinimumRole(ROLES.MEMBER, 'update board objects'),
        boardObjectAccess('update board objects'),
      ],
      patch: [
        requireMinimumRole(ROLES.MEMBER, 'update board objects'),
        boardObjectAccess('update board objects'),
      ],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete board objects'),
        boardObjectAccess('delete board objects'),
      ],
    },
  });

  // ============================================================================
  // Card types, cards, artifacts hooks
  // ============================================================================

  safeService('card-types')?.hooks({
    before: {
      all: [requireAuth],
      create: [requireMinimumRole(ROLES.MEMBER, 'create card types')],
      update: [requireMinimumRole(ROLES.MEMBER, 'update card types')],
      patch: [requireMinimumRole(ROLES.MEMBER, 'update card types')],
      remove: [requireMinimumRole(ROLES.MEMBER, 'delete card types')],
    },
  });

  safeService('cards')?.hooks({
    before: {
      all: [requireAuth],
      find: [
        ...(executionMode.appRbacEnabled ? [scopeFindToAccessibleBoardsSql(superadminOpts)] : []),
      ],
      get: [cardAccess('view', 'view this card')],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create cards'),
        cardAccess('mutate', 'create cards'),
        injectCreatedBy(),
      ],
      update: [
        requireMinimumRole(ROLES.MEMBER, 'update cards'),
        cardAccess('mutate', 'update this card'),
      ],
      patch: [
        requireMinimumRole(ROLES.MEMBER, 'update cards'),
        cardAccess('mutate', 'update this card'),
      ],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete cards'),
        cardAccess('mutate', 'delete this card'),
      ],
    },
  });

  /**
   * Before-hook for artifacts patch/remove: only the creator or an
   * admin/superadmin may modify an artifact. Without this, any `member` could
   * PATCH /artifacts/:id and rename, re-board, archive, or unpublish another
   * user's artifact — role-only gating is not enough.
   *
   * Runs AFTER requireMinimumRole (which guarantees `params.user`), skips
   * internal calls (no provider) and explicit daemon service accounts.
   */
  const ensureArtifactOwnerOrAdmin = () => async (context: HookContext) => {
    if (!context.params.provider) return context;
    const user = (context.params as { user?: User })?.user;
    if (!user) throw new NotAuthenticated('Authentication required');
    if ((user as unknown as { _isServiceAccount?: boolean })._isServiceAccount) return context;
    if (hasMinimumRole(user.role, ROLES.ADMIN)) return context;

    const artifactId = context.id;
    if (artifactId === undefined || artifactId === null) return context;
    const artifactRepo = new ArtifactRepository(db);
    const artifact = await artifactRepo.findById(String(artifactId));
    if (!artifact) {
      throw new Forbidden(`Artifact ${artifactId} not found or not accessible`);
    }
    if (artifact.created_by && artifact.created_by === user.user_id) return context;
    throw new Forbidden(
      "Only the artifact's creator or an admin may modify it. Use agor_artifacts_publish to create your own copy."
    );
  };

  safeService('artifacts')?.hooks({
    before: {
      all: [requireAuth],
      find: [
        // RBAC: Artifacts carry a `branch_id` (nullable — survives branch deletion).
        // Scope find() to the branches the caller can access. The service pushes
        // this into SQL as a correlated visibility predicate rather than
        // preloading ids and injecting `branch_id IN (...)`.
        ...(executionMode.appRbacEnabled ? [scopeFindToAccessibleBranchesSql(superadminOpts)] : []),
      ],
      create: [requireMinimumRole(ROLES.MEMBER, 'create artifacts'), injectCreatedBy()],
      publishFromExecutor: [requireMinimumRole(ROLES.MEMBER, 'publish artifacts')],
      validateFromExecutor: [requireMinimumRole(ROLES.MEMBER, 'validate artifacts')],
      patch: [requireMinimumRole(ROLES.MEMBER, 'update artifacts'), ensureArtifactOwnerOrAdmin()],
      remove: [requireMinimumRole(ROLES.MEMBER, 'delete artifacts'), ensureArtifactOwnerOrAdmin()],
    },
  } as never);

  // Custom REST routes for artifact payload and console
  {
    registerAuthenticatedRoute(
      app,
      '/artifacts/:id/payload',
      {
        async find(_params: RouteParams) {
          const artifactId = _params.route?.id;
          if (!artifactId) throw new Error('Artifact ID required');
          const artifactsService = app.service('artifacts') as unknown as ArtifactsService;
          return artifactsService.getPayload(artifactId, _params.user?.user_id);
        },
      },
      { find: { role: ROLES.VIEWER, action: 'get artifact payload' } },
      requireAuth
    );

    registerAuthenticatedRoute(
      app,
      '/artifacts/:id/console',
      {
        async create(
          data: {
            entries: Array<{ timestamp: number; level: string; message: string }>;
            content_hash?: string;
          },
          _params: RouteParams
        ) {
          const artifactId = _params.route?.id;
          if (!artifactId) throw new Error('Artifact ID required');
          const userId = _params.user?.user_id;
          if (!userId) throw new Error('Authenticated user required');
          const artifactsService = app.service('artifacts') as unknown as ArtifactsService;
          // Visibility check: only viewers who can see the artifact may
          // append to its console buffer. Without this any member could
          // write spam into another artifact's logs.
          const artifact = await artifactsService.get(artifactId);
          if (!artifactsService.isVisibleTo(artifact, userId)) {
            throw new Error(`Artifact ${artifactId} not found`);
          }
          await artifactsService.appendConsoleLogs(
            artifactId,
            userId,
            data.entries as never,
            data.content_hash
          );
          return { success: true };
        },
      },
      {
        create: { role: ROLES.MEMBER, action: 'post artifact console logs' },
      },
      requireAuth
    );

    registerAuthenticatedRoute(
      app,
      '/artifacts/:id/sandpack-error',
      {
        async create(
          data: {
            error: import('@agor/core/types').SandpackError | null;
            status?: string;
            content_hash?: string;
          },
          _params: RouteParams
        ) {
          const artifactId = _params.route?.id;
          if (!artifactId) throw new Error('Artifact ID required');
          const userId = _params.user?.user_id;
          if (!userId) throw new Error('Authenticated user required');
          const artifactsService = app.service('artifacts') as unknown as ArtifactsService;
          const artifact = await artifactsService.get(artifactId);
          if (!artifactsService.isVisibleTo(artifact, userId)) {
            throw new Error(`Artifact ${artifactId} not found`);
          }
          await artifactsService.setSandpackError(
            artifactId,
            userId,
            data.error,
            data.status,
            data.content_hash
          );
          return { success: true };
        },
      },
      {
        create: { role: ROLES.MEMBER, action: 'post artifact sandpack error' },
      },
      requireAuth
    );

    // ── Runtime query responses ────────────────────────────────────────────
    // Browser POSTs the iframe's `agor:result` payload here. Path encodes
    // the request id so the daemon can correlate to a pending query in
    // memory. The caller must be the same user that issued the original
    // query — the service-side check rejects mismatches silently.
    //
    // The injected agor-runtime.js caps replies (200KB document HTML, 50
    // nodes per query, 50KB outerHTML per node), but a malicious or buggy
    // browser could bypass the runtime and POST a much larger body. Cap
    // here too so a wrongly-sized payload doesn't bloat the daemon's
    // pending-query map or the agent's MCP context.
    const RUNTIME_RESPONSE_BYTE_CAP = 512 * 1024;
    registerAuthenticatedRoute(
      app,
      '/artifacts/:id/runtime-response/:requestId',
      {
        async create(
          data: { ok: boolean; result?: unknown; error?: string },
          _params: RouteParams
        ) {
          const requestId = _params.route?.requestId;
          if (!requestId) throw new Error('Request ID required');
          const userId = _params.user?.user_id;
          if (!userId) throw new Error('Authenticated user required');

          // Defensive size cap. JSON.stringify is the cheapest faithful
          // measurement of "how big is this payload going to be when we
          // hand it to the agent." Round trips through the runtime stay
          // well under this in practice.
          let payloadOk = data.ok;
          let payloadResult = data.result;
          let payloadError = data.error;
          try {
            const measured = JSON.stringify(payloadResult ?? null);
            if (measured.length > RUNTIME_RESPONSE_BYTE_CAP) {
              payloadOk = false;
              payloadResult = undefined;
              payloadError = `Runtime response exceeded ${RUNTIME_RESPONSE_BYTE_CAP} bytes (got ${measured.length}). Reduce maxNodes or use a more specific selector.`;
            }
          } catch (err) {
            payloadOk = false;
            payloadResult = undefined;
            payloadError = `Runtime response was not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`;
          }

          const artifactsService = app.service('artifacts') as unknown as ArtifactsService;
          artifactsService.resolveRuntimeQuery({
            requestId,
            responderUserId: userId,
            ok: payloadOk,
            result: payloadResult,
            error: payloadError,
          });
          return { received: true };
        },
      },
      {
        create: { role: ROLES.MEMBER, action: 'post artifact runtime response' },
      },
      requireAuth
    );

    // ── Trust grants (TOFU consent flow) ───────────────────────────────────
    // Per-artifact: POST creates a grant covering the artifact's currently-
    // requested env vars and grants. Caller MUST be authenticated; the grant
    // is attributed to the calling user.
    registerAuthenticatedRoute(
      app,
      '/artifacts/:id/trust',
      {
        async create(
          data: { scopeType: import('@agor/core/types').ArtifactTrustScopeType },
          _params: RouteParams
        ) {
          const artifactId = _params.route?.id;
          if (!artifactId) throw new Error('Artifact ID required');
          const userId = _params.user?.user_id;
          if (!userId) throw new Error('Authenticated user required');
          const artifactsService = app.service('artifacts') as unknown as ArtifactsService;
          // The consent surface (env vars + grants) is derived server-side
          // from the artifact's current request. The client only nominates
          // the scope; the server decides what the grant covers. This stops
          // a confused/malicious client from persisting a grant whose
          // covered set diverges from what the server will actually inject.
          return artifactsService.grantTrust({
            userId,
            artifactId,
            scopeType: data.scopeType,
          });
        },
      },
      {
        create: { role: ROLES.MEMBER, action: 'create artifact trust grant' },
      },
      requireAuth
    );

    // List the calling user's active trust grants. Used by the settings page.
    registerAuthenticatedRoute(
      app,
      '/me/artifact-trust-grants',
      {
        async find(params: RouteParams) {
          const userId = params.user?.user_id;
          if (!userId) throw new Error('Authenticated user required');
          const artifactsService = app.service('artifacts') as unknown as ArtifactsService;
          return artifactsService.listTrustGrants(userId);
        },
        async remove(id: unknown, params: RouteParams) {
          const userId = params.user?.user_id;
          if (!userId) throw new Error('Authenticated user required');
          const grantId = String(id);
          const artifactsService = app.service('artifacts') as unknown as ArtifactsService;
          await artifactsService.revokeTrustGrant(userId, grantId);
          return { revoked: true, grantId };
        },
      },
      {
        find: { role: ROLES.VIEWER, action: 'list artifact trust grants' },
        remove: { role: ROLES.MEMBER, action: 'revoke artifact trust grant' },
      },
      requireAuth
    );
  }

  // ============================================================================
  // Board comments, repos, branches hooks
  // ============================================================================

  safeService('board-comments')?.hooks({
    before: {
      all: [typedValidateQuery(boardCommentQueryValidator), requireAuth],
      find: [
        // Board comments inherit board visibility for pure board/spatial
        // comments and branch/session/task/message visibility for attached
        // comments. The service pushes the marker into SQL.
        ...(executionMode.appRbacEnabled ? [scopeFindToAccessibleBoardsSql(superadminOpts)] : []),
      ],
      get: [boardCommentAccess('view', 'view this board comment')],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create board comments'),
        enforcePublicBoardCommentCreate,
        boardCommentAccess('view', 'comment on this board'),
        injectCreatedBy(),
      ],
      update: [
        requireMinimumRole(ROLES.MEMBER, 'update board comments'),
        rejectExternalBoardCommentUpdate,
        boardCommentAccess('author', 'update this board comment'),
      ],
      patch: [
        requireMinimumRole(ROLES.MEMBER, 'update board comments'),
        enforcePublicBoardCommentPatch,
        boardCommentAccess('author', 'update this board comment'),
      ],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete board comments'),
        boardCommentAccess('author', 'delete this board comment'),
      ],
    },
  });

  app.service('repos').hooks({
    before: {
      all: [typedValidateQuery(repoQueryValidator), requireAuth],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create repositories'),
        requireAdminForEnvConfig(),
        validateRepoEnvPolicyHook(config),
      ],
      update: [
        requireMinimumRole(ROLES.MEMBER, 'update repositories'),
        requireAdminForEnvConfig(),
        validateRepoEnvPolicyHook(config),
      ],
      patch: [
        requireMinimumRole(ROLES.MEMBER, 'update repositories'),
        requireAdminForEnvConfig(),
        validateRepoEnvPolicyHook(config),
      ],
      remove: [requireMinimumRole(ROLES.MEMBER, 'delete repositories')],
    },
    after: {
      patch: [realignRepoOriginAfterPatchHook()],
    },
  });

  const ensureCanChangeBranchBoard = async (context: HookContext): Promise<HookContext> => {
    if (!executionMode.appRbacEnabled || !context.params.provider) return context;
    const user = context.params.user;
    if (!user) throw new NotAuthenticated('Authentication required');
    if (user._isServiceAccount || hasMinimumRole(user.role, ROLES.ADMIN)) return context;

    const values = Array.isArray(context.data) ? context.data : [context.data];
    for (const value of values as Array<Partial<Branch> | undefined>) {
      if (!value) continue;
      const previousBoardId = context.params.branch?.board_id;
      const boardWasSupplied = context.method === 'create' || Object.hasOwn(value, 'board_id');
      if (!boardWasSupplied || previousBoardId === value.board_id) continue;

      const userId = user.user_id as UUID;
      if (previousBoardId) {
        const canDetach = await boardRepository
          .canMutate(previousBoardId, userId)
          .catch(() => false);
        if (!canDetach) {
          throw new Forbidden('Board Editor or Manager access is required to detach this branch');
        }
      }
      if (value.board_id) {
        const targetBoard = await boardRepository.findBySlugOrId(value.board_id);
        const canAttach = targetBoard
          ? await new CapabilityPolicyRepository(db)
              .resolveBoardAccess(targetBoard.board_id, userId as UserID)
              .then((access) => access.capabilities.includes('board.attach_branch'))
              .catch(() => false)
          : false;
        if (!canAttach) {
          throw new Forbidden('Board Editor or Manager access is required to attach a branch');
        }
      }
    }
    return context;
  };

  const branchUpdateAuthorization = [
    requireMinimumRole(ROLES.MEMBER, 'update branches'),
    requireAdminForEnvConfig(),
    validateBranchEnvPolicyHook(config),
    ...(executionMode.appRbacEnabled
      ? [
          loadBranch(branchRepository),
          ensureBranchPermission('all', 'update branches', superadminOpts),
          ensureCanChangeBranchBoard,
        ]
      : []),
    captureMarketplaceInvalidationTargets,
  ];

  app.service('branches').hooks({
    before: {
      all: [typedValidateQuery(branchQueryValidator), requireAuth],
      find: [
        // RBAC: mark external regular-user finds for BranchesService to compose
        // the shared branch visibility predicate directly into its SQL read.
        ...(executionMode.appRbacEnabled ? [scopeFindToAccessibleBranchesSql(superadminOpts)] : []),
      ],
      get: [
        requireExecutorBranchReadScope(),
        ...(executionMode.appRbacEnabled
          ? [
              loadBranch(branchRepository),
              ensureCanView(superadminOpts), // Require 'view' permission to read branch
            ]
          : []),
      ],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create branches'),
        requireAdminForEnvConfig(),
        validateBranchEnvPolicyHook(config),
        ensureCanChangeBranchBoard,
        injectCreatedBy(),
        bindPrimaryOwnerToCreatedBy(),
      ],
      update: [...branchUpdateAuthorization],
      patch: [...branchUpdateAuthorization],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete branches'),
        loadBranch(branchRepository),
        ...(executionMode.appRbacEnabled
          ? [
              ensureBranchPermission('all', 'delete branches', superadminOpts), // Require 'all' permission to delete
            ]
          : [ensureBranchOwnerOrAdmin('delete branches')]),
        captureBranchRemovalRealtimeVisibility,
        captureMarketplaceInvalidationTargets,
      ],
    },
    after: {
      create: [invalidateRealtimeBranchFromResult],
      update: [invalidateRealtimeBranchFromResult, publishMarketplaceInvalidation],
      patch: [invalidateRealtimeBranchFromResult, publishMarketplaceInvalidation],
      remove: [invalidateRealtimeBranchFromResult, publishMarketplaceInvalidation],
    },
  });

  type BranchCustomHookRegistrar = {
    hooks(options: {
      before: Record<
        'updateEnvironment' | 'ensureTeammateKnowledgeNamespace',
        Array<(context: HookContext) => HookContext>
      >;
    }): void;
  };
  (app.service('branches') as unknown as BranchCustomHookRegistrar).hooks({
    before: {
      updateEnvironment: [requireMinimumRole(ROLES.MEMBER, 'update branch environments')],
      ensureTeammateKnowledgeNamespace: [
        requireMinimumRole(ROLES.MEMBER, 'create teammate knowledge namespaces'),
      ],
    },
  });

  // ============================================================================
  // Knowledge hooks
  // ============================================================================

  safeService('kb/namespaces')?.hooks({
    before: {
      all: [requireAuth],
      create: [requireMinimumRole(ROLES.MEMBER, 'create knowledge namespaces')],
      patch: [requireMinimumRole(ROLES.MEMBER, 'update knowledge namespaces')],
      update: [requireMinimumRole(ROLES.MEMBER, 'update knowledge namespaces')],
      remove: [requireMinimumRole(ROLES.MEMBER, 'delete knowledge namespaces')],
      saveWithAcl: [requireMinimumRole(ROLES.MEMBER, 'save knowledge namespace permissions')],
      listAcl: [requireMinimumRole(ROLES.MEMBER, 'manage knowledge namespace permissions')],
      setAcl: [requireMinimumRole(ROLES.MEMBER, 'manage knowledge namespace permissions')],
      removeAcl: [requireMinimumRole(ROLES.MEMBER, 'manage knowledge namespace permissions')],
    },
  } as never);

  safeService('kb/documents')?.hooks({
    before: {
      all: [requireAuth],
      create: [requireMinimumRole(ROLES.MEMBER, 'create knowledge documents')],
      patch: [requireMinimumRole(ROLES.MEMBER, 'update knowledge documents')],
      update: [requireMinimumRole(ROLES.MEMBER, 'update knowledge documents')],
      remove: [requireMinimumRole(ROLES.MEMBER, 'delete knowledge documents')],
    },
  });

  safeService('kb/document-edits')?.hooks({
    before: {
      all: [requireAuth, requireMinimumRole(ROLES.MEMBER, 'edit knowledge documents')],
    },
    after: {
      create: [suppressKnowledgeCommandRealtimeEvent],
    },
  });

  safeService('kb/versions')?.hooks({
    before: {
      all: [requireAuth],
    },
  });

  safeService('kb/search')?.hooks({
    before: {
      all: [requireAuth],
    },
    after: {
      create: [suppressKnowledgeCommandRealtimeEvent],
    },
  });

  safeService('kb/settings')?.hooks({
    before: {
      all: [requireAuth, requireMinimumRole(ROLES.ADMIN, 'configure Knowledge semantic search')],
    },
  });

  safeService('kb/indexing/status')?.hooks({
    before: {
      all: [requireAuth, requireMinimumRole(ROLES.ADMIN, 'view Knowledge indexing status')],
    },
  });

  safeService('kb/indexing/reindex')?.hooks({
    before: {
      all: [requireAuth, requireMinimumRole(ROLES.ADMIN, 'reindex Knowledge embeddings')],
    },
    after: {
      create: [suppressKnowledgeCommandRealtimeEvent],
    },
  });

  (safeService('kb/graph') as { hooks?: (options: unknown) => void } | undefined)?.hooks?.({
    before: {
      all: [requireAuth],
      create: [requireMinimumRole(ROLES.MEMBER, 'link knowledge graph nodes')],
      link: [requireMinimumRole(ROLES.MEMBER, 'link knowledge graph nodes')],
    },
  });

  // ============================================================================
  // MCP servers hooks
  // ============================================================================

  const presentMcpOAuthPolicies = async (context: HookContext): Promise<HookContext> => {
    if (Array.isArray(context.result)) {
      context.result = await presentMCPServerOAuthPolicies(context.result);
    } else if (context.result?.data && Array.isArray(context.result.data)) {
      context.result.data = await presentMCPServerOAuthPolicies(context.result.data);
    } else if (context.result?.mcp_server_id) {
      [context.result] = await presentMCPServerOAuthPolicies([context.result]);
    }
    return context;
  };

  // Writes are decided by `mcp_member_policy` plus ownership, not by role
  // alone — see `authorizeMcpServerWrite`. Reads are narrowed to the servers
  // the caller may use, because a private server is another user's
  // configuration and credential, not shared tenant configuration.
  const authorizeMcpServerWriteHook = createMcpServerWriteAuthorizationHook(db) as unknown as (
    context: HookContext
  ) => Promise<HookContext>;

  const validateMcpServerOAuthCompatibility = async (
    context: HookContext
  ): Promise<HookContext> => {
    const items = Array.isArray(context.data) ? context.data : [context.data];
    try {
      for (const item of items) {
        assertPublicMCPOAuthCompatibilityMode(
          item && typeof item === 'object' ? (item as { auth?: unknown }).auth : undefined
        );
      }
    } catch (error) {
      throw new BadRequest(error instanceof Error ? error.message : 'Invalid MCP OAuth policy');
    }
    return context;
  };

  const scopeMcpServerFindToUsable = async (context: HookContext): Promise<HookContext> => {
    if (!context.params.provider) return context;
    const user = context.params.user;
    if (!user || (user as { _isServiceAccount?: boolean })._isServiceAccount) return context;
    if (!hasMinimumRole(user.role, ROLES.ADMIN)) {
      // Do not trust a caller-supplied usableByUserId; it is an internal
      // authorization filter, not a public query capability.
      context.params.query = {
        ...(context.params.query ?? {}),
        usableByUserId: user.user_id,
      };
    }
    return context;
  };

  const denyMcpServerGetOfAnotherUsersPrivate = async (
    context: HookContext
  ): Promise<HookContext> => {
    if (!context.params.provider) return context;
    const user = context.params.user;
    if (
      !user ||
      (user as { _isServiceAccount?: boolean })._isServiceAccount ||
      hasMinimumRole(user.role, ROLES.ADMIN)
    ) {
      return context;
    }
    if (!isMCPServerUsableBy(context.result as MCPServer, user.user_id)) {
      throw new NotFound(`MCP server not found: ${String(context.id)}`);
    }
    return context;
  };

  safeService('mcp-servers')?.hooks({
    before: {
      // Authentication must run before query parsing so unauthenticated callers
      // cannot use validation errors as a schema oracle.
      all: [requireAuth, typedValidateQuery(mcpServerQueryValidator)],
      find: [scopeMcpServerFindToUsable],
      create: [
        authorizeMcpServerWriteHook,
        (context) => validateMcpServerWriteInput(context, true),
        validateMcpServerOAuthCompatibility,
      ],
      update: [
        authorizeMcpServerWriteHook,
        (context) => validateMcpServerWriteInput(context, false),
        validateMcpServerOAuthCompatibility,
      ],
      patch: [
        authorizeMcpServerWriteHook,
        (context) => validateMcpServerWriteInput(context, false),
        validateMcpServerOAuthCompatibility,
      ],
      remove: [authorizeMcpServerWriteHook],
    },
    after: {
      find: [presentMcpOAuthPolicies, redactMCPServerSecretFieldsForGatewayMode],
      get: [
        denyMcpServerGetOfAnotherUsersPrivate,
        presentMcpOAuthPolicies,
        redactMCPServerSecretFieldsForGatewayMode,
      ],
      create: [redactMCPServerSecretFieldsForGatewayMode],
      patch: [abortMcpInFlightAfterWrite, redactMCPServerSecretFieldsForGatewayMode],
      update: [abortMcpInFlightAfterWrite, redactMCPServerSecretFieldsForGatewayMode],
      // `remove` returns the deleted row: the adapter loads it in full before
      // deleting so it can return it, and that same object becomes the
      // `removed` payload broadcast to every authenticated connection in the
      // tenant. Without this it is the one method that hands out raw `env`,
      // `headers`, and `auth` — a delete is not an exemption from redaction.
      remove: [abortMcpInFlightAfterWrite, redactMCPServerSecretFieldsForGatewayMode],
    },
  });

  // The MCP catalog is a file checked into this repository — no tenant data, no
  // database behind it, and no writes through this service. Authentication
  // still gates it so an unauthenticated visitor cannot enumerate the browse
  // surface. Query validation no longer guards a query: `find` takes no
  // parameters, and the empty schema is what strips a stale client's filters
  // instead of letting them look honoured.
  safeService('mcp-catalog')?.hooks({
    before: {
      all: [typedValidateQuery(mcpCatalogQueryValidator), requireAuth],
    },
  });

  safeService('mcp-catalog/readiness')?.hooks({ before: { all: [requireAuth] } });
  safeService('mcp-marketplace')?.hooks({ before: { all: [requireAuth] } });
  safeService('mcp-marketplace/remove-unattached')?.hooks({ before: { all: [requireAuth] } });
  safeService('mcp-marketplace/tool-permission')?.hooks({ before: { all: [requireAuth] } });

  safeService('session-mcp-servers')?.hooks({
    before: {
      all: [requireAuth],
      find: [
        // RBAC: Scope to sessions the caller can access.
        ...(executionMode.appRbacEnabled ? [scopeFindToAccessibleSessionsSql(superadminOpts)] : []),
      ],
    },
    after: {
      find: [redactMCPServerSecretFields],
    },
  });

  // Top-level `/session-env-selections` is an empty compatibility placeholder;
  // nested routes own reads/writes and the realtime policy publishes no
  // selection events. Keep even the empty service authenticated so a future
  // method cannot accidentally become anonymous.
  safeService('session-env-selections')?.hooks({
    before: {
      all: [requireAuth],
      find: [
        // This top-level service is event-only and always returns []; do not
        // run RBAC preloads for an intentionally empty result set.
      ],
    },
  });

  // ============================================================================
  // Gateway channels hooks
  // ============================================================================

  // Refresh the gateway's in-memory channel state when channels are mutated.
  // This allows routeMessage() to skip DB lookups entirely when no channels exist.
  // Also starts/stops Socket Mode listeners for created/updated/deleted channels.
  const refreshGatewayChannelState = async (context: HookContext) => {
    const gw = context.app.service('gateway') as unknown as GatewayService;
    const channel = context.result as { id: string } | undefined;
    deferWithTenantContext(
      context.params,
      async () => {
        await gw.refreshChannelState();
        if (channel?.id) await gw.startListenerForChannel(channel.id);
      },
      (err) => console.warn('[gateway] Failed to refresh channel/listener state:', err)
    );

    return context;
  };

  // Stop listener when channel is deleted
  const stopGatewayChannelListener = async (context: HookContext) => {
    const gw = context.app.service('gateway') as unknown as GatewayService;

    // Stop listener for deleted channel (use id from route params)
    const channelId = context.id as string | undefined;
    if (channelId) {
      deferWithTenantContext(
        context.params,
        async () => {
          await gw.stopChannelListener(channelId);
        },
        (err) => console.warn(`[gateway] Failed to stop listener for channel ${channelId}:`, err)
      );
    }

    return context;
  };

  safeService('gateway-channels')?.hooks({
    before: {
      all: [
        requireAuth,
        async (context: HookContext) => {
          if (!['create', 'patch', 'remove'].includes(context.method)) return context;
          const tenantId = context.params.tenant?.tenant_id;
          if (!tenantId) return context;
          try {
            await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
              assertTenantWritable(scoped, tenantId).then(() => undefined)
            );
          } catch (error) {
            if (error instanceof TenantWriteGateActiveError) {
              throw new Unavailable(error.message);
            }
            throw error;
          }
          return context;
        },
      ],
      create: [
        requireMinimumRole(ROLES.ADMIN, 'create gateway channels'),
        enforcePublicWriteFields('Gateway channel', GATEWAY_CHANNEL_WRITE_FIELDS),
        injectCreatedBy(),
        // GatewayChannelRepository is the single encrypt-on-write boundary.
        // Encrypting here as well used to create a double envelope on REST/
        // Socket.IO creates and forced the prompt path to decrypt a second time.
        markWriteDataPrepared(),
      ],
      patch: [
        requireMinimumRole(ROLES.ADMIN, 'update gateway channels'),
        enforcePublicWriteFields('Gateway channel', GATEWAY_CHANNEL_WRITE_FIELDS),
        // Resolve redacted env var sentinel values ('••••••••') back to real
        // values from the database. Uses the repository directly to bypass
        // the after-hook redaction that the service layer applies.
        //
        // Semantics:
        // - envVars omitted (undefined) → preserve all existing env vars
        // - envVars = [] (empty array) → explicitly delete all env vars
        // - envVars = [...] with sentinels → substitute real values per key
        async (context: HookContext) => {
          const data = context.data as Record<string, unknown> | undefined;
          if (!data || !context.id) return context;

          // Explicit null means clear all agentic config. Do not resurrect envVars
          // from the existing row while resolving redacted sentinels.
          if (data.agentic_config === null) return context;

          let ac = data.agentic_config as Record<string, unknown> | undefined;
          const hadAgenticConfigInPatch = ac !== undefined;
          const ensureAc = (): Record<string, unknown> => {
            if (!ac) {
              ac = {};
              data.agentic_config = ac;
            }
            return ac;
          };

          const SENTINEL = GATEWAY_REDACTED_SENTINEL;
          const incomingVars = ac?.envVars as
            | { key: string; value: string; forceOverride: boolean }[]
            | undefined;

          // undefined → preserve existing env vars
          if (incomingVars === undefined) {
            try {
              const { GatewayChannelRepository } = await import('@agor/core/db');
              const existing = await runWithTenantDatabaseScope(
                db,
                requireCurrentTenantId('Missing active tenant context for gateway channel read'),
                async (scoped) => new GatewayChannelRepository(scoped).findById(String(context.id))
              );
              // For patches that omit agentic_config entirely (e.g. enabled toggle),
              // copy existing agentic_config so migration still occurs on save.
              if (!hadAgenticConfigInPatch && existing?.agentic_config) {
                ac = { ...(existing.agentic_config as unknown as Record<string, unknown>) };
                data.agentic_config = ac;
              }
              if (existing?.agentic_config?.envVars) {
                ensureAc().envVars = existing.agentic_config.envVars;
              }
            } catch {
              // Non-fatal
            }
            return context;
          }

          // [] → explicit delete all (no substitution needed)
          if (incomingVars.length === 0) return context;

          // Has entries with potential sentinels — substitute from DB
          const hasSentinels = incomingVars.some((v) => v.value === SENTINEL);
          if (!hasSentinels) {
            ensureAc().envVars = incomingVars;
            return context;
          }

          try {
            const { GatewayChannelRepository } = await import('@agor/core/db');
            const existing = await runWithTenantDatabaseScope(
              db,
              requireCurrentTenantId('Missing active tenant context for gateway channel read'),
              async (scoped) => new GatewayChannelRepository(scoped).findById(String(context.id))
            );
            const existingVars = existing?.agentic_config?.envVars ?? [];
            const existingByKey = new Map(existingVars.map((v) => [v.key, v.value]));

            // Substitute sentinels with existing values. Encryption-at-rest is
            // handled in GatewayChannelRepository.
            ensureAc().envVars = incomingVars.map((v) => {
              if (v.value === SENTINEL && existingByKey.has(v.key)) {
                return { ...v, value: existingByKey.get(v.key)! };
              }
              return v;
            });
          } catch (error) {
            throw new BadRequest(
              `Failed to resolve redacted gateway env vars: ${error instanceof Error ? error.message : String(error)}`
            );
          }

          return context;
        },
        markWriteDataPrepared(),
      ],
      remove: [requireMinimumRole(ROLES.ADMIN, 'delete gateway channels')],
    },
    after: {
      all: [redactGatewayChannelResultsForTransport],
      create: [refreshGatewayChannelState],
      patch: [refreshGatewayChannelState],
      remove: [stopGatewayChannelListener, refreshGatewayChannelState],
    },
  });

  // ============================================================================
  // Thread session map, config, context, files, terminals hooks
  // ============================================================================

  safeService('thread-session-map')?.hooks({
    before: {
      all: [requireAuth],
    },
  });

  // Gateway service create (postMessage) authenticates via channel_key, not user auth
  // No hooks needed — auth is handled internally by the service

  safeService('context')?.hooks({
    before: {
      all: [requireAuth],
    },
  });

  safeService('files')?.hooks({
    before: {
      all: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'search files'),
        // RBAC: files service takes a sessionId query param and returns files
        // from that session's branch. Verify the caller can at least 'view'
        // that branch before running git ls-files. If sessionId is missing
        // the service itself returns []; we skip the permission check in that
        // case rather than throwing.
        ...(executionMode.appRbacEnabled
          ? [
              createTenantScopedBeforeHookChain(db, async (context: HookContext) => {
                if (!context.params.provider) return context;
                if (context.params.user?._isServiceAccount) return context;
                const query = context.params.query as { sessionId?: string } | undefined;
                const sessionId = query?.sessionId;
                if (!sessionId) return context;
                context.params.sessionId = sessionId;
                // Delegate to the existing chain now that sessionId is primed.
                await loadSession(sessionsRepository)(context);
                await loadBranchFromSession(branchRepository)(context);
                await ensureCanView(superadminOpts)(context);
                return context;
              }),
            ]
          : []),
      ],
    },
  });

  // /file (singular): read-only branch filesystem browser. Takes branch_id
  // as a query param. Gate with branch RBAC 'view' permission when enabled.
  safeService('/file')?.hooks({
    before: {
      all: [
        requireAuth,
        requireMinimumRole(ROLES.MEMBER, 'read files'),
        ...(executionMode.appRbacEnabled
          ? [
              createTenantScopedBeforeHookChain(
                db,
                loadBranch(branchRepository, 'branch_id'),
                ensureCanView(superadminOpts)
              ),
            ]
          : []),
      ],
    },
  });

  // Terminal access gate:
  // - `execution.allow_web_terminal` defaults to true. Any authenticated user
  //   with role `member` or higher may open a terminal. Branch-level RBAC
  //   still applies inside the service (see services/terminals.ts).
  // - Setting the flag to false disables the terminal for everyone (including
  //   admins). The modal is hidden from the UI in that case.
  const webTerminalCapability = resolveWebTerminalCapability({ config, deployment });
  const webTerminalEnabled = webTerminalCapability.enabled;
  safeService('terminals')?.hooks({
    before: {
      all: [
        requireAuth,
        (context: HookContext) => {
          if (!webTerminalEnabled) {
            throw new Forbidden(
              `Web terminal is unavailable on this instance (${webTerminalCapability.reason ?? 'disabled'}).`
            );
          }
          return context;
        },
        requireMinimumRole(ROLES.MEMBER, 'access terminals'),
      ],
    },
  });

  // ============================================================================
  // Groups hooks
  // ============================================================================

  for (const path of AUTHENTICATED_RBAC_SERVICE_PATHS) {
    safeService(path)?.hooks({ before: { all: [requireAuth] } });
  }
  safeService('groups')?.hooks(groupsHooks);
  safeService('groups')?.hooks({
    before: {
      patch: [captureMarketplaceInvalidationTargets],
      remove: [captureMarketplaceInvalidationTargets],
    },
    after: {
      patch: [clearRealtimeBranchVisibility, publishMarketplaceInvalidation],
      remove: [clearRealtimeBranchVisibility, publishMarketplaceInvalidation],
    },
  });
  safeService('group-memberships')?.hooks(groupMembershipsHooks);
  safeService('group-memberships')?.hooks({
    before: {
      create: [captureMarketplaceInvalidationTargets],
      remove: [captureMarketplaceInvalidationTargets],
    },
    after: {
      create: [clearRealtimeBranchVisibility, publishMarketplaceInvalidation],
      remove: [clearRealtimeBranchVisibility, publishMarketplaceInvalidation],
    },
  });
  safeService('branches/:id/permissions')?.hooks({
    before: {
      patch: [captureMarketplaceInvalidationTargets],
    },
    after: {
      patch: [invalidateRealtimeBranchFromRoute, publishMarketplaceInvalidation],
    },
  });
  safeService('boards/:id/permissions')?.hooks({
    before: {
      patch: [captureMarketplaceInvalidationTargets],
    },
    after: {
      patch: [clearRealtimeBranchVisibility, publishMarketplaceInvalidation],
    },
  });

  // ============================================================================
  // Users hooks
  // ============================================================================

  /**
   * The users service deliberately serves two unauthenticated callers — internal
   * calls (no `provider`) and the Feathers local-auth email lookup during login —
   * so it cannot take a blanket `requireAuth` on `all` the way other services do.
   *
   * But with no authenticate hook at all, `params.user` was never populated on the
   * REST transport, so every downstream guard that reads it (the `find` hook,
   * `authorizeUsersGet`, the role checks) rejected a perfectly valid Bearer token
   * with "Authentication required". Socket.IO connections carry `params.user` from
   * the authenticated connection, which is why this only ever failed over REST and
   * only for the CLI — the UI never exercises this path.
   *
   * So: authenticate when the caller actually presented credentials, and leave both
   * intentional unauthenticated paths exactly as they were.
   */
  const authenticateUsersRequestWhenCredentialed = async (
    context: HookContext
  ): Promise<HookContext> => {
    const params = context.params as AuthenticatedParams;
    if (!params.provider) return context;
    if (params.user) return context;
    if (isLocalAuthenticationLookup(params) || isAuthenticationUserLookup(params)) return context;
    if (!params.authentication) return context;
    return requireAuth(context);
  };

  app.service('users').hooks({
    before: {
      all: [typedValidateQuery(userQueryValidator), authenticateUsersRequestWhenCredentialed],
      find: [
        (context) => {
          const params = context.params as AuthenticatedParams;

          if (!params.provider) {
            return context;
          }

          if (params.user) {
            // Viewers need the same redacted tenant directory that realtime
            // publishes for attribution. Tenant scoping remains owned by the
            // shared users service hook/RLS path; this only aligns the role
            // floor with the rest of the read-only workspace surface.
            ensureMinimumRole(params, ROLES.VIEWER, 'list users');
            return context;
          }

          const query = params.query || {};
          if (query.email && isLocalAuthenticationLookup(params)) {
            // Allow only the Feathers local authentication pipeline to perform
            // unauthenticated exact-email lookup. Direct external /users?email
            // calls are denied below so hashes/private auth fields cannot leak
            // through lookup/enumeration responses.
            params.query = { ...query, $limit: 1 };
            return context;
          }

          throw new NotAuthenticated('Authentication required');
        },
      ],
      get: [authorizeUsersGet],
      // UsersService owns target-aware role authorization. Keeping it in the
      // mutation methods means REST, Socket.IO, MCP, and direct Feathers calls
      // all compare the fresh actor role with both the target's current role
      // and any requested role. Hooks remain responsible for transport
      // validation only and cannot accidentally become an alternate bypass.
      create: [(context) => protectFilesystemHomeWrite(context, config)],
      patch: [
        (context) => protectFilesystemHomeWrite(context, config),
        captureMarketplaceInvalidationTargets,
      ],
    },
    after: {
      // Registered on `all`, not a method list: Feathers composes
      // `collectedAll.after` outermost, so this gets the LAST word on
      // `context.dispatch` after the avatar hooks have run. It is also what
      // keeps this from drifting the way the mcp-servers redaction did when it
      // was pinned to a method list that omitted `remove` (#2374) — the hook
      // itself no-ops on find/get by keying off `context.event`.
      all: [redactUserOwnerOnlyFieldsForBroadcast],
      // Refresh derived profile presentation after user creation or update.
      create: [
        async (context: HookContext) => {
          if ((context.params as Params & { skipAvatarRefresh?: boolean }).skipAvatarRefresh) {
            return context;
          }
          const user = context.result as User;
          const avatarService = safeService('users') as
            | { refreshAvatarFromSettings?: (userId: UserID) => Promise<unknown> }
            | undefined;
          if (avatarService?.refreshAvatarFromSettings) {
            avatarService.refreshAvatarFromSettings(user.user_id).catch((error: unknown) => {
              console.warn(
                `[users/avatar-sync] Failed to refresh avatar for new user ${shortId(user.user_id)}:`,
                error instanceof Error ? error.message : String(error)
              );
            });
          }
          return context;
        },
      ],
      patch: [
        (context: HookContext) => {
          const params = context.params as HookContext['params'] & {
            [CODEX_AUTH_DEFER_USER_REALTIME]?: boolean;
          };
          if (!params[CODEX_AUTH_DEFER_USER_REALTIME]) return context;

          // Codex HA completion/import/logout runs the users patch inside the
          // same generation-fenced transaction as its credential mutation.
          // Suppress Feathers' pre-commit automatic event and enqueue one
          // redacted event that can be observed only after commit.
          context.event = null;
          emitServiceEvent(app, {
            path: 'users',
            event: 'patched',
            id: context.id,
            data: redactUserPayload(context.result),
            params,
          });
          return context;
        },
        publishMarketplaceInvalidation,
        async (context: HookContext) => {
          if ((context.params as Params & { skipAvatarRefresh?: boolean }).skipAvatarRefresh) {
            return context;
          }
          const data = context.data as { email?: string; preferences?: unknown } | undefined;
          if (data?.email === undefined && data?.preferences === undefined) {
            return context;
          }
          const user = context.result as User;
          const avatarService = safeService('users') as
            | { refreshAvatarFromSettings?: (userId: UserID) => Promise<unknown> }
            | undefined;
          if (avatarService?.refreshAvatarFromSettings) {
            avatarService.refreshAvatarFromSettings(user.user_id).catch((error: unknown) => {
              console.warn(
                `[users/avatar-sync] Failed to refresh avatar for updated user ${shortId(user.user_id)}:`,
                error instanceof Error ? error.message : String(error)
              );
            });
          }
          return context;
        },
      ],
    },
  });

  safeService('executor-git-environment')?.hooks({
    before: { all: [requireAuth] },
  });

  // ============================================================================
  // Publish service events
  // ============================================================================

  configureRealtimePublish({
    app,
    db,
    branchRbacEnabled: executionMode.appRbacEnabled,
    branchRepository,
    boardRepository,
    sessionsRepository,
    accessCache: realtimeAccessCache,
    allowSuperadmin: superadminOpts.allowSuperadmin,
    multiTenancy,
    realtimeRelay,
  });

  // ============================================================================
  // Sessions hooks
  // ============================================================================

  // SessionsService.update delegates straight to patch, so both verbs mutate a
  // session the same way and must clear the same authorization chain.
  const sessionWriteGuards = [
    // created_by and unix_username remain immutable identity/history stamps.
    // unix_username is load-bearing for delegated execution-home Sessions;
    // branch-home Sessions deliberately use the current prompt actor instead.
    ensureSessionImmutability(),
    ...(executionMode.appRbacEnabled
      ? [
          resolveSessionContext(),
          loadSession(sessionsRepository),
          loadBranchFromSession(branchRepository),
          // Branch permission by patch type:
          //   - Prompt-flow patches (tasks, archived, status, …) are bookkeeping
          //     emitted by /sessions/:id/prompt and /sessions/:id/stop on behalf
          //     of the authenticated user. They need only the same tier as
          //     prompting the session (session-tier for own, prompt-tier for
          //     others), matching the permission table in CLAUDE.md.
          //   - Everything else is session metadata and still requires 'all'.
          // Mixed-field patches fail isPromptFlowPatchOnly and fall through to
          // the strict 'all' path, so there's no partial-trust footgun.
          (context: HookContext) => {
            if (isPromptFlowPatchOnly(context.data)) {
              return ensureCanPromptInSession({ ...superadminOpts, branchRepository })(context);
            }
            return ensureBranchPermission(
              'all',
              'update session metadata',
              superadminOpts
            )(context);
          },
        ]
      : []),
    // Validate user has prompt permission on callback target session's branch.
    // Skip for internal calls (no provider) — patches from dispatchCompletionCallbacks
    // spread the existing callback_config (which includes callback_session_id) and must
    // not be blocked by this check.
    async (context: HookContext) => {
      const patchCbConfig = (context.data as Record<string, unknown> | undefined)
        ?.callback_config as { callback_session_id?: string } | undefined;
      if (patchCbConfig?.callback_session_id && context.params.provider) {
        const userId =
          (context.params as { user?: { user_id: string } }).user?.user_id || 'unknown';
        await ensureCanPromptTargetSession(
          patchCbConfig.callback_session_id,
          userId,
          context.app,
          branchRepository
        );
      }
      return context;
    },
  ];

  app.service('sessions').hooks({
    before: {
      all: [typedValidateQuery(sessionQueryValidator), requireAuth],
      find: [
        // RBAC: mark external regular-user finds for SessionsService to compose
        // the shared branch visibility predicate directly into its SQL read.
        ...(executionMode.appRbacEnabled ? [scopeFindToAccessibleSessionsSql(superadminOpts)] : []),
      ],
      get: [
        ...(executionMode.appRbacEnabled
          ? [
              // Load session's branch and check permissions
              loadSessionBranch(sessionsRepository, branchRepository),
              ensureCanView(superadminOpts), // Require 'view' permission on branch
            ]
          : []),
      ],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create sessions'),
        // Stamp session with creator's unix_username (MUST run first). Also
        // registered without RBAC when delegated mode makes
        // unix_username load-bearing — otherwise sessions would be stamped
        // null and fail only at prompt time.
        ...(executionMode.appRbacEnabled || executionMode.requiresExecutionHomeKey
          ? [setSessionUnixUsername(usersRepository, executionMode.unixUserMode)]
          : []),
        ...(executionMode.appRbacEnabled
          ? [
              // Check branch permission BEFORE injecting created_by (need branch_id)
              async (context: HookContext) => {
                // RBAC: Ensure user can create sessions in this branch ('all' permission)
                const data = context.data as Partial<Session>;
                if (context.params.provider && data?.branch_id) {
                  try {
                    const branch = await branchRepository.findById(data.branch_id);
                    if (!branch) {
                      throw new Forbidden(`Branch not found: ${data.branch_id}`);
                    }
                    // Cache for later hooks (RBACParams fields)
                    await cacheBranchAccess(context.params, branchRepository, branch);
                  } catch (error) {
                    console.error('Failed to load branch for RBAC check:', error);
                    throw error;
                  }
                }
                return context;
              },
              ensureCanCreateSession(superadminOpts), // Require 'all' permission to create sessions
            ]
          : []),
        injectCreatedBy(),
        async (context) => {
          // Populate repo field from branch_id.
          if (!Array.isArray(context.data) && context.data?.branch_id) {
            try {
              const branch = await context.app.service('branches').get(context.data.branch_id);
              if (branch) {
                const repo = await context.app.service('repos').get(branch.repo_id);
                if (repo) {
                  (context.data as Record<string, unknown>).repo = {
                    repo_id: repo.repo_id,
                    repo_slug: repo.slug,
                    branch_name: branch.name,
                    cwd: branch.path,
                    managed_branch: true,
                  };
                  console.log(`✅ Populated repo.cwd from branch: ${branch.path}`);
                }
              }
            } catch (error) {
              console.error('Failed to populate repo from branch:', error);
            }
          }

          // Validate user has prompt permission on callback target session's branch.
          // Skip for internal calls (no provider) — those are trusted system calls.
          const cbConfig = (context.data as Record<string, unknown> | undefined)?.callback_config as
            | { callback_session_id?: string }
            | undefined;
          if (cbConfig?.callback_session_id && context.params.provider) {
            // Use authenticated user, NOT context.data.created_by (which could be client-supplied)
            const authenticatedUserId =
              (context.params as { user?: { user_id: string } }).user?.user_id || 'unknown';
            await ensureCanPromptTargetSession(
              cbConfig.callback_session_id,
              authenticatedUserId,
              context.app,
              branchRepository
            );
          }

          return context;
        },
      ],
      update: sessionWriteGuards,
      patch: sessionWriteGuards,
      remove: [
        ...(executionMode.appRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsRepository),
              loadBranchFromSession(branchRepository),
              ensureBranchPermission('all', 'delete sessions', superadminOpts), // Require 'all' permission
            ]
          : []),
      ],
    },
    after: {
      find: [
        async (context) => {
          // Session find results may be produced by custom hooks or service
          // methods. Enrich once, as a single batched query over the final page.
          context.result = await enrichSessionFindResultWithRemoteRelationships(
            context.result as Paginated<Session> | Session[],
            sessionsService
          );
          return context;
        },
      ],
      get: [sessionMcpTokenAfterHooks.get],
      create: [
        async (context) => {
          const session = context.result as Session;
          analyticsLogger.track(
            'session.created',
            buildSessionCreatedAnalyticsProperties(session),
            { userId: session.created_by }
          );
          return context;
        },
        sessionMcpTokenAfterHooks.create,
        // TODO: OpenCode session creation moved to executor - implement via IPC if needed
      ],
      patch: [
        async (context) => {
          // Automatically run post-turn side effects when a session becomes promptable.
          // Historically that meant IDLE; failed terminal tasks are now promptable too
          // (status=failed, ready_for_prompt=true) so the UI can surface the failure
          // without blocking queue draining or gateway finalization.
          const session = Array.isArray(context.result) ? context.result[0] : context.result;

          if (session && shouldRunSessionPostTurnHooks(session)) {
            // Flush the gateway outbound buffer (fire-and-forget).
            // When a GitHub/Shortcut-connected session finishes its turn, post
            // the last buffered message as a PR/issue/story comment. Must happen
            // before queue processing so the response posts before the next prompt.
            //
            // Defer outside the just-finished transaction, then re-enter a fresh
            // tenant scope so gateway DB work keeps Cloud RLS context without
            // inheriting a committed transaction object.
            deferWithTenantContext(context.params, async () => {
              try {
                const gatewayService = context.app.service('gateway') as unknown as GatewayService;
                await gatewayService.flushOutboundBuffer(session.session_id);
                await gatewayService.updateProgress({
                  session_id: session.session_id,
                  state: 'done',
                });
              } catch (error) {
                console.warn(
                  `[gateway] Failed to flush gateway buffers/status for session ${shortId(session.session_id)}:`,
                  error
                );
              }
            });

            if (shouldDrainQueueAfterSessionPostTurnPatch(session, context.params)) {
              const sessionTenantId = getTrustedSessionTenantId(session);
              // Same fresh-scope pattern: queue processing must run outside the
              // outer transaction but still inside the session tenant for RLS.
              // Some completion/background paths have minimal params, so this
              // relies on params.tenant, current tenant ALS, the already-returned
              // session row tenant_id, or static tenant config and otherwise
              // fails closed.
              deferWithSessionQueueTenantScope(
                {
                  db,
                  config,
                  sessionId: session.session_id,
                  params: context.params,
                  tenantIdHint: sessionTenantId,
                  label: 'SessionsService.after.patch queue drain',
                },
                async (queueParams) => {
                  console.log(
                    `🔄 [SessionsService.after.patch] Session ${shortId(session.session_id)} became promptable (${session.status}), checking for queued tasks...`
                  );

                  await sessionsService.triggerQueueProcessing(session.session_id, queueParams);
                },
                (error) => {
                  console.error(
                    `❌ [SessionsService.after.patch] Failed to process queue for session ${shortId(session.session_id)}:`,
                    error
                  );
                  // Don't throw - queue processing failure shouldn't break session patches
                }
              );
            } else {
              console.log(
                `⏭️  [SessionsService.after.patch] Queue drain suppressed for session ${shortId(session.session_id)} (suppressTerminalQueueProcessing or not ready)`
              );
            }
          }

          return context;
        },
      ],
    },
  });
  app.service('leaderboard').hooks({
    before: {
      all: [requireAuth],
    },
  });

  // ============================================================================
  // Schedules hooks
  // ============================================================================
  // Schedules inherit RBAC from the parent branch (same model as
  // sessions). See docs/internal/schedules-first-class-design-2026-05-24.md §4.4.

  const scheduleRepository = new ScheduleRepository(db);

  app.service('schedules').hooks({
    before: {
      all: [requireAuth],
      find: [
        ...(executionMode.appRbacEnabled
          ? [scopeScheduleQuery(scheduleRepository, superadminOpts)]
          : []),
      ],
      get: [
        ...(executionMode.appRbacEnabled
          ? [
              loadScheduleAndBranch(scheduleRepository, branchRepository),
              ensureCanView(superadminOpts),
            ]
          : []),
      ],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create schedules'),
        ...(executionMode.appRbacEnabled
          ? [loadBranch(branchRepository, 'branch_id'), ensureCanCreateSession(superadminOpts)]
          : []),
        enforcePublicWriteFields('Schedule', SCHEDULE_CREATE_WRITE_FIELDS),
        injectCreatedBy(),
        validateScheduleConfig(),
        recomputeNextRunAt(),
        markWriteDataPrepared(),
      ],
      patch: [
        requireMinimumRole(ROLES.MEMBER, 'update schedules'),
        ...(executionMode.appRbacEnabled
          ? [
              loadScheduleAndBranch(scheduleRepository, branchRepository),
              ensureCanModifySchedule(superadminOpts),
            ]
          : []),
        enforcePublicWriteFields('Schedule', SCHEDULE_PATCH_WRITE_FIELDS),
        // Lazy-load the current schedule when RBAC didn't cache it for
        // us. `validateScheduleConfig` and `recomputeNextRunAt` both
        // need the merged current+patch shape to do their work
        // correctly, and they have to run on every install.
        ensureCurrentScheduleLoaded(scheduleRepository),
        ensureScheduleRunsAsCaller(superadminOpts),
        validateScheduleConfig(),
        recomputeNextRunAt(),
        markWriteDataPrepared(),
      ],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete schedules'),
        ...(executionMode.appRbacEnabled
          ? [
              loadScheduleAndBranch(scheduleRepository, branchRepository),
              ensureBranchPermission('all', 'delete schedule', superadminOpts),
            ]
          : []),
      ],
    },
  });

  // ============================================================================
  // Tasks hooks
  // ============================================================================

  const tasksService = app.service('tasks') as FeathersService<Application, TasksServiceImpl>;
  tasksService.hooks({
    before: {
      all: [typedValidateQuery(taskQueryValidator), requireAuth],
      find: [
        // RBAC: Scope tasks.find() to sessions the caller can access.
        ...(executionMode.appRbacEnabled ? [scopeFindToAccessibleSessionsSql(superadminOpts)] : []),
      ],
      get: [
        ...(executionMode.appRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsRepository),
              loadBranchFromSession(branchRepository),
              ensureCanView(superadminOpts), // Require 'view' permission
            ]
          : []),
      ],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create tasks'),
        ...promptWriteGuards,
        protectExternalTaskCreate,
        injectCreatedBy(),
      ],
      patch: [
        protectServerManagedTaskWrites,
        projectExecutorTaskSdkResponse(taskRepository, sessionsRepository),
        ...(executionMode.appRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsRepository),
              loadBranchFromSession(branchRepository),
              ensureCanPromptInSession({ ...superadminOpts, branchRepository }), // Require 'prompt' (or 'session' for own sessions)
            ]
          : []),
      ],
      connectExecutor: [requireTaskScopedExecutorRuntimeToken()],
      reportTerminationComplete: [requireTaskScopedExecutorRuntimeToken()],
      reportRuntimeTelemetry: [requireTaskScopedExecutorRuntimeToken()],
      reportSdkHealthFailure: [requireTaskScopedExecutorRuntimeToken()],
      // Feathers' HookTypeMap only retains custom methods whose return type is
      // the service resource. completeWorkload returns the atomic Task/Message
      // pair, but it is still a registered transport method on TasksService.
      // @ts-expect-error -- custom atomic result method is omitted by HookTypeMap
      completeWorkload: [requireTaskScopedExecutorRuntimeToken()],
      // Receipt authority is accepted only for read-only replay of the exact
      // canonical settlement already committed before token retirement.
      reconcileWorkloadCompletion: [requireWorkloadCompletionReceipt()],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete tasks'),
        // RBAC: deleting a task requires 'all' permission on the branch
        // (mirrors sessions.remove). Without this, any member with 'session'
        // access could delete tasks owned by other users on shared branches.
        ...(executionMode.appRbacEnabled
          ? [
              resolveSessionContext(),
              loadSession(sessionsRepository),
              loadBranchFromSession(branchRepository),
              ensureBranchPermission('all', 'delete tasks', superadminOpts),
            ]
          : []),
      ],
    },
  });

  // ============================================================================
  // Boards hooks
  // ============================================================================

  // BoardRepository for RBAC find-scope hook (single instance reused across
  // requests). Cheap to construct — just wraps the shared db handle.
  const boardIdentifierFromHookContext = (context: HookContext): string | undefined => {
    // biome-ignore lint/suspicious/noExplicitAny: Custom Feathers method args are dynamic.
    const args = (context as any).arguments as unknown[] | undefined;
    const firstArg = args?.[0];
    return typeof context.id === 'string'
      ? context.id
      : typeof context.params.route?.id === 'string'
        ? context.params.route.id
        : typeof firstArg === 'string'
          ? firstArg
          : firstArg && typeof firstArg === 'object'
            ? ((firstArg as { boardId?: string; id?: string; slug?: string }).boardId ??
              (firstArg as { boardId?: string; id?: string; slug?: string }).id ??
              (firstArg as { boardId?: string; id?: string; slug?: string }).slug)
            : undefined;
  };

  const ensureBoardAccess = (mode: 'view' | 'mutate', action: string) => {
    return async (context: HookContext) => {
      if (!executionMode.appRbacEnabled || !context.params.provider) return context;
      const user = context.params.user;
      if (!user) throw new NotAuthenticated('Authentication required');
      if (user._isServiceAccount) return context;
      // `allow_superadmin` controls the exceptional branch/board RBAC bypass;
      // it must never strip ordinary admin authority from a superadmin.
      if (hasMinimumRole(user.role, ROLES.ADMIN)) {
        return context;
      }

      const id = boardIdentifierFromHookContext(context);
      if (!id) throw new BadRequest('Board ID is required');

      const board = await boardRepository.findBySlugOrId(id);
      if (!board) throw new Forbidden(`Board not found: ${id}`);
      const allowed =
        mode === 'view'
          ? await boardRepository.canViewResolved(board, user.user_id as UserID)
          : await boardRepository.canMutateResolved(board, user.user_id as UserID);
      if (!allowed) {
        throw new Forbidden(
          mode === 'view'
            ? `You need board access to ${action}`
            : `You need Board Editor or Manager access to ${action}`
        );
      }
      if (context.path === 'boards' && context.method === 'get' && context.id) {
        // The same tenant transaction and caller authority immediately enter
        // BoardsService.get after this hook. Canonicalize short/slug IDs and
        // pass the just-authorized row through the generic adapter's bounded
        // request params instead of reading it a third time. This is neither a
        // cross-request nor cross-principal cache; policy resolution above is
        // still performed on every call, preserving immediate revocation.
        context.id = board.board_id;
        (
          context.params as typeof context.params & {
            _agorPrefetchedRecord?: {
              id: string;
              idField: string;
              record: Board;
            };
          }
        )._agorPrefetchedRecord = {
          id: board.board_id,
          idField: 'board_id',
          record: board,
        };
      }
      return context;
    };
  };
  const ensureCanViewBoard = (action: string) => ensureBoardAccess('view', action);
  const ensureCanMutateBoard = (action: string) => ensureBoardAccess('mutate', action);

  type PrimaryTeammateInvalidationParams = HookContext['params'] & {
    [PRIMARY_TEAMMATE_INVALIDATION_MODE]?: Exclude<RealtimeAuthorizationInvalidationMode, 'none'>;
  };

  const capturePrimaryTeammateInvalidationMode = async (
    context: HookContext
  ): Promise<HookContext> => {
    // Fail closed unless the tenant-scoped pre-mutation state proves that the
    // current primary pointer is absent or redundant with an attached branch.
    let mode: Exclude<RealtimeAuthorizationInvalidationMode, 'none'> = 'evict';
    const boardIdentifier = boardIdentifierFromHookContext(context);
    if (boardIdentifier) {
      try {
        const board = await boardRepository.findBySlugOrId(boardIdentifier);
        if (board) {
          const primaryBranch = board.primary_teammate_id
            ? await branchRepository.findById(board.primary_teammate_id)
            : null;
          mode = classifyPrimaryTeammateAuthorizationInvalidation(board, primaryBranch);
        }
      } catch {
        // The mutation itself will return its normal non-enumerating error. If
        // it does succeed despite an unresolved pre-state, evict rather than
        // retaining a possibly revoked passive capability.
      }
    }
    (context.params as PrimaryTeammateInvalidationParams)[PRIMARY_TEAMMATE_INVALIDATION_MODE] =
      mode;
    return context;
  };

  const invalidatePrimaryTeammateAuthorization = (context: HookContext): HookContext => {
    const mode = (context.params as PrimaryTeammateInvalidationParams)[
      PRIMARY_TEAMMATE_INVALIDATION_MODE
    ];
    // A missing capture is unexpected, but full eviction is the safe fallback.
    return scheduleRealtimeAuthorizationInvalidation(context, mode ?? 'evict');
  };

  const emitBoardPatched = (board: Board | undefined, context: HookContext<Board>) => {
    if (board) {
      emitServiceEvent(app, {
        path: 'boards',
        event: 'patched',
        data: board,
        params: context.params,
        id: context.id,
      });
    }
  };

  const boardUpdateAuthorization = [
    requireMinimumRole(ROLES.MEMBER, 'update boards'),
    ensureCanMutateBoard('update this board'),
    captureBoardAlignedBranchMarketplaceTargets,
  ];

  safeService('boards')?.hooks({
    before: {
      all: [typedValidateQuery(boardQueryValidator), requireAuth],
      find: [
        // Board visibility is independent from branch visibility. Push the
        // normalized board policy into SQL rather than deriving canvas access
        // from any branch the caller happens to see.
        ...(executionMode.appRbacEnabled ? [scopeFindToAccessibleBoardsSql(superadminOpts)] : []),
      ],
      get: [ensureCanViewBoard('view this board')],
      findBySlug: [ensureCanViewBoard('view this board')],
      findBySlugOrId: [ensureCanViewBoard('view this board')],
      create: [
        requireMinimumRole(ROLES.MEMBER, 'create boards'),
        injectCreatedBy(),
        bindPrimaryOwnerToCreatedBy(),
      ],
      // Whole-row replacement carries the same authorization as patch. The
      // `_action` dispatcher below is patch-only: those atomic board-object
      // operations are addressed through PATCH and have no PUT equivalent.
      update: [...boardUpdateAuthorization],
      patch: [
        ...boardUpdateAuthorization,
        async (context: HookContext<Board>) => {
          // Handle atomic board object operations via _action parameter
          const contextData = context.data || {};
          const { _action, objectId, objectData, objects, deleteAssociatedSessions } =
            contextData as UnknownJson;

          if (_action === 'upsertObject') {
            if (!objectId || !objectData) {
              console.error('❌ upsertObject called without objectId or objectData!', {
                objectId,
                hasObjectData: !!objectData,
              });
              // Return early to prevent normal patch flow
              throw new Error('upsertObject requires objectId and objectData');
            }
            if (!context.id) throw new Error('Board ID required');
            const result = await boardsService!.upsertBoardObject(
              context.id as string,
              objectId as string,
              objectData
            );
            context.result = result;
            console.log('🔄 [boards patch hook] Emitting patched event for upsertObject', {
              board_id: shortId(result.board_id),
              objectId,
              objectsCount: Object.keys(result.objects || {}).length,
            });
            // Manually emit 'patched' event for WebSocket broadcasting (ONCE)
            emitServiceEvent(app, {
              path: 'boards',
              event: 'patched',
              data: result,
              params: context.params,
              id: context.id,
            });
            // Skip normal patch flow to prevent double emit
            context.dispatch = result;
            return context;
          }

          if (_action === 'removeObject' && objectId) {
            if (!context.id) throw new Error('Board ID required');
            const result = await boardsService!.removeBoardObject(
              context.id as string,
              objectId as string
            );
            context.result = result;
            // Manually emit 'patched' event for WebSocket broadcasting (ONCE)
            emitServiceEvent(app, {
              path: 'boards',
              event: 'patched',
              data: result,
              params: context.params,
              id: context.id,
            });
            // Skip normal patch flow to prevent double emit
            context.dispatch = result;
            return context;
          }

          if (_action === 'batchUpsertObjects' && objects) {
            if (!context.id) throw new Error('Board ID required');
            const result = await boardsService!.batchUpsertBoardObjects(
              context.id as string,
              objects
            );
            context.result = result;
            // Manually emit 'patched' event for WebSocket broadcasting (ONCE)
            emitServiceEvent(app, {
              path: 'boards',
              event: 'patched',
              data: result,
              params: context.params,
              id: context.id,
            });
            // Skip normal patch flow to prevent double emit
            context.dispatch = result;
            return context;
          }

          if (_action === 'mergeObjectFields' && objects) {
            if (!context.id) throw new Error('Board ID required');
            const result = await boardsService!.mergeBoardObjectFields(
              context.id as string,
              objects
            );
            context.result = result;
            // Manually emit 'patched' event for WebSocket broadcasting (ONCE)
            emitServiceEvent(app, {
              path: 'boards',
              event: 'patched',
              data: result,
              params: context.params,
              id: context.id,
            });
            // Skip normal patch flow to prevent double emit
            context.dispatch = result;
            return context;
          }

          if (_action === 'deleteZone' && objectId) {
            if (!context.id) throw new Error('Board ID required');
            const result = await boardsService!.deleteZone(
              context.id as string,
              objectId as string,
              deleteAssociatedSessions ?? false
            );
            context.result = result.board;
            // Manually emit 'patched' event for WebSocket broadcasting
            emitServiceEvent(app, {
              path: 'boards',
              event: 'patched',
              data: result.board,
              params: context.params,
              id: context.id,
            });
            return context;
          }

          return context;
        },
      ],
      remove: [
        requireMinimumRole(ROLES.MEMBER, 'delete boards'),
        ensureCanMutateBoard('delete this board'),
        captureBoardRemovalRealtimeVisibility,
        captureMarketplaceInvalidationTargets,
      ],
      toBlob: [
        requireMinimumRole(ROLES.MEMBER, 'export boards'),
        ensureCanViewBoard('export boards'),
      ],
      toYaml: [
        requireMinimumRole(ROLES.MEMBER, 'export boards'),
        ensureCanViewBoard('export boards'),
      ],
      fromBlob: [requireMinimumRole(ROLES.MEMBER, 'import boards')],
      fromYaml: [requireMinimumRole(ROLES.MEMBER, 'import boards')],
      clone: [requireMinimumRole(ROLES.MEMBER, 'clone boards'), ensureCanViewBoard('clone boards')],
      setPrimaryTeammate: [
        requireMinimumRole(ROLES.MEMBER, 'set primary teammate'),
        ensureCanMutateBoard('set primary teammate'),
        capturePrimaryTeammateInvalidationMode,
      ],
      clearPrimaryTeammate: [
        requireMinimumRole(ROLES.MEMBER, 'clear primary teammate'),
        ensureCanMutateBoard('clear primary teammate'),
        capturePrimaryTeammateInvalidationMode,
      ],
      ensureTeammateWelcomeNote: [
        requireMinimumRole(ROLES.MEMBER, 'create teammate welcome note'),
        ensureCanMutateBoard('create teammate welcome note'),
      ],
    },
    after: {
      // Strip private artifact objects from board.objects for non-owners
      get: [
        async (context: HookContext<Board>) => {
          const board = context.result;
          if (!board?.objects) return context;
          const userId = (context.params as { user?: { user_id: string } }).user?.user_id;
          const artifactObjectIds = Object.entries(board.objects)
            .filter(([, obj]) => obj && (obj as { type?: string }).type === 'artifact')
            .map(([id, obj]) => ({
              id,
              artifactId: (obj as { artifact_id?: string }).artifact_id,
            }));
          if (artifactObjectIds.length === 0) return context;

          const artifactRepo = new ArtifactRepository(db);
          const filtered = { ...board.objects };
          for (const { id, artifactId } of artifactObjectIds) {
            if (!artifactId) continue;
            try {
              const artifact = await artifactRepo.findById(artifactId);
              if (!artifact) {
                delete filtered[id]; // orphaned reference
              } else if (!artifact.public && artifact.created_by !== userId) {
                delete filtered[id]; // private, not owned
              }
            } catch {
              // artifact not found, remove stale reference
              delete filtered[id];
            }
          }
          context.result = { ...board, objects: filtered };
          return context;
        },
      ],
      find: [
        async (context: HookContext<Board>) => {
          const result = context.result;
          if (!result) return context;
          const boards = Array.isArray(result) ? result : (result as { data: Board[] }).data;
          if (!boards?.length) return context;
          const userId = (context.params as { user?: { user_id: string } }).user?.user_id;
          const artifactRepo = new ArtifactRepository(db);

          for (const board of boards) {
            if (!board.objects) continue;
            const artifactEntries = Object.entries(board.objects).filter(
              ([, obj]) => obj && (obj as { type?: string }).type === 'artifact'
            );
            if (artifactEntries.length === 0) continue;

            const filtered = { ...board.objects };
            for (const [id, obj] of artifactEntries) {
              const artifactId = (obj as { artifact_id?: string }).artifact_id;
              if (!artifactId) continue;
              try {
                const artifact = await artifactRepo.findById(artifactId);
                if (!artifact || (!artifact.public && artifact.created_by !== userId)) {
                  delete filtered[id];
                }
              } catch {
                delete filtered[id];
              }
            }
            board.objects = filtered;
          }
          return context;
        },
      ],
      update: [clearRealtimeBranchVisibility, publishMarketplaceInvalidation],
      patch: [clearRealtimeBranchVisibility, publishMarketplaceInvalidation],
      remove: [clearRealtimeBranchVisibility, publishMarketplaceInvalidation],
      // Emit created events for custom methods that create boards
      // Custom methods don't automatically trigger app.publish(), so we emit manually
      clone: [
        clearRealtimeBranchVisibility,
        async (context: HookContext<Board>) => {
          if (context.result) {
            emitServiceEvent(app, {
              path: 'boards',
              event: 'created',
              data: context.result,
              params: context.params,
            });
          }
          return context;
        },
      ],
      fromBlob: [
        clearRealtimeBranchVisibility,
        async (context: HookContext<Board>) => {
          if (context.result) {
            emitServiceEvent(app, {
              path: 'boards',
              event: 'created',
              data: context.result,
              params: context.params,
            });
          }
          return context;
        },
      ],
      fromYaml: [
        clearRealtimeBranchVisibility,
        async (context: HookContext<Board>) => {
          if (context.result) {
            emitServiceEvent(app, {
              path: 'boards',
              event: 'created',
              data: context.result,
              params: context.params,
            });
          }
          return context;
        },
      ],
      setPrimaryTeammate: [
        clearRealtimeBranchVisibility,
        // Replacing an attached primary is cache-only because its board_id is
        // an equivalent visibility anchor. Replacing a stale detached primary
        // can revoke the only remaining board access and fully evicts.
        invalidatePrimaryTeammateAuthorization,
        async (context: HookContext<Board>) => {
          emitBoardPatched(context.result, context);
          return context;
        },
      ],
      clearPrimaryTeammate: [
        clearRealtimeBranchVisibility,
        // Use trusted pre-mutation state captured inside this request's tenant
        // transaction; unresolved/detached primaries fail closed to eviction.
        invalidatePrimaryTeammateAuthorization,
        async (context: HookContext<Board>) => {
          emitBoardPatched(context.result, context);
          return context;
        },
      ],
      ensureTeammateWelcomeNote: [
        clearRealtimeBranchVisibility,
        async (context: HookContext<Board>) => {
          const teammateWelcomeNoteMutated = context.params as typeof context.params & {
            teammateWelcomeNoteMutated?: boolean;
          };
          if (context.result && teammateWelcomeNoteMutated.teammateWelcomeNoteMutated) {
            emitBoardPatched(context.result, context);
          }
          return context;
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: Custom service methods not in default hook map
  } as any);

  // ============================================================================
  // Board archive/unarchive routes (hooks only — services registered elsewhere)
  // ============================================================================

  if (boardsService) {
    app.use('/boards/:id/archive', {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Board ID required');
        return boardsService.archive(id, params);
      },
    });

    app.service('/boards/:id/archive').hooks({
      before: {
        create: [
          requireAuth,
          requireMinimumRole(ROLES.MEMBER, 'archive boards'),
          ensureCanMutateBoard('archive this board'),
        ],
      },
      after: { create: [clearRealtimeBranchVisibility] },
    });

    // POST /boards/:id/unarchive - Unarchive a board
    app.use('/boards/:id/unarchive', {
      async create(_data: unknown, params: RouteParams) {
        const id = params.route?.id;
        if (!id) throw new Error('Board ID required');
        return boardsService.unarchive(id, params);
      },
    });

    app.service('/boards/:id/unarchive').hooks({
      before: {
        create: [
          requireAuth,
          requireMinimumRole(ROLES.MEMBER, 'unarchive boards'),
          ensureCanMutateBoard('unarchive this board'),
        ],
      },
      after: { create: [clearRealtimeBranchVisibility] },
    });
  } // end boards archive/unarchive

  // Tenant hooks are registered last so service-specific authentication hooks
  // (which populate params.user / params.authentication) run before tenant
  // resolution in required_from_auth mode.
  if (tenantColumnsEnabled) {
    registerTenantHooks();
  } else {
    registerTenantIdentityForOwnedServices();
  }
  registerTenantIdentityHooks();
}
