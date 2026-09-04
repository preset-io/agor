/**
 * Sessions Service
 *
 * Provides REST + WebSocket API for session management.
 * Uses DrizzleService adapter with SessionRepository.
 */

import { getAgenticToolModelConfiguration } from '@agor/agentic-tools';
import {
  isResolvedAgenticToolModelConfiguration,
  materializeAgenticToolConfiguration,
} from '@agor/agentic-tools/config';
import {
  isTenantAgenticToolEnabled,
  PAGINATION,
  resolveExecutionSecurityMode,
} from '@agor/core/config';
import {
  BranchRepository,
  bindRepositoryToTenantUnitOfWork,
  EntityNotFoundError,
  getCurrentTenantId,
  inArray,
  lockRowForUpdate,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  SessionEnvSelectionRepository,
  SessionMCPServerRepository,
  SessionRelationshipRepository,
  SessionRepository,
  type SessionWithLastMessage,
  sessions,
  shortId,
  TaskRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UsersRepository,
} from '@agor/core/db';
import {
  type Application,
  BadRequest,
  Conflict,
  Forbidden,
  NotAuthenticated,
  NotFound,
} from '@agor/core/feathers';
import { MCPServerNotUsableError } from '@agor/core/mcp';
import {
  formatModelToolMismatchWarning,
  getCodexModelSelectionError,
  isInvalidModelConfigError,
  isResolvedModelConfig,
  lintModelToolMatch,
} from '@agor/core/models';
import type {
  AgenticToolName,
  AuthenticatedParams,
  Branch,
  BranchID,
  BranchPermissionLevel,
  CreateSessionInput,
  MCPServerID,
  Paginated,
  QueryParams,
  Session,
  SessionID,
  SessionSdkHomeScope,
  SessionUpdate,
  TaskID,
  UserID,
  UUID,
} from '@agor/core/types';
import {
  isAgenticToolDefaultConfigurationReference,
  isSessionExecuting,
  SessionStatus,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor/core/types';
import { assertExecutionHomeKeySatisfiesMode } from '@agor/core/unix';
import { DrizzleService, type Query } from '../adapters/drizzle';
import {
  branchSdkHomeUnsupportedReason,
  hasSecureLocalCredentialOverlay,
  resolveBranchSdkHomeIncompatibility,
  resolveNewSessionSdkHomeScope,
  resolveSdkHomeConfig,
} from '../branch-sdk-home.js';
import { requireActiveAgenticTool } from '../utils/agentic-tool-runtime.js';
import {
  determineSpawnIdentity,
  isSuperAdmin,
  loadUnixUsernameForUser,
  PERMISSION_RANK,
  sessionPromptDeniedMessage,
} from '../utils/branch-authorization.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { parseLastMessageTruncationLength } from '../utils/query-params.js';
import { deploymentAgenticToolUnavailableMessage } from './agentic-tool-deployment.js';
import {
  lockTenantAuthorizationFence,
  resolveCurrentTenantAuthorityActor,
} from './tenant-authorization-fence.js';

type MaterializedAgenticToolConfiguration = Awaited<
  ReturnType<typeof materializeAgenticToolConfiguration>
>;

type SessionArchiveReason = NonNullable<Session['archived_reason']>;

const PARENT_ARCHIVED_REASON = 'parent_archived' satisfies SessionArchiveReason;

export const ARCHIVE_PATCH_REJECTED_MESSAGE =
  'Archive state cannot be changed through a generic session update. ' +
  'Use POST /sessions/:id/archive, POST /sessions/:id/unarchive, or the ' +
  'agor_sessions_archive / agor_sessions_unarchive MCP tools.';

/** Named bounds for the remote expansion of one dedicated archive. */
const MAX_ARCHIVE_REMOTE_DEPTH = 8;
const MAX_ARCHIVE_REMOTE_BRANCH_UNITS = 32;
const MAX_ARCHIVE_REMOTE_SESSION_TARGETS = 5_000;

function describeArchiveLimit(limit: SessionArchiveLimit): string {
  switch (limit) {
    case 'remote_depth':
      return `a chain of remote-created sessions deeper than ${MAX_ARCHIVE_REMOTE_DEPTH} hops`;
    case 'remote_branch_units':
      return `more than ${MAX_ARCHIVE_REMOTE_BRANCH_UNITS} other branches`;
    case 'remote_session_targets':
      return `more than ${MAX_ARCHIVE_REMOTE_SESSION_TARGETS} sessions in other branches`;
  }
}

class ArchiveLimitExceededError extends Error {
  constructor(readonly limit: SessionArchiveLimit) {
    super(
      `Archiving this session would reach ${describeArchiveLimit(limit)}. ` +
        'Pass includeRemoteChildren: false or archive the remote sessions separately.'
    );
  }
}

type ArchiveBranchGraph = {
  branchId: BranchID;
  byId: Map<string, Session>;
  childrenOf: Map<string, Session[]>;
};

/** One authorization + mutation unit: a local root tree or one remote branch. */
type ArchiveUnit = {
  key: string;
  branchId: BranchID;
  kind: 'local' | 'remote';
  /** Explicit roots (local units) or relationship targets (remote units). */
  rootIds: Set<string>;
  members: Map<string, Session>;
};

type ArchivePlannedTarget = {
  session: Session;
  archived: boolean;
  archivedReason: SessionArchiveReason | null;
  selection: 'direct' | 'implied';
  unitKey: string;
};

type ArchiveExcludedImplied = {
  session: Session;
  /** Local authorization units whose root closures contain this descendant. */
  unitKeys: Set<string>;
};

type ArchiveTransitionPlan = {
  archived: boolean;
  localFailure: ArchiveTransitionRequest['localFailure'];
  units: ArchiveUnit[];
  unitResults: SessionArchiveUnitResult[];
  targets: ArchivePlannedTarget[];
  remainingArchived: SessionArchiveResult['remainingArchived'];
  /** Implied descendants a bulk eligibility policy left out. */
  excludedImplied: ArchiveExcludedImplied[];
  limitExceeded?: SessionArchiveLimit;
};

type ArchiveTransitionRequest = {
  roots: Session[];
  initiator: SessionArchiveInitiator;
  archived: boolean;
  includeChildren: boolean;
  includeRemoteChildren: boolean;
  /** `branch`: one local unit per branch. `root-tree`: one unit per (merged) root closure. */
  grouping: 'branch' | 'root-tree';
  /** What to do when a local unit is unauthorized. Remote units are always skipped. */
  localFailure: 'throw' | 'skip';
  /** Narrow implied descendants (never roots); returns the eligible session IDs. */
  descendantEligibility?: (candidates: Session[]) => Promise<Set<string>>;
  /** Dry-run: report a bound overflow on the plan instead of throwing. */
  tolerateLimits?: boolean;
  params?: SessionParams;
};

function localParentIds(session: Session): string[] {
  return [session.genealogy?.parent_session_id, session.genealogy?.forked_from_session_id].filter(
    (id): id is SessionID => typeof id === 'string' && id.length > 0
  );
}

function internalArchiveParams(params: SessionParams | undefined): SessionParams | undefined {
  // Trusted internal callers already authorized the user action that led here.
  return params ? { ...params, provider: undefined } : undefined;
}

function sessionConfigurationSource(
  data: Pick<CreateSessionInput, 'model_config' | 'permission_config'>
): import('@agor/core/types').AgenticToolConfigurationSource {
  return {
    configuration: {
      modelConfig: data.model_config ?? undefined,
      permissionMode: data.permission_config?.mode,
      codexSandboxMode: data.permission_config?.codex?.sandboxMode,
      codexApprovalPolicy: data.permission_config?.codex?.approvalPolicy,
      codexNetworkAccess: data.permission_config?.codex?.networkAccess,
    },
  };
}

function resolvedSessionPresetId(
  reference: CreateSessionInput['agentic_tool_preset_id']
): Session['agentic_tool_preset_id'] {
  if (reference && isAgenticToolDefaultConfigurationReference(reference)) {
    throw new BadRequest('agentic_tool_preset_id must be resolved before session creation');
  }
  return reference;
}

function resolvedSessionModelConfig(
  modelConfig: CreateSessionInput['model_config']
): Session['model_config'] {
  if (modelConfig == null) return modelConfig;
  if (!isResolvedModelConfig(modelConfig)) {
    throw new BadRequest('model_config must be resolved before session creation');
  }
  return modelConfig;
}

function normalizeCreateMcpServerIds(value: unknown): MCPServerID[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new BadRequest('mcpServerIds must be an array');
  }
  if (!value.every((serverId) => typeof serverId === 'string' && serverId.trim().length > 0)) {
    throw new BadRequest('mcpServerIds must contain non-empty strings');
  }
  return [...new Set(value)] as MCPServerID[];
}

/**
 * Internal service params shared between services that support last-message enrichment.
 * Bypasses Feathers query filtering for internal service-to-service calls.
 */
export interface InternalEnrichmentParams {
  /** Root-level truncation length (bypasses Feathers query filtering, used by internal service calls) */
  _last_message_truncation_length?: number;
}

/**
 * Session service params
 */
export type SessionParams = QueryParams<{
  status?: Session['status'];
  agentic_tool?: Session['agentic_tool'];
  board_id?: string;
  include_last_message?: boolean | 'true' | 'false'; // Opt-in last message enrichment
  last_message_truncation_length?: number; // Default: 500 chars, min: 50, max: 10000
  /** Marks a `remove` as the delete half of a "switch tool" swap (see `remove`). */
  _swapReplace?: boolean;
}> &
  AuthenticatedParams &
  InternalEnrichmentParams & {
    /** Root-level include_last_message flag (bypasses Feathers query filtering, used by internal service calls) */
    _include_last_message?: boolean | 'true' | 'false';
    /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
    _agorSqlSessionAccessUserId?: UUID;
    /** Internal task-start reconciliation of a live preset. */
    _applyingAgenticToolPreset?: boolean;
    /**
     * Internal caller already resolved permission/model fallbacks and must not inherit user defaults.
     * Root-level service params are server-controlled; transport query/data cannot set this marker.
     */
    _agenticConfigResolved?: boolean;
    /**
     * Trusted session-admission override. Genealogical children inherit their
     * parent's SDK lineage; independent creates resolve branch intent + config.
     */
    _sdkHomeScope?: SessionSdkHomeScope;
  };

/**
 * Whether a sessions `find` query should be served by `SessionRepository.findPage`
 * (SQL board filter + recency sort + limit/offset) rather than the generic
 * in-memory path. We only divert the loader's bounded list queries — those that
 * sort by `updated_at` and/or scope to a `board_id`/`branch_id` — and only when the rest of
 * the query is a shape findPage fully models (archived + pagination). Anything
 * with extra filters, operators, or `$select` falls through to the existing path
 * so we never silently drop semantics findPage doesn't implement.
 */
function shouldSqlPageSessionQuery(query?: Record<string, unknown>, forcePage = false): boolean {
  if (!query) return forcePage;

  const sort = query.$sort as Record<string, unknown> | undefined;
  const wantsRecency = !!sort && sort.updated_at !== undefined;
  const wantsCreatedAt = !!sort && sort.created_at !== undefined;
  const wantsBoard = query.board_id !== undefined;
  const wantsBranch = query.branch_id !== undefined;
  if (!wantsRecency && !wantsCreatedAt && !wantsBoard && !wantsBranch && !forcePage) return false;

  const allowedKeys = new Set(['archived', 'board_id', 'branch_id', '$sort', '$limit', '$skip']);
  for (const key of Object.keys(query)) {
    if (!allowedKeys.has(key)) return false;
  }
  if (query.archived !== undefined && typeof query.archived !== 'boolean') return false;
  if (wantsBoard && typeof query.board_id !== 'string') return false;
  if (wantsBranch) {
    const branchFilter = query.branch_id;
    const validExact = typeof branchFilter === 'string';
    const validSet =
      branchFilter !== null &&
      typeof branchFilter === 'object' &&
      Array.isArray((branchFilter as { $in?: unknown }).$in) &&
      (branchFilter as { $in: unknown[] }).$in.every((id) => typeof id === 'string');
    if (!validExact && !validSet) return false;
  }
  if (sort) {
    const sortKeys = Object.keys(sort);
    if (sortKeys.length !== 1 || !['updated_at', 'created_at'].includes(sortKeys[0])) return false;
    const direction = sort[sortKeys[0]];
    if (direction !== 1 && direction !== -1) return false;
  }
  return true;
}

const remoteRelationshipsEnrichedResults = new WeakSet<object>();

export function markRemoteRelationshipsEnrichedResult<T extends object>(result: T): T {
  remoteRelationshipsEnrichedResults.add(result);
  return result;
}

export function isRemoteRelationshipsEnrichedResult(result: unknown): boolean {
  return (
    typeof result === 'object' && result !== null && remoteRelationshipsEnrichedResults.has(result)
  );
}

/**
 * Execute task data payload
 * Used by setExecuteHandler, executeTask, and related methods
 */
export type ExecuteTaskData = {
  taskId: string;
  prompt: string;
  permissionMode?: import('@agor/core/types').PermissionMode;
  stream?: boolean;
  messageSource?: import('@agor/core/types').MessageSource;
  promptOrigin?: import('@agor/core/types').PromptOrigin;
};

