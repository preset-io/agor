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
  const { session_token, session_id, task_id, prompt } = params;

  // Connect to daemon via Feathers client
  const daemonUrl = getDaemonUrl();
  console.log(`[opencode] Connecting to daemon at ${daemonUrl}...`);
  const client = await createExecutorClient(daemonUrl, session_token);

  // Create DaemonClient for streaming callbacks
  const daemonClient = new DaemonClient(ipcServer, session_token);

  try {
    // Create Tool instance with config
    const tool = new OpenCodeTool(
      {
        enabled: true,
        serverUrl: process.env.OPENCODE_SERVER_URL || 'http://localhost:3000',
      },
      client.service('messages')
    );

    // Execute task (OpenCode doesn't support executePromptWithStreaming yet)
    // TODO: Implement streaming support for OpenCode
    const result = await tool.executeTask!(
      session_id as string,
      prompt,
      task_id as string | undefined,
      {
        onStreamStart: async (
          message_id: string,
          data: { session_id: string; task_id?: string; role: string; timestamp: string }
        ) => {
          await daemonClient.streamStart({
            message_id: message_id as MessageID,
            session_id: data.session_id as SessionID,
            task_id: data.task_id as TaskID,
            role: data.role,
            timestamp: data.timestamp,
          });
        },
        onStreamChunk: async (message_id: string, text: string) => {
          await daemonClient.streamChunk({ message_id: message_id as MessageID, text });
        },
        onStreamEnd: async (message_id: string) => {
          console.log(`[opencode] Stream ended: ${message_id}`);
        },
        onStreamError: async (message_id: string, error: Error) => {
          console.error(`[opencode] Stream error for ${message_id}:`, error);
        },
      }
    );

    console.log(
      `[opencode] Execution completed: status=${result.status}, messages=${result.messages.length}`
    );

    return {
      status: result.status,
      message_count: result.messages.length,
      token_usage: undefined, // OpenCode doesn't provide token usage yet
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

import type { MessageID, PermissionMode, SessionID, TaskID } from '@agor/core/types';
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
