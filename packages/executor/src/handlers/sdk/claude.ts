/**
 * Claude SDK Handler
 *
 * Executes prompts using Claude Code SDK with Feathers client connection to daemon
 */

import type { PermissionMode, SessionID, TaskID } from '@agor/core/types';
import { createFeathersBackedRepositories } from '../../db/feathers-repositories.js';
import type { ExecutorIPCServer } from '../../ipc-server.js';
import { globalPermissionManager } from '../../permissions/permission-manager.js';
import { PermissionService } from '../../permissions/permission-service.js';
import { ClaudeTool } from '../../sdk-handlers/claude/claude-tool.js';
import { DaemonClient } from '../../services/daemon-client.js';
import {
  type AgorClient,
  createExecutorClient,
  getDaemonUrl,
} from '../../services/feathers-client.js';
import type { ExecutePromptParams, ExecutePromptResult } from '../../types.js';

/**
 * Execute Claude prompt using Feathers client
 */
export async function executeClaudeSDK(
  params: ExecutePromptParams,
  apiKey: string,
  ipcServer: ExecutorIPCServer
): Promise<ExecutePromptResult> {
  const { session_token, session_id, task_id, prompt, permission_mode } = params;

  // Connect to daemon via Feathers client
  const daemonUrl = getDaemonUrl();
  console.log(`[claude] Connecting to daemon at ${daemonUrl}...`);
  const client = await createExecutorClient(daemonUrl, session_token);

  // Create DaemonClient for IPC communication (streaming, permissions, etc.)
  const daemonClient = new DaemonClient(ipcServer, session_token);

  // Create Feathers-backed repositories that proxy to daemon services
  const repos = createFeathersBackedRepositories(client);

  // Create PermissionService for this session that emits via IPC to daemon
  const permissionService = new PermissionService(async (event, data) => {
    await daemonClient.emitPermissionEvent({ event, data });
  });

  // Register with global permission manager
  globalPermissionManager.register(session_id, permissionService);

  try {
    // Create Tool instance with repositories and services
    const tool = new ClaudeTool(
      repos.messages, // MessagesRepository
      repos.sessions, // SessionRepository
      apiKey, // API key
      repos.messagesService, // MessagesService (for creating messages via Feathers)
      repos.sessionMCP, // SessionMCPServerRepository
      repos.mcpServers, // MCPServerRepository
      permissionService, // PermissionService
      repos.tasksService, // TasksService
      repos.sessionsService, // SessionsService
      repos.worktrees, // WorktreeRepository
      repos.repos, // RepoRepository
      true // mcpEnabled
    );

    // Execute prompt with streaming
    const result = await tool.executePromptWithStreaming(
      session_id as import('@agor/core/types').SessionID,
      prompt,
      task_id as import('@agor/core/types').TaskID | undefined,
      permission_mode as import('@anthropic-ai/claude-agent-sdk').PermissionMode | undefined,
      {
        onStreamStart: async (message_id, data) => {
          await daemonClient.streamStart({
            message_id,
            session_id: data.session_id,
            task_id: data.task_id,
            role: data.role,
            timestamp: data.timestamp,
          });
        },
        onStreamChunk: async (message_id, text) => {
          await daemonClient.streamChunk({ message_id, text });
        },
        onStreamEnd: async (message_id) => {
          console.log(`[claude] Stream ended: ${message_id}`);
        },
        onStreamError: async (message_id, error) => {
          console.error(`[claude] Stream error for ${message_id}:`, error);
        },
        onThinkingStart: async (message_id, metadata) => {
          await daemonClient.thinkingStart({ message_id, metadata });
        },
        onThinkingChunk: async (message_id, chunk) => {
          await daemonClient.thinkingChunk({ message_id, chunk });
        },
        onThinkingEnd: async (message_id) => {
          await daemonClient.thinkingEnd({ message_id });
        },
      }
    );

    console.log(
      `[claude] Execution completed: user=${result.userMessageId}, assistant=${result.assistantMessageIds.length} messages`
    );

    return {
      status: 'completed',
      message_count: 1 + result.assistantMessageIds.length,
      token_usage: result.tokenUsage
        ? {
            input_tokens: result.tokenUsage.input_tokens ?? 0,
            output_tokens: result.tokenUsage.output_tokens ?? 0,
            cache_read_tokens: result.tokenUsage.cache_read_tokens,
            cache_write_tokens: result.tokenUsage.cache_creation_tokens,
          }
        : undefined,
    };
  } catch (error) {
    const err = error as Error;
    console.error('[claude] Execution failed:', err);
    throw err;
  } finally {
    // Unregister from global permission manager
    globalPermissionManager.unregister(session_id);

    // Close client connection
    client.io.close();
  }
}

/**
 * Execute Claude Code task (new Feathers/WebSocket architecture)
 *
 * Used by ephemeral executor - no IPC, direct Feathers client passed in
 */
