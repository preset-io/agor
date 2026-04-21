/**
 * Codex SDK Handler
 *
 * Executes prompts using OpenAI Codex SDK with Feathers/WebSocket architecture
 */

import type { MessageSource, PermissionMode, SessionID, TaskID } from '@agor/core/types';
import { CodexTool, createCodexAuthStrategy } from '../../sdk-handlers/codex/index.js';
import type { AgorClient } from '../../services/feathers-client.js';
import type { NativeAuthContext } from './base-executor.js';

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
}): Promise<void> {
  // Import base executor helper
  const { executeToolTask } = await import('./base-executor.js');

  // Execute using base helper with Codex-specific factory
  await executeToolTask({
    ...params,
    apiKeyEnvVar: 'OPENAI_API_KEY',
    toolName: 'codex',
    createTool: (repos, apiKey, useNativeAuth, nativeAuthContext?: NativeAuthContext) =>
      new CodexTool(
        repos.messages,
        repos.sessions,
        repos.sessionMCP,
        repos.worktrees,
        repos.repos,
        createCodexAuthStrategy(apiKey, useNativeAuth),
        repos.messagesService,
        repos.tasksService,
        repos.tasksStreamingService,
        repos.mcpServers, // MCPServerRepository for global MCP server resolution
        repos.users,
        nativeAuthContext?.stableCodexHome
      ),
  });
}
