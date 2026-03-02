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

import { generateId } from '@agor/core';
import { loadConfig } from '@agor/core/config';
import type { MessageID, PermissionMode, SessionID, TaskID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
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

    // Get OpenCode server URL: env var > config.yaml > default
    let serverUrl = process.env.OPENCODE_SERVER_URL || '';
    if (!serverUrl) {
      try {
        const config = await loadConfig();
        serverUrl = config.opencode?.serverUrl || 'http://localhost:4096';
      } catch {
        serverUrl = 'http://localhost:4096';
      }
    }
    console.log(`[opencode] Using server URL: ${serverUrl}`);

    // Resolve worktree path from session's worktree_id
    let worktreePath: string | undefined;
    if (session.worktree_id) {
      try {
        const worktree = await repos.worktrees.findById(session.worktree_id);
        if (worktree) {
          worktreePath = worktree.path;
          console.log(`[opencode] Using worktree directory: ${worktreePath}`);
        }
      } catch (error) {
        console.warn(`[opencode] Could not resolve worktree ${session.worktree_id}:`, error);
      }
    }

    // Create Tool instance with config
    const tool = new OpenCodeTool(
      {
        enabled: true,
        serverUrl,
      },
      repos.messagesService,
      repos.sessionMCP,
      repos.mcpServers
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
        workingDirectory: worktreePath,
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

    // Set session context with model, provider, worktree path, and MCP token from session config
    tool.setSessionContext(
      sessionId,
      opencodeSessionId,
      session.model_config?.model,
      session.model_config?.provider,
      worktreePath,
      session.mcp_token
    );

    // Get existing messages to determine next index
    const existingMessages = await client.service('messages').find({
      query: {
        session_id: sessionId,
        $sort: { index: 1 },
      },
    });
    const messages = Array.isArray(existingMessages) ? existingMessages : existingMessages.data;
    const nextIndex = messages?.length || 0;

    // Create user message (same pattern as Claude/Codex/Gemini)
    console.log('[opencode] Creating user message at index', nextIndex);
    await repos.messagesService.create({
      message_id: generateId() as MessageID,
      session_id: sessionId,
      task_id: taskId,
      type: 'user' as const,
      role: MessageRole.USER,
      index: nextIndex,
      timestamp: new Date().toISOString(),
      content_preview: prompt.substring(0, 200),
      content: prompt,
    });

    // Execute task using OpenCode's executeTask interface
    // This will create the assistant message with streaming
    // Pass nextIndex + 1 for assistant message index
    const result = await tool.executeTask?.(sessionId, prompt, taskId, callbacks, nextIndex + 1);

    console.log(`[opencode] Execution completed: status=${result?.status}`);

    // Construct model identifier in provider/model format (e.g., "openai/gpt-4o")
    const modelIdentifier =
      session.model_config?.provider && session.model_config?.model
        ? `${session.model_config.provider}/${session.model_config.model}`
        : session.model_config?.model;

    console.log('[opencode] Setting task model:', modelIdentifier);

    // Update task status to completed and set model
    await client.service('tasks').patch(taskId, {
      status: result?.status === 'completed' ? 'completed' : 'failed',
      completed_at: new Date().toISOString(),
      model: modelIdentifier, // Set the model identifier used for this task (provider/model format)
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
