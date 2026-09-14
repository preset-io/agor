/**
 * @agor-live/client — TypeScript client for connecting to the Agor daemon
 *
 * Usage:
 *   import { createClient } from '@agor-live/client';
 *   const client = createClient('http://localhost:3030', true, {
 *     socketAuthentication: { accessToken }
 *   });
 */

import {
  AGENTIC_TOOL_CAPABILITIES as PRIVATE_AGENTIC_TOOL_CAPABILITIES,
  AGENTIC_TOOL_DISPLAY_NAMES as PRIVATE_AGENTIC_TOOL_DISPLAY_NAMES,
  AGENTIC_TOOL_KEY_CREATION_URL as PRIVATE_AGENTIC_TOOL_KEY_CREATION_URL,
  TOOL_API_KEY_NAMES as PRIVATE_TOOL_API_KEY_NAMES,
} from '@agor/agentic-tools';
import type { AgorClient as CoreAgorClient } from '@agor/core/client';
import {
  createClient as createCoreClient,
  createRestClient as createCoreRestClient,
  getApiKeyFromEnv,
  isDaemonRunning,
} from '@agor/core/client';
import type {
  AgenticToolCapabilities,
  AgenticToolName,
  ApiKeyName,
  PersistedAgenticToolName,
} from '@agor/core/types';
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

// @agor/core/client is the canonical browser-safe client surface. Keep this
// wildcard so new public core client types do not require a synchronized list.
export * from '@agor/core/client';

// Derive this public alias from the function we wrap instead of asking the DTS
// bundler to resolve the same named type through @agor/core's source and
// declaration export conditions. This keeps clean packaged builds deterministic
// while preserving the exact core client contract.
export type AuthenticatedAgorClient = Awaited<ReturnType<typeof createCoreRestClient>>;

// Preserve the published client contract while keeping registry values package-owned.
export const TOOL_API_KEY_NAMES: Partial<Record<AgenticToolName, ApiKeyName>> =
  PRIVATE_TOOL_API_KEY_NAMES;
export const AGENTIC_TOOL_DISPLAY_NAMES: Record<PersistedAgenticToolName, string> =
  PRIVATE_AGENTIC_TOOL_DISPLAY_NAMES;
export const AGENTIC_TOOL_KEY_CREATION_URL: Partial<Record<AgenticToolName, string>> =
  PRIVATE_AGENTIC_TOOL_KEY_CREATION_URL;
export const AGENTIC_TOOL_CAPABILITIES: Record<AgenticToolName, AgenticToolCapabilities> =
  PRIVATE_AGENTIC_TOOL_CAPABILITIES;
// `shortId` is the canonical display helper (always SHORT_ID_LENGTH chars).
// Use it for any UUID rendered to a user — URLs, pills, logs, notifications.
// `toShortId(id, length)` is the lower-level primitive for rare cases that
// need a non-canonical length (e.g. `findMinimumPrefixLength`).
export { shortId } from '@agor/core/client';
export { isValidSlug, REPO_SLUG_PATTERN } from '@agor/core/config/browser';
export type { PaginatedResult } from '@agor/core/types';
export { getGatewayCredentialPresentation } from '@agor/core/types';
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
): Promise<AuthenticatedAgorClient> {
  return createCoreRestClient(...args);
}

export {
  attachReactiveSessionApi,
  getApiKeyFromEnv,
  isDaemonRunning,
  releaseReactiveSession,
  retainReactiveSession,
};
