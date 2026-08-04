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
  TaskRunnerReport,
} from '@agor/core/types';
import type { ExecutorResult, ResolvedConfigSlice } from '../../payload-types.js';
import type { AgorClient } from '../../services/feathers-client.js';

/**
 * Tool identifier
 */
export type Tool = AgenticToolName;

export interface ToolExecutionResult {
  /** Present only for runners that delegate durable settlement to the host. */
  runnerReport?: TaskRunnerReport;
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
  /** Lazy task runner loader. */
  loadRunner: () => Promise<ToolRunner>;
  /** Optional adapter for bounded non-Task operations such as auth or catalogs. */
  loadAuxiliaryAdapter?: () => Promise<AgenticToolAuxiliaryAdapter>;
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
    return (await config.loadRunner())(params);
  }

  static async executeAuxiliary(
    tool: Tool,
    input: AgenticToolAuxiliaryInput
  ): Promise<ExecutorResult> {
    const loader = ToolRegistry.get(tool)?.loadAuxiliaryAdapter;
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
    const loader = ToolRegistry.get(tool)?.loadAuxiliaryAdapter;
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
export async function initializeToolRegistry(): Promise<void> {
  const legacyRunner =
    (runner: (params: Parameters<ToolRunner>[0]) => Promise<void>): ToolRunner =>
    async (params) => {
      await runner(params);
      return {};
    };
  const adapters: ToolConfig[] = [
    {
      tool: 'claude-code',
      loadRunner: async () => legacyRunner((await import('./claude.js')).executeClaudeCodeTask),
    },
    {
      tool: 'codex',
      loadRunner: async () => legacyRunner((await import('./codex.js')).executeCodexTask),
    },
    {
      tool: 'gemini',
      loadRunner: async () => legacyRunner((await import('./gemini.js')).executeGeminiTask),
    },
    {
      tool: 'opencode',
      loadRunner: async () => (await import('./opencode.js')).executeOpenCodeTask,
      loadAuxiliaryAdapter: async () =>
        (await import('@agor/agentic-tool-opencode/runtime')).OPENCODE_AUXILIARY_ADAPTER,
    },
    {
      tool: 'copilot',
      loadRunner: async () => legacyRunner((await import('./copilot.js')).executeCopilotTask),
    },
    {
      tool: 'cursor',
      loadRunner: async () => legacyRunner((await import('./cursor.js')).executeCursorTask),
    },
  ];
  for (const adapter of adapters) ToolRegistry.register(adapter);
}
