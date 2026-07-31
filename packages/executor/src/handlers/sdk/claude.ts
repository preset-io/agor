/**
 * Claude SDK Handler
 *
 * Executes prompts using Claude Code SDK with Feathers/WebSocket architecture
 */

import { TOOL_API_KEY_NAMES } from '@agor/agentic-tools';
import type { MessageSource, PermissionMode, SessionID, TaskID } from '@agor/core/types';
import type { InteractionMode, ResolvedConfigSlice } from '../../payload-types.js';
import { globalPermissionManager } from '../../permissions/permission-manager.js';
import { createExecutionPermissionService } from '../../permissions/permission-service.js';
import { ClaudeTool } from '../../sdk-handlers/claude/claude-tool.js';
import type { SdkActivityCallback } from '../../sdk-watchdog.js';
import type { AgorClient } from '../../services/feathers-client.js';
import type { AgenticToolOutcome } from '../../terminal-task.js';

/**
 * Execute Claude Code task (Feathers/WebSocket architecture)
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
  messageSource?: MessageSource;
  resolvedConfig?: ResolvedConfigSlice;
  onActivity?: SdkActivityCallback;
  interactionMode?: InteractionMode;
}): Promise<AgenticToolOutcome | undefined> {
  const { sessionId } = params;

  // Import base executor helper
  const { executeToolTask } = await import('./base-executor.js');

  const permissionService = createExecutionPermissionService(params);

  // Register with global manager
  globalPermissionManager.register(sessionId, permissionService);

  try {
    // Execute using base helper with Claude-specific factory
    return await executeToolTask({
      ...params,
      apiKeyEnvVar: TOOL_API_KEY_NAMES['claude-code']!,
      toolName: 'claude-code',
      createTool: (repos, apiKey, useNativeAuth) =>
        new ClaudeTool(
          repos.messages,
          repos.sessions,
          apiKey,
          repos.messagesService,
          repos.sessionMCP,
          repos.mcpServers,
          permissionService,
          repos.tasksService,
          repos.tasksStreamingService,
          repos.sessionsService,
          repos.branches,
          repos.repos,
          true, // mcpEnabled
          useNativeAuth, // Flag for Claude CLI OAuth (`claude login`)
          repos.users,
          repos.mcpOAuthAuthHeaders
        ),
    });
  } finally {
    globalPermissionManager.unregister(sessionId);
  }
}
