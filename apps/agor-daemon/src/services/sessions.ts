/**
 * Sessions Service
 *
 * Provides REST + WebSocket API for session management.
 * Uses DrizzleService adapter with SessionRepository.
 */

import { PAGINATION } from '@agor/core/config';
import {
  BranchRepository,
  SessionEnvSelectionRepository,
  SessionMCPServerRepository,
  SessionRelationshipRepository,
  SessionRepository,
  type SessionWithLastMessage,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { type Application, BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import {
  formatModelToolMismatchWarning,
  formatUnsupportedAgorCodexModelMessage,
  isUnsupportedAgorCodexModel,
  lintModelToolMatch,
} from '@agor/core/models';
import { resolveChildSessionConfig } from '@agor/core/sessions';
import type {
  AuthenticatedParams,
  Branch,
  BranchPermissionLevel,
  MCPServerID,
  Paginated,
  QueryParams,
  Session,
  SessionID,
  TaskID,
  UUID,
} from '@agor/core/types';
import { ROLES, SessionStatus } from '@agor/core/types';
import { DrizzleService, type Query } from '../adapters/drizzle';
import {
  determineSpawnIdentity,
  isSuperAdmin,
  loadUnixUsernameForUser,
  PERMISSION_RANK,
  resolveChildUnixUsername,
} from '../utils/branch-authorization.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { parseLastMessageTruncationLength } from '../utils/query-params.js';

/**
 * Session runtime configuration that should be inherited across forks, spawns, and btw.
 *
 * Bundled into a single type so that adding a new inheritable field only requires
 * updating this type and getInheritableConfig() — all creation paths (fork, spawn, btw)
 * automatically pick it up.
 */
interface InheritableSessionConfig {
  permission_config?: Session['permission_config'];
  model_config?: Session['model_config'];
}

type SessionArchiveReason = NonNullable<Session['archived_reason']>;
type SessionArchiveTarget = {
  session: Session;
  archived: boolean;
  archivedReason: SessionArchiveReason | null;
};

const MANUAL_ARCHIVED_REASON = 'manual' satisfies SessionArchiveReason;
const PARENT_ARCHIVED_REASON = 'parent_archived' satisfies SessionArchiveReason;

/**
 * Extract the inheritable runtime configuration from a parent session.
 * Used by fork() and spawn() to ensure consistent config inheritance.
 */
function getInheritableConfig(parent: Session): InheritableSessionConfig {
  return {
    permission_config: parent.permission_config,
    model_config: parent.model_config,
  };
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
}> &
  AuthenticatedParams &
  InternalEnrichmentParams & {
    /** Root-level include_last_message flag (bypasses Feathers query filtering, used by internal service calls) */
    _include_last_message?: boolean | 'true' | 'false';
    /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
    _agorSqlSessionAccessUserId?: UUID;
  };

/**
 * Whether a sessions `find` query should be served by `SessionRepository.findPage`
 * (SQL board filter + recency sort + limit/offset) rather than the generic
 * in-memory path. We only divert the loader's bounded list queries — those that
 * sort by `updated_at` and/or scope to a `board_id` — and only when the rest of
 * the query is a shape findPage fully models (archived + pagination). Anything
 * with extra filters, operators, or `$select` falls through to the existing path
 * so we never silently drop semantics findPage doesn't implement.
 */
function shouldSqlPageSessionQuery(query?: Record<string, unknown>, forcePage = false): boolean {
  if (!query) return forcePage;

  const sort = query.$sort as Record<string, unknown> | undefined;
  const wantsRecency = !!sort && sort.updated_at !== undefined;
  const wantsBoard = query.board_id !== undefined;
  if (!wantsRecency && !wantsBoard && !forcePage) return false;

  const allowedKeys = new Set(['archived', 'board_id', '$sort', '$limit', '$skip']);
  for (const key of Object.keys(query)) {
    if (!allowedKeys.has(key)) return false;
  }
  if (query.archived !== undefined && typeof query.archived !== 'boolean') return false;
  if (wantsBoard && typeof query.board_id !== 'string') return false;
  if (sort) {
    const sortKeys = Object.keys(sort);
    if (sortKeys.length !== 1 || sortKeys[0] !== 'updated_at') return false;
    if (sort.updated_at !== 1 && sort.updated_at !== -1) return false;
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
};

export type SessionArchiveOptions = {
  includeChildren?: boolean;
};

export type SessionArchiveResult = {
  session: Session;
  affectedSessions: Session[];
  count: number;
};

/**
 * Extended sessions service with custom methods
 */
export class SessionsService extends DrizzleService<Session, Partial<Session>, SessionParams> {
  private sessionRepo: SessionRepository;
  private app: Application;
  private sessionMCPRepo: SessionMCPServerRepository;
  private sessionRelationshipRepo: SessionRelationshipRepository;
  private sessionEnvSelectionRepo: SessionEnvSelectionRepository;
  private usersRepo: UsersRepository;
  private branchRepo: BranchRepository;

  private assertSupportedModelConfig(
    agenticTool: Session['agentic_tool'],
    modelConfig: Session['model_config'] | undefined
  ): void {
    if (
      agenticTool === 'codex' &&
      modelConfig?.model &&
      isUnsupportedAgorCodexModel(modelConfig.model)
    ) {
      throw new BadRequest(formatUnsupportedAgorCodexModelMessage(modelConfig.model));
    }
  }

  constructor(db: TenantScopeAwareDatabase, app: Application) {
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
    this.app = app;
    this.sessionMCPRepo = new SessionMCPServerRepository(db);
    this.sessionRelationshipRepo = new SessionRelationshipRepository(db);
    this.sessionEnvSelectionRepo = new SessionEnvSelectionRepository(db);
    this.branchRepo = new BranchRepository(db);
    // Used by resolveChildIdentity to stamp unix_username on fork/spawn children
    // without going through app.service('users') — matches the convention used
    // by scheduler.ts / gateway.ts / terminals.ts.
    this.usersRepo = new UsersRepository(db);
  }

  protected async fetchData(_query: Query, params?: SessionParams): Promise<Session[]> {
    return this.sessionRepo.findAll({
      visibleToUserId: params?._agorSqlSessionAccessUserId,
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
        this.app?.service('session-mcp-servers')?.emit?.('created', {
          session_id: sessionId,
          mcp_server_id: serverId,
          enabled: true,
          added_at: new Date(),
        });
      } catch {
        console.warn(`Skipped MCP server ${serverId} during ${label}`);
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
          this.app?.service('session-mcp-servers')?.emit?.('created', {
            session_id: targetSessionId,
            mcp_server_id: server.mcp_server_id,
            enabled: true,
            added_at: new Date(),
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
   * Defaults the child to the MCP-authenticated caller; only inherits the
   * parent's identity when the branch explicitly opts in via the
   * `dangerously_allow_session_sharing` flag (and the caller is not an admin
   * acting on someone else's session).
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
   * fires for these paths. Omitting unix_username silently breaks strict-mode
   * deployments where the executor refuses to launch without one.
   *
   * Resolution rules (kept aligned with the hook's behavior on normal creates):
   * - Internal call (no provider) → inherit parent.unix_username. The scheduler /
   *   service-to-service callers have no human caller to attribute to, and the
   *   parent's stamped value is the closest thing to ground truth.
   * - Legacy sharing (`dangerously_allow_session_sharing` triggers) → inherit
   *   parent's unix_username by design — this is the point of identity borrowing.
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
    // Preserve parent attribution; helper-level identity checks don't apply.
    if (!params?.provider) {
      return { created_by: parent.created_by, unix_username: parent.unix_username ?? null };
    }

    const caller = params.user;
    if (!caller) {
      // External call without an authenticated user should never reach here
      // (auth hooks run first), but fail closed defensively.
      throw new Forbidden('Cannot spawn/fork session without an authenticated caller identity.');
    }

    // Look up the parent's branch to read the opt-in flag.
    let branch: { branch_id: string; dangerously_allow_session_sharing?: boolean } | undefined;
    try {
      const wt = await this.app.service('branches').get(parent.branch_id, { provider: undefined });
      branch = wt as typeof branch;
      if (caller.user_id) {
        const effective = await this.branchRepo.resolveUserAccess(
          wt as Branch,
          caller.user_id as UUID
        );
        if (branch) {
          branch.dangerously_allow_session_sharing = effective.dangerously_allow_session_sharing;
        }
      }
    } catch {
      // If we can't load the branch, default to the safe (caller-as-owner) path.
      branch = undefined;
    }

    const result = determineSpawnIdentity(parent, caller, branch);
    const createdBy = result.created_by as Session['created_by'];

    // Legacy sharing → inherit parent's unix_username (identity borrowing by design).
    // Otherwise (including same-user) → resolve the attributed user's CURRENT
    // unix_username. Same-user forks must NOT inherit stale parent.unix_username,
    // because validateSessionUnixUsername would later reject prompts when the
    // user's unix_username drifts. The decision is delegated to the pure helper
    // `resolveChildUnixUsername` so it can be unit tested without DB mocks.
    let callerUnixUsername: string | null = null;
    if (!result.usedLegacySharing) {
      try {
        callerUnixUsername = await loadUnixUsernameForUser(this.usersRepo, createdBy as string);
      } catch (err) {
        // If we can't load the caller user, fail closed rather than silently
        // creating a session with no unix_username (which would hang forever
        // in strict mode).
        throw new Forbidden(
          `Cannot resolve unix_username for caller ${createdBy}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const unixUsername = resolveChildUnixUsername(
      parent.unix_username,
      callerUnixUsername,
      result.usedLegacySharing
    ) as Session['unix_username'];

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

    // Default: attribute the child to the MCP-authenticated caller, not the
    // parent owner. Legacy parent-inheriting "identity borrowing" is preserved
    // only when the branch opts in via dangerously_allow_session_sharing.
    const { created_by, unix_username } = await this.resolveChildIdentity(parent, params);
    const inheritableConfig = getInheritableConfig(parent);
    this.assertSupportedModelConfig(parent.agentic_tool, inheritableConfig.model_config);

    const forkedSession = await this.create(
      {
        agentic_tool: parent.agentic_tool,
        status: SessionStatus.IDLE,
        title: data.prompt.substring(0, 100), // First 100 chars as title
        description: data.prompt,
        branch_id: parent.branch_id,
        created_by, // See resolveChildIdentity — defaults to caller, not parent owner
        unix_username, // Stamped by resolveChildIdentity — this.create() bypasses
        // the setSessionUnixUsername hook so we must set it explicitly here.
        // Strict-mode deployments refuse to launch sessions with null unix_username.
        git_state: { ...parent.git_state },
        genealogy: {
          forked_from_session_id: parent.session_id,
          fork_point_task_id: data.task_id as TaskID,
          fork_point_message_index: await this.sessionRepo.countMessages(parent.session_id),
          children: [],
        },
        contextFiles: [...(parent.contextFiles || [])],
        ...inheritableConfig,
        tasks: [],
        // Don't copy sdk_session_id - fork will get its own via forkSession:true
      },
      params
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

  /**
   * Spawn a child session, optionally delegating to a different agentic tool.
   *
   * Config resolution is centralized in {@link resolveChildSessionConfig}
   * (`@agor/core/sessions`):
   *
   *   model_config:      request → parent (same tool only) → user default → undefined
   *   permission_config: request → parent (same tool only) → user default → mapped system default
   *
   * The "same tool only" gate prevents cross-tool inheritance bugs: a Codex
   * child spawned from a Claude parent must not inherit `claude-opus-4-7`,
   * because Codex cannot run Claude models. When no per-tool default exists,
   * the helper returns `model_config: undefined` and the SDK picks its own
   * default rather than running with a poisoned value.
   *
   * Identity resolution runs *before* defaults lookup so per-tool defaults
   * come from the resolved child owner (the caller in normal cross-user
   * spawns), not the parent owner. Otherwise a collaborator spawning a
   * subsession would get the parent owner's preferences stamped on their
   * own session.
   *
   * MCP server inheritance is handled inline below — MCPs are tool-agnostic
   * and follow "explicit list > copy from parent" regardless of tool match.
   */
  async spawn(
    id: string,
    data: Partial<import('@agor/core/types').SpawnConfig>,
    params?: SessionParams
  ): Promise<Session> {
    if (!data.prompt) {
      throw new Error('Spawn requires a prompt');
    }
    const parent = await this.get(id, params);
    const targetTool = data.agent || parent.agentic_tool;

    // Resolve identity first so per-tool defaults come from the resolved
    // child owner, not the parent owner. (For internal/provider-less calls,
    // `resolveChildIdentity` returns `parent.created_by` anyway.)
    const { created_by, unix_username } = await this.resolveChildIdentity(parent, params);

    // Load the child owner's per-tool defaults. Failing this lookup is
    // non-fatal — the resolver falls through to the mapped system default
    // when `user` is null.
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

    const resolved = resolveChildSessionConfig({
      parent,
      effectiveTool: targetTool,
      user,
      overrides: {
        permissionMode: data.permissionMode,
        modelConfig: data.modelConfig,
        codexSandboxMode: data.codexSandboxMode,
        codexApprovalPolicy: data.codexApprovalPolicy,
        codexNetworkAccess: data.codexNetworkAccess,
      },
    });
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
        status: SessionStatus.IDLE,
        title: data.title || data.prompt.substring(0, 100), // Use provided title or first 100 chars
        description: finalPrompt, // Use final prompt with extra instructions if provided
        branch_id: parent.branch_id,
        created_by, // See resolveChildIdentity — defaults to caller, not parent owner
        unix_username, // Stamped by resolveChildIdentity — this.create() bypasses
        // the setSessionUnixUsername hook so we must set it explicitly here.
        // Strict-mode deployments refuse to launch sessions with null unix_username.
        git_state: { ...parent.git_state },
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
      params
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

    // Session env var selections: explicit envVarNames > copy from parent.
    // Only the parent's creator (now the spawned session's creator) or a
    // global admin may override selections — otherwise silently fall back to
    // copying the parent's selections (the caller cannot see the creator's
    // env var names anyway).
    const callerUserId = params?.user?.user_id as string | undefined;
    const callerRole = params?.user?.role as string | undefined;
    const callerIsCreatorOrAdmin =
      callerUserId === parent.created_by || callerRole === ROLES.ADMIN || isSuperAdmin(callerRole);

    if (data.envVarNames !== undefined && callerIsCreatorOrAdmin) {
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

  private async collectBranchLocalDescendants(root: Session): Promise<Session[]> {
    // Session archive cascades follow the branch-local genealogy tree only.
    // Remote relationships are modeled separately and must not be affected.
    return this.sessionRepo.findBranchLocalDescendants(root.session_id, root.branch_id);
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
    params?: SessionParams
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
    const branchCache = new Map<string, Branch>();

    for (const session of sessions) {
      let branch = branchCache.get(session.branch_id);
      if (!branch) {
        const loadedBranch = await this.branchRepo.findById(session.branch_id);
        if (!loadedBranch) {
          throw new Forbidden(`Branch not found for session: ${session.session_id}`);
        }
        branch = loadedBranch;
        branchCache.set(session.branch_id, branch);
      }

      const access = await this.branchRepo.resolveUserAccess(branch, userId);
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

  private async setArchiveStateForTree(
    id: string,
    archived: boolean,
    options: SessionArchiveOptions | undefined,
    params?: SessionParams
  ): Promise<SessionArchiveResult> {
    const root = await this.get(id, params);
    const includeChildren = options?.includeChildren !== false;
    const descendants = includeChildren ? await this.collectBranchLocalDescendants(root) : [];
    const targets: SessionArchiveTarget[] = [
      {
        session: root,
        archived,
        archivedReason: archived ? MANUAL_ARCHIVED_REASON : null,
      },
    ];

    for (const session of descendants) {
      if (archived) {
        if (!session.archived) {
          targets.push({
            session,
            archived: true,
            archivedReason: PARENT_ARCHIVED_REASON,
          });
        }
        continue;
      }

      if (session.archived_reason === PARENT_ARCHIVED_REASON) {
        targets.push({
          session,
          archived: false,
          archivedReason: null,
        });
      }
    }

    await this.assertCanArchiveSessions(
      targets.map((target) => target.session),
      archived,
      params
    );

    const affectedSessions = await this.sessionRepo.updateArchiveStateForTargets(
      targets.map((target) => ({
        id: target.session.session_id,
        archived: target.archived,
        archivedReason: target.archivedReason,
      }))
    );

    for (const affectedSession of affectedSessions) {
      emitServiceEvent(this.app, {
        path: 'sessions',
        event: 'patched',
        data: affectedSession,
        params,
        id: affectedSession.session_id,
      });
    }

    const [session] = affectedSessions;
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }

    return {
      session,
      affectedSessions,
      count: affectedSessions.length,
    };
  }

  /**
   * Archive a session and, by default, its branch-local descendants.
   *
   * Generic `patch({ archived })` intentionally remains single-row so bulk
   * archive, branch archive, and auto-cleanup paths keep their existing
   * semantics.
   */
  async archive(
    id: string,
    options?: SessionArchiveOptions,
    params?: SessionParams
  ): Promise<SessionArchiveResult> {
    return this.setArchiveStateForTree(id, true, options, params);
  }

  /**
   * Restore a session and, by default, its branch-local descendants.
   */
  async unarchive(
    id: string,
    options?: SessionArchiveOptions,
    params?: SessionParams
  ): Promise<SessionArchiveResult> {
    return this.setArchiveStateForTree(id, false, options, params);
  }

  /**
   * Override remove to cascade delete children (forks and subsessions)
   */
  async remove(
    id: import('@agor/core/types').NullableId,
    params?: SessionParams
  ): Promise<Session | Session[]> {
    // Handle batch delete
    if (id === null) {
      // For multi-delete, get all matching sessions and delete each one
      const sessions = (await super.find(params)) as Session[];
      const results: Session[] = [];

      for (const session of sessions) {
        const deleted = (await this.remove(session.session_id, params)) as Session;
        results.push(deleted);
      }

      return results;
    }

    // Single delete with cascade
    // Get the session before deleting
    const session = await this.get(String(id), params);

    // Find all children (forks and subsessions)
    const children = await this.sessionRepo.findChildren(String(id));

    // Recursively delete all children first
    if (children.length > 0) {
      for (const child of children) {
        await this.remove(child.session_id, params);
      }
    }

    // Now delete the current session (messages and tasks are cascade-deleted by DB)
    await this.sessionRepo.delete(id as string);

    // Emit removed event for WebSocket broadcasting
    this.emit?.('removed', session, params);

    return session;
  }

  /**
   * Override patch to keep durable relationship callback state synchronized
   * with the existing callback_config.enabled execution switch.
   */
  async patch(
    id: import('@agor/core/types').NullableId,
    data: Partial<Session>,
    params?: SessionParams
  ): Promise<Session | Session[]> {
    const result = (await super.patch(id, data, params)) as Session | Session[];

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
      const sortSpec = query?.$sort as { updated_at?: 1 | -1 } | undefined;
      const limit = (query?.$limit as number | undefined) ?? PAGINATION.DEFAULT_LIMIT;
      const skip = (query?.$skip as number | undefined) ?? 0;
      const { data, total } = await this.sessionRepo.findPage({
        boardId: query?.board_id as string | undefined,
        archived: query?.archived as boolean | undefined,
        sortUpdatedAt: sortSpec?.updated_at,
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
  app: Application
): SessionsService {
  return new SessionsService(db, app);
}
