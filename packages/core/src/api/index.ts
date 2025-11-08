/**
 * Feathers Client for Agor
 *
 * Shared client library for connecting to agor-daemon from CLI and UI
 */

import type {
  AuthenticationResult,
  Board,
  ContextFileDetail,
  ContextFileListItem,
  MCPServer,
  Message,
  Repo,
  Session,
  Task,
  User,
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
 * Service interfaces for type safety
 */
export interface ServiceTypes {
  sessions: Session;
  tasks: Task;
  boards: Board;
  repos: Repo;
  worktrees: Worktree;
  users: User;
  'mcp-servers': MCPServer;
  context: ContextFileListItem | ContextFileDetail; // GET /context returns list, GET /context/:path returns detail
}

/**
 * Feathers service with find method properly typed and event emitter methods
 */
export interface AgorService<T> {
  // CRUD methods
  find(params?: Params): Promise<Paginated<T> | T[]>;
  get(id: string, params?: Params): Promise<T>;
  create(data: Partial<T>, params?: Params): Promise<T>;
  update(id: string, data: T, params?: Params): Promise<T>;
  patch(id: string | null, data: Partial<T> | null, params?: Params): Promise<T>;
  remove(id: string, params?: Params): Promise<T>;

  // Event emitter methods (for real-time updates)
  on(event: string, handler: (data: T) => void): void;
  removeListener(event: string, handler: (data: T) => void): void;
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
   * Clone a repository and register it
   */
  clone(data: { url: string; name?: string }, params?: Params): Promise<Repo>;

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

/**
 * Worktrees service with environment management
 */
export interface WorktreesService extends AgorService<Worktree> {
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
}

/**
 * Agor client with socket.io connection exposed for lifecycle management
 */
export interface AgorClient extends Omit<Application<ServiceTypes>, 'service'> {
  io: Socket;

  // Typed service overloads for services with custom methods
  service(path: 'sessions'): SessionsService;
  service(path: 'tasks'): TasksService;
  service(path: 'messages'): MessagesService;
  service(path: 'repos'): ReposService;
  service(path: 'worktrees'): WorktreesService;

  // Bulk operation endpoints
  service(path: 'messages/bulk'): MessagesService;
  service(path: 'tasks/bulk'): TasksService;

  // Standard services (CRUD only)
  service(path: 'boards'): AgorService<Board>;
  service(path: 'users'): AgorService<User>;
  service(path: 'mcp-servers'): AgorService<MCPServer>;
  service(path: 'context'): AgorService<ContextFileListItem | ContextFileDetail>;

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

/**
 * Create Feathers client connected to agor-daemon
 *
 * @param url - Daemon URL
 * @param autoConnect - Auto-connect socket (default: true for CLI, false for React)
 * @param options - Additional options
 * @returns Feathers client instance with socket exposed
 */
/**
 * Create REST-only Feathers client for CLI (prevents hanging processes)
 *
 * Uses REST transport instead of WebSocket to avoid keeping Node.js processes alive.
 * Only use this in CLI commands - UI should use createClient() with WebSocket.
 */
export async function createRestClient(url: string = DEFAULT_DAEMON_URL): Promise<AgorClient> {
  const client = feathers<ServiceTypes>() as AgorClient;

  // Lazy-load REST client (only imported when needed, not in browser bundles)
  const { default: rest } = await import('@feathersjs/rest-client');

  // Configure REST transport
  client.configure(rest(url).fetch(fetch));

  // Configure authentication with no storage (CLI will manage tokens separately)
  client.configure(authentication({ storage: undefined }));

  // Create a dummy socket object to satisfy the interface
  client.io = {
    close: () => {},
    removeAllListeners: () => {},
    io: { opts: {} },
    // biome-ignore lint/suspicious/noExplicitAny: Dummy socket for REST-only mode
  } as any;

  return client;
}

export function createClient(
  url: string = DEFAULT_DAEMON_URL,
  autoConnect: boolean = true,
  options?: {
    /** Show connection status logs (useful for CLI) */
    verbose?: boolean;
  }
): AgorClient {
  // Configure socket.io with better defaults for React StrictMode and reconnection
  const socket = io(url, {
    // Auto-connect by default for CLI, manual control for React hooks
    autoConnect,
    // Reconnection settings (less aggressive to prevent socket exhaustion)
    reconnection: true,
    reconnectionDelay: 1000, // Wait 1s before first reconnect attempt
    reconnectionDelayMax: 2000, // Max 2s between attempts
    reconnectionAttempts: 2, // Only try 2 times before giving up (fast fail for CLI)
    // Timeout settings
    timeout: 2000, // 2s timeout for initial connection
    // Transports (WebSocket preferred, fallback to polling)
    transports: ['websocket', 'polling'],
    // Connection lifecycle settings
    closeOnBeforeunload: true, // Close socket when page unloads
  });

  // Add connection monitoring if verbose mode enabled
  if (options?.verbose) {
    let attemptCount = 0;

    socket.on('connect_error', (error: Error) => {
      attemptCount++;
      if (attemptCount === 1) {
        console.error(`✗ Daemon not running at ${url}`);
        console.error(`  Retrying connection (${attemptCount}/2)...`);
      } else {
        console.error(`  Retry ${attemptCount}/2 failed`);
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

  // Configure authentication with localStorage if available (browser only)
  const storage =
    typeof globalThis !== 'undefined' && 'localStorage' in globalThis
      ? (globalThis as typeof globalThis & { localStorage: Storage }).localStorage
      : undefined;

  client.configure(authentication({ storage }));
  client.io = socket;

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
