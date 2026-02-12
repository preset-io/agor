/**
 * Claude SDK Handler
 *
 * Executes prompts using Claude Code SDK with Feathers/WebSocket architecture
 */

import type { MessageSource, PermissionMode, SessionID, TaskID } from '@agor/core/types';
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
}): Promise<void> {
  const { client, sessionId } = params;

  // Import base executor helper
  const { executeToolTask } = await import('./base-executor.js');

  // Create PermissionService that emits via Feathers WebSocket
  const permissionService = new PermissionService(async (event, data) => {
    // Emit permission events directly via Feathers
    // biome-ignore lint/suspicious/noExplicitAny: Feathers service types don't include emit method
    (client.service('sessions') as any).emit(event, data);
  });

  // Register with global permission manager
  globalPermissionManager.register(sessionId, permissionService);

  try {
    // Execute using base helper with Claude-specific factory
    await executeToolTask({
      ...params,
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
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
          repos.sessionsService,
          repos.worktrees,
          repos.repos,
          true, // mcpEnabled
          useNativeAuth, // Flag for Claude CLI OAuth (`claude login`)
          repos.mcpOAuthNotifyService // Service for notifying UI about OAuth requirements
        ),
    });
  } finally {
    // Unregister from global permission manager
    globalPermissionManager.unregister(sessionId);
  }
}
