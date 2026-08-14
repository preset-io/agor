/**
 * Feathers Client for Agor
 *
 * Shared client library for connecting to agor-daemon from CLI and UI
 */

import type {
  AgenticToolPreset,
  Artifact,
  AuthenticationResult,
  Board,
  BoardExportBlob,
  BoardGroupGrantWithGroup,
  Branch,
  BranchArchiveOrDeleteOptions,
  BranchClientPatch,
  BranchEnvironmentUpdate,
  BranchExecutorPatch,
  BranchGroupGrantWithGroup,
  BranchID,
  BranchUnarchiveOptions,
  CardType,
  CardWithType,
  CloneRepositoryResult,
  CreateAgenticToolPreset,
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
  MCPServer,
  Message,
  OpenCodeModelCatalog,
  OpenCodeOAuthAttempt,
  OpenCodeOAuthAttemptPatch,
  OpenCodeOAuthConnectRequest,
  OpenCodeProviderSettings,
  PatchAgenticToolPreset,
  PermissionMode,
  Repo,
  RepoBranchCreateRequest,
  RepoClientPatch,
  RepoExecutorPatch,
  RuntimeTelemetryInput,
  Schedule,
  ScheduleCreateData,
  SchedulePatchData,
  SdkHealthFailureInput,
  Session,
  SessionUpdate,
  Task,
  TeammateWelcomeNoteRequest,
  TemplateRenderRequest,
  TemplateRenderResponse,
  TenantAgenticToolSettings,
  TenantAgenticToolSettingsPatch,
  User,
  UserAvatarSettings,
  UserAvatarSyncRequest,
  UserAvatarSyncResult,
  UUID,
} from '@agor/core/types';
import authentication from '@feathersjs/authentication-client';
import type { Application, Paginated, Params } from '@feathersjs/feathers';
import { feathers } from '@feathersjs/feathers';
import socketio from '@feathersjs/socketio-client';
import io, { type Socket } from 'socket.io-client';
import { DAEMON } from '../config/constants';

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

export interface QueuedSessionPromptResult {
  success: true;
  queued: true;
  message: Message;
  queue_position: number;
}

export interface RunningSessionPromptResult {
  success: true;
  taskId: string;
  status: string;
  streaming: boolean;
  queued?: false;
}

export type SessionPromptResult = QueuedSessionPromptResult | RunningSessionPromptResult;

export interface SessionPromptOptions extends Omit<SessionPromptRequest, 'prompt'> {
  params?: Params;
}

