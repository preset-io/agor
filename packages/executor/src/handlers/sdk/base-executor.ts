/**
 * Base Executor - Shared execution logic for all SDK tools
 *
 * This module provides shared helpers to reduce duplication across
 * Claude, Codex, Gemini, and OpenCode executors.
 */

import { type ApiKeyName, resolveApiKey } from '@agor/core/config';
import { createDatabase, createLocalDatabase, type Database } from '@agor/core/db';
import { getCurrentSha } from '@agor/core/git';
import type { MessageID, PermissionMode, SessionID, Task, TaskID, UserID } from '@agor/core/types';
import { createFeathersBackedRepositories } from '../../db/feathers-repositories.js';
import type { StreamingCallbacks } from '../../sdk-handlers/base/types.js';
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
    callbacks?: StreamingCallbacks
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

  // Helper to broadcast streaming events via custom route
  const broadcastEvent = async (
    event:
      | 'streaming:start'
      | 'streaming:chunk'
      | 'streaming:end'
      | 'streaming:error'
      | 'thinking:start'
      | 'thinking:chunk'
      | 'thinking:end',
    data: Record<string, unknown>
  ) => {
    await client.service('/messages/streaming').create({
      event,
      data,
    });
  };

  return {
    onStreamStart: async (message_id, data) => {
      await broadcastEvent('streaming:start', {
        message_id,
        session_id: currentSessionId,
        task_id: data.task_id,
        role: data.role,
        timestamp: data.timestamp,
      });
    },
    onStreamChunk: async (message_id, chunk) => {
      console.log(
        `[${toolName}] Streaming chunk: ${message_id.substring(0, 8)}, length: ${chunk.length}`
      );
      await broadcastEvent('streaming:chunk', {
        message_id,
        session_id: currentSessionId,
        chunk,
      });
    },
    onStreamEnd: async (message_id) => {
      console.log(`[${toolName}] Stream ended: ${message_id}`);
      await broadcastEvent('streaming:end', {
        message_id,
        session_id: currentSessionId,
      });
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
 * Capture git SHA at task end
 *
 * Fetches the worktree path from the session and captures the current git SHA.
 * Returns the SHA or undefined if it cannot be determined.
 */
async function captureGitShaAtTaskEnd(
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

    // Get current git SHA
    const sha = await getCurrentSha(worktree.path);
    console.log(`[Git SHA Capture] Captured SHA at task end: ${sha.substring(0, 8)}`);
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
  // Get database connection
  let db: Database;
  const dbUrl = process.env.LIBSQL_URL || process.env.DATABASE_URL;

  if (dbUrl) {
    // Use custom database URL from environment
    db = createDatabase({ url: dbUrl });
  } else {
    // Use default local database (~/.agor/agor.db)
    try {
      db = createLocalDatabase();
    } catch (err) {
      console.warn(
        '[API Key Resolution] No database connection available, using config/env only:',
        err
      );
      // Fall back to sync resolution (config + env only, no per-user keys)
      return resolveApiKey(keyName, {});
    }
  }

  // Fetch task to get creator user ID
  let contextUserId: UserID | undefined;
  try {
    const task = await client.service('tasks').get(taskId);
    if (task?.created_by) {
      contextUserId = task.created_by as UserID;
      console.log(
        `[API Key Resolution] Task ${taskId.substring(0, 8)} created by user ${contextUserId.substring(0, 8)}`
      );
    }
  } catch (err) {
    console.warn(`[API Key Resolution] Failed to fetch task ${taskId}:`, err);
  }

  // Resolve API key with full precedence hierarchy
  const result = await resolveApiKey(keyName, {
    userId: contextUserId,
    db,
  });

  return result;
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
    const result = await tool.executePromptWithStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode,
      ctx.callbacks
    );

    console.log(
      `[${toolName}] Execution completed: user=${result.userMessageId}, assistant=${result.assistantMessageIds.length} messages`
    );

    // Capture git SHA at task end
    const shaAtEnd = await captureGitShaAtTaskEnd(client, sessionId);

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

    // Update task status to completed with git SHA
    await client.service('tasks').patch(taskId, patchData);
  } catch (error) {
    const err = error as Error;
    console.error(`[${toolName}] Execution failed:`, err);

    // Capture git SHA at task end (even for failed tasks)
    const shaAtEnd = await captureGitShaAtTaskEnd(client, sessionId);

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
