/**
 * Feathers Client for Agor
 *
 * Shared client library for connecting to agor-daemon from CLI and UI
 */

import type {
  AgenticToolName,
  AgenticToolPreset,
  Artifact,
  Board,
  BoardCapabilityPolicies,
  BoardComment,
  BoardCommentCreate,
  BoardCommentPatch,
  BoardCommentReposition,
  BoardExportBlob,
  Branch,
  BranchCapabilityPolicy,
  BranchEnvironmentUpdate,
  BranchFilesystemObservation,
  CapabilityPolicyWorkspacePreferences,
  CardType,
  CardWithType,
  CloneRepositoryResult,
  CreateAgenticToolPreset,
  CreateMCPServerInput,
  CreateSessionInput,
  GatewayChannel,
  GatewayChannelCreateData,
  GatewayChannelPatchData,
  Group,
  GroupMembership,
  KnowledgeDocument,
  KnowledgeDocumentVersion,
  KnowledgeEmbeddingStatus,
  KnowledgeIndexingStatus,
  KnowledgeNamespace,
  KnowledgeNamespaceGraph,
  KnowledgeSearchResult,
  KnowledgeSemanticSettingsPatch,
  KnowledgeSemanticSettingsPublic,
  MCPCatalogConnectData,
  MCPCatalogConnectResult,
  MCPCatalogEntry,
  MCPCatalogReadiness,
  MCPMarketplaceOverview,
  MCPMarketplaceRemoveServerData,
  MCPMarketplaceRemoveServerResult,
  MCPMarketplaceToolPermissionData,
  MCPMarketplaceToolPermissionResult,
  MCPMemberPolicySetting,
  MCPServer,
  Message,
  MessageCreate,
  MessagePatch,
  OpenCodeModelCatalog,
  OpenCodeOAuthAttempt,
  OpenCodeOAuthAttemptPatch,
  OpenCodeOAuthConnectRequest,
  OpenCodeProviderSettings,
  PatchAgenticToolPreset,
  PermissionMode,
  Repo,
  RuntimeTelemetryInput,
  Schedule,
  ScheduleCreateData,
  SchedulePatchData,
  SdkHealthFailureInput,
  Session,
  SessionID,
  SessionUpdate,
  Task,
  TeammateWelcomeNoteRequest,
  TemplateRenderRequest,
  TemplateRenderResponse,
  TenantAgenticToolSettings,
  TenantAgenticToolSettingsPatch,
  UpdateMCPServerInput,
  User,
  UserAvatarSettings,
  UserAvatarSyncRequest,
  UserAvatarSyncResult,
  UserID,
  UUID,
  WorkloadCompletionInput,
  WorkloadCompletionResult,
} from '@agor/core/types';
import authentication, { type AuthenticationClient } from '@feathersjs/authentication-client';
import type { Application, Paginated, Params } from '@feathersjs/feathers';
import { feathers } from '@feathersjs/feathers';
import socketio from '@feathersjs/socketio-client';
import io, { type Socket } from 'socket.io-client';
import { DAEMON, MESSAGE_PAGINATION, PAGINATION } from '../config/constants';

/**
 * Default daemon URL for client connections
 */
const DEFAULT_DAEMON_URL = `http://${DAEMON.DEFAULT_HOST}:${DAEMON.DEFAULT_PORT}`;

/**
 * Symbol used to mark the boards service after custom helpers have been attached.
 * Using a symbol avoids clashing with existing service properties.
 */
const BOARDS_SERVICE_EXTENDED = Symbol('agor.boardsServiceExtended');
const USERS_SERVICE_EXTENDED = Symbol('agor.usersServiceExtended');
const REPOS_SERVICE_EXTENDED = Symbol('agor.reposServiceExtended');
const BRANCHES_SERVICE_EXTENDED = Symbol('agor.branchesServiceExtended');
const TASKS_SERVICE_EXTENDED = Symbol('agor.tasksServiceExtended');
const SERVICE_FIND_ALL_EXTENDED = Symbol('agor.serviceFindAllExtended');
const CLIENT_SERVICE_FACTORY_EXTENDED = Symbol('agor.clientServiceFactoryExtended');
const CLIENT_SESSIONS_HELPERS_EXTENDED = Symbol('agor.clientSessionsHelpersExtended');
const CLIENT_TASKS_HELPERS_EXTENDED = Symbol('agor.clientTasksHelpersExtended');

/**
 * Client-side input type helper:
 * keeps strongly typed output models branded, while accepting plain strings
 * for branded UUID fields in create/update/patch payloads.
 */
export type ClientInput<T> = T extends UUID
  ? string
  : T extends string & { readonly __brand: string }
    ? string
    : T extends readonly (infer U)[]
      ? ClientInput<U>[]
      : T extends (...args: unknown[]) => unknown
        ? T
        : T extends object
          ? { [K in keyof T]: ClientInput<T[K]> }
          : T;

export type CreatePayload<T> = Partial<ClientInput<T>>;
export type UpdatePayload<T> = ClientInput<T>;
export type PatchPayload<T> = Partial<ClientInput<T>> | null;
export type FindResult<T> = Paginated<T> | T[];

export interface SessionPromptRequest {
  prompt: string;
  permissionMode?: PermissionMode;
  stream?: boolean;
}

export interface SessionPromptOptions extends Omit<SessionPromptRequest, 'prompt'> {
  params?: Params;
}

/** Required setup for an already-created session, applied before its first prompt. */
export interface SessionInitializationRequest {
  /** Fence delayed calls to the identity that created the session. */
  expectedUserId: UserID;
  /** Validated and branded after crossing the daemon trust boundary. */
  mcpServerIds?: string[];
  envVarNames?: string[];
  prompt?: string;
  permissionMode?: PermissionMode;
}

export interface SessionInitializationOptions extends SessionInitializationRequest {
  params?: Params;
}

export interface SessionInitializationResult {
  sessionId: SessionID;
  task?: Task;
}

export interface SessionsClientHelpers {
  prompt(sessionId: string, prompt: string, options?: SessionPromptOptions): Promise<Task>;
  initialize(
    sessionId: string,
    options: SessionInitializationOptions
  ): Promise<SessionInitializationResult>;
}

/**
 * Body shape for `POST /tasks/:id/run`. Message provenance is derived by the
 * daemon from the authenticated transport rather than accepted from callers.
 */
export interface TaskRunRequest {
  permissionMode?: PermissionMode;
  stream?: boolean;
}

export interface TaskRunOptions extends TaskRunRequest {
  params?: Params;
}

export interface TasksClientHelpers {
  /**
   * Trigger executor pickup for an already-created task. Pure-REST harnesses
   * use this after `POST /tasks` to avoid needing an MCP client. Returns the
   * Task with `status: 'dispatching'`; the authenticated executor claims it
   * as `running`. Only `'created'` tasks on idle sessions are accepted —
   * `'queued'` tasks drain automatically in queue-position order, and busy
   * sessions should be prompted via `client.sessions.prompt()` (which creates
   * and queues the task atomically).
   */
  run(taskId: string, options?: TaskRunOptions): Promise<Task>;
}

/**
 * Server-side Handlebars renderer. UI sends `{template, context}` via
 * `client.service('templates').create(...)`; daemon returns `{rendered}`.
 * Used so the browser bundle doesn't need Handlebars (avoids CSP
 * `script-src 'unsafe-eval'`).
 *
 * Transport DTOs live in `@agor/core/types/template.ts` so the daemon
 * service and this client typing share one shape.
 */