export interface SessionsClientHelpers {
  prompt(
    sessionId: string,
    prompt: string,
    options?: SessionPromptOptions
  ): Promise<SessionPromptResult>;
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

/**
 * Service interfaces for type safety
 */
export interface ServiceTypes {
  sessions: Session;
  tasks: Task;
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
  'boards/:id/owners': User;
  'boards/:id/group-grants': BoardGroupGrantWithGroup;
  'branches/:id/group-grants': BranchGroupGrantWithGroup;
  cards: CardWithType;
  'card-types': CardType; // CardType CRUD
  artifacts: Artifact;
  'mcp-servers': MCPServer;
  'mcp-catalog': MCPCatalogEntry;
  'mcp-catalog/connect': MCPCatalogConnectResult;
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

/**
 * Tasks service with bulk creation support
 */
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
  /**
   * Create multiple tasks in a single request
   * Returns array of created tasks with IDs
   */
  createMany(data: Partial<Task>[]): Promise<Task[]>;

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
export type MessagesService = Omit<AgorService<Message>, 'update'>;

/** Narrow transport contract for `POST /messages/bulk`. */
export interface MessagesBulkService {
  create(data: CreatePayload<Message>[], params?: Params): Promise<Message[]>;
}

/** Public repository collection/item transport. */
export type ReposService = AgorService<Repo, never, never, ClientInput<RepoClientPatch> | null>;

/** Dedicated `POST /repos/:id/branches` route service. */
export interface RepoBranchesService {
  create(data: ClientInput<RepoBranchCreateRequest>, params?: Params): Promise<Branch>;
}

/** Privileged repository patch surface used only by scoped lifecycle executors. */
export type ReposExecutorService = Omit<ReposService, 'patch'> & {
  patch(id: string | null, data: ClientInput<RepoExecutorPatch>, params?: Params): Promise<Repo>;
};

export interface ReposLocalService {
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

/**
 * Users service with git environment support
 */
export interface UsersService extends AgorService<User> {
  /**
   * Get the full resolved git environment for a user.
   * Auth: service-account JWTs may fetch any user's env;
   * regular users may only fetch their own.
   */
  getGitEnvironment(data: { userId: string }, params?: Params): Promise<Record<string, string>>;
  getAvatarSettings(data?: unknown, params?: Params): Promise<UserAvatarSettings>;
  updateAvatarSettings(
    data: Partial<UserAvatarSettings>,
    params?: Params
  ): Promise<UserAvatarSettings>;
  syncAvatars(data?: UserAvatarSyncRequest, params?: Params): Promise<UserAvatarSyncResult>;
}

/**
 * Branches service with environment management
 */
export interface BranchesService
  extends AgorService<Branch, never, never, ClientInput<BranchClientPatch> | null> {
  /**
   * Create or repair the primary Knowledge namespace for a teammate branch.
   * API/UI-only; not exposed through teammate MCP config mutation tools.
   */
  ensureTeammateKnowledgeNamespace(
    data: { branchId?: string; branch_id?: string } | string,
    params?: Params
  ): Promise<{ namespace: KnowledgeNamespace; branch: Branch }>;
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
}

/**
 * Privileged branch patch surface used only by operation-scoped executors.
 * Keeping this separate prevents browser/CLI callers from being typed as able
 * to report filesystem lifecycle or Unix-group state.
 */
export type BranchesExecutorService = Omit<BranchesService, 'patch'> & {
  patch(
    id: string | null,
    data: ClientInput<BranchExecutorPatch>,
    params?: Params
  ): Promise<Branch>;
};

/** Parameterized REST/socket route for one branch archive/delete operation. */
export interface BranchArchiveOrDeleteService {
  create(
    data: ClientInput<BranchArchiveOrDeleteOptions>,
    params?: Params
  ): Promise<Branch | { deleted: true; branch_id: BranchID }>;
}

/** Parameterized REST/socket route for one branch unarchive operation. */
export interface BranchUnarchiveService {
  create(data: ClientInput<BranchUnarchiveOptions>, params?: Params): Promise<Branch>;
}

/**
 * Agor client with socket.io connection exposed for lifecycle management
 */
export interface AgorClient extends Omit<Application<ServiceTypes>, 'service'> {
  io: Socket;
  sessions: SessionsClientHelpers;
  tasks: TasksClientHelpers;

  // Typed service overloads for services with custom methods
  service(path: 'sessions'): SessionsService;
  service(path: 'tasks'): TasksService;
  service(path: 'messages'): MessagesService;
  service(path: 'repos'): ReposService;
  service(path: 'repos/clone'): ReposCloneService;
  service(path: 'repos/local'): ReposLocalService;
  service(path: `repos/${string}/branches`): RepoBranchesService;
  service(path: 'branches'): BranchesService;
  service(path: `branches/${string}/archive-or-delete`): BranchArchiveOrDeleteService;
  service(path: `branches/${string}/unarchive`): BranchUnarchiveService;
  service(path: 'boards'): BoardsService;
  service(path: 'schedules'): SchedulesService;
  service(path: 'gateway-channels'): GatewayChannelsService;
  service(path: 'kb/settings'): KnowledgeSettingsService;
  service(path: 'kb/indexing/status'): KnowledgeIndexingStatusService;
  service(path: 'kb/indexing/reindex'): KnowledgeReindexService;
  service(path: 'agentic-tool-settings'): AgenticToolSettingsService;
  service(path: 'agentic-tool-presets'): AgenticToolPresetsService;
  service(path: 'opencode-auth'): OpenCodeAuthService;
  service(path: 'opencode-models'): OpenCodeModelsService;

  // Bulk operation endpoints
  service(path: 'messages/bulk'): MessagesBulkService;
  service(path: 'tasks/bulk'): TasksService;

  // Standard services (CRUD only)
  service(path: 'cards'): AgorService<CardWithType>;
  service(path: 'card-types'): AgorService<CardType>;
  service(path: 'users'): UsersService;
  service(path: 'mcp-servers'): AgorService<MCPServer>;
  service(path: 'mcp-catalog'): AgorService<MCPCatalogEntry>;
  service(path: 'mcp-catalog/connect'): MCPCatalogConnectService;
  service(path: 'templates'): TemplatesService;