export type SessionArchiveOptions = {
  /** Include branch-local spawned/forked descendants. Default: true. */
  includeChildren?: boolean;
  /** Follow outgoing `remote_create` relationships into other branches. Default: true. */
  includeRemoteChildren?: boolean;
  /** Plan and authorize only; change nothing. Default: false. */
  dryRun?: boolean;
};

/** Trusted reason assigned to the explicit roots of an archive transition. */
export type SessionArchiveInitiator = 'manual' | 'btw_completed' | 'branch_archived';

export type SessionArchiveSkipReason = 'insufficient_permission' | 'not_found' | 'conflict';

export type SessionArchiveUnitResult =
  | {
      /** The unit's anchor: an explicit root, or the relationship target of a remote unit. */
      rootSessionId: SessionID;
      kind: 'local' | 'remote';
      status: 'changed' | 'unchanged';
      changedCount: number;
      /** Present only for units the caller is authorized for. */
      branchId: BranchID;
    }
  | {
      /** Already visible to the caller: a selected root or a relationship target. */
      rootSessionId: SessionID;
      kind: 'local' | 'remote';
      status: 'skipped';
      changedCount: 0;
      reason: SessionArchiveSkipReason;
    };

export type SessionArchiveRemainingReason =
  | 'independent_reason'
  | 'archived_ancestor'
  | 'archived_branch';

export type SessionArchiveLimit = 'remote_depth' | 'remote_branch_units' | 'remote_session_targets';

export type SessionArchiveResult = {
  session: Session;
  dryRun: boolean;
  /** Rows the plan would change. On execution this equals the attempted set. */
  wouldChangeCount: number;
  /** Sessions whose persisted state actually changed. Empty on a dry-run. */
  affectedSessions: Session[];
  /** @deprecated alias of `affectedSessions.length`. */
  count: number;
  /** On a dry-run these describe the plan; on execution, the committed rows. */
  archivedCount: number;
  unarchivedCount: number;
  localCount: number;
  remoteCount: number;
  skippedCount: number;
  /** Planned rows whose session is still executing (archive hides, never stops). */
  runningCount: number;
  units: SessionArchiveUnitResult[];
  /** Descendants left archived by an unarchive, with the blocker. */
  remainingArchived: Array<{ sessionId: SessionID; reason: SessionArchiveRemainingReason }>;
  /** Set on a dry-run whose remote expansion exceeded a named bound. */
  limitExceeded?: SessionArchiveLimit;
};

export type SessionBulkArchivePolicy = 'none' | 'eligible' | 'all';

export type SessionBulkArchiveOptions = {
  policy: SessionBulkArchivePolicy;
  /** Age cutoff the caller's filter used; `eligible` reuses it for descendants. */
  cutoffDate?: Date | null;
};

export type SessionBulkArchivePreview = {
  policy: SessionBulkArchivePolicy;
  directRoots: Session[];
  /** Descendants the policy includes. */
  impliedDescendants: Session[];
  /** Descendants `eligible` left out: newer than the cutoff or with unfinished tasks. */
  excludedDescendants: Session[];
  /** Descendants newer than the cutoff, whether included or excluded. */
  descendantsNewerThanCutoff: Session[];
  /** Descendants with a nonterminal task, whether included or excluded. */
  descendantsWithUnfinishedTasks: Session[];
  /** Included descendants whose session status is executing. */
  activeDescendants: Session[];
  units: SessionArchiveUnitResult[];
  wouldArchive: number;
};

/**
 * Extended sessions service with custom methods
 */
export class SessionsService extends DrizzleService<Session, SessionUpdate, SessionParams> {
  private sessionRepo: SessionRepository;
  private app: Application;
  private sessionMCPRepo: SessionMCPServerRepository;
  private sessionRelationshipRepo: SessionRelationshipRepository;
  private sessionEnvSelectionRepo: SessionEnvSelectionRepository;
  private usersRepo: UsersRepository;
  private branchRepo: BranchRepository;
  private taskRepo: TaskRepository;
  private db: TenantScopeAwareDatabase;
  private deploymentAvailable: (tool: AgenticToolName) => boolean;

  private assertDeploymentToolConfigured(tool: AgenticToolName): void {
    if (this.deploymentAvailable(tool)) return;
    throw new BadRequest(deploymentAgenticToolUnavailableMessage(tool));
  }

  private assertSupportedModelConfig(
    agenticTool: Session['agentic_tool'],
    modelConfig: Session['model_config'] | undefined
  ): void {
    if (agenticTool !== 'codex' || !modelConfig) return;
    const modelError = getCodexModelSelectionError(modelConfig);
    if (modelError) throw new BadRequest(modelError);
  }

  private async resolveDirectCreateModelFallback(
    agenticTool: AgenticToolName,
    data: CreateSessionInput,
    params?: SessionParams
  ) {
    const policy = getAgenticToolModelConfiguration(agenticTool);
    if (
      !policy?.modelCatalogService ||
      !policy.resolveCatalogFallback ||
      !params?.user ||
      data.created_by !== params.user.user_id
    ) {
      return undefined;
    }
    const app = this.app as unknown as {
      service(path: string): { find(params?: SessionParams): Promise<unknown> };
    };
    const catalog = await app.service(policy.modelCatalogService).find(params);
    return policy.resolveCatalogFallback(catalog);
  }

  constructor(
    db: TenantScopeAwareDatabase,
    app: Application,
    deploymentAvailable: (tool: AgenticToolName) => boolean = () => true
  ) {
    const sessionRepo = new SessionRepository(db);
    super(sessionRepo, {
      id: 'session_id',
      resourceType: 'Session',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
      multi: ['patch', 'remove'], // Allow multi-patch and multi-remove
    });

    this.sessionRepo = sessionRepo;
    this.db = db;
    this.deploymentAvailable = deploymentAvailable;
    this.app = app;
    // Custom service-to-service methods such as setMCPServers() can run with
    // tenant identity but without a request-scoped database transaction. Bind
    // this repository to short per-method units so those paths remain RLS-safe
    // without extending a transaction across session/provider orchestration.
    this.sessionMCPRepo = bindRepositoryToTenantUnitOfWork(db, new SessionMCPServerRepository(db));
    this.sessionRelationshipRepo = new SessionRelationshipRepository(db);
    this.sessionEnvSelectionRepo = new SessionEnvSelectionRepository(db);
    this.branchRepo = new BranchRepository(db);
    // Used by resolveChildIdentity to stamp unix_username on fork/spawn children
    // without going through app.service('users') — matches the convention used
    // by scheduler.ts / gateway.ts / terminals.ts.
    this.usersRepo = new UsersRepository(db);
    this.taskRepo = new TaskRepository(db);
  }

  /**
   * `agentic_tool` picks the SDK a session's tasks are executed with — it
   * can't change mid-session once a task exists (the messages/tasks already
   * on the session were produced by a specific tool's SDK). The UI only
   * offers "Switch tool" while `session.tasks.length === 0`, but that's a
   * client-side convenience, not a security boundary: any other caller of
   * `sessions.patch` (a stale tab, the MCP session-update tool, CLI) could
   * otherwise desync `agentic_tool` from the tool that actually produced a
   * session's existing tasks/messages. Enforce it here so the constraint
   * holds regardless of caller.
   */
  private async assertAgenticToolMutable(
    sessionId: string,
    nextTool: AgenticToolName
  ): Promise<void> {
    if (nextTool === undefined) return;

    const existing = await this.sessionRepo.findById(sessionId);
    if (!existing || existing.agentic_tool === nextTool) return;
    requireActiveAgenticTool(existing.agentic_tool);

    // A branch-scoped session cannot be switched to a tool whose native state
    // cannot honor the branch-state/caller-credential split. Enforce this at
    // the mutation boundary rather than waiting for a confusing launch-time
    // refusal.
    if (existing.sdk_home_scope === 'branch') {
      const unsupportedReason = branchSdkHomeUnsupportedReason(nextTool);
      if (unsupportedReason) {
        throw new BadRequest(
          `${nextTool} cannot use this session's branch SDK home because ${unsupportedReason}.`
        );
      }
    }

    const taskCount = await this.taskRepo.countBySession(sessionId);
    if (taskCount > 0) {
      // Conflict (409), not Forbidden (403): nothing about the caller's identity
      // is at issue — the session's *state* forbids the change. Matches the
      // sibling `_swapReplace` guard in `remove`.
      throw new Conflict(
        `Cannot change agentic_tool on session ${sessionId}: it already has ${taskCount} task(s). ` +
          "The tool that produced a session's existing tasks/messages cannot be changed after the fact."
      );
    }
  }

  async create(data: CreateSessionInput, params?: SessionParams): Promise<Session>;
  async create(
    data: Partial<Session> | Partial<Session>[],
    params?: SessionParams
  ): Promise<Session | Session[]>;
  async create(
    data: CreateSessionInput | Partial<Session> | Partial<Session>[],
    params?: SessionParams
  ): Promise<Session | Session[]> {
    if (Array.isArray(data)) {
      return Promise.all(data.map((session) => this.create(session, params) as Promise<Session>));
    }
    if (!data || typeof data !== 'object') {
      throw new BadRequest('Session data must be an object');
    }
    if (Object.hasOwn(data, 'sdk_home_scope')) {
      throw new BadRequest('sdk_home_scope is server-managed and cannot be set by clients');
    }
    const explicitMcpServerIds = normalizeCreateMcpServerIds(
      (data as { mcpServerIds?: unknown }).mcpServerIds
    );
    const agenticTool = requireActiveAgenticTool(data.agentic_tool ?? 'claude-code');
    this.assertDeploymentToolConfigured(agenticTool);
    if (!(await isTenantAgenticToolEnabled(agenticTool, this.db))) {
      throw new BadRequest(`${agenticTool} is disabled for this workspace`);
    }
    const {
      agentic_tool_preset_id: configurationReference,
      model_config: originalModelConfig,
      mcpServerIds: _requestedMcpServerIds,
      ...sessionData
    } = data as CreateSessionInput;
    let createData: Partial<Session> = { ...sessionData };
    if (params?._agenticConfigResolved) {
      createData = {
        ...createData,
        agentic_tool_preset_id: resolvedSessionPresetId(configurationReference),
        model_config: resolvedSessionModelConfig(originalModelConfig),
      };
    } else {
      const source = configurationReference
        ? ({ reference: configurationReference } as const)
        : data.model_config != null || data.permission_config != null
          ? sessionConfigurationSource(data)
          : ({ reference: USER_DEFAULT_AGENTIC_CONFIGURATION } as const);
      let materialized: MaterializedAgenticToolConfiguration;
      try {
        materialized = await materializeAgenticToolConfiguration(this.db, {
          tool: agenticTool,
          source,
          executionOwnerId: data.created_by as import('@agor/core/types').UserID | undefined,
        });
      } catch (error) {
        const shouldUseCatalogFallback =
          isInvalidModelConfigError(error) &&
          (!configurationReference ||
            isAgenticToolDefaultConfigurationReference(configurationReference));
        if (!shouldUseCatalogFallback) {
          throw error;
        }
        const modelFallback = await this.resolveDirectCreateModelFallback(
          agenticTool,
          data as CreateSessionInput,
          params
        );
        materialized = await materializeAgenticToolConfiguration(this.db, {
          tool: agenticTool,
          source,
          executionOwnerId: data.created_by as import('@agor/core/types').UserID | undefined,
          modelFallback,
        });
      }
      createData = {
        ...createData,
        agentic_tool_preset_id: materialized.agentic_tool_preset_id,
        permission_config: materialized.permission_config,
        model_config: materialized.model_config,
      };
    }
    const modelPolicy = getAgenticToolModelConfiguration(agenticTool);
    if (
      modelPolicy?.isResolved &&
      !isResolvedAgenticToolModelConfiguration(agenticTool, createData.model_config)
    ) {
      throw new BadRequest(modelPolicy.missingSelectionError ?? 'model_config is not resolved');
    }
    if (createData.model_config != null && !createData.model_config.updated_at) {
      throw new BadRequest('model_config must be resolved before session creation');
    }
    this.assertSupportedModelConfig(agenticTool, createData.model_config);
    if (!createData.branch_id) {
      throw new BadRequest('Session must have a branch_id');
    }

    // Session scope, branch adoption, and the row itself form one metadata
    // decision. This prevents a crash from leaving an adopted branch without
    // the session that caused adoption (or the inverse). The live deployment
    // flag is consulted only here; executor startup reads the immutable stamp.
    const tenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();
    const created = await runWithTenantDatabaseTransaction(this.db, tenantId, async (scoped) => {
      const branchRepo = new BranchRepository(scoped);
      const branch = await branchRepo.findById(createData.branch_id as BranchID);
      if (!branch) throw new NotFound(`Branch ${createData.branch_id} not found`);

      // Minimal service harnesses predate application configuration. Treat an
      // absent getter as the product default (`inherit`); production always
      // supplies the resolved application config.
      const config =
        typeof (this.app as { get?: unknown }).get === 'function'
          ? this.app.get('config')
          : ({} as import('@agor/core/config').AgorConfig);
      const sdkHomeConfig = resolveSdkHomeConfig(config);
      const admission = resolveNewSessionSdkHomeScope({
        branchSdkHomeIntent: branch.sdk_home ?? null,
        enabledForNewSessions: sdkHomeConfig.enabledForNewSessions,
        inheritedScope: params?._sdkHomeScope,
      });
      if (admission.scope === 'branch') {
        // Admission must reject credential/state combinations before it
        // performs the sticky branch transition. Otherwise a failed first
        // Codex-native Session would permanently adopt the branch even though
        // no usable branch-scoped conversation was created. Launch repeats
        // this actor-sensitive check because a later shared prompt may have a
        // different caller and therefore a different credential mode.
        const delegated = config.execution?.unix_user_mode === 'delegated';
        const unsupportedReason = await resolveBranchSdkHomeIncompatibility({
          tool: agenticTool,
          delegated,
          secureLocalCredentialOverlay: hasSecureLocalCredentialOverlay(config),
          userId: createData.created_by as UserID | undefined,
          db: scoped,
        });
        if (unsupportedReason) {
          throw new BadRequest(
            `${agenticTool} cannot use a branch SDK home because ${unsupportedReason}. ` +
              'Choose a supported tool or authentication mode.'
          );
        }
      }
      if (admission.adoptBranch) await branchRepo.adoptSdkHome(branch.branch_id);

      const createdSession = await new SessionRepository(scoped).create({
        ...createData,
        sdk_home_scope: admission.scope,
      });

      // Attach in-transaction: a bad server rolls the create back, not a silent drop (#2629).
      if (explicitMcpServerIds && explicitMcpServerIds.length > 0) {
        const mcpRepo = new SessionMCPServerRepository(scoped);
        try {
          for (const serverId of explicitMcpServerIds) {
            await mcpRepo.addServer(createdSession.session_id, serverId);
          }
        } catch (error) {
          if (error instanceof MCPServerNotUsableError) {
            throw new Forbidden('That MCP server is private to another user');
          }
          if (error instanceof EntityNotFoundError) {
            throw new NotFound('That MCP server was not found');
          }
          throw error;
        }
      }

      return createdSession;
    });
    if (Array.isArray(created)) {
      throw new Error('Single-session creation returned multiple sessions');
    }
    if (explicitMcpServerIds && explicitMcpServerIds.length > 0) {
      for (const serverId of explicitMcpServerIds) {
        emitServiceEvent(this.app, {
          path: 'session-mcp-servers',
          event: 'created',
          data: {
            session_id: created.session_id,
            mcp_server_id: serverId,
            enabled: true,
            added_at: new Date(),
          },
          params,
          id: created.session_id,
        });
      }
    }
    return created;
  }

