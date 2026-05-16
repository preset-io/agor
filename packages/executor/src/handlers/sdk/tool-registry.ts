/**
 * Tool Runner Registry
 *
 * Centralized registry for all SDK tool runners.
 * Makes it easier to add new tools and ensures consistency.
 */

import type { MessageSource, PermissionMode, SessionID, TaskID } from '@agor/core/types';
import { TOOL_API_KEY_NAMES } from '@agor/core/types';
import type { ResolvedConfigSlice } from '../../payload-types.js';
import type { AgorClient } from '../../services/feathers-client.js';

/**
 * Tool identifier
 */
export type Tool = 'claude-code' | 'gemini' | 'codex' | 'opencode' | 'copilot';

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
  /** Daemon-resolved config slice. Undefined in legacy CLI mode. */
  resolvedConfig?: ResolvedConfigSlice;
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
// biome-ignore lint/complexity/noStaticOnlyClass: registry pattern groups related tool configuration
export class ToolRegistry {
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
      resolvedConfig?: ResolvedConfigSlice;
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
  const [claude, codex, gemini, opencode, copilot] = await Promise.all([
    import('./claude.js'),
    import('./codex.js'),
    import('./gemini.js'),
    import('./opencode.js'),
    import('./copilot.js'),
  ]);

  // Register Claude Code
  ToolRegistry.register({
    tool: 'claude-code',
    name: 'Claude Code',
    apiKeyEnvVar: TOOL_API_KEY_NAMES['claude-code']!,
    runner: claude.executeClaudeCodeTask,
  });

  // Register Codex
  ToolRegistry.register({
    tool: 'codex',
    name: 'Codex',
    apiKeyEnvVar: TOOL_API_KEY_NAMES['codex']!,
    runner: codex.executeCodexTask,
  });

  // Register Gemini
  ToolRegistry.register({
    tool: 'gemini',
    name: 'Gemini',
    apiKeyEnvVar: TOOL_API_KEY_NAMES['gemini']!,
    runner: gemini.executeGeminiTask,
  });

  // Register OpenCode
  ToolRegistry.register({
    tool: 'opencode',
    name: 'OpenCode',
    apiKeyEnvVar: 'NONE', // OpenCode doesn't need API key
    runner: opencode.executeOpenCodeTask,
  });

  // Register Copilot
  ToolRegistry.register({
    tool: 'copilot',
    name: 'GitHub Copilot',
    apiKeyEnvVar: TOOL_API_KEY_NAMES['copilot']!, // Note: execution also accepts GH_TOKEN / GITHUB_TOKEN aliases
    runner: copilot.executeCopilotTask,
  });
}
