/**
 * Codex SDK Handler
 *
 * Executes prompts using OpenAI Codex SDK with Feathers client connection to daemon
 */

import type { PermissionMode, SessionID, TaskID } from '@agor/core/types';
import { createFeathersBackedRepositories } from '../../db/feathers-repositories.js';
import type { ExecutorIPCServer } from '../../ipc-server.js';
import { CodexTool } from '../../sdk-handlers/codex/index.js';
import { DaemonClient } from '../../services/daemon-client.js';
import {
  type AgorClient,
  createExecutorClient,
  getDaemonUrl,
} from '../../services/feathers-client.js';
import type { ExecutePromptParams, ExecutePromptResult } from '../../types.js';

/**
 * Execute Codex prompt using Feathers client
 */
export async function executeCodexSDK(
  params: ExecutePromptParams,
  apiKey: string,
  ipcServer: ExecutorIPCServer
): Promise<ExecutePromptResult> {
  const { session_token, session_id, task_id, prompt, permission_mode } = params;

  // Connect to daemon via Feathers client
  const daemonUrl = getDaemonUrl();
  console.log(`[codex] Connecting to daemon at ${daemonUrl}...`);
  const client = await createExecutorClient(daemonUrl, session_token);

  // Create DaemonClient for streaming callbacks
  const daemonClient = new DaemonClient(ipcServer, session_token);

  // Create Feathers-backed repositories
  const repos = createFeathersBackedRepositories(client);

  try {
    // Create Tool instance with repositories and services
    const tool = new CodexTool(
      repos.messages, // MessagesRepository
      repos.sessions, // SessionRepository
      repos.sessionMCP, // SessionMCPServerRepository
      repos.worktrees, // WorktreeRepository
      repos.repos, // RepoRepository
      apiKey, // API key
      repos.messagesService, // MessagesService
      repos.tasksService, // TasksService
      undefined // Database (not used in Feathers architecture)
    );

    // Execute prompt with streaming
    const result = await tool.executePromptWithStreaming(
      session_id as import('@agor/core/types').SessionID,
      prompt,
      task_id as import('@agor/core/types').TaskID | undefined,
      permission_mode as import('@agor/core/types').PermissionMode | undefined,
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
          // Stream ended successfully - cleanup handled by daemon
          console.log(`[codex] Stream ended: ${message_id}`);
        },
        onStreamError: async (message_id, error) => {
          console.error(`[codex] Stream error for ${message_id}:`, error);
        },
      }
    );

    console.log(
      `[codex] Execution completed: user=${result.userMessageId}, assistant=${result.assistantMessageIds.length} messages`
    );

    return {
      status: result.wasStopped ? 'cancelled' : 'completed',
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
    console.error('[codex] Execution failed:', err);
    throw err;
  } finally {
    // Close client connection
    client.io.close();
  }
}

/**
 * Execute Codex task (new Feathers/WebSocket architecture)
 * TODO: Implement full Codex execution with streaming
 */
export async function executeCodexTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
}): Promise<void> {
  throw new Error('Codex task execution not yet implemented in new architecture');
}
