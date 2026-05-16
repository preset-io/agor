/**
 * Claude SDK Handler
 *
 * Executes prompts using Claude Code SDK with Feathers/WebSocket architecture
 */

import type { MessageSource, PermissionMode, SessionID, TaskID } from '@agor/core/types';
import { TOOL_API_KEY_NAMES } from '@agor/core/types';
import type { ResolvedConfigSlice } from '../../payload-types.js';
import { globalPermissionManager } from '../../permissions/permission-manager.js';
import { PermissionService } from '../../permissions/permission-service.js';
import { ClaudeTool } from '../../sdk-handlers/claude/claude-tool.js';
import type { AgorClient } from '../../services/feathers-client.js';

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
}): Promise<void> {
  const { client, sessionId } = params;

  // Import base executor helper
  const { executeToolTask } = await import('./base-executor.js');

  // Permission timeout: daemon-resolved slice, fallback to 10-minute default.
  const permissionTimeoutMs = params.resolvedConfig?.execution?.permission_timeout_ms ?? 600_000;

  // Create PermissionService that emits via Feathers WebSocket
  const permissionService = new PermissionService(async (event, data) => {
    // Emit permission events directly via Feathers
    client.service('sessions').emit(event, data);
  }, permissionTimeoutMs);

  // Register with global manager
  globalPermissionManager.register(sessionId, permissionService);

  try {
    // Execute using base helper with Claude-specific factory
    await executeToolTask({
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
          repos.worktrees,
          repos.repos,
          true, // mcpEnabled
          useNativeAuth, // Flag for Claude CLI OAuth (`claude login`)
          repos.users
        ),
    });
  } finally {
    globalPermissionManager.unregister(sessionId);
  }
}
