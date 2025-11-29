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
    // Get session to extract model config
    const session = await client.service('sessions').get(sessionId);
    console.log('[opencode] Session loaded:', {
      sessionId: sessionId.substring(0, 8),
      sdk_session_id: session.sdk_session_id?.substring(0, 8),
      model: session.model_config?.model,
      provider: session.model_config?.provider,
    });

    // Create execution context (similar to other handlers)
    const repos = createFeathersBackedRepositories(client);
    const callbacks = createStreamingCallbacks(client, 'opencode', sessionId);

    // Get OpenCode server URL from environment
    // Default to localhost if OpenCode runs in same container, or host.docker.internal if on host
    const serverUrl = process.env.OPENCODE_SERVER_URL || 'http://localhost:4096';

    // Create Tool instance with config
    const tool = new OpenCodeTool(
      {
        enabled: true,
        serverUrl,
      },
      repos.messagesService
    );

    let opencodeSessionId: string;

    // Check if we already have an OpenCode session (stored in sdk_session_id)
    if (session.sdk_session_id) {
      console.log(
        `[opencode] Resuming existing OpenCode session: ${session.sdk_session_id.substring(0, 8)}`
      );
      opencodeSessionId = session.sdk_session_id;
    } else {
      // Create new OpenCode session
      console.log('[opencode] Creating new OpenCode session...');
      const sessionHandle = await tool.createSession?.({
        title: session.title || `Task ${taskId.substring(0, 8)}`,
        projectName: 'agor',
        model: session.model_config?.model,
        provider: session.model_config?.provider,
      });

      if (!sessionHandle) {
        throw new Error('Failed to create OpenCode session');
      }

      opencodeSessionId = sessionHandle.sessionId;
      console.log(`[opencode] Created OpenCode session: ${opencodeSessionId.substring(0, 8)}`);

      // Store OpenCode session ID in Agor session for future resumes
      await client.service('sessions').patch(sessionId, {
        sdk_session_id: opencodeSessionId,
      });
      console.log('[opencode] Stored OpenCode session ID in Agor session');
    }

    // Set session context with model and provider from session config
    tool.setSessionContext(
      sessionId,
      opencodeSessionId,
      session.model_config?.model,
      session.model_config?.provider
    );

    // Execute task using OpenCode's executeTask interface
    const result = await tool.executeTask?.(sessionId, prompt, taskId, callbacks);

    console.log(`[opencode] Execution completed: status=${result?.status}`);

    // Update task status to completed and set model
    await client.service('tasks').patch(taskId, {
      status: result?.status === 'completed' ? 'completed' : 'failed',
      completed_at: new Date().toISOString(),
      model: session.model_config?.model, // Set the model ID used for this task
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
