/**
 * Codex SDK Handler
 *
 * Executes prompts using OpenAI Codex SDK with Feathers/WebSocket architecture
 */

import type { PermissionMode, SessionID, TaskID } from '@agor/core/types';
import { CodexTool } from '../../sdk-handlers/codex/index.js';
import type { AgorClient } from '../../services/feathers-client.js';

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
}): Promise<void> {
  // Import base executor helper
  const { executeToolTask } = await import('./base-executor.js');

  // Execute using base helper with Codex-specific factory
  await executeToolTask({
    ...params,
    apiKeyEnvVar: 'OPENAI_API_KEY',
    toolName: 'codex',
    createTool: (repos, apiKey, useNativeAuth) =>
      new CodexTool(
        repos.messages,
        repos.sessions,
        repos.sessionMCP,
        repos.worktrees,
        repos.repos,
        apiKey,
        repos.messagesService,
        repos.tasksService,
        useNativeAuth // Flag for native auth (if applicable)
      ),
  });
}
