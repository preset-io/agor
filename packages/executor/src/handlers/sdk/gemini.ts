/**
 * Gemini SDK Handler
 *
 * Executes prompts using Google Gemini SDK with Feathers client connection to daemon
 */

import type { MessageID, PermissionMode, SessionID, TaskID } from '@agor/core/types';
import { createFeathersBackedRepositories } from '../../db/feathers-repositories.js';
import type { ExecutorIPCServer } from '../../ipc-server.js';
import { GeminiTool } from '../../sdk-handlers/gemini/index.js';
import { DaemonClient } from '../../services/daemon-client.js';
import {
  type AgorClient,
  createExecutorClient,
  getDaemonUrl,
} from '../../services/feathers-client.js';
import type { ExecutePromptParams, ExecutePromptResult } from '../../types.js';

/**
 * Execute Gemini prompt using Feathers client
 */
export async function executeGeminiSDK(
  params: ExecutePromptParams,
  apiKey: string,
  ipcServer: ExecutorIPCServer
): Promise<ExecutePromptResult> {
  const { session_token, session_id, task_id, prompt, permission_mode } = params;

  // Connect to daemon via Feathers client
  const daemonUrl = getDaemonUrl();
  console.log(`[gemini] Connecting to daemon at ${daemonUrl}...`);
  const client = await createExecutorClient(daemonUrl, session_token);

  // Create DaemonClient for streaming callbacks
  const daemonClient = new DaemonClient(ipcServer, session_token);

  // Create Feathers-backed repositories that proxy to daemon services
  const repos = createFeathersBackedRepositories(client);

  try {
    // Create Tool instance with repositories and services
    const tool = new GeminiTool(
      repos.messages, // MessagesRepository
      repos.sessions, // SessionRepository
      apiKey, // API key
      repos.messagesService, // MessagesService (for creating messages via Feathers)
      repos.tasksService, // TasksService
      repos.worktrees, // WorktreeRepository
      repos.repos, // RepoRepository
      repos.mcpServers, // MCPServerRepository
      repos.sessionMCP, // SessionMCPServerRepository
      true, // mcpEnabled
      undefined // Database (not used in Feathers architecture)
    );

    // Execute prompt with streaming
    const result = await tool.executePromptWithStreaming(
      session_id as import('@agor/core/types').SessionID,
      prompt,
      task_id as import('@agor/core/types').TaskID | undefined,
      permission_mode as import('@agor/core/types').PermissionMode | undefined,
      {
        onStreamStart: async (
          message_id: string,
          data: { session_id: string; task_id?: string; role: string; timestamp: string }
        ) => {
          await daemonClient.streamStart({
            message_id: message_id as MessageID,
            session_id: data.session_id as SessionID,
            task_id: data.task_id as TaskID | undefined,
            role: data.role,
            timestamp: data.timestamp,
          });
        },
        onStreamChunk: async (message_id: string, text: string) => {
          await daemonClient.streamChunk({ message_id: message_id as MessageID, text });
        },
        onStreamEnd: async (message_id: string) => {
          console.log(`[gemini] Stream ended: ${message_id}`);
        },
        onStreamError: async (message_id: string, error: Error) => {
          console.error(`[gemini] Stream error for ${message_id}:`, error);
        },
      }
    );

    console.log(
      `[gemini] Execution completed: user=${result.userMessageId}, assistant=${result.assistantMessageIds.length} messages`
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
    console.error('[gemini] Execution failed:', err);
    throw err;
  } finally {
    // Close client connection
    client.io.close();
  }
}

/**
 * Execute Gemini task (new Feathers/WebSocket architecture)
 *
 * Used by ephemeral executor - no IPC, direct Feathers client passed in
 */
export async function executeGeminiTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
}): Promise<void> {
  // Import base executor helper
  const { executeToolTask } = await import('./base-executor.js');

  // Execute using base helper with Gemini-specific factory
  await executeToolTask({
    ...params,
    apiKeyEnvVar: 'GEMINI_API_KEY',
    toolName: 'gemini',
    createTool: (repos, apiKey) =>
      new GeminiTool(
        repos.messages,
        repos.sessions,
        apiKey,
        repos.messagesService,
        repos.tasksService,
        repos.worktrees,
        repos.repos,
        repos.mcpServers,
        repos.sessionMCP,
        true, // mcpEnabled
        undefined // Database (not used in Feathers architecture)
      ),
  });
}
