/**
 * OpenCode SDK Handler
 *
 * Executes prompts using OpenCode SDK with Feathers client connection to daemon
 */

import type { ExecutorIPCServer } from '../../ipc-server.js';
import { OpenCodeTool } from '../../sdk-handlers/opencode/index.js';
import { DaemonClient } from '../../services/daemon-client.js';
import { createExecutorClient, getDaemonUrl } from '../../services/feathers-client.js';
import type { ExecutePromptParams, ExecutePromptResult } from '../../types.js';

/**
 * Execute OpenCode prompt using Feathers client
 */
export async function executeOpenCodeSDK(
  params: ExecutePromptParams,
  apiKey: string,
  ipcServer: ExecutorIPCServer
): Promise<ExecutePromptResult> {
  const { session_token, session_id, task_id, prompt, permission_mode } = params;

  // Connect to daemon via Feathers client
  const daemonUrl = getDaemonUrl();
  console.log(`[opencode] Connecting to daemon at ${daemonUrl}...`);
  const client = await createExecutorClient(daemonUrl, session_token);

  // Create DaemonClient for streaming callbacks
  const daemonClient = new DaemonClient(ipcServer, session_token);

  try {
    // Create Tool instance with Feathers client
    const tool = new OpenCodeTool({
      app: client,
      apiKey,
    });

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
          console.log(`[opencode] Stream ended: ${message_id}`);
        },
        onStreamError: async (message_id, error) => {
          console.error(`[opencode] Stream error for ${message_id}:`, error);
        },
      }
    );

    console.log(
      `[opencode] Execution completed: user=${result.userMessageId}, assistant=${result.assistantMessageIds.length} messages`
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
    console.error('[opencode] Execution failed:', err);
    throw err;
  } finally {
    // Close client connection
    client.io.close();
  }
}

import type { PermissionMode, SessionID, TaskID } from '@agor/core/types';
import type { AgorClient } from '../../services/feathers-client.js';

/**
 * Execute OpenCode task (new Feathers/WebSocket architecture)
 * TODO: Implement full OpenCode execution with streaming
 */
export async function executeOpenCodeTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
}): Promise<void> {
  throw new Error('OpenCode task execution not yet implemented in new architecture');
}
