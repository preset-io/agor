/**
 * OpenCode SDK Handler
 *
 * Executes prompts using OpenCode SDK with Feathers/WebSocket architecture
 *
 * Note: OpenCode has a different interface than Claude/Codex/Gemini:
 * - Uses executeTask() instead of executePromptWithStreaming()
 * - Requires session creation and context setup
 * - Different return type (TaskResult vs execution result)
 */

import type { PermissionMode, SessionID, TaskID } from '@agor/core/types';
import { createFeathersBackedRepositories } from '../../db/feathers-repositories.js';
import { OpenCodeTool } from '../../sdk-handlers/opencode/index.js';
import type { AgorClient } from '../../services/feathers-client.js';
import { createStreamingCallbacks } from './base-executor.js';

/**
 * Execute OpenCode task (Feathers/WebSocket architecture)
 *
 * Used by ephemeral executor - direct Feathers client passed in
 */
export async function executeOpenCodeTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
}): Promise<void> {
  const { client, sessionId, taskId, prompt } = params;

  console.log(`[opencode] Executing task ${taskId.substring(0, 8)}...`);

  try {
    // Create execution context (similar to other handlers)
    const repos = createFeathersBackedRepositories(client);
    const callbacks = createStreamingCallbacks(client, 'opencode', sessionId);

    // Get OpenCode server URL from environment
    const serverUrl = process.env.OPENCODE_SERVER_URL || 'http://localhost:3000';

    // Create Tool instance with config
    const tool = new OpenCodeTool(
      {
        enabled: true,
        serverUrl,
      },
      repos.messagesService
    );

    // Create OpenCode session (required for OpenCode)
    const sessionHandle = await tool.createSession?.({
      title: `Task ${taskId.substring(0, 8)}`,
      projectName: 'agor',
    });

    if (!sessionHandle) {
      throw new Error('Failed to create OpenCode session');
    }

    // Set session context (OpenCode-specific requirement)
    tool.setSessionContext(sessionId, sessionHandle.sessionId);

    // Execute task using OpenCode's executeTask interface
    const result = await tool.executeTask?.(sessionId, prompt, taskId, callbacks);

    console.log(`[opencode] Execution completed: status=${result?.status}`);

    // Update task status to completed
    await client.service('tasks').patch(taskId, {
      status: result?.status === 'completed' ? 'completed' : 'failed',
      completed_at: new Date().toISOString(),
    });
  } catch (error) {
    const err = error as Error;
    console.error('[opencode] Execution failed:', err);

    // Update task status to failed
    await client.service('tasks').patch(taskId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
    });

    throw err;
  }
}
