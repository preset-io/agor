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
export type Tool = 'claude-code' | 'gemini' | 'codex' | 'opencode' | 'copilot' | 'cursor';

export const KNOWN_TOOLS: readonly Tool[] = [
  'claude-code',
  'codex',
  'gemini',
  'opencode',
  'copilot',
  'cursor',
] as const;

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
    return [...KNOWN_TOOLS];
  }

  /**
   * Check if tool is registered
   */
  static has(tool: string): tool is Tool {
    return (KNOWN_TOOLS as readonly string[]).includes(tool);
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
export async function initializeToolRegistry(tool?: Tool): Promise<void> {
  const registerTool = async (selectedTool: Tool): Promise<void> => {
    if (ToolRegistry.get(selectedTool)) return;

    switch (selectedTool) {
      case 'claude-code': {
        const claude = await import('./claude.js');
        ToolRegistry.register({
          tool: 'claude-code',
          name: 'Claude Code',
          apiKeyEnvVar: TOOL_API_KEY_NAMES['claude-code']!,
          runner: claude.executeClaudeCodeTask,
        });
        break;
      }
      case 'codex': {
        const codex = await import('./codex.js');
        ToolRegistry.register({
          tool: 'codex',
          name: 'Codex',
          apiKeyEnvVar: TOOL_API_KEY_NAMES.codex!,
          runner: codex.executeCodexTask,
        });
        break;
      }
      case 'gemini': {
        const gemini = await import('./gemini.js');
        ToolRegistry.register({
          tool: 'gemini',
          name: 'Gemini',
          apiKeyEnvVar: TOOL_API_KEY_NAMES.gemini!,
          runner: gemini.executeGeminiTask,
        });
        break;
      }
      case 'opencode': {
        const opencode = await import('./opencode.js');
        ToolRegistry.register({
          tool: 'opencode',
          name: 'OpenCode',
          apiKeyEnvVar: 'NONE', // OpenCode doesn't need API key
          runner: opencode.executeOpenCodeTask,
        });
        break;
      }
      case 'copilot': {
        const copilot = await import('./copilot.js');
        ToolRegistry.register({
          tool: 'copilot',
          name: 'GitHub Copilot',
          apiKeyEnvVar: TOOL_API_KEY_NAMES.copilot!, // Note: execution also accepts GH_TOKEN / GITHUB_TOKEN aliases
          runner: copilot.executeCopilotTask,
        });
        break;
      }
      case 'cursor': {
        const cursor = await import('./cursor.js');
        ToolRegistry.register({
          tool: 'cursor',
          name: 'Cursor SDK',
          apiKeyEnvVar: TOOL_API_KEY_NAMES.cursor!,
          runner: cursor.executeCursorTask,
        });
        break;
      }
    }
  };

  if (tool) {
    await registerTool(tool);
    return;
  }

  await Promise.all(KNOWN_TOOLS.map((knownTool) => registerTool(knownTool)));
}