  /** Re-resolve a live preset immediately before a task starts. */
  async materializeAgenticToolPreset(session: Session, _params?: SessionParams): Promise<Session> {
    const agenticTool = requireActiveAgenticTool(session.agentic_tool);
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new Error('Missing active tenant context for agentic tool preset materialization');
    }

    return runWithTenantDatabaseScope(this.db, tenantId, async (tenantDb) => {
      if (!session.agentic_tool_preset_id) {
        const policy = getAgenticToolModelConfiguration(agenticTool);
        if (
          policy?.isResolved &&
          !isResolvedAgenticToolModelConfiguration(agenticTool, session.model_config)
        ) {
          throw new BadRequest(policy.missingSelectionError ?? 'model_config is not resolved');
        }
        return session;
      }
      const materialized = await materializeAgenticToolConfiguration(tenantDb, {
        tool: agenticTool,
        source: { reference: session.agentic_tool_preset_id },
        executionOwnerId: session.created_by as import('@agor/core/types').UserID,
      });
      this.assertSupportedModelConfig(agenticTool, materialized.model_config);
      return this.sessionRepo.update(
        session.session_id,
        {
          permission_config: materialized.permission_config,
          model_config: materialized.model_config,
        },
        {
          replaceAgenticConfig: true,
        }
      );
    });
  }

  protected async fetchData(_query: Query, params?: SessionParams): Promise<Session[]> {
    const branchId =
      typeof _query.branch_id === 'string' ? (_query.branch_id as BranchID) : undefined;
    const branchIds =
      _query.branch_id &&
      typeof _query.branch_id === 'object' &&
      Array.isArray(_query.branch_id.$in) &&
      _query.branch_id.$in.every((value: unknown) => typeof value === 'string')
        ? (_query.branch_id.$in as BranchID[])
        : undefined;
    const archived = typeof _query.archived === 'boolean' ? _query.archived : undefined;
    return this.sessionRepo.findAll({
      visibleToUserId: params?._agorSqlSessionAccessUserId,
      branchId,
      branchIds,
      archived,
    });
  }

  async enrichRemoteRelationships(sessionList: Session[]): Promise<Session[]> {
    const sessionIds = sessionList.map((session) => session.session_id);
    if (sessionIds.length === 0) return sessionList;

    const relationships = await this.sessionRelationshipRepo.findForSessions(sessionIds);
    if (relationships.length === 0) return sessionList;

    const bySessionId = new Map<SessionID, NonNullable<Session['remote_relationships']>>();

    for (const relationship of relationships) {
      const sourceBucket =
        bySessionId.get(relationship.source_session_id) ??
        ({ as_source: [], as_target: [] } satisfies NonNullable<Session['remote_relationships']>);
      sourceBucket.as_source?.push(relationship);
      bySessionId.set(relationship.source_session_id, sourceBucket);

      const targetBucket =
        bySessionId.get(relationship.target_session_id) ??
        ({ as_source: [], as_target: [] } satisfies NonNullable<Session['remote_relationships']>);
      targetBucket.as_target?.push(relationship);
      bySessionId.set(relationship.target_session_id, targetBucket);
    }

    return sessionList.map((session) => {
      const remoteRelationships = bySessionId.get(session.session_id);
      if (!remoteRelationships) return session;
      return { ...session, remote_relationships: remoteRelationships };
    });
  }

  /**
   * Attach explicit MCP server IDs to a session.
   * Emits WebSocket events so the UI updates in real-time.
   */
  async setMCPServers(sessionId: SessionID, serverIds: string[], label: string): Promise<void> {
    for (const serverId of serverIds) {
      try {
        await this.sessionMCPRepo.addServer(sessionId, serverId as MCPServerID);
        emitServiceEvent(this.app, {
          path: 'session-mcp-servers',
          event: 'created',
          data: {
            session_id: sessionId,
            mcp_server_id: serverId,
            enabled: true,
            added_at: new Date(),
          },
        });
      } catch (error) {
        // Dropping one server rather than failing the whole session is the
        // established behaviour here, and the right one for inherited and
        // default selections. Say why, though: "skipped" alone cannot tell an
        // ownership refusal from a deleted row or a database fault, and the
        // first of those is the only one a user can act on.
        console.warn(
          `Skipped MCP server ${serverId} during ${label}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  /**
   * Copy MCP servers from a source session to a target session.
   * Emits WebSocket events so the UI updates in real-time.
   */
  private async copyMCPServers(
    sourceSessionId: SessionID,
    targetSessionId: SessionID,
    label: string
  ): Promise<void> {
    try {
      const parentServers = await this.sessionMCPRepo.listServers(sourceSessionId, true);
      for (const server of parentServers) {
        try {
          await this.sessionMCPRepo.addServer(targetSessionId, server.mcp_server_id as MCPServerID);
          // Emit WebSocket event for real-time UI updates
          emitServiceEvent(this.app, {
            path: 'session-mcp-servers',
            event: 'created',
            data: {
              session_id: targetSessionId,
              mcp_server_id: server.mcp_server_id,
              enabled: true,
              added_at: new Date(),
            },
          });
        } catch {
          // Silently skip — server may have been deleted between list and add
        }
      }
    } catch (error) {
      console.warn(`Failed to copy MCP servers during ${label}:`, error);
    }
  }

  /**
   * Resolve the `created_by` AND `unix_username` identity for a child session
   * being created via spawn / fork / btw. See {@link determineSpawnIdentity}
   * for the rules.
   *
   * Same-owner children stay with their owner. Cross-user children are allowed
   * only for shareable branch-home Sessions and are attributed to the caller.
   *
   * Internal calls (`params.provider == null`) preserve parent attribution —
   * they're service-to-service or scheduler-driven and have no human caller
   * to attribute. External calls (REST/socketio/MCP) must always be routed
   * through `determineSpawnIdentity`, which fails closed if the caller has
   * no `user_id`.
   *
   * `unix_username` is stamped explicitly here (not via a Feathers hook)
   * because fork()/spawn() call `this.create(...)` directly, which bypasses
   * the `before.create` hook pipeline — so `setSessionUnixUsername` never
   * fires for these paths. Omitting unix_username breaks delegated deployments where the launcher requires one.
   *
   * Resolution rules (kept aligned with the hook's behavior on normal creates):
   * - Internal call (no provider) → inherit parent.unix_username. The scheduler /
   *   service-to-service callers have no human caller to attribute to, and the
   *   parent's stamped value is the closest thing to ground truth.
   * - Branch-scoped sharing → load the prompt caller's current key.
   * - Otherwise (including the common same-user path) → load the attributed
   *   caller's CURRENT unix_username via {@link loadUnixUsernameForUser}. We
   *   do NOT inherit parent.unix_username on same-user forks, because the user's
   *   unix_username may have changed since the parent was created, and
   *   `validateSessionUnixUsername` would then reject every prompt on the child.
   */
  private async resolveChildIdentity(
    parent: Session,
    params?: SessionParams
  ): Promise<{ created_by: Session['created_by']; unix_username: Session['unix_username'] }> {
    // Internal call (no transport provider) → service-to-service or scheduler.
    // Preserve parent attribution. The delegated execution-home key
    // requirement still applies: an internal fork/spawn of a null-stamped
    // parent must fail here, not later at prompt time.
    if (!params?.provider) {
      const inheritedUnixUsername = parent.unix_username ?? null;
      if ((parent.sdk_home_scope ?? 'execution_home') === 'execution_home') {
        assertExecutionHomeKeySatisfiesMode(
          inheritedUnixUsername,
          resolveExecutionSecurityMode().unixUserMode,
          `the parent session's owner (${parent.created_by})`
        );
      }
      return { created_by: parent.created_by, unix_username: inheritedUnixUsername };
    }

    const caller = params.user;
    if (!caller) {
      // External call without an authenticated user should never reach here
      // (auth hooks run first), but fail closed defensively.
      throw new Forbidden('Cannot spawn/fork session without an authenticated caller identity.');
    }

    let sharing: { allow_caller_identity: boolean } | undefined;
    try {
      const wt = await this.app.service('branches').get(parent.branch_id, { provider: undefined });
      if (caller.user_id) {
        const authority = await this.branchRepo.resolveSessionPromptAuthority(
          (wt as Branch).branch_id,
          caller.user_id as UUID,
          parent.created_by as UUID,
          parent.sdk_home_scope
        );
        sharing = {
          allow_caller_identity: authority.source === 'branch_session',
        };
        if (!authority.allowed) {
          throw new Forbidden(sessionPromptDeniedMessage(authority));
        }
      }
    } catch (error) {
      if (error instanceof Forbidden) throw error;
      throw new Forbidden('Cannot resolve session-sharing authority for this branch.');
    }

    const result = determineSpawnIdentity(parent, caller, sharing);
    const createdBy = result.created_by as Session['created_by'];

    // Always resolve the attributed user's CURRENT execution-home key. A
    // branch-home child never borrows the parent owner's home, and same-user
    // forks must not inherit a stale key after an administrator changes it.
    let unixUsername: string | null;
    try {
      unixUsername = await loadUnixUsernameForUser(this.usersRepo, createdBy as string);
    } catch (err) {
      throw new Forbidden(
        `Cannot resolve unix_username for caller ${createdBy}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // In delegated mode, a child stamped null would fail at prompt time (or
    // silently share an identity in hosted deployments) — reject at fork/spawn
    // time with an actionable error instead.
    assertExecutionHomeKeySatisfiesMode(
      unixUsername,
      resolveExecutionSecurityMode().unixUserMode,
      `the attributed user (${createdBy})`
    );

    return { created_by: createdBy, unix_username: unixUsername };
  }

  /**
   * Custom method: Fork a session
   *
   * Creates a new session branching from the current session at a decision point.
   */
  async fork(
    id: string,
    data: { prompt: string; task_id?: string },
    params?: SessionParams
  ): Promise<Session> {
    const parent = await this.get(id, params);
    const parentTool = requireActiveAgenticTool(parent.agentic_tool);

    // Cross-user genealogy is allowed only for an explicitly shareable branch
    // Session and is attributed to the caller.
    const { created_by, unix_username } = await this.resolveChildIdentity(parent, params);
    const inherited = await materializeAgenticToolConfiguration(this.db, {
      tool: parentTool,
      source: parent.agentic_tool_preset_id
        ? { reference: parent.agentic_tool_preset_id }
        : sessionConfigurationSource(parent),
      executionOwnerId: created_by as import('@agor/core/types').UserID,
    });
    this.assertSupportedModelConfig(parentTool, inherited.model_config);

    const forkedSession = await this.create(
      {
        agentic_tool: parentTool,
        agentic_tool_preset_id: inherited.agentic_tool_preset_id,
        status: SessionStatus.IDLE,
        title: data.prompt.substring(0, 100), // First 100 chars as title
        description: data.prompt,
        branch_id: parent.branch_id,
        created_by, // See resolveChildIdentity — defaults to caller, not parent owner
        unix_username, // Stamped by resolveChildIdentity — this.create() bypasses
        // the setSessionUnixUsername hook so we must set it explicitly here.
        // Delegated deployments refuse to launch sessions with a null home key.
        genealogy: {
          forked_from_session_id: parent.session_id,
          fork_point_task_id: data.task_id as TaskID,
          fork_point_message_index: await this.sessionRepo.countMessages(parent.session_id),
          children: [],
        },
        contextFiles: [...(parent.contextFiles || [])],
        permission_config: inherited.permission_config,
        model_config: inherited.model_config,
        tasks: [],
        // Don't copy sdk_session_id - fork will get its own via forkSession:true
      },
      { ...params, _agenticConfigResolved: true, _sdkHomeScope: parent.sdk_home_scope }
    );

    // Cast forkedSession to Session to handle return type
    const session = forkedSession as Session;

    // Copy MCP servers from parent session to forked session
    await this.copyMCPServers(
      parent.session_id as SessionID,
      session.session_id as SessionID,
      'fork'
    );

    // Copy parent's env var *names* to forked session.
    // Names resolve at execution time against the child session's owner's
    // env vars (see env-var-access.md), so when a cross-user fork happens
    // these names are looked up under the caller's namespace, not the parent
    // owner's — no leakage of parent credentials into a fork the caller owns.
    const parentEnvSelections = await this.sessionEnvSelectionRepo.listNames(
      parent.session_id as SessionID
    );
    if (parentEnvSelections.length > 0) {
      await this.sessionEnvSelectionRepo.setAll(
        session.session_id as SessionID,
        parentEnvSelections
      );
    }

    // Update parent's children list
    const parentChildren = parent.genealogy?.children || [];
    await this.patch(
      id,
      {
        genealogy: {
          ...parent.genealogy,
          children: [...parentChildren, session.session_id],
        },
      },
      params
    );

    return session;
  }

  /** Spawn a child after atomically materializing its selected source for the child owner. */
  async spawn(
    id: string,
    data: Partial<import('@agor/core/types').SpawnConfig>,
    params?: SessionParams
  ): Promise<Session> {
    if (!data.prompt) {
      throw new Error('Spawn requires a prompt');
    }
    const parent = await this.get(id, params);
    requireActiveAgenticTool(parent.agentic_tool);
    const targetTool = requireActiveAgenticTool(data.agent || parent.agentic_tool);
    const hasAtomicOverride =
      data.permissionMode !== undefined ||
      data.modelConfig !== undefined ||
      data.codexSandboxMode !== undefined ||
      data.codexApprovalPolicy !== undefined ||
      data.codexNetworkAccess !== undefined;
    const inheritedPresetId =
      targetTool === parent.agentic_tool ? parent.agentic_tool_preset_id : undefined;
    const presetId = data.presetId ?? inheritedPresetId ?? undefined;
    if (presetId && hasAtomicOverride) {
      throw new BadRequest(
        'Preset-backed child sessions cannot override individual configuration fields'
      );
    }

    // Resolve identity first so per-tool defaults come from the resolved
    // child owner, not the parent owner. (For internal/provider-less calls,
    // `resolveChildIdentity` returns `parent.created_by` anyway.)
    const { created_by, unix_username } = await this.resolveChildIdentity(parent, params);

    // Preload the child owner when the app service is available; the shared
    // materializer can also resolve the owner directly from its scoped DB.
    let user: import('@agor/core/types').User | null = null;
    if (created_by && this.app) {
      try {
        user = (await this.app
          .service('users')
          .get(created_by, params)) as import('@agor/core/types').User;
      } catch (error) {
        console.warn(
          'Could not fetch user preferences for spawned session, using system defaults:',
          error
        );
      }
    }

    let resolved: MaterializedAgenticToolConfiguration;
    try {
      resolved = await materializeAgenticToolConfiguration(this.db, {
        tool: targetTool,
        source: presetId
          ? { reference: presetId }
          : hasAtomicOverride || targetTool === parent.agentic_tool
            ? {
                configuration: {
                  modelConfig: data.modelConfig,
                  permissionMode: data.permissionMode,
                  codexSandboxMode: data.codexSandboxMode,
                  codexApprovalPolicy: data.codexApprovalPolicy,
                  codexNetworkAccess: data.codexNetworkAccess,
                },
              }
            : { reference: USER_DEFAULT_AGENTIC_CONFIGURATION },
        executionOwnerId: created_by as import('@agor/core/types').UserID,
        ...(user ? { executionOwner: user } : {}),
        parent,
      });
    } catch (error) {
      if (isInvalidModelConfigError(error)) throw new BadRequest(error.message);
      throw error;
    }
    const permissionConfig = resolved.permission_config;
    const modelConfig = resolved.model_config;

    // Soft validation: warn (don't block) when the resolved model looks like
    // it belongs to a different tool. Custom model strings are accepted.
    const lintWarning = formatModelToolMismatchWarning(
      lintModelToolMatch(modelConfig?.model, targetTool)
    );
    if (lintWarning) {
      console.warn(`[SessionsService.spawn] ${lintWarning}`);
    }

    this.assertSupportedModelConfig(targetTool, modelConfig);

    // callback_session_id is the single source of truth for where to deliver
    // callbacks. Default to parent session when callbacks are enabled (which
    // is the default for spawn).
    const isCallbackEnabled = data.enableCallback !== false;
    const callbackConfig = {
      ...(data.enableCallback !== undefined ? { enabled: data.enableCallback } : {}),
      ...(isCallbackEnabled
        ? { callback_session_id: parent.session_id, callback_created_by: parent.created_by }
        : {}),
      ...(data.includeLastMessage !== undefined
        ? { include_last_message: data.includeLastMessage }
        : {}),
      ...(data.includeOriginalPrompt !== undefined
        ? { include_original_prompt: data.includeOriginalPrompt }
        : {}),
      callback_mode: data.callbackMode ?? 'once',
    };

    let finalPrompt = data.prompt;
    if (data.extraInstructions) {
      finalPrompt = `${data.prompt}\n\n${data.extraInstructions}`;
    }

    const spawnedSession = await this.create(
      {
        agentic_tool: targetTool,
        agentic_tool_preset_id: resolved.agentic_tool_preset_id,
        status: SessionStatus.IDLE,
        title: data.title || data.prompt.substring(0, 100), // Use provided title or first 100 chars
        description: finalPrompt, // Use final prompt with extra instructions if provided
        branch_id: parent.branch_id,
        created_by, // See resolveChildIdentity — defaults to caller, not parent owner
        unix_username, // Stamped by resolveChildIdentity — this.create() bypasses
        // the setSessionUnixUsername hook so we must set it explicitly here.
        // Delegated deployments refuse to launch sessions with a null home key.
        genealogy: {
          parent_session_id: parent.session_id,
          spawn_point_task_id: data.task_id as TaskID,
          spawn_point_message_index: await this.sessionRepo.countMessages(parent.session_id),
          children: [],
        },
        contextFiles: [...(parent.contextFiles || [])],
        tasks: [],
        permission_config: permissionConfig,
        model_config: modelConfig,
        callback_config: callbackConfig,
        // Don't copy sdk_session_id - spawn will get its own via forkSession:true
      },
      { ...params, _agenticConfigResolved: true, _sdkHomeScope: parent.sdk_home_scope }
    );

    // Cast spawnedSession to Session to handle return type (create returns Session | Session[])
    const session = spawnedSession as Session;

    // MCP servers: explicit mcpServerIds > copy from parent
    // An explicit empty array means "no MCPs" — does NOT fall through to parent.
    if (data.mcpServerIds !== undefined) {
      await this.setMCPServers(session.session_id as SessionID, data.mcpServerIds, 'spawn');
    } else {
      await this.copyMCPServers(
        parent.session_id as SessionID,
        session.session_id as SessionID,
        'spawn'
      );
    }

    // An explicit caller selection wins; otherwise continue the parent's
    // selected names. Values resolve for each Task's creator in the executor.
    const callerUserId = params?.user?.user_id as string | undefined;

    if (data.envVarNames !== undefined && callerUserId) {
      await this.sessionEnvSelectionRepo.setAll(session.session_id as SessionID, data.envVarNames);
    } else {
      const parentNames = await this.sessionEnvSelectionRepo.listNames(
        parent.session_id as SessionID
      );
      if (parentNames.length > 0) {
        await this.sessionEnvSelectionRepo.setAll(session.session_id as SessionID, parentNames);
      }
    }

    // Update parent's children list
    const parentChildren = parent.genealogy?.children || [];
    await this.patch(
      id,
      {
        genealogy: {
          ...parent.genealogy,
          children: [...parentChildren, session.session_id],
        },
      },
      params
    );

    return session;
  }

  /**
   * Custom method: Execute a prompt on this session
   *
   * Spawns an executor subprocess to run the prompt against the session.
   * The executor connects back to daemon via Feathers/WebSocket.
   *
   * NOTE: The actual implementation is provided by index.ts via setExecuteHandler
   */
  private executeHandler?: (
    sessionId: string,
    data: ExecuteTaskData,
    params?: SessionParams
  ) => Promise<{
    success: boolean;
    taskId: string;
    status: string;
    streaming: boolean;
  }>;

  setExecuteHandler(
    handler: (
      sessionId: string,
      data: ExecuteTaskData,
      params?: SessionParams
    ) => Promise<{
      success: boolean;
      taskId: string;
      status: string;
      streaming: boolean;
    }>
  ): void {
    this.executeHandler = handler;
  }

  async executeTask(
    id: string,
    data: ExecuteTaskData,
    params?: SessionParams
  ): Promise<{
    success: boolean;
    taskId: string;
    status: string;
    streaming: boolean;
  }> {
    if (this.executeHandler) {
      return this.executeHandler(id, data, params);
    }
    throw new Error('Execute handler not set - cannot execute task');
  }

  /**
   * Custom method: Trigger queue processing
   *
   * Drains the next queued task for an idle session.
   * Used by callback system to trigger immediate queue processing.
   *
   * NOTE: The actual implementation is provided by index.ts via setQueueProcessor
   */
  private queueProcessor?: (sessionId: string, params?: SessionParams) => Promise<void>;

  setQueueProcessor(processor: (sessionId: string, params?: SessionParams) => Promise<void>): void {
    this.queueProcessor = processor;
  }

  async triggerQueueProcessing(id: string, params?: SessionParams): Promise<void> {
    if (this.queueProcessor) {
      await this.queueProcessor(id, params);
    } else {
      console.warn('⚠️  [SessionsService] Queue processor not set, cannot trigger queue processing');
    }
  }

  /**
   * Custom method: Get session genealogy tree
   *
   * Returns ancestors and descendants for visualization.
   */
  async getGenealogy(
    id: string,
    params?: SessionParams
  ): Promise<{
    session: Session;
    ancestors: Session[];
    children: Session[];
  }> {
    const session = await this.get(id, params);

    // Get ancestors
    const ancestors = await this.sessionRepo.findAncestors(id);

    // Get children
    const children = await this.sessionRepo.findChildren(id);

    return {
      session,
      ancestors,
      children,
    };
  }

  // ===========================================================================
  // Session archive engine
  //
  // One planner decides the affected set for every archive entry point
  // (dedicated REST/MCP, bulk, BTW cleanup, prompt restore, branch archive),
  // then one apply phase writes each unit atomically and emits one event per
  // changed row. See context/explorations/session-archive-cascade.md.
  // ===========================================================================

  private async loadArchiveBranchGraph(
    graphs: Map<string, ArchiveBranchGraph>,
    branchId: BranchID,
    sessionRepo = this.sessionRepo
  ): Promise<ArchiveBranchGraph> {
    const cached = graphs.get(branchId);
    if (cached) return cached;
    const rows = await sessionRepo.findAll({ branchId });
    const byId = new Map<string, Session>();
    const childrenOf = new Map<string, Session[]>();
    for (const session of rows) {
      byId.set(session.session_id, session);
      for (const parentId of localParentIds(session)) {
        const siblings = childrenOf.get(parentId) ?? [];
        siblings.push(session);
        childrenOf.set(parentId, siblings);
      }
    }
    const graph = { branchId, byId, childrenOf };
    graphs.set(branchId, graph);
    return graph;
  }

  /** Breadth-first branch-local descendants; parents always precede children. */
  private collectLocalDescendants(graph: ArchiveBranchGraph, rootId: string): Session[] {
    const descendants: Session[] = [];
    const visited = new Set<string>([rootId]);
    const queue = [...(graph.childrenOf.get(rootId) ?? [])];
    for (let index = 0; index < queue.length; index += 1) {
      const child = queue[index];
      if (!child || visited.has(child.session_id)) continue;
      visited.add(child.session_id);
      descendants.push(child);
      queue.push(...(graph.childrenOf.get(child.session_id) ?? []));
    }
    return descendants;
  }

  private async loadArchiveBranch(
    cache: Map<string, Branch | null>,
    branchId: BranchID,
    branchRepo = this.branchRepo
  ): Promise<Branch | null> {
    if (cache.has(branchId)) return cache.get(branchId) ?? null;
    const branch = await branchRepo.findById(branchId);
    cache.set(branchId, branch);
    return branch;
  }

  private async archiveUnitDenial(
    members: Session[],
    archived: boolean,
    params: SessionParams | undefined,
    branchCache: Map<string, Branch | null>,
    branchRepo = this.branchRepo
  ): Promise<Forbidden | null> {
    try {
      await this.assertCanArchiveSessions(members, archived, params, branchCache, branchRepo);
      return null;
    } catch (error) {
      if (error instanceof Forbidden) return error;
      throw error;
    }
  }

  private async planArchiveTransition(
    request: ArchiveTransitionRequest
  ): Promise<ArchiveTransitionPlan> {
    const graphs = new Map<string, ArchiveBranchGraph>();
    const branchCache = new Map<string, Branch | null>();
    const authorized: ArchiveUnit[] = [];
    const unitResults: SessionArchiveUnitResult[] = [];
    const excludedImplied: ArchiveExcludedImplied[] = [];
    const excludedClosureIndexes = new Map<string, Set<number>>();

    const skipUnit = (
      unit: Pick<ArchiveUnit, 'kind'>,
      anchorIds: Iterable<string>,
      reason: SessionArchiveSkipReason
    ) => {
      for (const anchorId of anchorIds) {
        unitResults.push({
          rootSessionId: anchorId as SessionID,
          kind: unit.kind,
          status: 'skipped',
          changedCount: 0,
          reason,
        });
      }
    };

    // 1. Local closures: every root plus (optionally) its branch-local descendants.
    const closures: Array<{ root: Session; members: Session[] }> = [];
    for (const requested of request.roots) {
      const graph = await this.loadArchiveBranchGraph(graphs, requested.branch_id);
      const root = graph.byId.get(requested.session_id) ?? requested;
      const descendants = request.includeChildren
        ? this.collectLocalDescendants(graph, root.session_id)
        : [];
      closures.push({ root, members: [root, ...descendants] });
    }

    // 2. Optional eligibility narrows implied descendants only; roots always stay.
    if (request.descendantEligibility) {
      const rootIds = new Set(closures.map(({ root }) => root.session_id));
      const candidates = new Map<string, Session>();
      for (const { members } of closures) {
        for (const member of members) {
          if (!rootIds.has(member.session_id)) candidates.set(member.session_id, member);
        }
      }
      const eligible = await request.descendantEligibility([...candidates.values()]);
      for (const [id, session] of candidates) {
        if (!eligible.has(id)) excludedImplied.push({ session, unitKeys: new Set() });
      }
      closures.forEach((closure, index) => {
        for (const member of closure.members) {
          if (rootIds.has(member.session_id) || eligible.has(member.session_id)) continue;
          const indexes = excludedClosureIndexes.get(member.session_id) ?? new Set<number>();
          indexes.add(index);
          excludedClosureIndexes.set(member.session_id, indexes);
        }
        closure.members = closure.members.filter(
          (member) => rootIds.has(member.session_id) || eligible.has(member.session_id)
        );
      });
    }

    // 3. Group closures into local authorization units. Direct roots win over
    //    implied membership when closures overlap.
    const localUnits = new Map<string, ArchiveUnit>();
    const unitKeyByClosure = new Map<number, string>();
    const closureUnitIndex = new Map<number, number>();
    if (request.grouping === 'root-tree') {
      // Union-find over closures that share a session so overlapping trees
      // authorize and write as one unit.
      const parent = closures.map((_, index) => index);
      const find = (index: number): number => {
        let current = index;
        while (parent[current] !== current) current = parent[current] as number;
        return current;
      };
      const owner = new Map<string, number>();
      closures.forEach(({ members }, index) => {
        for (const member of members) {
          const existing = owner.get(member.session_id);
          if (existing === undefined) {
            owner.set(member.session_id, index);
            continue;
          }
          const a = find(existing);
          const b = find(index);
          if (a !== b) parent[b] = a;
        }
      });
      for (let index = 0; index < closures.length; index += 1) {
        closureUnitIndex.set(index, find(index));
      }
    } else {
      for (let index = 0; index < closures.length; index += 1) {
        closureUnitIndex.set(index, index);
      }
    }
    closures.forEach(({ root, members }, index) => {
      const representative = closures[closureUnitIndex.get(index) ?? index]?.root ?? root;
      const key =
        request.grouping === 'branch'
          ? `local:${root.branch_id}`
          : `tree:${representative.session_id}`;
      unitKeyByClosure.set(index, key);
      let unit = localUnits.get(key);
      if (!unit) {
        unit = {
          key,
          branchId: root.branch_id,
          kind: 'local',
          rootIds: new Set(),
          members: new Map(),
        };
        localUnits.set(key, unit);
      }
      for (const member of members) {
        if (!unit.members.has(member.session_id)) unit.members.set(member.session_id, member);
      }
      unit.rootIds.add(root.session_id);
    });
    for (const excluded of excludedImplied) {
      for (const index of excludedClosureIndexes.get(excluded.session.session_id) ?? []) {
        const unitKey = unitKeyByClosure.get(index);
        if (unitKey) excluded.unitKeys.add(unitKey);
      }
    }

    // 4. Authorize local units before any traversal leaves them.
    for (const unit of localUnits.values()) {
      const denial = await this.archiveUnitDenial(
        [...unit.members.values()],
        request.archived,
        request.params,
        branchCache
      );
      if (!denial) {
        authorized.push(unit);
        continue;
      }
      if (request.localFailure === 'throw') throw denial;
      skipUnit(unit, unit.rootIds, 'insufficient_permission');
    }

    // 5. Remote units: follow outgoing `remote_create` edges from authorized
    //    members only, one authorization unit per canonical target branch,
    //    within the named depth / branch / target bounds.
    let limitExceeded: SessionArchiveLimit | undefined;
    if (request.includeRemoteChildren) {
      try {
        await this.expandRemoteArchiveUnits(request, authorized, graphs, branchCache, skipUnit);
      } catch (error) {
        if (!(error instanceof ArchiveLimitExceededError)) throw error;
        if (!request.tolerateLimits) throw new BadRequest(error.message);
        limitExceeded = error.limit;
        // Report the overflow instead of a partial plan: drop remote units.
        for (let index = authorized.length - 1; index >= 0; index -= 1) {
          if (authorized[index]?.kind === 'remote') authorized.splice(index, 1);
        }
      }
    }

    const authorizedUnitKeys = new Set(authorized.map((unit) => unit.key));
    const plan: ArchiveTransitionPlan = {
      archived: request.archived,
      localFailure: request.localFailure,
      units: authorized,
      unitResults,
      targets: [],
      remainingArchived: [],
      excludedImplied: excludedImplied.flatMap((excluded) => {
        const unitKeys = new Set(
          [...excluded.unitKeys].filter((unitKey) => authorizedUnitKeys.has(unitKey))
        );
        return unitKeys.size > 0 ? [{ ...excluded, unitKeys }] : [];
      }),
      ...(limitExceeded && { limitExceeded }),
    };
    if (request.archived) {
      this.planArchiveTargets(plan, request.initiator);
    } else {
      await this.planRestoreTargets(plan, graphs, branchCache);
    }
    return plan;
  }

  private async expandRemoteArchiveUnits(
    request: ArchiveTransitionRequest,
    authorized: ArchiveUnit[],
    graphs: Map<string, ArchiveBranchGraph>,
    branchCache: Map<string, Branch | null>,
    skipUnit: (
      unit: Pick<ArchiveUnit, 'kind'>,
      anchorIds: Iterable<string>,
      reason: SessionArchiveSkipReason
    ) => void
  ): Promise<void> {
    const visited = new Set<string>();
    for (const unit of authorized) for (const id of unit.members.keys()) visited.add(id);
    let frontier = [...visited];
    let depth = 0;
    let remoteUnitCount = 0;
    let remoteTargetCount = 0;
    while (frontier.length > 0) {
      const edges = await this.sessionRelationshipRepo.findRemoteChildrenForSources(
        frontier as SessionID[]
      );
      const targetIds = [...new Set(edges.map((edge) => edge.target_session_id))].filter(
        (id) => !visited.has(id)
      );
      if (targetIds.length === 0) break;
      const targets = await this.sessionRepo.findByIds(targetIds);
      const targetsByBranch = new Map<BranchID, Session[]>();
      for (const target of targets) {
        visited.add(target.session_id);
        const bucket = targetsByBranch.get(target.branch_id) ?? [];
        bucket.push(target);
        targetsByBranch.set(target.branch_id, bucket);
      }
      const nextFrontier: string[] = [];
      const authorizedTargetsByBranch = new Map<BranchID, Session[]>();
      for (const [branchId, branchTargets] of targetsByBranch) {
        // Authorize the visible relationship targets before loading any other
        // sessions from their branch. Session-tier access is checked again for
        // the complete unit after descendant discovery.
        const rootDenial = await this.archiveUnitDenial(
          branchTargets,
          request.archived,
          request.params,
          branchCache
        );
        if (rootDenial) {
          skipUnit(
            { kind: 'remote' },
            branchTargets.map((target) => target.session_id),
            'insufficient_permission'
          );
          continue;
        }
        authorizedTargetsByBranch.set(branchId, branchTargets);
      }
      if (authorizedTargetsByBranch.size === 0) break;
      depth += 1;
      if (depth > MAX_ARCHIVE_REMOTE_DEPTH) throw new ArchiveLimitExceededError('remote_depth');
      for (const [branchId, branchTargets] of authorizedTargetsByBranch) {
        const members: Session[] = [...branchTargets];
        if (request.includeChildren) {
          const graph = await this.loadArchiveBranchGraph(graphs, branchId);
          for (const target of branchTargets) {
            for (const descendant of this.collectLocalDescendants(graph, target.session_id)) {
              if (visited.has(descendant.session_id)) continue;
              visited.add(descendant.session_id);
              members.push(descendant);
            }
          }
          const denial = await this.archiveUnitDenial(
            members,
            request.archived,
            request.params,
            branchCache
          );
          if (denial) {
            skipUnit(
              { kind: 'remote' },
              branchTargets.map((target) => target.session_id),
              'insufficient_permission'
            );
            continue;
          }
        }
        remoteTargetCount += members.length;
        if (remoteTargetCount > MAX_ARCHIVE_REMOTE_SESSION_TARGETS) {
          throw new ArchiveLimitExceededError('remote_session_targets');
        }
        const existing = authorized.find((unit) => unit.branchId === branchId);
        let unit = existing;
        if (!unit) {
          remoteUnitCount += 1;
          if (remoteUnitCount > MAX_ARCHIVE_REMOTE_BRANCH_UNITS) {
            throw new ArchiveLimitExceededError('remote_branch_units');
          }
          unit = {
            key: `remote:${branchId}`,
            branchId,
            kind: 'remote',
            rootIds: new Set(),
            members: new Map(),
          };
          authorized.push(unit);
        }
        for (const target of branchTargets) {
          if (unit.kind === 'remote') unit.rootIds.add(target.session_id);
        }
        for (const member of members) {
          unit.members.set(member.session_id, member);
          nextFrontier.push(member.session_id);
        }
      }
      frontier = nextFrontier;
    }
  }

  private planArchiveTargets(plan: ArchiveTransitionPlan, initiator: SessionArchiveInitiator) {
    for (const unit of plan.units) {
      for (const [id, session] of unit.members) {
        if (unit.kind === 'local' && unit.rootIds.has(id)) {
          const reasonMatches = (session.archived_reason ?? null) === initiator;
          if (session.archived !== true || !reasonMatches) {
            plan.targets.push({
              session,
              archived: true,
              archivedReason: initiator,
              selection: 'direct',
              unitKey: unit.key,
            });
          }
          continue;
        }
        if (session.archived) continue;
        plan.targets.push({
          session,
          archived: true,
          archivedReason: PARENT_ARCHIVED_REASON,
          selection: 'implied',
          unitKey: unit.key,
        });
      }
    }
  }

  /**
   * Restoration is cause-aware. One activation predicate covers local and
   * remote rows: a session may activate when its branch is active and it is
   * either an explicit root or none of its incoming parent sources (local
   * genealogy or remote creator) remains archived after the transition.
   * An explicit root never overrides an archived branch; that is a conflict.
   */
  private async planRestoreTargets(
    plan: ArchiveTransitionPlan,
    graphs: Map<string, ArchiveBranchGraph>,
    branchCache: Map<string, Branch | null>,
    sessionRepo = this.sessionRepo,
    relationshipRepo = this.sessionRelationshipRepo,
    branchRepo = this.branchRepo,
    applicableRestoreIds?: ReadonlySet<string>
  ): Promise<void> {
    const plannedActive = new Set<string>();
    const blockedRestoreCandidates = new Set<string>();
    const impliedIds: SessionID[] = [];
    for (const unit of plan.units) {
      for (const [id, session] of unit.members) {
        const isExplicitRoot = unit.kind === 'local' && unit.rootIds.has(id);
        if (!isExplicitRoot) impliedIds.push(id as SessionID);
        if (isExplicitRoot) {
          const branch = await this.loadArchiveBranch(branchCache, session.branch_id, branchRepo);
          if (branch?.archived) {
            throw new Conflict(
              `Session ${shortId(session.session_id)} belongs to an archived branch. Restore the branch first.`
            );
          }
        }
        if (session.archived && applicableRestoreIds?.has(id) === false) {
          blockedRestoreCandidates.add(id);
          continue;
        }
        if (!isExplicitRoot) continue;
        plannedActive.add(id);
        if (session.archived) {
          plan.targets.push({
            session,
            archived: false,
            archivedReason: null,
            selection: 'direct',
            unitKey: unit.key,
          });
        }
      }
    }

    const incoming = await relationshipRepo.findRemoteParentsForTargets(impliedIds);
    const remoteSourcesOf = new Map<string, string[]>();
    for (const edge of incoming) {
      const sources = remoteSourcesOf.get(edge.target_session_id) ?? [];
      sources.push(edge.source_session_id);
      remoteSourcesOf.set(edge.target_session_id, sources);
    }
    const lookupSession = (id: string): Session | undefined => {
      for (const graph of graphs.values()) {
        const found = graph.byId.get(id);
        if (found) return found;
      }
      return undefined;
    };
    const unknownSourceIds = [...new Set(incoming.map((edge) => edge.source_session_id))].filter(
      (id) => !lookupSession(id)
    );
    const externalSources = new Map<string, Session>(
      (await sessionRepo.findByIds(unknownSourceIds)).map((session) => [
        session.session_id as string,
        session,
      ])
    );

    // Units and members are in discovery order, so every parent source is
    // decided before the rows it covers.
    for (const unit of plan.units) {
      for (const [id, session] of unit.members) {
        if (plannedActive.has(id) || !session.archived) continue;
        if (blockedRestoreCandidates.has(id)) {
          plan.remainingArchived.push({
            sessionId: id as SessionID,
            reason:
              session.archived_reason === PARENT_ARCHIVED_REASON
                ? 'archived_ancestor'
                : 'independent_reason',
          });
          continue;
        }
        if (session.archived_reason !== PARENT_ARCHIVED_REASON) {
          plan.remainingArchived.push({ sessionId: id as SessionID, reason: 'independent_reason' });
          continue;
        }
        const branch = await this.loadArchiveBranch(branchCache, session.branch_id, branchRepo);
        if (branch?.archived) {
          plan.remainingArchived.push({ sessionId: id as SessionID, reason: 'archived_branch' });
          continue;
        }
        const parentIds = [...localParentIds(session), ...(remoteSourcesOf.get(id) ?? [])];
        const blocked = parentIds.some((parentId) => {
          if (plannedActive.has(parentId)) return false;
          const parent = lookupSession(parentId) ?? externalSources.get(parentId);
          return parent === undefined || parent.archived === true;
        });
        if (blocked) {
          plan.remainingArchived.push({ sessionId: id as SessionID, reason: 'archived_ancestor' });
          continue;
        }
        plan.targets.push({
          session,
          archived: false,
          archivedReason: null,
          selection: 'implied',
          unitKey: unit.key,
        });
        plannedActive.add(id);
      }
    }
  }

  /**
   * Apply one unit at a time. The repository re-reads current state inside its
   * transaction and skips rows that already match, so a concurrent identical
   * transition is a no-op and emits nothing.
   */
  private async applyArchiveTransitionPlan(
    plan: ArchiveTransitionPlan,
    params?: SessionParams
  ): Promise<Session[]> {
    const changed: Session[] = [];
    const skippedUnitKeys = new Set<string>();
    const skippedMemberIds = new Set<string>();
    const tenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();
    for (const unit of plan.units) {
      const unitTargets = plan.targets.filter((target) => target.unitKey === unit.key);
      if (unitTargets.length === 0) continue;
      const unitOutcome = await runWithTenantDatabaseTransaction(
        this.db,
        tenantId,
        async (operationDb) => {
          const currentParams = await this.currentArchiveParams(operationDb, params);
          const sessionRepo = new SessionRepository(operationDb);
          const branchRepo = new BranchRepository(operationDb);
          const memberIds = [...unit.members.keys()] as SessionID[];
          await lockRowForUpdate(
            operationDb,
            this.db,
            sessions,
            inArray(sessions.session_id, memberIds)
          );
          const currentMembersById = new Map(
            (await sessionRepo.findByIds(memberIds)).map((member) => [member.session_id, member])
          );
          const currentMembers: Session[] = [];
          for (const memberId of memberIds) {
            const member = currentMembersById.get(memberId);
            if (!member) throw new NotFound('An archive target no longer exists');
            currentMembers.push(member);
          }
          const denial = await this.archiveUnitDenial(
            currentMembers,
            plan.archived,
            currentParams,
            new Map(),
            branchRepo
          );
          if (denial) throw denial;
          const applicableTargets: ArchivePlannedTarget[] = [];
          for (const target of unitTargets) {
            const current = currentMembersById.get(target.session.session_id);
            if (!current) throw new NotFound('An archive target no longer exists');
            const currentReason = current.archived ? (current.archived_reason ?? null) : null;
            const observedReason = target.session.archived
              ? (target.session.archived_reason ?? null)
              : null;
            const matchesObserved =
              current.archived === target.session.archived && currentReason === observedReason;
            if (matchesObserved) applicableTargets.push(target);
          }

          let writeTargets = applicableTargets;
          let currentRemaining: SessionArchiveResult['remainingArchived'] | null = null;
          if (!plan.archived) {
            const currentGraphs = new Map<string, ArchiveBranchGraph>();
            for (const branchId of new Set(currentMembers.map((member) => member.branch_id))) {
              const graph = await this.loadArchiveBranchGraph(currentGraphs, branchId, sessionRepo);
              for (const member of currentMembers) {
                if (member.branch_id === branchId) graph.byId.set(member.session_id, member);
              }
            }
            const currentUnit: ArchiveUnit = {
              ...unit,
              members: new Map(currentMembers.map((member) => [member.session_id, member])),
            };
            const currentPlan: ArchiveTransitionPlan = {
              archived: false,
              localFailure: plan.localFailure,
              units: [currentUnit],
              unitResults: [],
              targets: [],
              remainingArchived: [],
              excludedImplied: [],
            };
            await this.planRestoreTargets(
              currentPlan,
              currentGraphs,
              new Map(),
              sessionRepo,
              new SessionRelationshipRepository(operationDb),
              branchRepo,
              new Set(applicableTargets.map((target) => target.session.session_id))
            );
            const currentlyRestorable = new Set(
              currentPlan.targets.map((target) => target.session.session_id)
            );
            writeTargets = applicableTargets.filter((target) =>
              currentlyRestorable.has(target.session.session_id)
            );
            currentRemaining = currentPlan.remainingArchived;
          }
          return {
            changed: await sessionRepo.updateArchiveStateForTargets(
              writeTargets.map((target) => ({
                id: target.session.session_id,
                archived: target.archived,
                archivedReason: target.archivedReason,
              }))
            ),
            currentMembers,
            writeTargetIds: new Set(writeTargets.map((target) => target.session.session_id)),
            currentRemaining,
          };
        }
      ).catch((error) => {
        if (
          error instanceof Forbidden &&
          (unit.kind === 'remote' || plan.localFailure === 'skip')
        ) {
          skippedUnitKeys.add(unit.key);
          for (const memberId of unit.members.keys()) skippedMemberIds.add(memberId);
          for (const rootSessionId of unit.rootIds) {
            plan.unitResults.push({
              rootSessionId: rootSessionId as SessionID,
              kind: unit.kind,
              status: 'skipped',
              changedCount: 0,
              reason: 'insufficient_permission',
            });
          }
          return {
            changed: [],
            currentMembers: [],
            writeTargetIds: new Set<string>(),
            currentRemaining: null,
          };
        }
        throw error;
      });
      if (unitOutcome.currentMembers.length > 0) {
        for (const session of unitOutcome.currentMembers) {
          unit.members.set(session.session_id, session);
        }
        plan.targets = plan.targets.filter(
          (target) =>
            target.unitKey !== unit.key || unitOutcome.writeTargetIds.has(target.session.session_id)
        );
      }
      if (unitOutcome.currentRemaining) {
        const memberIds = new Set(unit.members.keys());
        const remainingById = new Map(
          plan.remainingArchived
            .filter(({ sessionId }) => !memberIds.has(sessionId))
            .map((remaining) => [remaining.sessionId, remaining])
        );
        for (const remaining of unitOutcome.currentRemaining) {
          remainingById.set(remaining.sessionId, remaining);
        }
        plan.remainingArchived = [...remainingById.values()];
      }
      for (const session of unitOutcome.changed) {
        emitServiceEvent(this.app, {
          path: 'sessions',
          event: 'patched',
          data: session,
          params,
          id: session.session_id,
        });
      }
      changed.push(...unitOutcome.changed);
    }
    if (skippedUnitKeys.size > 0) {
      plan.units = plan.units.filter((unit) => !skippedUnitKeys.has(unit.key));
      plan.targets = plan.targets.filter((target) => !skippedUnitKeys.has(target.unitKey));
      plan.remainingArchived = plan.remainingArchived.filter(
        ({ sessionId }) => !skippedMemberIds.has(sessionId)
      );
      plan.excludedImplied = plan.excludedImplied.filter((excluded) =>
        [...excluded.unitKeys].some((unitKey) => !skippedUnitKeys.has(unitKey))
      );
    }
    return changed;
  }

  private async currentArchiveParams(
    operationDb: TenantScopedDatabase,
    params?: SessionParams
  ): Promise<SessionParams | undefined> {
    if (!params?.provider || !this.shouldEnforceBranchRbac()) return params;
    await lockTenantAuthorizationFence(operationDb, params);
    const actor = await resolveCurrentTenantAuthorityActor(operationDb, params);
    return {
      ...params,
      user: {
        ...params.user,
        user_id: actor.user_id,
        role: actor.role ?? params.user?.role,
        _isServiceAccount: actor.service,
      },
    } as SessionParams;
  }

  private buildArchiveResult(
    root: Session,
    plan: ArchiveTransitionPlan,
    changed: Session[] | null
  ): SessionArchiveResult {
    const dryRun = changed === null;
    const changedById = new Map<string, Session>(
      (changed ?? []).map((session) => [session.session_id as string, session])
    );
    const countedById = dryRun
      ? new Map<string, Session>(
          plan.targets.map((target) => [target.session.session_id as string, target.session])
        )
      : changedById;
    const units: SessionArchiveUnitResult[] = [...plan.unitResults];
    let localCount = 0;
    let remoteCount = 0;
    for (const unit of plan.units) {
      let changedCount = 0;
      for (const id of unit.members.keys()) if (countedById.has(id)) changedCount += 1;
      if (unit.kind === 'local') localCount += changedCount;
      else remoteCount += changedCount;
      const [anchor] = unit.rootIds;
      units.push({
        rootSessionId: (anchor ?? root.session_id) as SessionID,
        kind: unit.kind,
        status: changedCount > 0 ? 'changed' : 'unchanged',
        changedCount,
        branchId: unit.branchId,
      });
    }
    const archivedCount = dryRun
      ? plan.targets.filter((target) => target.archived).length
      : (changed ?? []).filter((session) => session.archived).length;
    const total = dryRun ? plan.targets.length : (changed ?? []).length;
    const currentRoot = plan.units
      .map((unit) => unit.members.get(root.session_id))
      .find((session): session is Session => session !== undefined);
    return {
      session: changedById.get(root.session_id) ?? currentRoot ?? root,
      dryRun,
      wouldChangeCount: plan.targets.length,
      affectedSessions: changed ?? [],
      count: (changed ?? []).length,
      archivedCount,
      unarchivedCount: total - archivedCount,
      localCount,
      remoteCount,
      skippedCount: plan.unitResults.filter((unit) => unit.status === 'skipped').length,
      runningCount: plan.targets.filter((target) => isSessionExecuting(target.session)).length,
      units,
      remainingArchived: plan.remainingArchived,
      ...(plan.limitExceeded && { limitExceeded: plan.limitExceeded }),
    };
  }

  private withArchiveScope<T>(
    params: SessionParams | undefined,
    work: () => Promise<T>
  ): Promise<T> {
    const tenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();
    return runWithTenantDatabaseScope(this.db, tenantId, work);
  }

  private async runArchiveTransition(
    request: ArchiveTransitionRequest,
    dryRun = false
  ): Promise<SessionArchiveResult> {
    const [root] = request.roots;
    if (!root) throw new BadRequest('At least one session is required');
    return this.withArchiveScope(request.params, async () => {
      const plan = await this.planArchiveTransition({ ...request, tolerateLimits: dryRun });
      if (dryRun) return this.buildArchiveResult(root, plan, null);
      const changed = await this.applyArchiveTransitionPlan(plan, request.params);
      return this.buildArchiveResult(root, plan, changed);
    });
  }

  private getRuntimeExecutionConfig():
    | {
        execution?: {
          branch_rbac?: boolean;
          allow_superadmin?: boolean;
        };
      }
    | undefined {
    try {
      return (
        this.app as {
          get?: (key: string) => unknown;
        }
      ).get?.('config') as
        | {
            execution?: {
              branch_rbac?: boolean;
              allow_superadmin?: boolean;
            };
          }
        | undefined;
    } catch {
      return undefined;
    }
  }

  private shouldEnforceBranchRbac(): boolean {
    return this.getRuntimeExecutionConfig()?.execution?.branch_rbac === true;
  }

  private shouldAllowSuperadminBypass(): boolean {
    return this.getRuntimeExecutionConfig()?.execution?.allow_superadmin === true;
  }

  private async assertCanArchiveSessions(
    sessions: Session[],
    archived: boolean,
    params: SessionParams | undefined,
    branchCache: Map<string, Branch | null>,
    branchRepo = this.branchRepo
  ): Promise<void> {
    if (!params?.provider || !this.shouldEnforceBranchRbac()) return;

    const user = params.user;
    if (!user) {
      throw new NotAuthenticated('Authentication required');
    }

    if (user._isServiceAccount) {
      return;
    }

    const userId = user.user_id as UUID | undefined;
    if (!userId) {
      throw new NotAuthenticated('Authentication required');
    }

    const allowSuperadmin = this.shouldAllowSuperadminBypass();
    const userRole = user.role;
    const action = archived ? 'archive sessions' : 'unarchive sessions';

    for (const session of sessions) {
      const branch = await this.loadArchiveBranch(branchCache, session.branch_id, branchRepo);
      if (!branch) {
        throw new Forbidden(`Branch not found for session: ${session.session_id}`);
      }

      const access = await branchRepo.resolveUserAccess(branch, userId);
      const effectiveLevel: BranchPermissionLevel = isSuperAdmin(userRole, allowSuperadmin)
        ? 'all'
        : access.can;

      if (PERMISSION_RANK[effectiveLevel] >= PERMISSION_RANK.prompt) {
        continue;
      }

      if (effectiveLevel === 'session' && session.created_by === userId) {
        continue;
      }

      throw new Forbidden(
        `You need 'prompt' permission to ${action} in this branch. You have '${effectiveLevel}' permission.`
      );
    }
  }

  /**
   * Archive a session with its branch-local descendants and, by default, the
   * sessions it created in other branches (each remote branch is authorized and
   * reported separately, within named bounds). `dryRun` plans and authorizes
   * without changing anything. Generic `patch({ archived })` is rejected; this
   * is the only archive entry point for callers.
   */
  async archive(
    id: string,
    options?: SessionArchiveOptions,
    params?: SessionParams
  ): Promise<SessionArchiveResult> {
    return this.withArchiveScope(params, async () => {
      const root = await this.get(id, params);
      return this.runArchiveTransition(
        {
          roots: [root],
          initiator: 'manual',
          archived: true,
          includeChildren: options?.includeChildren !== false,
          includeRemoteChildren: options?.includeRemoteChildren !== false,
          grouping: 'branch',
          localFailure: 'throw',
          params,
        },
        options?.dryRun === true
      );
    });
  }

  /**
   * Restore a session and, cause-aware, the descendants its archive implied.
   * Descendants archived for an independent reason, or still covered by another
   * archived parent edge or an archived branch, stay archived and are reported.
   * Restoring a session inside an archived branch is a conflict.
   */
  async unarchive(
    id: string,
    options?: SessionArchiveOptions,
    params?: SessionParams
  ): Promise<SessionArchiveResult> {
    return this.withArchiveScope(params, async () => {
      const root = await this.get(id, params);
      return this.runArchiveTransition(
        {
          roots: [root],
          initiator: 'manual',
          archived: false,
          includeChildren: options?.includeChildren !== false,
          includeRemoteChildren: options?.includeRemoteChildren !== false,
          grouping: 'branch',
          localFailure: 'throw',
          params,
        },
        options?.dryRun === true
      );
    });
  }

  /**
   * Internal: archive a completed ephemeral `btw` fork with its local
   * descendants. Remote work it created stays active.
   */
  async archiveBtwSession(id: string, params?: SessionParams): Promise<SessionArchiveResult> {
    const internal = internalArchiveParams(params);
    return this.withArchiveScope(internal, async () => {
      const root = await this.get(id, internal);
      return this.runArchiveTransition({
        roots: [root],
        initiator: 'btw_completed',
        archived: true,
        includeChildren: true,
        includeRemoteChildren: false,
        grouping: 'branch',
        localFailure: 'throw',
        params: internal,
      });
    });
  }

  /**
   * Internal: restore only the session a prompt was just sent to. Ancestors,
   * descendants, and remote work are untouched; the prompt route already
   * authorized the caller. Prompting into an archived branch is a conflict.
   */
  async restorePromptedSession(id: string, params?: SessionParams): Promise<SessionArchiveResult> {
    const internal = internalArchiveParams(params);
    return this.withArchiveScope(internal, async () => {
      const root = await this.get(id, internal);
      return this.runArchiveTransition({
        roots: [root],
        initiator: 'manual',
        archived: false,
        includeChildren: false,
        includeRemoteChildren: false,
        grouping: 'branch',
        localFailure: 'throw',
        params: internal,
      });
    });
  }

  /**
   * Internal: archive every active session canonically owned by a branch as an
   * explicit `branch_archived` root. Already-archived rows keep their reason.
   */
  async archiveBranchSessions(
    branchId: BranchID,
    params?: SessionParams
  ): Promise<{ affectedSessions: Session[]; count: number }> {
    const internal = internalArchiveParams(params);
    return this.withArchiveScope(internal, async () => {
      const roots = await this.sessionRepo.findAll({ branchId, archived: false });
      if (roots.length === 0) return { affectedSessions: [], count: 0 };
      const result = await this.runArchiveTransition({
        roots,
        initiator: 'branch_archived',
        archived: true,
        includeChildren: false,
        includeRemoteChildren: false,
        grouping: 'branch',
        localFailure: 'throw',
        params: internal,
      });
      return { affectedSessions: result.affectedSessions, count: result.count };
    });
  }

  /**
   * Internal: restore only the rows a branch archive caused. The branch row
   * itself must already be active.
   */
  async unarchiveBranchSessions(
    branchId: BranchID,
    params?: SessionParams
  ): Promise<{ affectedSessions: Session[]; count: number }> {
    const internal = internalArchiveParams(params);
    return this.withArchiveScope(internal, async () => {
      const archivedRows = await this.sessionRepo.findAll({ branchId, archived: true });
      const roots = archivedRows.filter((session) => session.archived_reason === 'branch_archived');
      if (roots.length === 0) return { affectedSessions: [], count: 0 };
      const result = await this.runArchiveTransition({
        roots,
        initiator: 'manual',
        archived: false,
        includeChildren: false,
        includeRemoteChildren: false,
        grouping: 'branch',
        localFailure: 'throw',
        params: internal,
      });
      return { affectedSessions: result.affectedSessions, count: result.count };
    });
  }

  /**
   * Bulk archive: the caller's filter selected the direct roots; the policy
   * decides which branch-local descendants join them. `eligible` keeps only
   * descendants with no unfinished task that are not newer than the caller's
   * age cutoff. Each root tree is its own authorization unit (overlapping
   * trees merge); unauthorized units are skipped and reported rather than
   * failing the run. Remote work is never followed.
   */
  async previewBulkArchive(
    roots: Session[],
    options: SessionBulkArchiveOptions,
    params?: SessionParams
  ): Promise<SessionBulkArchivePreview> {
    return this.withArchiveScope(params, async () => {
      const { plan, unfinishedIds } = await this.planBulkArchive(roots, options, params);
      return this.summarizeBulkPlan(plan, options, unfinishedIds);
    });
  }

  async bulkArchive(
    roots: Session[],
    options: SessionBulkArchiveOptions,
    params?: SessionParams
  ): Promise<SessionArchiveResult & { preview: SessionBulkArchivePreview }> {
    const [first] = roots;
    if (!first) throw new BadRequest('At least one session is required');
    return this.withArchiveScope(params, async () => {
      const { plan, unfinishedIds } = await this.planBulkArchive(roots, options, params);
      const changed = await this.applyArchiveTransitionPlan(plan, params);
      const preview = this.summarizeBulkPlan(plan, options, unfinishedIds);
      return { ...this.buildArchiveResult(first, plan, changed), preview };
    });
  }

  private async planBulkArchive(
    roots: Session[],
    options: SessionBulkArchiveOptions,
    params?: SessionParams
  ): Promise<{ plan: ArchiveTransitionPlan; unfinishedIds: Set<string> }> {
    const taskRepo = new TaskRepository(this.db);
    let unfinishedIds = new Set<string>();
    const cutoff = options.cutoffDate ?? null;
    const isNewerThanCutoff = (session: Session) =>
      cutoff !== null && new Date(session.last_updated || session.created_at) >= cutoff;
    const plan = await this.planArchiveTransition({
      roots,
      initiator: 'manual',
      archived: true,
      includeChildren: options.policy !== 'none',
      includeRemoteChildren: false,
      grouping: 'root-tree',
      localFailure: 'skip',
      params,
      ...(options.policy === 'eligible' && {
        descendantEligibility: async (candidates: Session[]) => {
          unfinishedIds = await taskRepo.findSessionIdsWithNonterminalTasks(
            candidates.map((session) => session.session_id)
          );
          return new Set(
            candidates
              .filter(
                (session) => !unfinishedIds.has(session.session_id) && !isNewerThanCutoff(session)
              )
              .map((session) => session.session_id as string)
          );
        },
      }),
    });
    if (options.policy === 'all') {
      unfinishedIds = await taskRepo.findSessionIdsWithNonterminalTasks(
        plan.targets
          .filter((target) => target.selection === 'implied')
          .map((target) => target.session.session_id)
      );
    }
    return { plan, unfinishedIds };
  }

  private summarizeBulkPlan(
    plan: ArchiveTransitionPlan,
    options: SessionBulkArchiveOptions,
    unfinishedIds: Set<string>
  ): SessionBulkArchivePreview {
    const cutoff = options.cutoffDate ?? null;
    const directRoots = plan.targets
      .filter((target) => target.selection === 'direct')
      .map((target) => target.session);
    const impliedDescendants = plan.targets
      .filter((target) => target.selection === 'implied')
      .map((target) => target.session);
    const excludedDescendants = plan.excludedImplied.map(({ session }) => session);
    const classifiedDescendants = [...impliedDescendants, ...excludedDescendants];
    const plannedByUnit = new Map<string, number>();
    for (const target of plan.targets) {
      plannedByUnit.set(target.unitKey, (plannedByUnit.get(target.unitKey) ?? 0) + 1);
    }
    return {
      policy: options.policy,
      directRoots,
      impliedDescendants,
      excludedDescendants,
      descendantsNewerThanCutoff: classifiedDescendants.filter(
        (session) =>
          cutoff !== null && new Date(session.last_updated || session.created_at) >= cutoff
      ),
      descendantsWithUnfinishedTasks: classifiedDescendants.filter((session) =>
        unfinishedIds.has(session.session_id)
      ),
      activeDescendants: impliedDescendants.filter((session) => isSessionExecuting(session)),
      units: [
        ...plan.unitResults,
        ...plan.units.map((unit) => {
          const [anchor] = unit.rootIds;
          const changedCount = plannedByUnit.get(unit.key) ?? 0;
          return {
            rootSessionId: (anchor ?? unit.key) as SessionID,
            kind: unit.kind,
            status: changedCount > 0 ? ('changed' as const) : ('unchanged' as const),
            changedCount,
            branchId: unit.branchId,
          };
        }),
      ],
      wouldArchive: plan.targets.length,
    };
  }

  /**
   * Override remove to cascade delete children (forks and subsessions)
   */
  async remove(
    id: import('@agor/core/types').NullableId,
    params?: SessionParams
  ): Promise<Session | Session[]> {
    const tenantId = params?.tenant?.tenant_id ?? getCurrentTenantId();
    const selected = id === null ? ((await super.find(params)) as Session[]) : null;
    return runWithTenantDatabaseTransaction(this.db, tenantId, async (scoped) => {
      const sessionRepo = new SessionRepository(scoped);
      const taskRepo = new TaskRepository(scoped);
      if (selected) {
        const results: Session[] = [];
        for (const session of selected) {
          results.push(
            await this.removeOne(session.session_id, params, false, sessionRepo, taskRepo)
          );
        }
        return results;
      }

      // "Switch tool" (`chooseAgenticTool` in the UI) removes the session it's
      // replacing as an implementation detail of swapping. Keep its stronger
      // zero-history invariant distinct from the general unfinished-task guard
      // in removeOne: terminal history may be deliberately deleted, but live
      // executor leases may never be orphaned by a metadata cascade.
      if ((params?.query as { _swapReplace?: boolean } | undefined)?._swapReplace) {
        const taskCount = await taskRepo.countBySession(String(id));
        if (taskCount > 0) {
          throw new Conflict(
            `Cannot complete tool switch: session ${id} has gained ${taskCount} task(s) since the switch ` +
              'was initiated. Refresh and try again — the in-flight work has not been touched.'
          );
        }
      }

      return this.removeOne(String(id), params, false, sessionRepo, taskRepo);
    });
  }

  private async removeOne(
    id: string,
    params: SessionParams | undefined,
    emitRemoved: boolean,
    sessionRepo: SessionRepository,
    taskRepo: TaskRepository
  ): Promise<Session> {
    const session = await sessionRepo.findById(id);
    if (!session) throw new NotFound(`Session not found: ${id}`);
    if (await taskRepo.hasNonterminalForSession(session.session_id)) {
      throw new Conflict(
        `Cannot delete session ${session.session_id} while it has unfinished tasks. Stop them first.`
      );
    }
    const children = await sessionRepo.findChildren(id);

    for (const child of children) {
      await this.removeOne(child.session_id, params, true, sessionRepo, taskRepo);
    }

    await sessionRepo.delete(id);

    if (emitRemoved) {
      emitServiceEvent(this.app, {
        path: 'sessions',
        event: 'removed',
        data: session,
        params,
        id,
      });
    }

    return session;
  }

  /**
   * Override patch to keep durable relationship callback state synchronized
   * with the existing callback_config.enabled execution switch.
   */
  async patch(
    id: import('@agor/core/types').NullableId,
    data: SessionUpdate,
    params?: SessionParams
  ): Promise<Session | Session[]> {
    if (Object.hasOwn(data, 'sdk_home_scope')) {
      throw new BadRequest('sdk_home_scope is immutable and server-managed');
    }
    if (Object.hasOwn(data, 'archived') || Object.hasOwn(data, 'archived_reason')) {
      throw new BadRequest(ARCHIVE_PATCH_REJECTED_MESSAGE);
    }
    let replaceAgenticConfig = false;
    if (
      (id === null || Array.isArray(id)) &&
      (data.agentic_tool !== undefined ||
        data.agentic_tool_preset_id !== undefined ||
        data.model_config !== undefined ||
        data.permission_config !== undefined)
    ) {
      throw new BadRequest('Agentic configuration cannot be changed with a multi-session patch');
    }
    const patchedAgenticTool =
      data.agentic_tool === undefined ? undefined : requireActiveAgenticTool(data.agentic_tool);
    if (patchedAgenticTool && !(await isTenantAgenticToolEnabled(patchedAgenticTool, this.db))) {
      throw new BadRequest(`${patchedAgenticTool} is disabled for this workspace`);
    }
    if (patchedAgenticTool) this.assertDeploymentToolConfigured(patchedAgenticTool);
    // `agentic_tool` is immutable once a session has tasks. Multi-session and
    // array patches that touch it are already rejected above, so the single-id
    // path is the only one that can reach the actual mutation — enforce the
    // guard there, matching the exact target the patch will modify.
    if (data.agentic_tool !== undefined && id !== null && !Array.isArray(id)) {
      await this.assertAgenticToolMutable(String(id), patchedAgenticTool!);
    }
    if (id && !Array.isArray(id) && !params?._applyingAgenticToolPreset) {
      const current = await this.get(String(id), params);
      const mutatesAtomicConfig =
        data.model_config !== undefined ||
        data.permission_config !== undefined ||
        data.agentic_tool !== undefined ||
        data.agentic_tool_preset_id === null;
      if (
        current.agentic_tool_preset_id &&
        mutatesAtomicConfig &&
        data.agentic_tool_preset_id === undefined
      ) {
        throw new BadRequest(
          'Preset-backed session configuration can only be changed by selecting a preset'
        );
      }
      if (data.agentic_tool_preset_id) {
        const tool = requireActiveAgenticTool(data.agentic_tool ?? current.agentic_tool);
        const materialized = await materializeAgenticToolConfiguration(this.db, {
          tool,
          source: { reference: data.agentic_tool_preset_id },
          executionOwnerId: current.created_by as import('@agor/core/types').UserID,
        });
        data = {
          ...data,
          agentic_tool_preset_id: materialized.agentic_tool_preset_id,
          permission_config: materialized.permission_config,
          model_config: materialized.model_config,
        };
        replaceAgenticConfig = true;
      } else if (mutatesAtomicConfig) {
        const tool = requireActiveAgenticTool(data.agentic_tool ?? current.agentic_tool);
        const materialized = await materializeAgenticToolConfiguration(this.db, {
          tool,
          source: sessionConfigurationSource({
            model_config:
              data.model_config === undefined ? current.model_config : data.model_config,
            permission_config:
              data.permission_config === undefined
                ? current.permission_config
                : data.permission_config,
          }),
          executionOwnerId: current.created_by as import('@agor/core/types').UserID,
        });
        data = {
          ...data,
          agentic_tool_preset_id: null,
          permission_config: materialized.permission_config,
          model_config: materialized.model_config,
        };
        replaceAgenticConfig = true;
      }
      // Validate only a newly selected/effective model. Existing persisted
      // sessions remain patchable when the curated registry changes.
      if (
        data.model_config !== undefined ||
        data.agentic_tool !== undefined ||
        data.agentic_tool_preset_id !== undefined
      ) {
        const effectiveTool = requireActiveAgenticTool(data.agentic_tool ?? current.agentic_tool);
        const effectiveModelConfig =
          data.model_config === undefined ? current.model_config : data.model_config;
        const modelPolicy = getAgenticToolModelConfiguration(effectiveTool);
        if (
          modelPolicy?.isResolved &&
          !isResolvedAgenticToolModelConfiguration(effectiveTool, effectiveModelConfig)
        ) {
          throw new BadRequest(modelPolicy.missingSelectionError ?? 'model_config is not resolved');
        }
        this.assertSupportedModelConfig(effectiveTool, effectiveModelConfig);
      }
    }
    const result = (
      replaceAgenticConfig && id && !Array.isArray(id)
        ? await this.sessionRepo.update(String(id), data, { replaceAgenticConfig: true })
        : await super.patch(id, data, params)
    ) as Session | Session[];

    const callbackEnabled = data.callback_config?.enabled;
    if (
      typeof callbackEnabled === 'boolean' &&
      !(params as (SessionParams & { _skipRelationshipCallbackSync?: boolean }) | undefined)
        ?._skipRelationshipCallbackSync
    ) {
      const sessionsToSync = Array.isArray(result) ? result : [result];
      for (const session of sessionsToSync) {
        await this.sessionRelationshipRepo.setCallbackEnabledForTargetSession(
          session.session_id as SessionID,
          callbackEnabled
        );
      }
    }

    return result;
  }

  async update(id: string, data: SessionUpdate, params?: SessionParams): Promise<Session> {
    return (await this.patch(id, data, params)) as Session;
  }

  /**
   * Override get to optionally enrich with last message
   *
   * Last message enrichment is opt-in via include_last_message query parameter
   */
  async get(id: string, params?: SessionParams): Promise<SessionWithLastMessage> {
    // Check both query params and root-level params (root-level bypasses Feathers query filtering)
    const includeLastMessageQuery = params?.query?.include_last_message;
    const includeLastMessageRoot = params?._include_last_message;
    const includeLastMessage = includeLastMessageRoot ?? includeLastMessageQuery;

    const session = await super.get(id, params);
    const [enrichedSession] = await this.enrichRemoteRelationships([session]);
    const sessionWithRelationships = enrichedSession ?? session;

    // Only enrich with last message if explicitly requested
    if (includeLastMessage === true || includeLastMessage === 'true') {
      const truncationLengthQuery = params?.query?.last_message_truncation_length;
      const truncationLengthRoot = params?._last_message_truncation_length;
      const truncationLength = parseLastMessageTruncationLength(
        truncationLengthRoot ?? truncationLengthQuery
      );
      const result = await this.sessionRepo.enrichWithLastMessage(
        sessionWithRelationships as Session,
        truncationLength
      );
      return result;
    }

    return sessionWithRelationships as SessionWithLastMessage;
  }

  /**
   * Override find to include durable remote relationships in list results.
   * Note: Last message is NOT included in list operations - only on single GET.
   */
  async find(params?: SessionParams): Promise<Paginated<Session> | Session[]> {
    // SQL-pushdown path for the recency-sorted / board-scoped list queries the
    // first-paint loader issues. In RBAC mode the before-hook stamps a marker
    // here so the same SQL path can compose branch visibility into the query;
    // in open-access mode this path still handles board_id + `$sort:{updated_at}`.
    //
    // We can't lean on DrizzleService's generic path: (1) its filter matches
    // `item.board_id`, but sessions expose the board as `branch_board_id`, so a
    // board_id filter would wipe every row; (2) its sort looks up `item.updated_at`
    // (the field is `last_updated`), so a `$sort:{updated_at}` is a silent no-op
    // and the bounded slice wouldn't be ordered by recency. findPage does the
    // filter + recency sort + limit/offset in SQL instead.
    const query = params?.query as Record<string, unknown> | undefined;
    if (shouldSqlPageSessionQuery(query, !!params?._agorSqlSessionAccessUserId)) {
      const sortSpec = query?.$sort as { updated_at?: 1 | -1; created_at?: 1 | -1 } | undefined;
      const branchFilter = query?.branch_id;
      const branchIds =
        branchFilter &&
        typeof branchFilter === 'object' &&
        Array.isArray((branchFilter as { $in?: unknown }).$in)
          ? ((branchFilter as { $in: BranchID[] }).$in ?? [])
          : undefined;
      const limit = (query?.$limit as number | undefined) ?? PAGINATION.DEFAULT_LIMIT;
      const skip = (query?.$skip as number | undefined) ?? 0;
      const { data, total } = await this.sessionRepo.findPage({
        boardId: query?.board_id as string | undefined,
        branchId: typeof branchFilter === 'string' ? (branchFilter as BranchID) : undefined,
        branchIds,
        archived: query?.archived as boolean | undefined,
        sortUpdatedAt: sortSpec?.updated_at,
        sortCreatedAt: sortSpec?.created_at,
        limit,
        skip,
        visibleToUserId: params?._agorSqlSessionAccessUserId,
      });
      const enriched = await this.enrichRemoteRelationships(data);
      return markRemoteRelationshipsEnrichedResult({ total, limit, skip, data: enriched });
    }

    // board_id present but with a shape findPage doesn't model (Feathers
    // operators like $in/$ne/$gt, $select, extra filters): push the board filter
    // to SQL via the branch join, then run the FULL generic DrizzleService
    // pipeline on the board-scoped rows so operators / $select / $sort / pagination
    // all behave exactly as on the unscoped path. (paginateClientSide would only
    // do strict equality and silently mishandle operators.)
    const boardId = params?.query?.board_id;
    if (boardId) {
      const { board_id: _scopedBoardId, ...residualQuery } = (params?.query ?? {}) as Record<
        string,
        unknown
      >;
      const residual = residualQuery as Query;
      const rows = await this.sessionRepo.findByBoard(boardId as string, {
        visibleToUserId: params?._agorSqlSessionAccessUserId,
      });
      const filtered = this.filterData(rows, residual);
      const total = filtered.length;
      const sorted = this.sortData(filtered, residual.$sort);
      const selected = this.selectFields(sorted, residual.$select);
      const paged = this.paginateData(selected as Session[], residual, total);

      if (Array.isArray(paged)) {
        const enriched = await this.enrichRemoteRelationships(paged);
        return markRemoteRelationshipsEnrichedResult(enriched);
      }
      const enrichedData = await this.enrichRemoteRelationships(paged.data);
      return markRemoteRelationshipsEnrichedResult({ ...paged, data: enrichedData });
    }

    // Branch-modal session lists commonly sort by created_at rather than the
    // recency column used by findPage. Keep the generic Feathers semantics for
    // those shapes, but scope the candidate rows to the branch in SQL.
    const branchId = params?.query?.branch_id;
    const exactBranchId = typeof branchId === 'string' ? (branchId as BranchID) : undefined;
    const branchIds =
      branchId &&
      typeof branchId === 'object' &&
      Array.isArray(branchId.$in) &&
      branchId.$in.every((value: unknown) => typeof value === 'string')
        ? (branchId.$in as BranchID[])
        : undefined;
    if (exactBranchId || branchIds) {
      const { branch_id: _scopedBranchId, ...residualQuery } = (params?.query ?? {}) as Record<
        string,
        unknown
      >;
      const rows = await this.sessionRepo.findAll({
        branchId: exactBranchId,
        branchIds,
        archived: typeof residualQuery.archived === 'boolean' ? residualQuery.archived : undefined,
        visibleToUserId: params?._agorSqlSessionAccessUserId,
      });
      const residual = residualQuery as Query;
      const filtered = this.filterData(rows, residual);
      const total = filtered.length;
      const sorted = this.sortData(filtered, residual.$sort);
      const selected = this.selectFields(sorted, residual.$select);
      const paged = this.paginateData(selected as Session[], residual, total);
      if (Array.isArray(paged)) {
        const enriched = await this.enrichRemoteRelationships(paged);
        return markRemoteRelationshipsEnrichedResult(enriched);
      }
      const enrichedData = await this.enrichRemoteRelationships(paged.data);
      return markRemoteRelationshipsEnrichedResult({ ...paged, data: enrichedData });
    }

    const result = await super.find(params);

    if (Array.isArray(result)) {
      const enriched = await this.enrichRemoteRelationships(result);
      return markRemoteRelationshipsEnrichedResult(enriched);
    }

    const enrichedData = await this.enrichRemoteRelationships(result.data);
    return markRemoteRelationshipsEnrichedResult({
      ...result,
      data: enrichedData,
    });
  }
}

/**
 * Service factory function
 */
export function createSessionsService(
  db: TenantScopeAwareDatabase,
  app: Application,
  deploymentAvailable: (tool: AgenticToolName) => boolean = () => true
): SessionsService {
  return new SessionsService(db, app, deploymentAvailable);
}
