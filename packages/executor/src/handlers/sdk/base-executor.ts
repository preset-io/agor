/**
 * Base Executor - Shared execution logic for all SDK tools
 *
 * This module provides shared helpers to reduce duplication across
 * Claude, Codex, Gemini, and OpenCode executors.
 */

import { type ApiKeyName, resolveApiKey } from '@agor/core/config';
import { getGitState } from '@agor/core/git';
import type {
  MessageID,
  MessageSource,
  PermissionMode,
  SessionID,
  StreamingEventType,
  Task,
  TaskID,
} from '@agor/core/types';
import { createFeathersBackedRepositories } from '../../db/feathers-repositories.js';
import type { StreamingCallbacks } from '../../sdk-handlers/base/types.js';
import { normalizeRawSdkResponse } from '../../sdk-handlers/normalizer-factory.js';
import type { AgorClient } from '../../services/feathers-client.js';

/**
 * Tool interface that all SDK wrappers must implement
 */
export interface BaseTool {
  executePromptWithStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    callbacks?: StreamingCallbacks,
    abortController?: AbortController,
    messageSource?: MessageSource
  ): Promise<{
    userMessageId: MessageID;
    assistantMessageIds: MessageID[];
    tokenUsage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      cache_creation_tokens?: number;
    };
    wasStopped?: boolean;
    /** Raw SDK response for token accounting - stored and normalized */
    rawSdkResponse?: unknown;
  }>;

  // Optional stopTask method for tools that support interruption
  stopTask?(
    sessionId: SessionID,
    taskId?: TaskID
  ): Promise<{
    success: boolean;
    partialResult?: Partial<{ taskId: string; status: 'completed' | 'failed' | 'cancelled' }>;
    reason?: string;
  }>;

  /**
   * Compute cumulative context window usage for a session
   *
   * Each tool implements its own strategy:
   * - Claude Code: Sum input+output tokens across tasks since last compaction
   * - Codex/Gemini: May use SDK's cumulative reporting
   *
   * @param sessionId - Session ID to compute context for
   * @param currentTaskId - Current task ID (optional)
   * @param currentRawSdkResponse - Raw SDK response for current task (required during task completion)
   * @returns Cumulative context window usage in tokens
   */
  computeContextWindow?(
    sessionId: string,
    currentTaskId?: string,
    currentRawSdkResponse?: unknown
  ): Promise<number>;
}

/**
 * Execution context containing all necessary resources for SDK execution
 */
export interface ExecutionContext {
  client: AgorClient;
  repos: ReturnType<typeof createFeathersBackedRepositories>;
  callbacks: StreamingCallbacks;
}

/**
 * Create streaming callbacks that call daemon custom route to broadcast events
 *
 * IMPORTANT: Executors cannot emit events directly - they must call a custom route
 * which then uses app.service().emit() to trigger the daemon's app.publish() system.
 * See: context/guides/extending-feathers-services.md
 */
export function createStreamingCallbacks(
  client: AgorClient,
  toolName: string,
  sessionId: SessionID
): StreamingCallbacks {
  // Use session_id passed in (available before any streaming starts)
  // This ensures thinking events have session_id even if they fire before onStreamStart
  const currentSessionId: SessionID = sessionId;

  // Track sequence numbers per message for ordering guarantees
  const sequenceCounters = new Map<string, number>();

  // Helper to broadcast streaming events via custom route
  const broadcastEvent = async (event: StreamingEventType, data: Record<string, unknown>) => {
    await client.service('/messages/streaming').create({
      event,
      data,
    });
  };

  return {
    onStreamStart: async (message_id, data) => {
      // Initialize sequence counter for this message
      sequenceCounters.set(message_id, 0);

      await broadcastEvent('streaming:start', {
        message_id,
        session_id: currentSessionId,
        task_id: data.task_id,
        role: data.role,
        timestamp: data.timestamp,
      });
    },
    onStreamChunk: async (message_id, chunk, _sequenceOverride?: number) => {
      // Get and increment sequence number for this message
      const currentSeq = sequenceCounters.get(message_id) || 0;
      const sequence = _sequenceOverride !== undefined ? _sequenceOverride : currentSeq;
      sequenceCounters.set(message_id, sequence + 1);

      await broadcastEvent('streaming:chunk', {
        message_id,
        session_id: currentSessionId,
        chunk,
        sequence, // Add sequence number for ordering
      });
    },
    onStreamEnd: async (message_id) => {
      // Get final sequence number for this message
      const finalSequence = sequenceCounters.get(message_id) || 0;

      await broadcastEvent('streaming:end', {
        message_id,
        session_id: currentSessionId,
        sequence: finalSequence, // Include final sequence for validation
      });

      // Clean up sequence counter
      sequenceCounters.delete(message_id);
    },
    onStreamError: async (message_id, error) => {
      console.error(`[${toolName}] Stream error for ${message_id}:`, error);
      await broadcastEvent('streaming:error', {
        message_id,
        session_id: currentSessionId,
        error: error.message,
      });
    },
    onThinkingStart: async (message_id, metadata) => {
      await broadcastEvent('thinking:start', {
        message_id,
        session_id: currentSessionId,
        ...metadata,
      });
    },
    onThinkingChunk: async (message_id, chunk) => {
      await broadcastEvent('thinking:chunk', {
        message_id,
        session_id: currentSessionId,
        chunk,
      });
    },
    onThinkingEnd: async (message_id) => {
      await broadcastEvent('thinking:end', {
        message_id,
        session_id: currentSessionId,
      });
    },
  };
}