  // Generic fallback for custom routes and dynamic paths
  service<K extends keyof ServiceTypes>(path: K): AgorService<ServiceTypes[K]>;
  service(path: string): AgorService<unknown>;

  // Authentication methods (from @feathersjs/authentication-client)
  authenticate(credentials?: {
    strategy?: string;
    email?: string;
    password?: string;
    accessToken?: string;
  }): Promise<AuthenticationResult>;
  logout(): Promise<AuthenticationResult | null>;
  reAuthenticate(force?: boolean): Promise<AuthenticationResult>;
}

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

function extendFindAllOnService(service: AgorService<unknown>): void {
  const findAllService = service as AgorService<unknown> & {
    [SERVICE_FIND_ALL_EXTENDED]?: boolean;
  };

  if (findAllService[SERVICE_FIND_ALL_EXTENDED]) {
    return;
  }

  findAllService.findAll = async (params?: Params) => {
    const firstResult = await service.find(params);
    if (!isPaginatedResult(firstResult)) {
      return firstResult;
    }

    const allData = [...firstResult.data];
    let total = firstResult.total;
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

    while (allData.length < total) {
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
        allData.push(...nextResult);
        break;
      }

      if (nextResult.data.length === 0) {
        break;
      }

      allData.push(...nextResult.data);
      nextSkip = nextResult.skip + nextResult.data.length;
      total = nextResult.total;
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
      'getGitEnvironment',
      'getAvatarSettings',
      'updateAvatarSettings',
      'syncAvatars'
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
      'reportSdkHealthFailure'
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
    extendFindAllOnService(service);
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
      return response as SessionPromptResult;
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
 * Create Feathers client connected to agor-daemon
 *
 * @param url - Daemon URL
 * @param autoConnect - Auto-connect socket (default: true for CLI, false for React)
 * @param options - Additional options
 * @returns Feathers client instance with socket exposed
 */
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
): Promise<AgorClient> {
  const client = feathers<ServiceTypes>() as AgorClient;
  const fetchImpl = globalThis.fetch.bind(globalThis);

  // Lazy-load REST client (only imported when needed, not in browser bundles)
  const { default: rest } = await import('@feathersjs/rest-client');

  // When an API key is provided, wrap fetch to inject the Authorization header
  const fetchFn = apiKey
    ? (input: string | URL | globalThis.Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${apiKey}`);
        return fetchImpl(input, { ...init, headers });
      }
    : fetchImpl;

  // Configure REST transport
  client.configure(rest(url).fetch(fetchFn));

  // Configure authentication with no storage (CLI will manage tokens separately)
  client.configure(authentication({ storage: undefined }));

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
    /** Explicit authentication storage for non-browser clients. */
    authStorage?: {
      getItem(key: string): string | null | Promise<string | null>;
      setItem(key: string, value: string): void | Promise<void>;
      removeItem(key: string): void | Promise<void>;
    };
  }
): AgorClient {
  // Detect if running in browser vs Node.js (CLI)
  // Use 'in' operator to avoid TypeScript index signature errors during DTS build
  const isBrowser = typeof globalThis !== 'undefined' && 'window' in globalThis;

  // Configure socket.io with better defaults for React StrictMode and reconnection
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
  });

  // Add connection monitoring if verbose mode enabled
  if (options?.verbose) {
    let attemptCount = 0;
    const maxAttempts = options?.reconnectionAttempts ?? (isBrowser ? Infinity : 2);

    socket.on('connect_error', (error: Error) => {
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

  const client = feathers<ServiceTypes>() as AgorClient;

  client.configure(socketio(socket));

  // Configure authentication with localStorage if available (browser only).
  // Node 25 exposes a `localStorage` global that is NOT a working Storage —
  // it has no `setItem` method, so the Feathers auth client throws
  // `_a.setItem is not a function` on first authenticate(). Guard against
  // that by also requiring a callable setItem before treating it as Storage.
  const _ls = (globalThis as { localStorage?: unknown }).localStorage as
    | (Storage & { setItem?: unknown })
    | undefined;
  const storage =
    options?.authStorage ??
    (_ls && typeof _ls.setItem === 'function' ? (_ls as Storage) : undefined);

  client.configure(authentication({ storage }));
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

/**
 * Re-export Feathers authentication client for use in executor
 * This allows the executor to import authentication client through @agor/core
 * instead of having it as a direct dependency
 */
export { default as authenticationClient } from '@feathersjs/authentication-client';