export type { TemplateRenderRequest, TemplateRenderResponse };

export interface TemplatesService {
  create(data: TemplateRenderRequest, params?: Params): Promise<TemplateRenderResponse>;
}

export interface MCPMarketplaceService {
  find(params?: Params): Promise<MCPMarketplaceOverview>;
}

export interface MCPMarketplaceRemoveServerService {
  create(
    data: MCPMarketplaceRemoveServerData,
    params?: Params
  ): Promise<MCPMarketplaceRemoveServerResult>;
}

export interface MCPMarketplaceToolPermissionService {
  create(
    data: MCPMarketplaceToolPermissionData,
    params?: Params
  ): Promise<MCPMarketplaceToolPermissionResult>;
}

export interface BoardPermissionsService {
  find(params?: Params): Promise<BoardCapabilityPolicies>;
  patch(
    id: null,
    data: ClientInput<BoardCapabilityPolicies>,
    params?: Params
  ): Promise<BoardCapabilityPolicies>;
}

export interface BranchPermissionsService {
  find(params?: Params): Promise<BranchCapabilityPolicy>;
  patch(
    id: null,
    data: ClientInput<BranchCapabilityPolicy>,
    params?: Params
  ): Promise<BranchCapabilityPolicy>;
}

/** Read-only, path-free observation of a Branch's server-owned filesystem root. */
export interface BranchFilesystemStatusService {
  find(params?: Params): Promise<BranchFilesystemObservation>;
}

export interface WorkspacePreferencesService {
  find(params?: Params): Promise<CapabilityPolicyWorkspacePreferences>;
  patch(
    id: null,
    data: CapabilityPolicyWorkspacePreferences,
    params?: Params
  ): Promise<CapabilityPolicyWorkspacePreferences>;
}

/**
 * Service interfaces for type safety
 */
export interface ServiceTypes {
  sessions: Session;
  tasks: Task;
  'board-comments': BoardComment;
  boards: Board;
  repos: Repo;
  'repos/clone': Repo;
  'repos/local': Repo;
  branches: Branch;
  schedules: Schedule;
  'gateway-channels': GatewayChannel;
  users: User;
  groups: Group;
  'group-memberships': GroupMembership;
  'boards/:id/permissions': BoardCapabilityPolicies;
  'branches/:id/permissions': BranchCapabilityPolicy;
  'workspace-preferences': CapabilityPolicyWorkspacePreferences;
  cards: CardWithType;
  'card-types': CardType; // CardType CRUD
  artifacts: Artifact;
  'mcp-servers': MCPServer;
  'mcp-catalog': MCPCatalogEntry;
  'mcp-catalog/readiness': MCPCatalogReadiness;
  'mcp-catalog/connect': MCPCatalogConnectResult;
  'mcp-marketplace': MCPMarketplaceOverview;
  'mcp-marketplace/remove-unattached': MCPMarketplaceRemoveServerResult;
  'mcp-marketplace/tool-permission': MCPMarketplaceToolPermissionResult;
  'mcp-member-policy': MCPMemberPolicySetting;
  'kb/namespaces': KnowledgeNamespace;
  'kb/documents': KnowledgeDocument;
  'kb/versions': KnowledgeDocumentVersion;
  'kb/search': KnowledgeSearchResult;
  'kb/graph': KnowledgeNamespaceGraph;
  'kb/settings': KnowledgeSemanticSettingsPublic;
  'kb/indexing/status': KnowledgeIndexingStatus;
  'kb/indexing/reindex': { queued: number; status: KnowledgeEmbeddingStatus };
  templates: TemplateRenderResponse;
  'agentic-tool-settings': TenantAgenticToolSettings;
  'agentic-tool-presets': AgenticToolPreset;
  'opencode-auth': OpenCodeProviderSettings;
  'opencode-models': OpenCodeModelCatalog;
  'executor-git-environment': ExecutorGitEnvironment;
}

/**
 * Bounded plaintext capability returned only to authenticated Git executors.
 *
 * Keep this public client DTO structural: `@agor/git` is a private workspace
 * package and must not appear in the packed `@agor-live/client` declaration
 * graph. A daemon-side type-equivalence test keeps it aligned with the
 * authoritative Git transport allowlist.
 */
export interface ExecutorGitEnvironment {
  GITHUB_TOKEN?: string;
  GH_TOKEN?: string;
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  NO_PROXY?: string;
  ALL_PROXY?: string;
  SSL_CERT_FILE?: string;
  SSL_CERT_DIR?: string;
}

/**
 * Feathers service with find method properly typed and event emitter methods
 */
export interface AgorService<
  T,
  TCreate = CreatePayload<T>,
  TUpdate = UpdatePayload<T>,
  TPatch = PatchPayload<T>,
> {
  // CRUD methods
  find(params?: Params): Promise<FindResult<T>>;
  findAll(params?: Params): Promise<T[]>;
  get(id: string, params?: Params): Promise<T>;
  create(data: TCreate, params?: Params): Promise<T>;
  update(id: string, data: TUpdate, params?: Params): Promise<T>;
  patch(id: string | null, data: TPatch, params?: Params): Promise<T>;
  remove(id: string, params?: Params): Promise<T>;

  // Event emitter methods (for real-time updates)
  // Standard CRUD events use the service entity type T
  on(event: 'created' | 'updated' | 'patched' | 'removed', handler: (data: T) => void): void;
  // Custom events (e.g. permission_resolved, queued)
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS event handlers have varied signatures
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: 'created' | 'updated' | 'patched' | 'removed', handler: (data: T) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS event handlers have varied signatures
  off(event: string, handler: (...args: any[]) => void): void;
  removeListener(
    event: 'created' | 'updated' | 'patched' | 'removed',
    handler: (data: T) => void
  ): void;
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS event handlers have varied signatures
  removeListener(event: string, handler: (...args: any[]) => void): void;

  // Emit custom events to WebSocket clients (available at runtime via FeathersJS socket.io integration)
  emit(event: string, data: unknown): void;
}

/** Schedules return storage-facing rows but accept active-only public write data. */
export interface SchedulesService
  extends AgorService<
    Schedule,
    ClientInput<ScheduleCreateData>,
    never,
    ClientInput<SchedulePatchData> | null
  > {}

/** Gateway channels return storage-facing rows but accept active-only public write data. */
export interface GatewayChannelsService
  extends AgorService<
    GatewayChannel,
    ClientInput<GatewayChannelCreateData>,
    never,
    ClientInput<GatewayChannelPatchData> | null
  > {}

/** MCP servers expose redacted entities but accept purpose-built auth patch DTOs. */
export type MCPServersService = AgorService<
  MCPServer,
  ClientInput<CreateMCPServerInput>,
  ClientInput<UpdateMCPServerInput>,
  ClientInput<UpdateMCPServerInput> | null
>;

export type AgenticToolSettingsService = AgorService<
  TenantAgenticToolSettings,
  never,
  never,
  TenantAgenticToolSettingsPatch
>;

export type AgenticToolPresetsService = AgorService<
  AgenticToolPreset,
  CreateAgenticToolPreset,
  never,
  PatchAgenticToolPreset
>;

