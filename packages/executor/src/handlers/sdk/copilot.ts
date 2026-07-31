/**
 * Copilot SDK Handler
 *
 * Executes prompts using GitHub Copilot SDK with Feathers/WebSocket architecture.
 * Includes interactive permission handling via PermissionService (same as Claude Code).
 */

import { TOOL_API_KEY_NAMES } from '@agor/agentic-tools';
import type {
  ExecutorPulseKind,
  MessageSource,
  PermissionMode,
  SessionID,
  TaskID,
} from '@agor/core/types';
import type { InteractionMode, ResolvedConfigSlice } from '../../payload-types.js';
import { globalPermissionManager } from '../../permissions/permission-manager.js';
import { createExecutionPermissionService } from '../../permissions/permission-service.js';
import { CopilotTool } from '../../sdk-handlers/copilot/index.js';
import type { AgorClient } from '../../services/feathers-client.js';
import type { AgenticToolOutcome } from '../../terminal-task.js';

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
  resolvedConfig?: ResolvedConfigSlice;
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void;
  interactionMode?: InteractionMode;
}): Promise<AgenticToolOutcome | undefined> {
  const { sessionId } = params;

  // Import base executor helper
  const { executeToolTask } = await import('./base-executor.js');

  const permissionService = createExecutionPermissionService(params);

  // Register with global manager
  globalPermissionManager.register(sessionId, permissionService);

  try {
    // Execute using base helper with Copilot-specific factory
    return await executeToolTask({
      ...params,
      apiKeyEnvVar: TOOL_API_KEY_NAMES.copilot!,
      toolName: 'copilot',
      createTool: (repos, apiKey, useNativeAuth) =>
        new CopilotTool(
          repos.messages,
          repos.sessions,
          repos.sessionMCP,
          repos.branches,
          repos.repos,
          apiKey,
          repos.messagesService,
          repos.tasksService,
          useNativeAuth,
          repos.mcpServers,
          repos.users,
          permissionService,
          repos.sessionsService,
          repos.mcpOAuthAuthHeaders
        ),
    });
  } finally {
    // Unregister from global manager
    globalPermissionManager.unregister(sessionId);
  }
}
