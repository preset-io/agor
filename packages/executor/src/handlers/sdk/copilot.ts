/**
 * Copilot SDK Handler
 *
 * Executes prompts using GitHub Copilot SDK with Feathers/WebSocket architecture.
 * Includes interactive permission handling via PermissionService (same as Claude Code).
 */

import { loadConfig } from '@agor/core/config';
import type { MessageSource, PermissionMode, SessionID, TaskID } from '@agor/core/types';
import { TOOL_API_KEY_NAMES } from '@agor/core/types';
import { globalPermissionManager } from '../../permissions/permission-manager.js';
import { PermissionService } from '../../permissions/permission-service.js';
import { CopilotTool } from '../../sdk-handlers/copilot/index.js';
import type { AgorClient } from '../../services/feathers-client.js';

/**
 * Execute Copilot task (Feathers/WebSocket architecture)
 *
 * Used by ephemeral executor - no IPC, direct Feathers client passed in
 */
export async function executeCopilotTask(params: {
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

  // Load config for permission timeout setting
  const config = await loadConfig();
  const permissionTimeoutMs = config.execution?.permission_timeout_ms ?? 600_000; // default: 10 minutes

  // Create PermissionService that emits via Feathers WebSocket
  const permissionService = new PermissionService(async (event, data) => {
    // Emit permission events directly via Feathers
    client.service('sessions').emit(event, data);
  }, permissionTimeoutMs);

  // Register with global manager
  globalPermissionManager.register(sessionId, permissionService);

  try {
    // Execute using base helper with Copilot-specific factory
    await executeToolTask({
      ...params,
      apiKeyEnvVar: TOOL_API_KEY_NAMES['copilot']!,
      toolName: 'copilot',
      createTool: (repos, apiKey, useNativeAuth) =>
        new CopilotTool(
          repos.messages,
          repos.sessions,
          repos.sessionMCP,
          repos.worktrees,
          repos.repos,
          apiKey,
          repos.messagesService,
          repos.tasksService,
          useNativeAuth,
          repos.mcpServers,
          repos.users,
          permissionService,
          repos.sessionsService
        ),
    });
  } finally {
    // Unregister from global manager
    globalPermissionManager.unregister(sessionId);
  }
}