/**
 * Create execution context with all necessary resources
 */
export function createExecutionContext(
  client: AgorClient,
  toolName: string,
  sessionId: SessionID
): ExecutionContext {
  return {
    client,
    repos: createFeathersBackedRepositories(client),
    callbacks: createStreamingCallbacks(client, toolName, sessionId),
  };
}

/**
 * Capture git state at task end
 *
 * Fetches the worktree path from the session and captures the current git state.
 * Returns the SHA (with "-dirty" suffix if working directory has uncommitted changes)
 * or undefined if it cannot be determined.
 */
async function captureGitStateAtTaskEnd(
  client: AgorClient,
  sessionId: SessionID
): Promise<string | undefined> {
  try {
    // Get session to find worktree
    const session = await client.service('sessions').get(sessionId);
    if (!session.worktree_id) {
      console.warn('[Git SHA Capture] Session has no worktree_id');
      return undefined;
    }

    // Get worktree to find path
    const worktree = await client.service('worktrees').get(session.worktree_id);
    if (!worktree.path) {
      console.warn('[Git SHA Capture] Worktree has no path');
      return undefined;
    }

    // Get current git state (includes dirty detection)
    const sha = await getGitState(worktree.path);
    console.log(
      `[Git SHA Capture] Captured git state at task end: ${sha.substring(0, 8)}${sha.endsWith('-dirty') ? ' (dirty)' : ''}`
    );
    return sha;
  } catch (error) {
    console.warn('[Git SHA Capture] Failed to capture git SHA at task end:', error);
    return undefined;
  }
}

/**
 * Resolve API key with proper precedence:
 * 1. Per-user encrypted keys (from database) - HIGHEST
 * 2. Global config.yaml keys - MEDIUM
 * 3. Environment variables - LOW
 * 4. SDK native auth (OAuth, CLI login) - FALLBACK
 *
 * Returns resolution result with key, source, and useNativeAuth flag
 */
async function resolveApiKeyForTask(
  keyName: ApiKeyName,
  client: AgorClient,
  taskId: TaskID
): Promise<import('@agor/core/config').KeyResolutionResult> {
  // Call daemon service to resolve API key (no direct database access from executor!)
  // This allows executors to run as different Unix users without needing database access
  try {
    const result = (await client.service('config/resolve-api-key').create({
      taskId,
      keyName,
    })) as import('@agor/core/config').KeyResolutionResult;
    console.log(`[API Key Resolution] Resolved ${keyName} via daemon (source: ${result.source})`);
    return result;
  } catch (err) {
    console.warn('[API Key Resolution] Failed to resolve via daemon service:', err);
    // Fall back to sync resolution (config + env only, no per-user keys)
    return resolveApiKey(keyName, {});
  }
}

/**
 * Execute a tool task - shared implementation for all SDK tools
 */
