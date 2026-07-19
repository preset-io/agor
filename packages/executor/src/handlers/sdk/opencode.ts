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

import { generateId, shortId } from '@agor/core';
import type {
  ExecutorPulseKind,
  MessageID,
  PermissionMode,
  SessionID,
  TaskID,
} from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { createFeathersBackedRepositories } from '../../db/feathers-repositories.js';
import type { ResolvedConfigSlice } from '../../payload-types.js';
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
  resolvedConfig?: ResolvedConfigSlice;
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void;
}): Promise<void> {
  const { client, sessionId, taskId, prompt } = params;
  let abortHandler: (() => void) | undefined;

  console.log(`[opencode] Executing task ${shortId(taskId)}...`);

  try {
    // Get session to extract model config
    const session = await client.service('sessions').get(sessionId);
    console.log('[opencode] Session loaded:', {
      sessionId: shortId(sessionId),
      sdk_session_id: session.sdk_session_id ? shortId(session.sdk_session_id) : undefined,
      model: session.model_config?.model,
      provider: session.model_config?.provider,
    });

    // Create execution context (similar to other handlers)
    const repos = createFeathersBackedRepositories(client);
    const callbacks = createStreamingCallbacks(client, 'opencode', sessionId, params.onPulse);

    // OpenCode server URL: env var > daemon-resolved config slice > default.
    const serverUrl =
      process.env.OPENCODE_SERVER_URL ||
      params.resolvedConfig?.opencode?.serverUrl ||
      'http://localhost:4096';
    console.log(`[opencode] Using server URL: ${serverUrl}`);

    // Resolve branch path from session's branch_id
    let branchPath: string | undefined;
    if (session.branch_id) {
      try {
        const branch = await repos.branches.findById(session.branch_id);
        if (branch) {
          branchPath = branch.path;
          console.log(`[opencode] Using branch directory: ${branchPath}`);
        }
      } catch (error) {
        console.warn(`[opencode] Could not resolve branch ${session.branch_id}:`, error);
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
      repos.mcpServers,
      repos.mcpOAuthAuthHeaders
    );

    let opencodeSessionId: string;

    // Check if we already have an OpenCode session (stored in sdk_session_id)
    if (session.sdk_session_id) {
      console.log(
        `[opencode] Resuming existing OpenCode session: ${shortId(session.sdk_session_id)}`
      );
      opencodeSessionId = session.sdk_session_id;
    } else {
      // Create new OpenCode session
      console.log('[opencode] Creating new OpenCode session...');
      const sessionHandle = await tool.createSession?.({
        title: session.title || `Task ${shortId(taskId)}`,
        projectName: 'agor',
        model: session.model_config?.model,
        provider: session.model_config?.provider,
        workingDirectory: branchPath,
      });

      if (!sessionHandle) {
        throw new Error('Failed to create OpenCode session');
      }

      opencodeSessionId = sessionHandle.sessionId;
      console.log(`[opencode] Created OpenCode session: ${shortId(opencodeSessionId)}`);

      // Store OpenCode session ID in Agor session for future resumes
      await client.service('sessions').patch(sessionId, {
        sdk_session_id: opencodeSessionId,
      });
      console.log('[opencode] Stored OpenCode session ID in Agor session');
    }

    // Set session context with model, provider, branch path, and MCP token from session config
    tool.setSessionContext(
      sessionId,
      opencodeSessionId,
      session.model_config?.model,
      session.model_config?.provider,
      branchPath,
      session.mcp_token
    );
    abortHandler = () => {
      void tool.stopTask(sessionId).then((result) => {
        if (!result.success) console.warn(`[opencode] Abort was not confirmed: ${result.reason}`);
      });
    };
    params.abortController.signal.addEventListener('abort', abortHandler, { once: true });
    if (params.abortController.signal.aborted) abortHandler();

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
    if (!params.abortController.signal.aborted) {
      await client.service('tasks').patch(taskId, {
        status: result?.status === 'completed' ? 'completed' : 'failed',
        completed_at: new Date().toISOString(),
        model: modelIdentifier, // Set the model identifier used for this task (provider/model format)
      });
    }
  } catch (error) {
    const err = error as Error;
    console.error('[opencode] Execution failed:', err);

    // Update task status to failed
    if (!params.abortController.signal.aborted) {
      await client.service('tasks').patch(taskId, {
        status: 'failed',
        completed_at: new Date().toISOString(),
      });
    }

    throw err;
  } finally {
    if (abortHandler) params.abortController.signal.removeEventListener('abort', abortHandler);
  }
}
