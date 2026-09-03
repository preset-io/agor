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
import type { ExecutorResult, ResolvedConfigSlice } from '../../payload-types.js';
import type { AgorClient } from '../../services/feathers-client.js';

/**
 * Tool identifier
 */
export type Tool = AgenticToolName;

/**
 * Tool runner function - executes via Feathers WebSocket
 */
export type ToolRunner = (params: {
  client: AgorClient;
  sessionId: SessionID;
  taskId: TaskID;
  prompt: string;
  /** Daemon-authored Task cwd from the authenticated prompt payload. */
  workspaceCwd?: string;
  permissionMode?: PermissionMode;
  abortController: AbortController;
  messageSource?: MessageSource;
  agenticToolContext?: Record<string, unknown>;
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
  apiKeyEnvVar?: string;
  /** Tool runner function */
  runner: ToolRunner;
}

export interface AgenticToolAuxiliaryInput {
  context: unknown;
  request: unknown;
  dryRun?: boolean;
}

export interface AgenticToolInteractiveChannel {
  emit(event: unknown): void;
  read(): Promise<unknown>;
}

export interface AgenticToolAuxiliaryAdapter {
  execute(input: AgenticToolAuxiliaryInput): Promise<ExecutorResult>;
  executeInteractive?(
    input: AgenticToolAuxiliaryInput,
    channel: AgenticToolInteractiveChannel
  ): Promise<ExecutorResult>;
}

const auxiliaryAdapters: Partial<Record<Tool, () => Promise<AgenticToolAuxiliaryAdapter>>> = {
  opencode: async () =>
    (await import('@agor/agentic-tool-opencode/runtime')).OPENCODE_AUXILIARY_ADAPTER,
};

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
  static getApiKeyEnvVar(tool: Tool): string | undefined {
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
      /** Daemon-authored Task cwd from the authenticated prompt payload. */
      workspaceCwd?: string;
      permissionMode?: PermissionMode;
      abortController: AbortController;
      messageSource?: MessageSource;
      agenticToolContext?: Record<string, unknown>;
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

  static async executeAuxiliary(
    tool: Tool,
    input: AgenticToolAuxiliaryInput
  ): Promise<ExecutorResult> {
    const loader = auxiliaryAdapters[tool];
    if (!loader) {
      return {
        success: false,
        error: {
          code: 'AGENTIC_TOOL_AUXILIARY_UNSUPPORTED',
          message: `Agentic tool does not support auxiliary executor operations: ${tool}`,
        },
      };
    }
    return (await loader()).execute(input);
  }

  static async executeInteractiveAuxiliary(
    tool: Tool,
    input: AgenticToolAuxiliaryInput,
    channel: AgenticToolInteractiveChannel
  ): Promise<ExecutorResult> {
    const loader = auxiliaryAdapters[tool];
    if (!loader) {
      return {
        success: false,
        error: {
          code: 'AGENTIC_TOOL_AUXILIARY_UNSUPPORTED',
          message: `Agentic tool does not support auxiliary executor operations: ${tool}`,
        },
      };
    }
    const adapter = await loader();
    if (!adapter.executeInteractive) {
      return {
        success: false,
        error: {
          code: 'INTERACTIVE_COMMAND_UNSUPPORTED',
          message: `Agentic tool does not support interactive auxiliary operations: ${tool}`,
        },
      };
    }
    return adapter.executeInteractive(input, channel);
  }
}

/**
 * Initialize tool registry with all available tools
 */
export async function initializeToolRegistry(tool?: Tool): Promise<void> {
  if (tool === 'workload') {
    const workload = await import('./workload.js');
    ToolRegistry.register({
      tool: 'workload',
      name: getAgenticToolIntegration('workload').displayName,
      runner: workload.executeWorkloadTask,
    });
    return;
  }

  // Import all tool handlers
  const [claude, codex, opencode, copilot] = await Promise.all([
    import('./claude.js'),
    import('./codex.js'),
    import('./opencode.js'),
    import('./copilot.js'),
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
    runner: async (params) => {
      try {
        const gemini = await import('./gemini.js');
        return await gemini.executeGeminiTask(params);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('@google/gemini-cli-core') ||
            (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND')
        ) {
          throw new Error(
            'Gemini support is not installed on this Agor instance. ' +
              'See https://agor.live/guide/extended-install#agentic-tools',
            { cause: error }
          );
        }
        throw error;
      }
    },
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

  // Register Cursor SDK (beta). Load it only when selected so Cursor remains optional.
  ToolRegistry.register({
    tool: 'cursor',
    name: getAgenticToolIntegration('cursor').displayName,
    apiKeyEnvVar: getAgenticToolIntegration('cursor').apiKeyName!,
    runner: async (params) => {
      try {
        const cursor = await import('./cursor.js');
        return await cursor.executeCursorTask(params);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('@cursor/sdk') ||
            (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND')
        ) {
          throw new Error(
            'Cursor SDK support is not installed on this Agor instance. ' +
              'See https://agor.live/guide/extended-install#agentic-tools',
            { cause: error }
          );
        }
        throw error;
      }
    },
  });
}
