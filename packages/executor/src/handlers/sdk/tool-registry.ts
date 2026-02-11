/**
 * Tool Runner Registry
 *
 * Centralized registry for all SDK tool runners.
 * Makes it easier to add new tools and ensures consistency.
 */

import type { MessageSource, PermissionMode, SessionID, TaskID } from '@agor/core/types';
import type { AgorClient } from '../../services/feathers-client.js';

/**
 * Tool identifier
 */
export type Tool = 'claude-code' | 'gemini' | 'codex' | 'opencode';

/**
 * Tool runner function - executes via Feathers WebSocket
 */
export type ToolRunner = (params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
  messageSource?: MessageSource;
}) => Promise<void>;

/**
 * Tool configuration
 */
export interface ToolConfig {
  /** Tool identifier */
  tool: Tool;
  /** Display name */
  name: string;
  /** Environment variable for API key */
  apiKeyEnvVar: string;
  /** Tool runner function */
  runner: ToolRunner;
}

/**
 * Tool registry - centralized configuration for all tools
 */
export class ToolRegistry {
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: referenced via static helper methods
  private static tools: Map<Tool, ToolConfig> = new Map();

  /**
   * Register a tool
   */
  static register(config: ToolConfig): void {
    ToolRegistry.tools.set(config.tool, config);
  }

  /**
   * Get tool configuration
   */
  static get(tool: Tool): ToolConfig | undefined {
    return ToolRegistry.tools.get(tool);
  }

  /**
   * Get all registered tools
   */
  static getAll(): Tool[] {
    return Array.from(ToolRegistry.tools.keys());
  }

  /**
   * Check if tool is registered
   */
  static has(tool: string): tool is Tool {
    return ToolRegistry.tools.has(tool as Tool);
  }

  /**
   * Get API key environment variable for tool
   */
  static getApiKeyEnvVar(tool: Tool): string {
    const config = ToolRegistry.get(tool);
    if (!config) {
      throw new Error(`Unknown tool: ${tool}`);
    }
    return config.apiKeyEnvVar;
  }

  /**
   * Execute tool
   */
  static async execute(
    tool: Tool,
    params: {
      client: AgorClient;
      sessionId: SessionID;
      taskId: TaskID;
      prompt: string;
      permissionMode?: PermissionMode;
      abortController: AbortController;
      messageSource?: MessageSource;
    }
  ): Promise<void> {
    const config = ToolRegistry.get(tool);
    if (!config) {
      throw new Error(`Unknown tool: ${tool}`);
    }
    return config.runner(params);
  }
}

/**
 * Initialize tool registry with all available tools
 */
export async function initializeToolRegistry(): Promise<void> {
  // Import all tool handlers
  const [claude, codex, gemini, opencode] = await Promise.all([
    import('./claude.js'),
    import('./codex.js'),
    import('./gemini.js'),
    import('./opencode.js'),
  ]);

  // Register Claude Code
  ToolRegistry.register({
    tool: 'claude-code',
    name: 'Claude Code',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    runner: claude.executeClaudeCodeTask,
  });

  // Register Codex
  ToolRegistry.register({
    tool: 'codex',
    name: 'Codex',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    runner: codex.executeCodexTask,
  });

  // Register Gemini
  ToolRegistry.register({
    tool: 'gemini',
    name: 'Gemini',
    apiKeyEnvVar: 'GOOGLE_API_KEY',
    runner: gemini.executeGeminiTask,
  });

  // Register OpenCode
  ToolRegistry.register({
    tool: 'opencode',
    name: 'OpenCode',
    apiKeyEnvVar: 'NONE', // OpenCode doesn't need API key
    runner: opencode.executeOpenCodeTask,
  });
}
