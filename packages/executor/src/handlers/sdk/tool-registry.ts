/**
 * Tool Runner Registry
 *
 * Centralized registry for all SDK tool runners.
 * Makes it easier to add new tools and ensures consistency.
 */

import { getAgenticToolIntegration } from '@agor/agentic-tools';
import type {
  AgenticToolName,
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
export type Tool = AgenticToolName;

export interface ToolExecutionResult {
  completion?: {
    model?: string;
  };
}

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
  agenticToolContext?: Record<string, unknown>;
  /** Daemon-resolved config slice. Undefined in legacy CLI mode. */
  resolvedConfig?: ResolvedConfigSlice;
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void;
}) => Promise<ToolExecutionResult>;

/**
 * Tool configuration
 */
export interface ToolConfig {
  /** Tool identifier */
  tool: Tool;
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
    return getAgenticToolIntegration(tool).apiKeyName ?? 'NONE';
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
      agenticToolContext?: Record<string, unknown>;
      resolvedConfig?: ResolvedConfigSlice;
      onPulse?: (kind: ExecutorPulseKind, detail?: string) => void;
    }
  ): Promise<ToolExecutionResult> {
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

  const legacyRunner =
    (runner: (params: Parameters<ToolRunner>[0]) => Promise<void>): ToolRunner =>
    async (params) => {
      await runner(params);
      return {};
    };
  const adapters: ToolConfig[] = [
    { tool: 'claude-code', runner: legacyRunner(claude.executeClaudeCodeTask) },
    { tool: 'codex', runner: legacyRunner(codex.executeCodexTask) },
    { tool: 'gemini', runner: legacyRunner(gemini.executeGeminiTask) },
    { tool: 'opencode', runner: opencode.executeOpenCodeTask },
    { tool: 'copilot', runner: legacyRunner(copilot.executeCopilotTask) },
    { tool: 'cursor', runner: legacyRunner(cursor.executeCursorTask) },
  ];
  for (const adapter of adapters) ToolRegistry.register(adapter);
}
