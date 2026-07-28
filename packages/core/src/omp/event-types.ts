/**
 * Wire types for the Oh My Pi (OMP) JSONL RPC protocol.
 *
 * Agor drives OMP by spawning `omp --mode rpc`, which speaks newline-delimited
 * JSON over stdio: commands in on stdin, a `ready` frame plus command
 * responses and agent events out on stdout.
 *
 * These types are hand-written against OMP's documented RPC reference rather
 * than imported: OMP's npm package ships raw TypeScript and targets the Bun
 * runtime, so it cannot be a dependency of Agor's Node executor.
 *
 * Only the surface Agor actually consumes is modelled. Unknown frames are
 * tolerated by design — OMP may add event types, and the translator ignores
 * anything it does not recognise instead of failing the turn.
 */

/** Reasoning levels OMP accepts for `set_thinking_level`. */
export type OmpThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'auto';

/** How a prompt issued while the agent is streaming should be queued. */
export type OmpStreamingBehavior = 'steer' | 'followUp';

/**
 * Per-message token accounting as reported by OMP.
 *
 * Note OMP reports real spend in `cost` (USD) rather than leaving the host to
 * infer it from a price table — Agor surfaces this directly instead of
 * estimating.
 */
export interface OmpUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  /** Cache time-to-live buckets, e.g. `{ ephemeral1h: 53259 }`. Informational. */
  cttl?: Record<string, number>;
}

/** A single content block on an OMP message. */
export interface OmpContentBlock {
  type: 'text' | 'thinking' | 'toolCall' | 'toolResult' | string;
  text?: string;
  thinking?: string;
  thinkingSignature?: string;
  /** Present on `toolCall` blocks. */
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A whole message as carried by `message_start` / `message_end`. */
export interface OmpMessage {
  role: 'user' | 'assistant' | 'system' | string;
  content: OmpContentBlock[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: OmpUsage;
  stopReason?: string;
  timestamp?: number;
  attribution?: string;
  [key: string]: unknown;
}

/**
 * Streaming delta carried by `message_update`.
 *
 * `contentIndex` identifies which block of the in-flight assistant message the
 * delta belongs to, which is what lets text and thinking interleave safely.
 */
export interface OmpAssistantMessageEvent {
  type:
    | 'text_start'
    | 'text_delta'
    | 'text_end'
    | 'thinking_start'
    | 'thinking_delta'
    | 'thinking_end'
    | 'toolcall_start'
    | 'toolcall_delta'
    | 'toolcall_end'
    | string;
  contentIndex?: number;
  delta?: string;
  [key: string]: unknown;
}

/** Result payload attached to `tool_execution_end`. */
export interface OmpToolResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One slash command advertised by OMP. */
export interface OmpSlashCommand {
  name: string;
  description?: string;
  aliases?: string[];
  /** Free-form argument hint, e.g. `"[on|off|status]"`. */
  input?: { hint?: string };
  subcommands?: Array<{ name: string; description?: string }>;
  /** Where the command came from: `builtin`, an extension, a file, etc. */
  source?: string;
}

/** Context-window occupancy reported by `get_state`. */
export interface OmpContextUsage {
  tokens: number;
  contextWindow: number;
  /** Percentage in the 0–100 range (may be fractional). */
  percent: number;
}

/** Model descriptor reported by `get_state` / `get_available_models`. */
export interface OmpModelInfo {
  id: string;
  name?: string;
  provider?: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinking?: { mode?: string; efforts?: string[]; supportsDisplay?: boolean };
  [key: string]: unknown;
}

/** Payload of a successful `get_state` response. */
export interface OmpState {
  model?: OmpModelInfo;
  thinkingLevel?: OmpThinkingLevel;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  queuedMessageCount?: number;
  contextUsage?: OmpContextUsage;
  [key: string]: unknown;
}

/** The handshake frame OMP writes before accepting commands. */
export interface OmpReadyFrame {
  type: 'ready';
  protocolVersion: number;
  supportedProtocolVersions?: number[];
  maxFrameBytes?: number;
  maxReassembledFrameBytes?: number;
}

/** Reply to a command, correlated by the `id` the caller supplied. */
export interface OmpResponseFrame {
  type: 'response';
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Every stdout frame Agor understands.
 *
 * Deliberately open-ended (`| { type: string }`) so an OMP upgrade that adds
 * frames cannot break parsing.
 */
export type OmpFrame =
  | OmpReadyFrame
  | OmpResponseFrame
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages?: OmpMessage[]; isTerminal?: boolean }
  | { type: 'turn_start' }
  | { type: 'turn_end' }
  | { type: 'message_start'; message: OmpMessage }
  | { type: 'message_end'; message: OmpMessage }
  | {
      type: 'message_update';
      assistantMessageEvent: OmpAssistantMessageEvent;
      message?: OmpMessage;
    }
  | {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName: string;
      args?: Record<string, unknown>;
      intent?: string;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result?: OmpToolResult;
      isError?: boolean;
    }
  | { type: 'available_commands_update'; commands: OmpSlashCommand[] }
  | { type: 'command_output'; text: string }
  | { type: 'prompt_result'; id?: string; agentInvoked: boolean }
  | { type: 'extension_ui_request'; id: string; method: string; [key: string]: unknown }
  | { type: 'extension_error'; extensionPath?: string; event?: string; error?: string }
  | { type: string; [key: string]: unknown };

/** Commands Agor sends on stdin. `id` correlates the eventual response. */
export type OmpCommand =
  | { id?: string; type: 'prompt'; message: string; streamingBehavior?: OmpStreamingBehavior }
  | { id?: string; type: 'steer'; message: string }
  | { id?: string; type: 'follow_up'; message: string }
  | { id?: string; type: 'abort' }
  | { id?: string; type: 'get_state' }
  | { id?: string; type: 'get_available_commands' }
  | { id?: string; type: 'get_available_models' }
  | { id?: string; type: 'set_model'; provider: string; modelId: string }
  | { id?: string; type: 'set_thinking_level'; level: OmpThinkingLevel }
  | { id?: string; type: 'get_last_assistant_text' }
  | { id?: string; type: 'set_session_name'; name: string }
  | { id?: string; type: string; [key: string]: unknown };

/** Narrowing helper — `type` is present on every well-formed frame. */
export function isOmpFrame(value: unknown): value is OmpFrame {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  return typeof value.type === 'string';
}
