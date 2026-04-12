/**
 * @agor-live/client — TypeScript client for connecting to the Agor daemon
 *
 * Usage:
 *   import { createClient } from '@agor-live/client';
 *   const client = createClient('http://localhost:3030');
 */

import type { AgorClient as CoreAgorClient } from '@agor/core/api';
import {
  createClient as createCoreClient,
  createRestClient as createCoreRestClient,
  getApiKeyFromEnv,
  isDaemonRunning,
} from '@agor/core/api';
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
  releaseReactiveSession,
  retainReactiveSession,
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
} from '@agor/core/api';

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

export * from '@agor/core/config/browser';
export type { AgorConfig } from '@agor/core/config/types';
export * from '@agor/core/models';
export * from '@agor/core/templates/handlebars-helpers';
// Re-export full browser-safe type/runtime surface for UI consumers.
export * from '@agor/core/types';
export { toShortId as formatShortId } from '@agor/core/types';

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
export { releaseReactiveSession, retainReactiveSession };
export { getApiKeyFromEnv };
export { isDaemonRunning };