/** Singleton workspace Knowledge semantic-search settings endpoint. */
export interface KnowledgeSettingsService {
  find(params?: Params): Promise<KnowledgeSemanticSettingsPublic>;
  create(
    data: KnowledgeSemanticSettingsPatch,
    params?: Params
  ): Promise<KnowledgeSemanticSettingsPublic>;
  patch(
    id: null,
    data: KnowledgeSemanticSettingsPatch,
    params?: Params
  ): Promise<KnowledgeSemanticSettingsPublic>;
}

/** Singleton workspace Knowledge indexing status endpoint. */
export interface KnowledgeIndexingStatusService {
  find(params?: Params): Promise<KnowledgeIndexingStatus>;
}

/** Workspace-wide Knowledge reindex command endpoint. */
export interface KnowledgeReindexService {
  create(
    data?: Record<string, never>,
    params?: Params
  ): Promise<{ queued: number; status: KnowledgeEmbeddingStatus }>;
}

export interface OpenCodeAuthService {
  find(params?: Params): Promise<OpenCodeProviderSettings>;
  get(attemptId: string, params?: Params): Promise<OpenCodeOAuthAttempt>;
  create(
    data:
      | { providerId: string; apiKey: string; metadata?: Record<string, string> }
      | OpenCodeOAuthConnectRequest,
    params?: Params
  ): Promise<OpenCodeProviderSettings | OpenCodeOAuthAttempt>;
  patch(
    attemptId: string,
    data: OpenCodeOAuthAttemptPatch,
    params?: Params
  ): Promise<OpenCodeOAuthAttempt>;
  remove(providerId: string, params?: Params): Promise<OpenCodeProviderSettings>;
}

export interface OpenCodeModelsService {
  find(params?: Params): Promise<OpenCodeModelCatalog>;
}

/**
 * Marketplace connect command endpoint.
 *
 * Create-only: it installs one catalog entry and returns the session that can
 * use it. There is nothing to read back, so it exposes no find/get.
 */
export interface MCPCatalogConnectService {
  create(data: MCPCatalogConnectData, params?: Params): Promise<MCPCatalogConnectResult>;
}

/**
 * Singleton tenant-wide MCP member policy endpoint.
 *
 * Readable by members — the value explains why a write of theirs was refused —
 * and writable by admins. The daemon enforces both; this typing only describes
 * the shape.
 */
export interface MCPMemberPolicyService {
  find(params?: Params): Promise<MCPMemberPolicySetting>;
  // `can_configure` is the daemon's answer about the caller, not a field a
  // caller submits, so a write names the policy and nothing else.
  patch(
    id: null,
    data: Pick<MCPMemberPolicySetting, 'policy'>,
    params?: Params
  ): Promise<MCPMemberPolicySetting>;
}

/**
 * Sessions service with custom methods for forking, spawning, and genealogy
 */
export interface SessionsService
  extends AgorService<
    Session,
    CreatePayload<CreateSessionInput>,
    ClientInput<SessionUpdate>,
    ClientInput<SessionUpdate>
  > {
  /**
   * Fork a session at a decision point
   * Creates a new session branching from the parent at a specific task
   */
  fork(id: string, data: { prompt: string; task_id?: string }, params?: Params): Promise<Session>;

  /**
   * Spawn a child session from a parent
   * Creates a new session with the parent's context
   */
  spawn(
    id: string,
    data: { prompt: string; agent?: string; task_id?: string },
    params?: Params
  ): Promise<Session>;

  /**
   * Get genealogy tree for a session
   * Returns the full ancestor/descendant tree
   */
  getGenealogy(id: string, params?: Params): Promise<unknown>;
}

/** Tasks service with lifecycle methods. */
export interface TasksService extends AgorService<Task> {
  /** Claim a daemon-dispatched task after executor authentication. */
  connectExecutor(data: { task_id: string }, params?: Params): Promise<Task>;
  /** Report that a requested cooperative stop has fully quiesced SDK work. */
  reportTerminationComplete(
    data: import('../types/task').ExecutorTerminationCompleteInput,
    params?: Params
  ): Promise<Task>;
  /** Report daemon-stamped wrapper liveness and the latest coalesced SDK pulse. */
  reportRuntimeTelemetry(data: RuntimeTelemetryInput, params?: Params): Promise<Task>;
  /** Report a daemon-authorized SDK watchdog decision. */
  reportSdkHealthFailure(data: SdkHealthFailureInput, params?: Params): Promise<Task>;
  /** Atomically publish a built-in workload result and settle its Task. */
  completeWorkload(
    data: WorkloadCompletionInput,
    params?: Params
  ): Promise<WorkloadCompletionResult>;
  /** Replay an already-committed workload settlement after token retirement. */
  reconcileWorkloadCompletion(
    data: WorkloadCompletionInput,
    params?: Params
  ): Promise<WorkloadCompletionResult>;
  /**
   * Mark a task as completed
   */
  complete(id: string, data: { report?: unknown }, params?: Params): Promise<Task>;

  /**
   * Mark a task as failed
   */
  fail(id: string, data: { error: string }, params?: Params): Promise<Task>;
}

/** Public Message CRUD surface. Full replacement is daemon-internal. */
export type MessagesService = Omit<
  AgorService<Message, ClientInput<MessageCreate>>,
  'update' | 'patch'
> & {
  patch(id: string, data: ClientInput<MessagePatch>, params?: Params): Promise<Message>;
};

/** Public comment CRUD surface; spatial movement and reactions use custom routes. */
export type BoardCommentsService = Omit<
  AgorService<BoardComment, ClientInput<BoardCommentCreate>, never, ClientInput<BoardCommentPatch>>,
  'update'
>;

/** Dedicated comment-position command; the URL supplies the comment identity. */
export interface BoardCommentRepositionService {
  create(data: ClientInput<BoardCommentReposition>, params?: Params): Promise<BoardComment>;
}

/**
 * Repos service with branch management
 */
export interface ReposService extends AgorService<Repo> {
  /**
   * Create a git branch for a repository.
   *
   * Shape matches the daemon's `/repos/:id/branches` route + Feathers
   * service. Keep this in sync with `RepoService.createBranch()` in
   * apps/agor-daemon/src/services/repos.ts — drift here means CLI/client
   * consumers silently drop fields.
   */
  createBranch(
    id: string,
    data: {
      name: string;
      ref: string;
      refType?: 'branch' | 'tag';
      createBranch?: boolean;
      pullLatest?: boolean;
      sourceBranch?: string;
      /** Remote that owns sourceBranch when it differs from this destination repo. */
      sourceRemoteUrl?: string;
      issue_url?: string;
      pull_request_url?: string;
      boardId: string;
      custom_context?: Record<string, unknown>;
      notes?: string | null;
      /** Explicit board position. Honored as-is when supplied. */
      position?: { x: number; y: number };
      zoneId?: string;
      environment_variant?: string;
      /**
       * Branch storage model — see
       * context/explorations/clone-redesign.md.
       * 'worktree' (default) = native `git worktree add`.
       * 'clone' = self-standing `git clone` with its own `.git/`.
       */
      storage_mode?: 'worktree' | 'clone';
      /** Shallow clone depth (only when storage_mode='clone'). */
      clone_depth?: number;
    },
    params?: Params
  ): Promise<Branch>;

  /**
   * Remove a git branch
   */
  removeBranch(id: string, name: string, params?: Params): Promise<Repo>;
}

