/**
 * Gemini SDK Handler
 *
 * Executes prompts using Google Gemini SDK with Feathers/WebSocket architecture
 */

import type { MessageSource, PermissionMode, SessionID, TaskID } from '@agor/core/types';
import { GeminiTool } from '../../sdk-handlers/gemini/index.js';
import type { AgorClient } from '../../services/feathers-client.js';

/**
 * Execute Gemini task (Feathers/WebSocket architecture)
 *
 * Used by ephemeral executor - no IPC, direct Feathers client passed in
 */
export async function executeGeminiTask(params: {
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

  // Execute using base helper with Gemini-specific factory
  await executeToolTask({
    ...params,
    apiKeyEnvVar: 'GEMINI_API_KEY',
    toolName: 'gemini',
    createTool: (repos, apiKey, useNativeAuth) =>
      new GeminiTool(
        repos.messages,
        repos.sessions,
        apiKey,
        repos.messagesService,
        repos.tasksService,
        repos.worktrees,
        repos.repos,
        repos.mcpServers,
        repos.sessionMCP,
        true, // mcpEnabled
        useNativeAuth // Flag to use OAuth when no API key
      ),
  });
}