export async function executeToolTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
  apiKeyEnvVar: string;
  toolName: string;
  messageSource?: 'gateway' | 'agor';
  createTool: (
    repos: ReturnType<typeof createFeathersBackedRepositories>,
    apiKey: string,
    useNativeAuth: boolean
  ) => BaseTool;
}): Promise<void> {
  const { client, sessionId, taskId, prompt, permissionMode, apiKeyEnvVar, toolName, createTool } =
    params;

  console.log(`[${toolName}] Executing task ${taskId.substring(0, 8)}...`);

  // Resolve API key with proper precedence (user → config → env → native auth)
  const resolution = await resolveApiKeyForTask(apiKeyEnvVar as ApiKeyName, client, taskId);

  // Fail fast if stored key can't be decrypted (e.g. master secret changed)
  if (resolution.decryptionFailed) {
    throw new Error(
      `API key "${apiKeyEnvVar}" could not be decrypted. ` +
        `The stored key may have been encrypted with a different master secret. ` +
        `Please re-enter your API key in Settings > API Keys.`
    );
  }

  // Log resolution result
  if (resolution.apiKey) {
    console.log(`[${toolName}] Using API key from ${resolution.source} level for ${apiKeyEnvVar}`);
  } else {
    console.log(
      `[${toolName}] No API key found - SDK will use native authentication (OAuth/CLI login)`
    );
  }

  // Create execution context
  const ctx = createExecutionContext(client, toolName, sessionId);

  // Create tool instance using factory function
  // Pass the resolved key (or empty string) and useNativeAuth flag
  const tool = createTool(ctx.repos, resolution.apiKey || '', resolution.useNativeAuth);

  // Wire up abort signal to tool's stopTask method
  const abortHandler = async () => {
    console.log(`[${toolName}] Abort signal received, calling tool.stopTask()...`);
    if (tool.stopTask) {
      try {
        const stopResult = await tool.stopTask(sessionId, taskId);
        if (stopResult.success) {
          console.log(`[${toolName}] Tool stopped successfully`);
          // NOTE: Completion signal is sent AFTER executePromptWithStreaming returns
          // This ensures all streaming chunks have been flushed before we signal completion
        } else {
          console.warn(`[${toolName}] Tool stop failed: ${stopResult.reason}`);
        }
      } catch (error) {
        console.error(`[${toolName}] Error calling stopTask:`, error);
      }
    } else {
      console.warn(`[${toolName}] Tool does not implement stopTask method`);
    }
  };

  // Handle race condition: if signal is already aborted, call handler immediately
  if (params.abortController.signal.aborted) {
    await abortHandler();
  }

  // Listen for abort signal
  params.abortController.signal.addEventListener('abort', abortHandler);

  try {
    // Execute prompt with streaming
    // Pass abortController directly to SDK for proper cancellation support
    const result = await tool.executePromptWithStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode,
      ctx.callbacks,
      params.abortController,
      params.messageSource
    );

    console.log(
      `[${toolName}] Execution completed: user=${result.userMessageId}, assistant=${result.assistantMessageIds.length} messages`
    );

    // Capture git SHA at task end
    const shaAtEnd = await captureGitStateAtTaskEnd(client, sessionId);

    // Build patch data
    const patchData: Partial<Task> = {
      status: result.wasStopped ? 'stopped' : 'completed',
      completed_at: new Date().toISOString(),
    };

    // Add git_state if we captured a SHA
    // Note: This will be deep-merged with existing git_state by the repository layer
    if (shaAtEnd) {
      // @ts-expect-error - Partial update of nested git_state object is handled by repository deep merge
      patchData.git_state = {
        sha_at_end: shaAtEnd,
      };
    }

    // Add SDK response data for token accounting
    // Store both raw (for debugging) and normalized (for UI/analytics)
    if (result.rawSdkResponse) {
      patchData.raw_sdk_response = result.rawSdkResponse;
      // Normalize using tool-specific normalizer (toolName maps to agentic tool type)
      const normalized = normalizeRawSdkResponse(toolName, result.rawSdkResponse);
      if (normalized) {
        patchData.normalized_sdk_response = normalized;
        console.log(
          `[${toolName}] Normalized SDK response: ${normalized.tokenUsage.totalTokens} tokens, $${normalized.costUsd?.toFixed(4) ?? 'N/A'}`
        );
      }

      // Compute cumulative context window usage (BEFORE the patch to avoid DB deadlocks)
      if (tool.computeContextWindow) {
        try {
          const contextWindow = await tool.computeContextWindow(
            sessionId,
            taskId,
            result.rawSdkResponse
          );
          if (contextWindow > 0) {
            patchData.computed_context_window = contextWindow;
            console.log(`[${toolName}] Computed context window: ${contextWindow} tokens`);
          }
        } catch (error) {
          console.error(`[${toolName}] Failed to compute context window:`, error);
          // Continue without context window - not critical
        }
      }
    }

    // Update task status to completed/stopped with git SHA and SDK responses
    await client.service('tasks').patch(taskId, patchData);

    // Send completion signal if task was stopped
    if (result.wasStopped) {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Feathers types don't support custom events
        (client.service('sessions') as any).emit('task_stopped_complete', {
          session_id: sessionId,
          task_id: taskId,
          stopped_at: new Date().toISOString(),
        });
        console.log(`✅ [${toolName}] Sent stop complete signal after execution finished`);
      } catch (error) {
        console.error(`❌ [${toolName}] Failed to send stop complete signal:`, error);
      }
    }
  } catch (error) {
    const err = error as Error;
    console.error(`[${toolName}] Execution failed:`, err);

    // Capture git SHA at task end (even for failed tasks)
    const shaAtEnd = await captureGitStateAtTaskEnd(client, sessionId);

    // Build patch data
    const patchData: Partial<Task> = {
      status: 'failed',
      completed_at: new Date().toISOString(),
    };

    // Add git_state if we captured a SHA
    // Note: This will be deep-merged with existing git_state by the repository layer
    if (shaAtEnd) {
      // @ts-expect-error - Partial update of nested git_state object is handled by repository deep merge
      patchData.git_state = {
        sha_at_end: shaAtEnd,
      };
    }

    // Update task status to failed with git SHA
    await client.service('tasks').patch(taskId, patchData);

    throw err;
  } finally {
    // Clean up abort listener
    params.abortController.signal.removeEventListener('abort', abortHandler);
  }
}