export interface ReposLocalService extends AgorService<Repo> {
  create(data: { path: string; slug?: string }, params?: Params): Promise<Repo>;
}

/**
 * `POST /repos/clone` returns the async `CloneRepositoryResult` envelope
 * (status + repo_id for polling), not a fully-materialized `Repo`. Declared
 * as a minimal standalone interface (not `AgorService<Repo>`) because
 * overriding `create()` with a non-`Repo` return type would be a structural
 * mismatch on the base service. Callers should fetch the full `Repo` via
 * `client.service('repos').get(repo_id)` once polling shows `clone_status:
 * 'ready'`.
 */
export interface ReposCloneService {
  create(
    data: { url: string; name?: string; slug?: string; default_branch?: string },
    params?: Params
  ): Promise<CloneRepositoryResult>;
}

/**
 * Boards service with export/import/clone functionality
 */
export interface BoardsService extends AgorService<Board> {
  /**
   * Export board to a portable JSON blob
   */
  toBlob(
    data: { id?: string; boardId?: string } | string,
    params?: Params
  ): Promise<BoardExportBlob>;

  /**
   * Import board from a JSON blob
   */
  fromBlob(blob: BoardExportBlob, params?: Params): Promise<Board>;

  /**
   * Export board to YAML string
   */
  toYaml(data: { id?: string; boardId?: string } | string, params?: Params): Promise<string>;

  /**
   * Import board from YAML string
   */
  fromYaml(data: { yaml?: string; content?: string } | string, params?: Params): Promise<Board>;

  /**
   * Clone an existing board with a new name
   */
  clone(
    data: { id?: string; boardId?: string; name?: string } | string,
    newName?: string,
    params?: Params
  ): Promise<Board>;

  /**
   * Set or clear the board's primary teammate branch.
   */
  setPrimaryTeammate(
    data: { id?: string; boardId?: string; branchId: string },
    params?: Params
  ): Promise<Board>;
  clearPrimaryTeammate(boardId: string, params?: Params): Promise<Board>;

  /**
   * Create the bundled teammate welcome markdown note when missing. Rendering
   * happens server-side from a static template; callers only provide values.
   */
  ensureTeammateWelcomeNote(data: TeammateWelcomeNoteRequest, params?: Params): Promise<Board>;
}

/** Users service custom methods. */
export interface UsersService extends AgorService<User> {
  getAvatarSettings(data?: unknown, params?: Params): Promise<UserAvatarSettings>;
  updateAvatarSettings(
    data: Partial<UserAvatarSettings>,
    params?: Params
  ): Promise<UserAvatarSettings>;
  syncAvatars(data?: UserAvatarSyncRequest, params?: Params): Promise<UserAvatarSyncResult>;
  /**
   * Resolve the calling user's primary teammate branch, or null when unset or
   * no longer accessible.
   */
  getPrimaryTeammate(data?: unknown, params?: Params): Promise<Branch | null>;
  /** List active teammate branches the caller can start sessions on. */
  getPrimaryTeammateCandidates(data?: unknown, params?: Params): Promise<Branch[]>;
  /**
   * Set the calling user's primary teammate to an accessible branch,
   * recorded as an explicit user pick.
   */
  setPrimaryTeammate(
    data: { branchId: string; expectedUserId: UserID },
    params?: Params
  ): Promise<Branch | null>;
  /** Set an onboarding/default teammate only when the caller is still unset. */
  setPrimaryTeammateIfUnset(
    data: { branchId: string; expectedUserId: UserID },
    params?: Params
  ): Promise<Branch | null>;
  /** Seed the caller's primary coding agent without overwriting an existing preference. */
  setPrimaryAgenticToolIfUnset(
    data: { tool: AgenticToolName; expectedUserId: UserID },
    params?: Params
  ): Promise<User>;
}

/**
 * Branches service with environment management
 */
export interface BranchesService extends AgorService<Branch> {
  /**
   * Create or repair the primary Knowledge namespace for a teammate branch.
   * API/UI-only; not exposed through teammate MCP config mutation tools.
   */
  ensureTeammateKnowledgeNamespace(
    data: { branchId?: string; branch_id?: string } | string,
    params?: Params
  ): Promise<{ namespace: KnowledgeNamespace; branch: Branch }>;
  /**
   * Find branch by repo_id and name
   */
  findByRepoAndName(repoId: string, name: string, params?: Params): Promise<Branch | null>;

  /**
   * Add session to branch
   */
  addSession(id: string, sessionId: string, params?: Params): Promise<Branch>;

  /**
   * Remove session from branch
   */
  removeSession(id: string, sessionId: string, params?: Params): Promise<Branch>;

  /**
   * Add branch to board
   */
  addToBoard(id: string, boardId: string, params?: Params): Promise<Branch>;

  /**
   * Remove branch from board
   */
  removeFromBoard(id: string, params?: Params): Promise<Branch>;

  /**
   * Update environment status
   */
  updateEnvironment(
    data:
      | {
          branch_id?: string;
          branchId?: string;
          environment_update?: BranchEnvironmentUpdate;
          environmentUpdate?: BranchEnvironmentUpdate;
        }
      | string,
    environmentUpdate?: BranchEnvironmentUpdate,
    params?: Params
  ): Promise<Branch>;

  /**
   * Start branch environment
   */
  startEnvironment(id: string, params?: Params): Promise<Branch>;

  /**
   * Stop branch environment
   */
  stopEnvironment(id: string, params?: Params): Promise<Branch>;

  /**
   * Restart branch environment
   */
  restartEnvironment(id: string, params?: Params): Promise<Branch>;

  /**
   * Check environment health
   */
  checkHealth(id: string, params?: Params): Promise<Branch>;

  /**
   * Archive or delete a branch with filesystem cleanup options
   */
  archiveOrDelete(
    id: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    },
    params?: Params
  ): Promise<Branch | { deleted: true; branch_id: string }>;

  /**
   * Unarchive a branch
   */
  unarchive(id: string, options?: { boardId?: string }, params?: Params): Promise<Branch>;
}

/**
 * Agor client with socket.io connection exposed for lifecycle management
 */
type AuthenticationClientSurface = {
  authentication: AuthenticationClient;
  authenticate: AuthenticationClient['authenticate'];
  reAuthenticate: AuthenticationClient['reAuthenticate'];
  logout: AuthenticationClient['logout'];
};

/**
 * Common Agor service client surface. Socket clients intentionally exclude
 * Feathers' live authentication methods; REST clients add them through
 * {@link AuthenticatedAgorClient}.
 */