export async function executeClaudeCodeTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
}): Promise<void> {
  const { client, sessionId, taskId, prompt, permissionMode, abortController } = params;

  console.log(`[claude] Executing task ${taskId.substring(0, 8)}`);

  // Get API key from environment (injected by daemon)
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY not configured. This should be injected by daemon via environment variables.'
    );
  }

  // Create Feathers-backed repositories
  const repos = createFeathersBackedRepositories(client);

  // Create PermissionService that emits via Feathers WebSocket
  const permissionService = new PermissionService(async (event, data) => {
    // Emit permission events directly via Feathers
    // biome-ignore lint/suspicious/noExplicitAny: Feathers service types don't include emit method
    (client.service('sessions') as any).emit(event, data);
  });

  // Register with global permission manager
  globalPermissionManager.register(sessionId, permissionService);

  // Create Tool instance
  const tool = new ClaudeTool(
    repos.messages,
    repos.sessions,
    apiKey,
    repos.messagesService,
    repos.sessionMCP,
    repos.mcpServers,
    permissionService,
    repos.tasksService,
    repos.sessionsService,
    repos.worktrees,
    repos.repos,
    true // mcpEnabled
  );

  // Setup abort signal listener to stop execution when requested
  const abortListener = () => {
    console.log('[claude] Abort signal received, stopping execution...');
    tool.stopTask(sessionId).catch((error) => {
      console.error('[claude] Failed to stop task:', error);
    });
  };
  abortController.signal.addEventListener('abort', abortListener);

  try {
    // Execute prompt with streaming (streaming events emitted directly via Feathers)
    const result = await tool.executePromptWithStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode as import('@anthropic-ai/claude-agent-sdk').PermissionMode | undefined,
      {
        onStreamStart: async (message_id, data) => {
          // biome-ignore lint/suspicious/noExplicitAny: emit available at runtime from socket.io
          (client.service('messages') as any).emit('streaming:start', {
            message_id,
            session_id: data.session_id,
            task_id: data.task_id,
            role: data.role,
            timestamp: data.timestamp,
          });
        },
        onStreamChunk: async (message_id, text) => {
          // biome-ignore lint/suspicious/noExplicitAny: emit available at runtime from socket.io
          (client.service('messages') as any).emit('streaming:chunk', {
            message_id,
            session_id: sessionId,
            chunk: text,
          });
        },
        onStreamEnd: async (message_id) => {
          console.log(`[claude] Stream ended: ${message_id}`);
          // biome-ignore lint/suspicious/noExplicitAny: emit available at runtime from socket.io
          (client.service('messages') as any).emit('streaming:end', {
            message_id,
            session_id: sessionId,
          });
        },
        onStreamError: async (message_id, error) => {
          console.error(`[claude] Stream error for ${message_id}:`, error);
          // biome-ignore lint/suspicious/noExplicitAny: emit available at runtime from socket.io
          (client.service('messages') as any).emit('streaming:error', {
            message_id,
            session_id: sessionId,
            error: error.message,
          });
        },
        onThinkingStart: async (message_id, metadata) => {
          // biome-ignore lint/suspicious/noExplicitAny: emit available at runtime from socket.io
          (client.service('messages') as any).emit('thinking:start', {
            message_id,
            ...metadata,
            session_id: sessionId,
          });
        },
        onThinkingChunk: async (message_id, chunk) => {
          // biome-ignore lint/suspicious/noExplicitAny: emit available at runtime from socket.io
          (client.service('messages') as any).emit('thinking:chunk', {
            message_id,
            session_id: sessionId,
            chunk,
          });
        },
        onThinkingEnd: async (message_id) => {
          // biome-ignore lint/suspicious/noExplicitAny: emit available at runtime from socket.io
          (client.service('messages') as any).emit('thinking:end', {
            message_id,
            session_id: sessionId,
          });
        },
      }
    );

    // Remove abort listener after execution completes
    abortController.signal.removeEventListener('abort', abortListener);

    console.log(`[claude] Execution completed: ${result.assistantMessageIds.length} messages`);

    // Update task status to COMPLETED
    await client.service('tasks').patch(taskId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      normalized_sdk_response: result.tokenUsage
        ? {
            tokenUsage: {
              inputTokens: result.tokenUsage.input_tokens ?? 0,
              outputTokens: result.tokenUsage.output_tokens ?? 0,
              totalTokens:
                (result.tokenUsage.input_tokens ?? 0) + (result.tokenUsage.output_tokens ?? 0),
              cacheReadTokens: result.tokenUsage.cache_read_tokens,
              cacheCreationTokens: result.tokenUsage.cache_creation_tokens,
            },
          }
        : undefined,
    });
  } catch (error) {
    const err = error as Error;

    // Remove abort listener on error
    abortController.signal.removeEventListener('abort', abortListener);

    // Check if this was an abort
    if (abortController.signal.aborted) {
      console.log('[claude] Execution stopped by user');
      await client.service('tasks').patch(taskId, {
        status: 'stopped',
        completed_at: new Date().toISOString(),
      });
      // Don't re-throw on abort - this is a graceful stop
      return;
    }

    console.error('[claude] Execution failed:', err);

    // Update task status to FAILED
    await client.service('tasks').patch(taskId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
    });

    throw err;
  } finally {
    // Unregister from global permission manager
    globalPermissionManager.unregister(sessionId);
  }
}
