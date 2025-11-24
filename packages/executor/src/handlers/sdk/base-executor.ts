/**
 * Base Executor - Shared execution logic for all SDK tools
 *
 * This module provides shared helpers to reduce duplication across
 * Claude, Codex, Gemini, and OpenCode executors.
 */

import { type ApiKeyName, resolveApiKey } from '@agor/core/config';
import { createDatabase, createLocalDatabase, type Database } from '@agor/core/db';
import type { MessageID, PermissionMode, SessionID, TaskID, UserID } from '@agor/core/types';
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
 * Create streaming callbacks that emit events directly via Feathers WebSocket
 */
export function createStreamingCallbacks(client: AgorClient, toolName: string): StreamingCallbacks {
  return {
    onStreamStart: async (message_id, data) => {
      // Emit via Feathers WebSocket
      // biome-ignore lint/suspicious/noExplicitAny: Feathers service types don't include emit method
      (client.service('messages') as any).emit('stream:start', {
        message_id,
        session_id: data.session_id,
        task_id: data.task_id,
        role: data.role,
        timestamp: data.timestamp,
      });
    },
    onStreamChunk: async (message_id, text) => {
      // biome-ignore lint/suspicious/noExplicitAny: Feathers service types don't include emit method
      (client.service('messages') as any).emit('stream:chunk', {
        message_id,
        text,
      });
    },
    onStreamEnd: async (message_id) => {
      console.log(`[${toolName}] Stream ended: ${message_id}`);
      // biome-ignore lint/suspicious/noExplicitAny: Feathers service types don't include emit method
      (client.service('messages') as any).emit('stream:end', {
        message_id,
      });
    },
    onStreamError: async (message_id, error) => {
      console.error(`[${toolName}] Stream error for ${message_id}:`, error);
      // biome-ignore lint/suspicious/noExplicitAny: Feathers service types don't include emit method
      (client.service('messages') as any).emit('stream:error', {
        message_id,
        error: error.message,
      });
    },
    onThinkingStart: async (message_id, metadata) => {
      // biome-ignore lint/suspicious/noExplicitAny: Feathers service types don't include emit method
      (client.service('messages') as any).emit('thinking:start', {
        message_id,
        metadata,
      });
    },
    onThinkingChunk: async (message_id, chunk) => {
      // biome-ignore lint/suspicious/noExplicitAny: Feathers service types don't include emit method
      (client.service('messages') as any).emit('thinking:chunk', {
        message_id,
        chunk,
      });
    },
    onThinkingEnd: async (message_id) => {
      // biome-ignore lint/suspicious/noExplicitAny: Feathers service types don't include emit method
      (client.service('messages') as any).emit('thinking:end', {
        message_id,
      });
    },
  };
}

/**
 * Create execution context with all necessary resources
 */
export function createExecutionContext(client: AgorClient, toolName: string): ExecutionContext {
  return {
    client,
    repos: createFeathersBackedRepositories(client),
    callbacks: createStreamingCallbacks(client, toolName),
  };
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
  const ctx = createExecutionContext(client, toolName);

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

    // Update task status to completed
    await client.service('tasks').patch(taskId, {
      status: result.wasStopped ? 'stopped' : 'completed',
      completed_at: new Date().toISOString(),
    });
  } catch (error) {
    const err = error as Error;
    console.error(`[${toolName}] Execution failed:`, err);

    // Update task status to failed
    await client.service('tasks').patch(taskId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
    });

    throw err;
  } finally {
    // Clean up abort listener
    params.abortController.signal.removeEventListener('abort', abortHandler);
  }
}