export interface AgorClient
  extends Omit<
    Application<ServiceTypes>,
    'service' | 'authentication' | 'authenticate' | 'reAuthenticate' | 'logout'
  > {
  io: Socket;
  sessions: SessionsClientHelpers;
  tasks: TasksClientHelpers;

  // Typed service overloads for services with custom methods
  service(path: 'sessions'): SessionsService;
  service(path: 'tasks'): TasksService;
  service(path: 'messages'): MessagesService;
  service(path: 'board-comments'): BoardCommentsService;
  service(path: 'repos'): ReposService;
  service(path: 'repos/clone'): ReposCloneService;
  service(path: 'repos/local'): ReposLocalService;
  service(path: 'branches'): BranchesService;
  service(path: 'boards'): BoardsService;
  service(path: 'boards/:id/permissions'): BoardPermissionsService;
  service(path: 'branches/:id/permissions'): BranchPermissionsService;
  service(path: `branches/${string}/filesystem-status`): BranchFilesystemStatusService;
  service(path: 'workspace-preferences'): WorkspacePreferencesService;
  service(path: 'schedules'): SchedulesService;
  service(path: 'gateway-channels'): GatewayChannelsService;
  service(path: 'kb/settings'): KnowledgeSettingsService;
  service(path: 'kb/indexing/status'): KnowledgeIndexingStatusService;
  service(path: 'kb/indexing/reindex'): KnowledgeReindexService;
  service(path: 'agentic-tool-settings'): AgenticToolSettingsService;
  service(path: 'agentic-tool-presets'): AgenticToolPresetsService;
  service(path: 'opencode-auth'): OpenCodeAuthService;
  service(path: 'opencode-models'): OpenCodeModelsService;
  service(path: `board-comments/${string}/reposition`): BoardCommentRepositionService;

  // Standard services (CRUD only)
  service(path: 'cards'): AgorService<CardWithType>;
  service(path: 'card-types'): AgorService<CardType>;
  service(path: 'users'): UsersService;
  service(path: 'mcp-servers'): MCPServersService;
  service(path: 'mcp-catalog'): AgorService<MCPCatalogEntry>;
  service(path: 'mcp-catalog/readiness'): AgorService<MCPCatalogReadiness>;
  service(path: 'mcp-catalog/connect'): MCPCatalogConnectService;
  service(path: 'mcp-marketplace'): MCPMarketplaceService;
  service(path: 'mcp-marketplace/remove-unattached'): MCPMarketplaceRemoveServerService;
  service(path: 'mcp-marketplace/tool-permission'): MCPMarketplaceToolPermissionService;
  service(path: 'mcp-member-policy'): MCPMemberPolicyService;
  service(path: 'templates'): TemplatesService;

  // Generic fallback for custom routes and dynamic paths
  service<K extends keyof ServiceTypes>(path: K): AgorService<ServiceTypes[K]>;
  service(path: string): AgorService<unknown>;
}

/** REST-capable client with the normal Feathers authentication API. */
export type AuthenticatedAgorClient = AgorClient & AuthenticationClientSurface;

type BoardsServiceInternal = AgorService<Board> &
  Partial<BoardsService> & {
    [BOARDS_SERVICE_EXTENDED]?: boolean;
  };

function extendBoardsService(client: AgorClient): void {
  const boardsService = client.service('boards') as BoardsServiceInternal & {
    methods?: (names: string[]) => unknown;
  };

  if (boardsService[BOARDS_SERVICE_EXTENDED]) {
    return;
  }

  const registerMethods = (service: BoardsServiceInternal) => {
    const methodsFn = (
      service as unknown as {
        methods?: (...names: string[]) => unknown;
      }
    ).methods;

    if (typeof methodsFn === 'function') {
      methodsFn.call(
        service,
        'toBlob',
        'fromBlob',
        'toYaml',
        'fromYaml',
        'clone',
        'setPrimaryTeammate',
        'clearPrimaryTeammate',
        'ensureTeammateWelcomeNote'
      );
    }
  };

  registerMethods(boardsService);

  const rawToBlob = (
    boardsService as unknown as {
      toBlob?: (data: unknown, params?: Params) => Promise<BoardExportBlob>;
    }
  ).toBlob?.bind(boardsService);

  if (rawToBlob) {
    boardsService.toBlob = (data: { id?: string; boardId?: string } | string, params?: Params) => {
      if (typeof data === 'string') {
        return rawToBlob({ boardId: data }, params);
      }
      return rawToBlob(data, params);
    };
  }

  const rawFromBlob = (
    boardsService as unknown as {
      fromBlob?: (data: BoardExportBlob, params?: Params) => Promise<Board>;
    }
  ).fromBlob?.bind(boardsService);

  if (rawFromBlob) {
    boardsService.fromBlob = (blob: BoardExportBlob, params?: Params) => rawFromBlob(blob, params);
  }

  const rawToYaml = (
    boardsService as unknown as {
      toYaml?: (data: unknown, params?: Params) => Promise<string>;
    }
  ).toYaml?.bind(boardsService);

  if (rawToYaml) {
    boardsService.toYaml = (data: { id?: string; boardId?: string } | string, params?: Params) => {
      if (typeof data === 'string') {
        return rawToYaml({ boardId: data }, params);
      }
      return rawToYaml(data, params);
    };
  }

  const rawFromYaml = (
    boardsService as unknown as {
      fromYaml?: (data: unknown, params?: Params) => Promise<Board>;
    }
  ).fromYaml?.bind(boardsService);

  if (rawFromYaml) {
    boardsService.fromYaml = (
      data: { yaml?: string; content?: string } | string,
      params?: Params
    ) => {
      if (typeof data === 'string') {
        return rawFromYaml({ yaml: data }, params);
      }
      return rawFromYaml(data, params);
    };
  }

  const rawClone = (
    boardsService as unknown as {
      clone?: (data: unknown, params?: Params) => Promise<Board>;
    }
  ).clone?.bind(boardsService);

  if (rawClone) {
    boardsService.clone = (
      data: { id?: string; boardId?: string; name?: string } | string,
      newNameOrParams?: string | Params,
      maybeParams?: Params
    ) => {
      if (typeof data === 'string') {
        if (typeof newNameOrParams !== 'string') {
          throw new Error('Board name required');
        }
        return rawClone({ boardId: data, name: newNameOrParams }, maybeParams);
      }

      const params =
        (typeof newNameOrParams === 'object' ? (newNameOrParams as Params) : undefined) ??
        maybeParams;
      return rawClone(data, params);
    };
  }

  boardsService[BOARDS_SERVICE_EXTENDED] = true;
}

export function normalizeFindResult<T>(result: FindResult<T>): T[] {
  return Array.isArray(result) ? result : result.data;
}

function isPaginatedResult<T>(result: FindResult<T>): result is Paginated<T> {
  return (
    !Array.isArray(result) &&
    typeof result === 'object' &&
    result !== null &&
    Array.isArray((result as Paginated<T>).data)
  );
}

function isAscendingHydrationSort(path: string, sort: unknown): boolean {
  if (sort === undefined) return true;
  if (!sort || typeof sort !== 'object' || Array.isArray(sort)) return false;
  const entries = Object.entries(sort);
  if (path === 'messages') {
    return (
      entries.length >= 1 &&
      entries.length <= 2 &&
      entries[0][0] === 'index' &&
      entries[0][1] === 1 &&
      (entries.length === 1 || (entries[1][0] === 'message_id' && entries[1][1] === 1))
    );
  }
  return (
    entries.length === 2 &&
    entries[0][0] === 'created_at' &&
    entries[0][1] === 1 &&
    entries[1][0] === 'task_id' &&
    entries[1][1] === 1
  );
}

function hydrationKeysetFor(
  path: string,
  query: Record<string, unknown>
): { idField: 'message_id' | 'task_id'; pageLimit: number } | null {
  if (query.$skip !== undefined && query.$skip !== 0) return null;
  if (query.$select !== undefined) return null;
  if (!isAscendingHydrationSort(path, query.$sort)) return null;

  if (
    path === 'messages' &&
    query.message_id === undefined &&
    (typeof query.task_id === 'string' || typeof query.session_id === 'string')
  ) {
    return { idField: 'message_id', pageLimit: MESSAGE_PAGINATION.MAX_LIMIT };
  }
  if (path === 'tasks' && query.task_id === undefined && typeof query.session_id === 'string') {
    return { idField: 'task_id', pageLimit: PAGINATION.MAX_LIMIT };
  }
  return null;
}

