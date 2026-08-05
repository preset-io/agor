/**
 * Tool Runner Registry
 *
 * Centralized registry for all SDK tool runners.
 * Makes it easier to add new tools and ensures consistency.
 */

import { getAgenticToolIntegration } from '@agor/agentic-tools';
import type {
  ExecutorPulseKind,
  MessageSource,
  PermissionMode,
  SessionID,
  TaskID,
} from '@agor/core/types';
import type { ResolvedConfigSlice } from '../../payload-types.js';
import type { AgorClient } from '../../services/feathers-client.js';

/**
 * Tool identifier
 */
export type Tool = 'claude-code' | 'gemini' | 'codex' | 'opencode' | 'copilot' | 'cursor';

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
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void;
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
      onPulse?: (kind: ExecutorPulseKind, detail?: string) => void;
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
  const [claude, codex, gemini, opencode, copilot, cursor] = await Promise.all([
    import('./claude.js'),
    import('./codex.js'),
    import('./gemini.js'),
    import('./opencode.js'),
    import('./copilot.js'),
    import('./cursor.js'),
  ]);

  // Register Claude Code
  ToolRegistry.register({
    tool: 'claude-code',
    name: getAgenticToolIntegration('claude-code').displayName,
    apiKeyEnvVar: getAgenticToolIntegration('claude-code').apiKeyName!,
    runner: claude.executeClaudeCodeTask,
  });

  // Register Codex
  ToolRegistry.register({
    tool: 'codex',
    name: getAgenticToolIntegration('codex').displayName,
    apiKeyEnvVar: getAgenticToolIntegration('codex').apiKeyName!,
    runner: codex.executeCodexTask,
  });

  // Register Gemini
  ToolRegistry.register({
    tool: 'gemini',
    name: getAgenticToolIntegration('gemini').displayName,
    apiKeyEnvVar: getAgenticToolIntegration('gemini').apiKeyName!,
    runner: gemini.executeGeminiTask,
  });

  // Register OpenCode
  ToolRegistry.register({
    tool: 'opencode',
    name: getAgenticToolIntegration('opencode').displayName,
    apiKeyEnvVar: getAgenticToolIntegration('opencode').apiKeyName ?? 'NONE',
    runner: opencode.executeOpenCodeTask,
  });

  // Register Copilot
  ToolRegistry.register({
    tool: 'copilot',
    name: getAgenticToolIntegration('copilot').displayName,
    apiKeyEnvVar: getAgenticToolIntegration('copilot').apiKeyName!, // Note: execution also accepts GH_TOKEN / GITHUB_TOKEN aliases
    runner: copilot.executeCopilotTask,
  });

  // Register Cursor SDK (experimental skeleton; handler intentionally fails until runtime lands)
  ToolRegistry.register({
    tool: 'cursor',
    name: getAgenticToolIntegration('cursor').displayName,
    apiKeyEnvVar: getAgenticToolIntegration('cursor').apiKeyName!,
    runner: cursor.executeCursorTask,
  });
}
