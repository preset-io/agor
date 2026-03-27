/**
 * Copilot SDK Handler
 *
 * Executes prompts using GitHub Copilot SDK with Feathers/WebSocket architecture
 */

import type { MessageSource, PermissionMode, SessionID, TaskID } from '@agor/core/types';
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
  // Import base executor helper
  const { executeToolTask } = await import('./base-executor.js');

  // Execute using base helper with Copilot-specific factory
  await executeToolTask({
    ...params,
    apiKeyEnvVar: 'COPILOT_GITHUB_TOKEN',
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
        repos.users
      ),
  });
}
