/**
 * Codex SDK Handler
 *
 * Executes prompts using OpenAI Codex SDK with Feathers/WebSocket architecture
 */

import { TOOL_API_KEY_NAMES } from '@agor/agentic-tools';
import type { MessageSource, PermissionMode, SessionID, TaskID } from '@agor/core/types';
import type { InteractionMode, ResolvedConfigSlice } from '../../payload-types.js';
import { CodexTool } from '../../sdk-handlers/codex/index.js';
import type { SdkActivityCallback } from '../../sdk-watchdog.js';
import type { AgorClient } from '../../services/feathers-client.js';
import type { AgenticToolOutcome } from '../../terminal-task.js';

/**
 * Execute Codex task (Feathers/WebSocket architecture)
 *
 * Used by ephemeral executor - no IPC, direct Feathers client passed in
 */
export async function executeCodexTask(params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
  messageSource?: MessageSource;
  resolvedConfig?: ResolvedConfigSlice;
  onActivity?: SdkActivityCallback;
  interactionMode?: InteractionMode;
}): Promise<AgenticToolOutcome | undefined> {
  // Import base executor helper
  const { executeToolTask } = await import('./base-executor.js');

  // Execute using base helper with Codex-specific factory
  return executeToolTask({
    ...params,
    apiKeyEnvVar: TOOL_API_KEY_NAMES.codex!,
    toolName: 'codex',
    createTool: (repos, apiKey, useNativeAuth) =>
      new CodexTool(
        repos.messages,
        repos.sessions,
        repos.sessionMCP,
        repos.branches,
        repos.repos,
        apiKey,
        repos.messagesService,
        repos.tasksService,
        repos.tasksStreamingService,
        useNativeAuth, // Flag for native auth (if applicable)
        repos.mcpServers, // MCPServerRepository for global MCP server resolution
        repos.users,
        repos.mcpOAuthAuthHeaders,
        params.interactionMode
      ),
  });
}
