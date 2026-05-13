/**
 * Claude SDK Handler
 *
 * Executes prompts using Claude Code SDK with Feathers/WebSocket architecture
 */

import { loadConfig } from '@agor/core/config';
import type { MessageSource, PermissionMode, SessionID, TaskID } from '@agor/core/types';
import { TOOL_API_KEY_NAMES } from '@agor/core/types';
import { globalInputRequestManager } from '../../input-requests/input-request-manager.js';
import { InputRequestService } from '../../input-requests/input-request-service.js';
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

  // Load config for permission + input-request timeouts
  const config = await loadConfig();
  const permissionTimeoutMs = config.execution?.permission_timeout_ms ?? 600_000; // default: 10 minutes
  const inputRequestTimeoutMs = config.execution?.input_request_timeout_ms ?? 1_800_000; // default: 30 minutes

  // Create PermissionService that emits via Feathers WebSocket
  const permissionService = new PermissionService(async (event, data) => {
    // Emit permission events directly via Feathers
    client.service('sessions').emit(event, data);
  }, permissionTimeoutMs);

  // Create InputRequestService that emits via Feathers WebSocket
  const inputRequestService = new InputRequestService(async (event, data) => {
    client.service('sessions').emit(event, data);
  }, inputRequestTimeoutMs);

  // Register with global managers
  globalPermissionManager.register(sessionId, permissionService);
  globalInputRequestManager.register(sessionId, inputRequestService);

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
          inputRequestService,
          repos.users
        ),
    });
  } finally {
    // Unregister from global managers
    globalPermissionManager.unregister(sessionId);
    globalInputRequestManager.unregister(sessionId);
  }
}
