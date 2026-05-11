/**
 * Feathers Client for Agor
 *
 * Shared client library for connecting to agor-daemon from CLI and UI
 */

import type {
  Artifact,
  AuthenticationResult,
  Board,
  BoardExportBlob,
  CardType,
  CardWithType,
  CloneRepositoryResult,
  ContextFileDetail,
  ContextFileListItem,
  MCPServer,
  Message,
  PermissionMode,
  Repo,
  Session,
  Task,
  TemplateRenderRequest,
  TemplateRenderResponse,
  User,
  UUID,
  Worktree,
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
const WORKTREES_SERVICE_EXTENDED = Symbol('agor.worktreesServiceExtended');
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
  messageSource?: 'gateway' | 'agor';
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
 * Body shape for `POST /tasks/:id/run`. Matches the prompt route's options
 * so the same defaults (`stream: true`, agor messageSource for socket
 * callers) apply when explicitly triggering an already-created task.
 */
export interface TaskRunRequest {
  permissionMode?: PermissionMode;
  stream?: boolean;
  messageSource?: 'gateway' | 'agor';
}

export interface TaskRunOptions extends TaskRunRequest {
  params?: Params;
}

export interface TasksClientHelpers {
  /**
   * Trigger executor pickup for an already-created task. Pure-REST harnesses
   * use this after `POST /tasks` to avoid needing an MCP client. Returns the
   * Task with `status: 'running'`. Only `'created'` tasks on idle sessions
   * are accepted — `'queued'` tasks drain automatically in queue-position
   * order via the queue processor, and busy sessions should be prompted via
   * `client.sessions.prompt()` (which creates and queues the task atomically).
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
  worktrees: Worktree;
  users: User;
  cards: CardWithType;
  'card-types': CardType; // CardType CRUD
  artifacts: Artifact;
  'mcp-servers': MCPServer;
  context: ContextFileListItem | ContextFileDetail; // GET /context returns list, GET /context/:path returns detail
  templates: TemplateRenderResponse;
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
  // Custom events (e.g. permission_resolved, input_resolved, queued)
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

/**
 * Sessions service with custom methods for forking, spawning, and genealogy
 */
export interface SessionsService extends AgorService<Session> {
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

/**
 * Messages service with bulk creation support
 */
export interface MessagesService extends AgorService<Message> {
  /**
   * Create multiple messages in a single request
   * Returns array of created messages with IDs
   */
  createMany(data: Partial<Message>[]): Promise<Message[]>;
}

/**
 * Repos service with worktree management
 */
export interface ReposService extends AgorService<Repo> {
  /**
   * Initialize Unix group for a repo (daemon-side privileged operation).
   * Called by executor after cloning.
   */
  initializeUnixGroup(
    data: { repoId: string; userId?: string },
    params?: Params
  ): Promise<{ unixGroup: string }>;

  /**
   * Create a git worktree for a repository
   */
  createWorktree(
    id: string,
    data: {
      name: string;
      ref: string;
      createBranch?: boolean;
      pullLatest?: boolean;
      sourceBranch?: string;
    },
    params?: Params
  ): Promise<Repo>;

  /**
   * Remove a git worktree
   */
  removeWorktree(id: string, name: string, params?: Params): Promise<Repo>;
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
}

/**
 * Worktrees service with environment management
 */
export interface WorktreesService extends AgorService<Worktree> {
  /**
   * Initialize Unix group for a worktree (daemon-side privileged operation).
   * Called by executor after creating the git worktree.
   */
  initializeUnixGroup(
    data: { worktreeId: string; othersAccess?: 'none' | 'read' | 'write' },
    params?: Params
  ): Promise<{ unixGroup: string }>;

  /**
   * Find worktree by repo_id and name
   */
  findByRepoAndName(repoId: string, name: string, params?: Params): Promise<Worktree | null>;

  /**
   * Add session to worktree
   */
  addSession(id: string, sessionId: string, params?: Params): Promise<Worktree>;

  /**
   * Remove session from worktree
   */
  removeSession(id: string, sessionId: string, params?: Params): Promise<Worktree>;

  /**
   * Add worktree to board
   */
  addToBoard(id: string, boardId: string, params?: Params): Promise<Worktree>;

  /**
   * Remove worktree from board
   */
  removeFromBoard(id: string, params?: Params): Promise<Worktree>;

  /**
   * Update environment status
   */
  updateEnvironment(
    id: string,
    environmentUpdate: Partial<Worktree['environment_instance']>,
    params?: Params
  ): Promise<Worktree>;

  /**
   * Start worktree environment
   */
  startEnvironment(id: string, params?: Params): Promise<Worktree>;

  /**
   * Stop worktree environment
   */
  stopEnvironment(id: string, params?: Params): Promise<Worktree>;

  /**
   * Restart worktree environment
   */
  restartEnvironment(id: string, params?: Params): Promise<Worktree>;

  /**
   * Check environment health
   */
  checkHealth(id: string, params?: Params): Promise<Worktree>;

  /**
   * Archive or delete a worktree with filesystem cleanup options
   */
  archiveOrDelete(
    id: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    },
    params?: Params
  ): Promise<Worktree | { deleted: true; worktree_id: string }>;

  /**
   * Unarchive a worktree
   */
  unarchive(id: string, options?: { boardId?: string }, params?: Params): Promise<Worktree>;
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
  service(path: 'worktrees'): WorktreesService;
  service(path: 'boards'): BoardsService;

  // Bulk operation endpoints
  service(path: 'messages/bulk'): MessagesService;
  service(path: 'tasks/bulk'): TasksService;

  // Standard services (CRUD only)
  service(path: 'cards'): AgorService<CardWithType>;
  service(path: 'card-types'): AgorService<CardType>;
  service(path: 'users'): UsersService;
  service(path: 'mcp-servers'): AgorService<MCPServer>;
  service(path: 'context'): AgorService<ContextFileListItem | ContextFileDetail>;
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
      methodsFn.call(service, 'toBlob', 'fromBlob', 'toYaml', 'fromYaml', 'clone');
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
    usersService.methods('getGitEnvironment');
  }
  usersService[USERS_SERVICE_EXTENDED] = true;
}

function extendReposService(client: AgorClient): void {
  const reposService = client.service('repos') as AgorService<Repo> & {
    [REPOS_SERVICE_EXTENDED]?: boolean;
    methods?: (...names: string[]) => unknown;
  };
  if (reposService[REPOS_SERVICE_EXTENDED]) return;
  if (typeof reposService.methods === 'function') {
    reposService.methods('initializeUnixGroup');
  }
  reposService[REPOS_SERVICE_EXTENDED] = true;
}

function extendWorktreesService(client: AgorClient): void {
  const worktreesService = client.service('worktrees') as AgorService<Worktree> & {
    [WORKTREES_SERVICE_EXTENDED]?: boolean;
    methods?: (...names: string[]) => unknown;
  };
  if (worktreesService[WORKTREES_SERVICE_EXTENDED]) return;
  if (typeof worktreesService.methods === 'function') {
    worktreesService.methods('initializeUnixGroup');
  }
  worktreesService[WORKTREES_SERVICE_EXTENDED] = true;
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
  extendWorktreesService(client);
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
  const storage = _ls && typeof _ls.setItem === 'function' ? (_ls as Storage) : undefined;

  client.configure(authentication({ storage }));
  client.io = socket;

  extendServiceFactory(client);
  extendBoardsService(client);
  extendUsersService(client);
  extendReposService(client);
  extendWorktreesService(client);
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