function sortHydratedRows(path: string, rows: unknown[]): unknown[] {
  if (path === 'messages') {
    return rows.sort((left, right) => {
      const a = left as { index?: unknown; message_id?: unknown };
      const b = right as { index?: unknown; message_id?: unknown };
      const indexDiff = Number(a.index ?? 0) - Number(b.index ?? 0);
      return indexDiff || String(a.message_id).localeCompare(String(b.message_id));
    });
  }
  return rows.sort((left, right) => {
    const a = left as { created_at?: unknown; task_id?: unknown };
    const b = right as { created_at?: unknown; task_id?: unknown };
    const createdDiff =
      new Date(String(a.created_at)).getTime() - new Date(String(b.created_at)).getTime();
    return createdDiff || String(a.task_id).localeCompare(String(b.task_id));
  });
}

const MAX_HYDRATION_STABILITY_ATTEMPTS = 3;

class HydrationMembershipChangedError extends Error {}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function scanAtIdHighWater(
  service: AgorService<unknown>,
  params: Params | undefined,
  path: string,
  idField: 'message_id' | 'task_id',
  pageLimit: number,
  idsOnly = false
): Promise<{ rows: unknown[]; ids: string[] }> {
  const originalQuery =
    params?.query && typeof params.query === 'object'
      ? ({ ...params.query } as Record<string, unknown>)
      : {};
  const baseQuery = { ...originalQuery };
  delete baseQuery.$limit;
  delete baseQuery.$skip;
  delete baseQuery.$sort;
  delete baseQuery.$select;
  delete baseQuery[idField];

  // Capture a traversal boundary. IDs are immutable but deliberately are not
  // monotonic by commit time, so the caller verifies every multi-page walk
  // against a second collection before accepting it as one stable membership
  // view.
  const boundaryResult = await service.find({
    ...(params ?? {}),
    query: {
      ...baseQuery,
      $sort: { [idField]: -1 },
      $limit: 1,
      $select: [idField],
    },
  });
  const boundaryData = normalizeFindResult(boundaryResult);
  if (boundaryData.length === 0) return { rows: [], ids: [] };
  const through = (boundaryData[0] as Record<string, unknown>)[idField];
  if (typeof through !== 'string') {
    throw new Error(`Cannot hydrate ${path}: boundary page omitted ${idField}`);
  }

  const rows: unknown[] = [];
  let after: string | undefined;
  for (;;) {
    const cursor = after ? { $gt: after, $lte: through } : { $lte: through };
    const pageResult = await service.find({
      ...(params ?? {}),
      query: {
        ...baseQuery,
        [idField]: cursor,
        $sort: { [idField]: 1 },
        $limit: pageLimit,
        ...(idsOnly ? { $select: [idField] } : {}),
      },
    });
    const page = normalizeFindResult(pageResult);
    if (page.length === 0) {
      throw new HydrationMembershipChangedError(
        `Cannot hydrate ${path}: keyset ended before ${idField} high-water mark`
      );
    }

    for (const row of page) {
      const id = (row as Record<string, unknown>)[idField];
      if (typeof id !== 'string' || (after !== undefined && id <= after) || id > through) {
        throw new HydrationMembershipChangedError(
          `Cannot hydrate ${path}: ${idField} keyset did not advance`
        );
      }
      after = id;
      rows.push(row);
    }
    // Do not infer exhaustion from the requested limit. An older/more
    // conservative daemon may clamp the page below this client's compiled-in
    // ceiling. The immutable boundary (or an actually empty page) is the only
    // version-skew-safe completion signal for this keyset walk.
    if (after === through) break;
  }

  return { rows, ids: rows.map((row) => String((row as Record<string, unknown>)[idField])) };
}

async function findAllAtStableIdMembership(
  service: AgorService<unknown>,
  params: Params | undefined,
  path: string,
  idField: 'message_id' | 'task_id',
  pageLimit: number
): Promise<unknown[]> {
  const originalQuery =
    params?.query && typeof params.query === 'object'
      ? ({ ...params.query } as Record<string, unknown>)
      : {};
  const probeResult = await service.find({
    ...(params ?? {}),
    query: {
      ...originalQuery,
      $sort: { [idField]: 1 },
      $limit: pageLimit,
    },
  });
  const probe = normalizeFindResult(probeResult);
  if (!isPaginatedResult(probeResult) || probe.length < probeResult.limit) {
    return sortHydratedRows(path, probe);
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_HYDRATION_STABILITY_ATTEMPTS; attempt += 1) {
    try {
      const candidate = await scanAtIdHighWater(service, params, path, idField, pageLimit);
      const verification = await scanAtIdHighWater(service, params, path, idField, pageLimit, true);
      if (sameIds(candidate.ids, verification.ids)) {
        return sortHydratedRows(path, candidate.rows);
      }
      lastError = new HydrationMembershipChangedError(
        `Cannot hydrate ${path}: membership changed while keyset pages were being read`
      );
    } catch (error) {
      if (!(error instanceof HydrationMembershipChangedError)) throw error;
      lastError = error;
    }
  }

  throw (
    lastError ??
    new HydrationMembershipChangedError(
      `Cannot hydrate ${path}: membership did not stabilize after bounded retries`
    )
  );
}

