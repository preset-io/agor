/**
 * FeathersJS Type Declarations for Agor Daemon
 *
 * Provides proper TypeScript types for:
 * - Hook contexts with authentication
 * - Service implementations with custom methods
 * - Application instance
 */

import type { ExpressApplication, Service } from '@agor/core/feathers';
import type {
  Board,
  AuthenticatedParams as CoreAuthenticatedParams,
  AuthenticatedUser as CoreAuthenticatedUser,
  CreateHookContext as CoreCreateHookContext,
  HookContext as CoreHookContext,
  Params as FeathersParams,
  Message,
  Repo,
  Session,
  Task,
  Worktree,
  WorktreeID,
} from '@agor/core/types';

// Re-export core types for convenience
export type AuthenticatedUser = CoreAuthenticatedUser;
export type AuthenticatedParams = CoreAuthenticatedParams;
export type CreateHookContext<T = unknown> = CoreCreateHookContext<T>;
export type HookContext<T = unknown> = CoreHookContext<T>;

/**
 * Application type for the daemon
 */
export type Application = ExpressApplication;

/**
 * Sessions service with custom methods (server-side implementation)
 * This matches the SessionRepository methods exposed via the service adapter
 */
export interface SessionsServiceImpl extends Service<Session, Partial<Session>, FeathersParams> {
  fork(
    id: string,
    data: { prompt: string; task_id?: string },
    params?: FeathersParams
  ): Promise<Session>;
  spawn(
    id: string,
    data: {
      prompt: string;
      title?: string;
      agentic_tool?: Session['agentic_tool'];
      task_id?: string;
    },
    params?: FeathersParams
  ): Promise<Session>;
  getGenealogy(id: string, params?: FeathersParams): Promise<unknown>; // GenealogyTree type would go here
  // Event emitter methods (FeathersJS EventEmitter interface - any[] for event args flexibility)
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS event handlers accept variable arguments
  on(event: string, handler: (...args: any[]) => void): this;
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS event handlers accept variable arguments
  removeListener(event: string, handler: (...args: any[]) => void): this;
}

/**
 * Tasks service with custom methods (server-side implementation)
 */
export interface TasksServiceImpl extends Service<Task, Partial<Task>, FeathersParams> {
  createMany(data: Array<Partial<Task>>): Promise<Task[]>;
  complete(
    id: string,
    data: { git_state?: { sha_at_end?: string; commit_message?: string } },
    params?: FeathersParams
  ): Promise<Task>;
  fail(id: string, data: { error?: string }, params?: FeathersParams): Promise<Task>;
  getOrphaned(params?: FeathersParams): Promise<Task[]>;
}

/**
 * Repos service with custom methods (server-side implementation)
 */
export interface ReposServiceImpl extends Service<Repo, Partial<Repo>, FeathersParams> {
  cloneRepository(
    data: { url: string; name?: string; destination?: string },
    params?: FeathersParams
  ): Promise<Repo>;
  createWorktree(
    id: string,
    data: {
      name: string;
      ref: string;
      createBranch?: boolean;
      pullLatest?: boolean;
      sourceBranch?: string;
      issue_url?: string;
      pull_request_url?: string;
      boardId?: string;
    },
    params?: FeathersParams
  ): Promise<Worktree>;
  removeWorktree(id: string, name: string, params?: FeathersParams): Promise<Repo>;
  importFromAgorYml(id: string, data: unknown, params?: FeathersParams): Promise<Repo>;
  exportToAgorYml(id: string, data: unknown, params?: FeathersParams): Promise<{ path: string }>;
}

/**
 * Boards service with custom methods (server-side implementation)
 */
export interface BoardsServiceImpl extends Service<Board, Partial<Board>, FeathersParams> {
  addSession(boardId: string, sessionId: string, params?: FeathersParams): Promise<Board>;
  removeSession(boardId: string, sessionId: string, params?: FeathersParams): Promise<Board>;
  upsertBoardObject(
    boardId: string,
    objectId: string,
    objectData: unknown,
    params?: FeathersParams
  ): Promise<Board>;
  removeBoardObject(boardId: string, objectId: string, params?: FeathersParams): Promise<Board>;
  batchUpsertBoardObjects(
    boardId: string,
    objects: unknown[],
    params?: FeathersParams
  ): Promise<Board>;
  deleteZone(
    boardId: string,
    zoneId: string,
    deleteAssociatedSessions: boolean,
    params?: FeathersParams
  ): Promise<{ board: Board; affectedSessions: string[] }>;
}

/**
 * Messages service with custom methods (server-side implementation)
 */
export interface MessagesServiceImpl extends Service<Message, Partial<Message>, FeathersParams> {
  createMany(data: Array<Partial<Message>>): Promise<Message[]>;
}

/**
 * Worktrees service with custom methods (server-side implementation)
 */
export interface WorktreesServiceImpl extends Service<Worktree, Partial<Worktree>, FeathersParams> {
  startEnvironment(id: WorktreeID, params?: FeathersParams): Promise<Worktree>;
  stopEnvironment(id: WorktreeID, params?: FeathersParams): Promise<Worktree>;
  restartEnvironment(id: WorktreeID, params?: FeathersParams): Promise<Worktree>;
  checkHealth(id: WorktreeID, params?: FeathersParams): Promise<Worktree>;
  getLogs(
    id: WorktreeID,
    params?: FeathersParams
  ): Promise<{
    logs: string;
    timestamp: string;
    error?: string;
    truncated?: boolean;
  }>;
  archiveOrDelete(
    id: WorktreeID,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    },
    params?: FeathersParams
  ): Promise<Worktree | { deleted: true; worktree_id: WorktreeID }>;
  unarchive(
    id: WorktreeID,
    options?: { boardId?: import('@agor/core/types').BoardID },
    params?: FeathersParams
  ): Promise<Worktree>;
}
