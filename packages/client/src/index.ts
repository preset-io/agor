/**
 * @agor-live/client — TypeScript client for connecting to the Agor daemon
 *
 * Usage:
 *   import { createClient } from '@agor-live/client';
 *   const client = createClient('http://localhost:3030');
 */

import type { AgorClient as CoreAgorClient } from '@agor/core/client';
import {
  createClient as createCoreClient,
  createRestClient as createCoreRestClient,
  getApiKeyFromEnv,
  isDaemonRunning,
} from '@agor/core/client';
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
  BranchesService,
  MessagesService,
  ReposCloneService,
  ReposLocalService,
  ReposService,
  ServiceTypes,
  SessionsService,
  TasksService,
} from '@agor/core/client';
export * from '@agor/core/client';
// `shortId` is the canonical display helper (always SHORT_ID_LENGTH chars).
// Use it for any UUID rendered to a user — URLs, pills, logs, notifications.
// `toShortId(id, length)` is the lower-level primitive for rare cases that
// need a non-canonical length (e.g. `findMinimumPrefixLength`).
export { shortId } from '@agor/core/client';
export { isValidSlug, REPO_SLUG_PATTERN } from '@agor/core/config/browser';
export type { PaginatedResult } from '@agor/core/types';
export * from './models';
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

export function createClient(...args: Parameters<typeof createCoreClient>): ReactiveAgorClient {
  const client = createCoreClient(...args);
  return attachReactiveSessionApi(client as CoreAgorClient);
}

export async function createRestClient(
  ...args: Parameters<typeof createCoreRestClient>
): Promise<CoreAgorClient> {
  return createCoreRestClient(...args);
}

export {
  attachReactiveSessionApi,
  getApiKeyFromEnv,
  isDaemonRunning,
  releaseReactiveSession,
  retainReactiveSession,
};