function extendFindAllOnService(service: AgorService<unknown>, rawPath: string): void {
  const findAllService = service as AgorService<unknown> & {
    [SERVICE_FIND_ALL_EXTENDED]?: boolean;
  };

  if (findAllService[SERVICE_FIND_ALL_EXTENDED]) {
    return;
  }

  findAllService.findAll = async (params?: Params) => {
    const path = rawPath.replace(/^\//, '');
    const query =
      params?.query && typeof params.query === 'object'
        ? (params.query as Record<string, unknown>)
        : {};
    const keyset = hydrationKeysetFor(path, query);
    if (keyset) {
      return findAllAtStableIdMembership(service, params, path, keyset.idField, keyset.pageLimit);
    }

    const firstResult = await service.find(params);
    if (!isPaginatedResult(firstResult)) {
      return firstResult;
    }

    const allData = [...firstResult.data];
    const total = firstResult.total;
    // Feathers `total` describes the whole matching query, not the tail that
    // begins at `$skip`. Preserve the caller's offset semantics while still
    // validating that every continuation page belongs to one stable walk.
    const initialSkip = firstResult.skip;
    const expectedRows = Math.max(0, total - initialSkip);
    let nextSkip = firstResult.skip + firstResult.data.length;
    const pageLimit =
      typeof firstResult.limit === 'number' && firstResult.limit > 0
        ? firstResult.limit
        : firstResult.data.length;

    if (!Number.isFinite(total) || pageLimit <= 0) {
      return allData;
    }

    const baseQuery =
      params?.query && typeof params.query === 'object' ? { ...params.query } : undefined;

    while (allData.length < expectedRows) {
      const nextParams: Params = {
        ...(params ?? {}),
        query: {
          ...(baseQuery ?? {}),
          $skip: nextSkip,
          $limit: pageLimit,
        },
      };

      const nextResult = await service.find(nextParams);
      if (!isPaginatedResult(nextResult)) {
        throw new Error('Paginated findAll() received a non-paginated continuation page');
      }

      if (nextResult.total !== total || nextResult.skip !== nextSkip) {
        throw new Error('Paginated findAll() changed while pages were being read');
      }
      if (nextResult.data.length === 0) {
        throw new Error('Paginated findAll() ended before the advertised total');
      }

      allData.push(...nextResult.data);
      nextSkip = nextResult.skip + nextResult.data.length;
    }

    if (allData.length !== expectedRows) {
      throw new Error('Paginated findAll() did not return the advertised total');
    }

    return allData;
  };

  findAllService[SERVICE_FIND_ALL_EXTENDED] = true;
}

/**
 * Wire client-side custom methods for services that expose RPCs beyond the
 * standard Feathers CRUD interface. The Socket.io client only wires the
 * default methods at construction time, so each path that has custom methods
 * on the server must call `service.methods(...)` here too — otherwise calling
 * them on the client proxy throws "client.service(...).<method> is not a
 * function". Keep these in sync with the `methods:` arrays in
 * `apps/agor-daemon/src/register-services.ts`.
 */
function extendUsersService(client: AgorClient): void {
  const usersService = client.service('users') as AgorService<User> & {
    [USERS_SERVICE_EXTENDED]?: boolean;
    methods?: (...names: string[]) => unknown;
  };
  if (usersService[USERS_SERVICE_EXTENDED]) return;
  if (typeof usersService.methods === 'function') {
    usersService.methods(
      'getAvatarSettings',
      'updateAvatarSettings',
      'syncAvatars',
      'getPrimaryTeammate',
      'getPrimaryTeammateCandidates',
      'setPrimaryTeammate',
      'setPrimaryTeammateIfUnset',
      'setPrimaryAgenticToolIfUnset'
    );
  }
  usersService[USERS_SERVICE_EXTENDED] = true;
}

function extendReposService(client: AgorClient): void {
  const reposService = client.service('repos') as AgorService<Repo> & {
    [REPOS_SERVICE_EXTENDED]?: boolean;
    methods?: (...names: string[]) => unknown;
  };
  if (reposService[REPOS_SERVICE_EXTENDED]) return;
  reposService[REPOS_SERVICE_EXTENDED] = true;
}

function extendBranchesService(client: AgorClient): void {
  const branchesService = client.service('branches') as AgorService<Branch> & {
    [BRANCHES_SERVICE_EXTENDED]?: boolean;
    methods?: (...names: string[]) => unknown;
  };
  if (branchesService[BRANCHES_SERVICE_EXTENDED]) return;
  if (typeof branchesService.methods === 'function') {
    branchesService.methods('updateEnvironment', 'ensureTeammateKnowledgeNamespace');
  }
  branchesService[BRANCHES_SERVICE_EXTENDED] = true;
}

function extendTasksService(client: AgorClient): void {
  const tasksService = client.service('tasks') as AgorService<Task> & {
    [TASKS_SERVICE_EXTENDED]?: boolean;
    methods?: (...names: string[]) => unknown;
  };
  if (tasksService[TASKS_SERVICE_EXTENDED]) return;
  if (typeof tasksService.methods === 'function') {
    tasksService.methods(
      'connectExecutor',
      'reportTerminationComplete',
      'reportRuntimeTelemetry',
      'reportSdkHealthFailure',
      'completeWorkload',
      'reconcileWorkloadCompletion'
    );
  }
  tasksService[TASKS_SERVICE_EXTENDED] = true;
}

function extendServiceFactory(client: AgorClient): void {
  const augmentedClient = client as AgorClient & {
    [CLIENT_SERVICE_FACTORY_EXTENDED]?: boolean;
  };

  if (augmentedClient[CLIENT_SERVICE_FACTORY_EXTENDED]) {
    return;
  }

  const rawService = client.service.bind(client) as (path: string) => AgorService<unknown>;

  augmentedClient.service = ((path: string) => {
    const service = rawService(path);
    extendFindAllOnService(service, path);
    return service;
  }) as AgorClient['service'];

  augmentedClient[CLIENT_SERVICE_FACTORY_EXTENDED] = true;
}

function extendSessionsHelpers(client: AgorClient): void {
  const augmentedClient = client as AgorClient & {
    [CLIENT_SESSIONS_HELPERS_EXTENDED]?: boolean;
  };

  if (augmentedClient[CLIENT_SESSIONS_HELPERS_EXTENDED]) {
    return;
  }

  client.sessions = {
    prompt: async (sessionId: string, prompt: string, options?: SessionPromptOptions) => {
      const { params, ...requestOptions } = options ?? {};
      const response = await client
        .service(`sessions/${sessionId}/prompt`)
        .create({ prompt, ...requestOptions } as SessionPromptRequest, params);
      return response as Task;
    },
    initialize: async (sessionId: string, options: SessionInitializationOptions) => {
      const { params, ...request } = options;
      const response = await client
        .service(`sessions/${sessionId}/initialize`)
        .create(request, params);
      return response as SessionInitializationResult;
    },
  };

  augmentedClient[CLIENT_SESSIONS_HELPERS_EXTENDED] = true;
}

function extendTasksHelpers(client: AgorClient): void {
  const augmentedClient = client as AgorClient & {
    [CLIENT_TASKS_HELPERS_EXTENDED]?: boolean;
  };

  if (augmentedClient[CLIENT_TASKS_HELPERS_EXTENDED]) {
    return;
  }

  client.tasks = {
    run: async (taskId: string, options?: TaskRunOptions) => {
      const { params, ...requestOptions } = options ?? {};
      const response = await client
        .service(`tasks/${taskId}/run`)
        .create(requestOptions as TaskRunRequest, params);
      return response as Task;
    },
  };

  augmentedClient[CLIENT_TASKS_HELPERS_EXTENDED] = true;
}

/**
 * Check if an AGOR_API_KEY environment variable is set.
 * Returns the key if valid format, null otherwise.
 */
export function getApiKeyFromEnv(): string | null {
  const key = typeof process !== 'undefined' ? process.env?.AGOR_API_KEY : null;
  if (key?.startsWith('agor_sk_')) {
    return key;
  }
  return null;
}

/**
 * Create REST-only Feathers client for CLI (prevents hanging processes)
 *
 * Uses REST transport instead of WebSocket to avoid keeping Node.js processes alive.
 * Only use this in CLI commands - UI should use createClient() with WebSocket.
 *
 * @param url - Daemon URL
 * @param apiKey - Optional API key to use for authentication (sets Authorization header on all requests)
 */
export async function createRestClient(
  url: string = DEFAULT_DAEMON_URL,
  apiKey?: string
): Promise<AuthenticatedAgorClient> {
  const client = feathers<ServiceTypes>() as AuthenticatedAgorClient;
  const fetchImpl = globalThis.fetch.bind(globalThis);

  // Lazy-load REST client (only imported when needed, not in browser bundles)
  const { default: rest } = await import('@feathersjs/rest-client');

  // Inject the Authorization header at the transport layer rather than relying on
  // the Feathers authentication hook.
  //
  // That hook only decorates the *standard* service methods. Calls to custom methods
  // registered via `service.methods(...)` — board `toYaml`/`clone`/`fromYaml`, repo
  // `createBranch`, … — went out with no credentials at all, and the daemon correctly
  // answered 401 "Not authenticated". Only the CLI hit this: the UI is on Socket.IO,
  // where the connection itself is authenticated.
  //
  // The token is tracked here rather than read back from the authentication client
  // because this client is configured with `storage: undefined`, so
  // `getAccessToken()` resolves to null.
  let bearerToken: string | null = apiKey ?? null;

  const fetchFn = async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);

    // Never attach a bearer to the login exchange itself: the credentials live in
    // the request body, and a stale token here would 401 the very call meant to
    // replace it.
    const target = typeof input === 'string' ? input : input.toString();
    const isAuthenticationRequest = /\/authentication\/?(?:\?|$)/.test(target);

    if (!isAuthenticationRequest && !headers.has('Authorization') && bearerToken) {
      headers.set('Authorization', `Bearer ${bearerToken}`);
    }

    return fetchImpl(input, { ...init, headers });
  };

  // Configure REST transport
  client.configure(rest(url).fetch(fetchFn));

  // Configure authentication with no storage (CLI will manage tokens separately)
  client.configure(authentication({ storage: undefined }));

  // Remember the credential each successful login establishes, so `fetchFn` above
  // can authenticate custom-method calls the Feathers hook does not cover.
  if (!apiKey) {
    const authenticateWithClient = client.authenticate.bind(client);
    client.authenticate = async (data?: Parameters<typeof authenticateWithClient>[0]) => {
      const result = await authenticateWithClient(data);
      const established =
        (result as { accessToken?: unknown } | undefined)?.accessToken ??
        (data as { accessToken?: unknown } | undefined)?.accessToken;
      if (typeof established === 'string') bearerToken = established;
      return result;
    };

    const logoutFromClient = client.logout.bind(client);
    client.logout = async () => {
      bearerToken = null;
      return logoutFromClient();
    };
  }

  // Create a dummy socket object to satisfy the interface
  client.io = {
    close: () => {},
    removeAllListeners: () => {},
    io: { opts: {} },
  } as unknown as Socket;

  extendServiceFactory(client);
  extendBoardsService(client);
  extendUsersService(client);
  extendReposService(client);
  extendBranchesService(client);
  extendTasksService(client);
  extendSessionsHelpers(client);
  extendTasksHelpers(client);

  return client;
}

