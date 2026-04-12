/**
 * @agor-live/client — TypeScript client for connecting to the Agor daemon
 *
 * Usage:
 *   import { createClient } from '@agor-live/client';
 *   const client = createClient('http://localhost:3030');
 */

import type { AgorClient as CoreAgorClient } from '../../core/src/api/index';
import {
  createClient as createCoreClient,
  createRestClient as createCoreRestClient,
  isDaemonRunning,
} from '../../core/src/api/index';
import {
  attachReactiveSessionApi,
  type ReactiveAgorClient,
  type ReactiveLoadedTaskIds,
  type ReactiveMessagesByTask,
  type ReactiveSessionHandle,
  type ReactiveSessionOptions,
  type ReactiveSessionState,
  type ReactiveStreamingMessagesById,
  type ReactiveToolsByTask,
  type StreamingMessageState,
  type TaskHydrationMode,
  type ToolExecutionState,
} from './reactive-session';

export type {
  AgorClient,
  AgorService,
  BoardsService,
  MessagesService,
  ReposLocalService,
  ReposService,
  ServiceTypes,
  SessionsService,
  TasksService,
  WorktreesService,
} from '../../core/src/api/index';

export type {
  ReactiveAgorClient,
  ReactiveLoadedTaskIds,
  ReactiveMessagesByTask,
  ReactiveSessionHandle,
  ReactiveSessionOptions,
  ReactiveSessionState,
  ReactiveStreamingMessagesById,
  ReactiveToolsByTask,
  StreamingMessageState,
  TaskHydrationMode,
  ToolExecutionState,
};

// Core types that consumers need for working with the API
export type {
  Artifact,
  AuthenticationResult,
  Board,
  BoardExportBlob,
  CardType,
  CardWithType,
  ContextFileDetail,
  ContextFileListItem,
  MCPServer,
  Message,
  Repo,
  Session,
  Task,
  User,
  Worktree,
} from '../../core/src/types/index';

export function createClient(...args: Parameters<typeof createCoreClient>): ReactiveAgorClient {
  const client = createCoreClient(...args);
  return attachReactiveSessionApi(client as CoreAgorClient);
}

export async function createRestClient(
  ...args: Parameters<typeof createCoreRestClient>
): Promise<CoreAgorClient> {
  return createCoreRestClient(...args);
}

export { attachReactiveSessionApi };
export { isDaemonRunning };