export interface SocketConnectionAuthentication {
  /**
   * Access token presented in every Socket.IO namespace handshake. A getter
   * lets long-lived browser clients rotate the credential without recreating
   * the Feathers client; the next automatic or controlled reconnect reads the
   * latest value.
   */
  accessToken: string | (() => string | null | undefined);
  /** Narrow, transport-only handshake metadata such as a workload receipt. */
  authData?: () => Record<string, unknown>;
}

/**
 * Create a Socket.IO-backed Feathers client connected to agor-daemon.
 *
 * The daemon authenticates every namespace handshake before accepting the
 * connection, so callers must either provide `socketAuthentication` here or
 * set an equivalent Socket.IO auth object before connecting. Calling the
 * Feathers `authenticate()` method after connection is not a supported socket
 * identity transition.
 *
 * @param url - Daemon URL
 * @param autoConnect - Whether Socket.IO connects immediately (default: true)
 * @param options - Transport and handshake options
 * @returns Feathers client instance with its Socket.IO socket exposed
 */
export function createClient(
  url: string = DEFAULT_DAEMON_URL,
  autoConnect: boolean = true,
  options?: {
    /** Show connection status logs (useful for CLI) */
    verbose?: boolean;
    /** Limit reconnection attempts (useful for CLI to avoid hanging) */
    reconnectionAttempts?: number;
    /** Reject acknowledged service calls when Socket.IO does not receive an acknowledgement. */
    ackTimeout?: number;
    /** Authenticate each Socket.IO connection before the server accepts it. */
    socketAuthentication?: SocketConnectionAuthentication;
  }
): AgorClient {
  // Detect if running in browser vs Node.js (CLI)
  // Use 'in' operator to avoid TypeScript index signature errors during DTS build
  const isBrowser = typeof globalThis !== 'undefined' && 'window' in globalThis;

  // Configure socket.io with better defaults for React StrictMode and reconnection
  const socketAuthentication = options?.socketAuthentication;
  const socket = io(url, {
    // Auto-connect by default for CLI, manual control for React hooks
    autoConnect,
    // Reconnection settings
    reconnection: true,
    reconnectionDelay: 1000, // Wait 1s before first reconnect attempt
    reconnectionDelayMax: 5000, // Max 5s between attempts
    // Browser: keep trying indefinitely, CLI: fail fast (2 attempts)
    reconnectionAttempts:
      options?.reconnectionAttempts ?? (isBrowser ? Number.POSITIVE_INFINITY : 2),
    // Timeout settings
    timeout: 20000, // 20s timeout for initial connection
    ...(options?.ackTimeout === undefined ? {} : { ackTimeout: options.ackTimeout }),
    // Transports (WebSocket preferred, fallback to polling)
    transports: ['websocket', 'polling'],
    // Connection lifecycle settings
    closeOnBeforeunload: true, // Close socket when page unloads
    ...(socketAuthentication
      ? {
          auth: (authorize: (data: Record<string, unknown>) => void) => {
            const configured = socketAuthentication.accessToken;
            const accessToken = typeof configured === 'function' ? configured() : configured;
            const authData = socketAuthentication.authData?.() ?? {};
            authorize(accessToken ? { ...authData, token: accessToken } : authData);
          },
        }
      : {}),
  });

  // Add connection monitoring if verbose mode enabled
  if (options?.verbose) {
    let attemptCount = 0;
    const maxAttempts = options?.reconnectionAttempts ?? (isBrowser ? Infinity : 2);

    socket.on('connect_error', () => {
      attemptCount++;
      if (attemptCount === 1) {
        console.error(`✗ Daemon not running at ${url}`);
        console.error(`  Retrying connection (${attemptCount}/${maxAttempts})...`);
      } else {
        console.error(`  Retry ${attemptCount}/${maxAttempts} failed`);
      }
    });

    socket.on('connect', () => {
      if (attemptCount > 0) {
        console.log('✓ Connected to daemon');
      }
    });
  }

  // The typed helper surfaces (`sessions` and `tasks`) are installed below as
  // part of client construction. Cross through `unknown` deliberately rather
  // than claiming that a bare Feathers application already satisfies the
  // completed AgorClient contract.
  const client = feathers<ServiceTypes>() as unknown as AgorClient;

  client.configure(socketio(socket));
  // Socket identity is established exclusively by the namespace handshake.
  // Deliberately do not configure Feathers' authentication client here: once
  // its `authenticate()` method has run it automatically reauthenticates after
  // reconnect, which would introduce a second, post-connect identity
  // transition. REST clients retain the normal Feathers authentication API.
  client.io = socket;

  extendServiceFactory(client);
  extendBoardsService(client);
  extendUsersService(client);
  extendReposService(client);
  extendBranchesService(client);
  extendTasksService(client);
  extendSessionsHelpers(client);
  extendTasksHelpers(client);

  return client;
}

/**
 * Check if daemon is running
 *
 * @param url - Daemon URL
 * @returns true if daemon is reachable
 */
export async function isDaemonRunning(url: string = DEFAULT_DAEMON_URL): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}
