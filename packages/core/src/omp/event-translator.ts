/**
 * Translates an Oh My Pi RPC event stream into Agor message content.
 *
 * OMP emits both incremental deltas (for live typing) and, at
 * `message_end`, the authoritative final message. This accumulator streams the
 * deltas for UX but builds the persisted blocks from the final messages, so a
 * dropped or reordered delta can never corrupt what gets stored.
 *
 * Pure and transport-free so it can be unit-tested without spawning OMP.
 */

import type { ContentBlock } from '../types/message.js';
import type { OmpFrame, OmpMessage } from './event-types.js';

/** A chunk of streamable output to forward to Agor's streaming callbacks. */
export interface OmpStreamDelta {
  kind: 'text' | 'thinking';
  text: string;
}

/** Token/cost totals summed across every assistant message in a turn. */
export interface OmpTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  /** Real USD spend as reported by OMP — not an Agor-side estimate. */
  costUsd: number;
}

/** Everything the executor needs once a turn finishes. */
export interface OmpTurnResult {
  contentBlocks: ContentBlock[];
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  usage: OmpTurnUsage;
  model?: string;
  provider?: string;
  stopReason?: string;
  hadError: boolean;
  errorDetails: string[];
  /**
   * True once OMP signalled the turn is over. Set by `agent_end`, or by a
   * local-only slash command resolving without invoking the agent.
   */
  ended: boolean;
  /** Output produced by local-only slash commands (e.g. `/model`). */
  commandOutputs: string[];
  /**
   * Slash commands OMP advertised for this session. Agor persists these so the
   * composer can autocomplete them.
   */
  slashCommands: string[];
}

const EMPTY_USAGE: OmpTurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

/**
 * Read a numeric field off an unvalidated object, defaulting to 0.
 *
 * OMP's usage payloads are external input, so every field is checked rather
 * than assumed; a missing or non-numeric entry contributes nothing to totals.
 */
function readNumber(source: object, key: string): number {
  if (!(key in source)) return 0;
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'number' ? value : 0;
}

/**
 * Accumulates one OMP turn.
 *
 * Feed every frame to `handle()`; it returns a delta whenever the frame
 * carried streamable text. Read `result()` once `ended` is true.
 */
export class OmpTurnAccumulator {
  private readonly blocks: ContentBlock[] = [];
  private readonly toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> =
    [];
  private readonly errors: string[] = [];
  private readonly commandOutputs: string[] = [];
  private slashCommandNames: string[] = [];
  private usage: OmpTurnUsage = { ...EMPTY_USAGE };
  private model?: string;
  private provider?: string;
  private stopReason?: string;
  private ended = false;
  private sawError = false;
  /** Tool call ids already emitted, so a retried frame cannot duplicate a block. */
  private readonly seenToolCalls = new Set<string>();
  /** Tool call ids already completed, so a retried end frame cannot duplicate. */
  private readonly settledToolCalls = new Set<string>();

  /**
   * Consume one frame.
   *
   * @returns streamable text when the frame was a text/thinking delta.
   */
  handle(frame: OmpFrame): OmpStreamDelta | undefined {
    switch (frame.type) {
      case 'message_update':
        return this.handleMessageUpdate(frame);
      case 'message_end':
        this.handleMessageEnd(frame);
        return undefined;
      case 'tool_execution_start':
        this.handleToolStart(frame);
        return undefined;
      case 'tool_execution_end':
        this.handleToolEnd(frame);
        return undefined;
      case 'command_output':
        if ('text' in frame && typeof frame.text === 'string') {
          this.commandOutputs.push(frame.text);
          this.blocks.push({ type: 'text', text: frame.text });
        }
        return undefined;
      case 'available_commands_update':
        this.captureSlashCommands(frame);
        return undefined;
      case 'extension_error':
        if ('error' in frame && typeof frame.error === 'string') {
          this.sawError = true;
          this.errors.push(frame.error);
        }
        return undefined;
      case 'agent_end':
        this.ended = true;
        return undefined;
      default:
        return undefined;
    }
  }

  /** Mark the turn finished without an `agent_end` (local-only slash command). */
  markEnded(): void {
    this.ended = true;
  }

  /** Record a transport/protocol failure against the turn. */
  recordError(message: string): void {
    this.sawError = true;
    this.errors.push(message);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /**
   * Record the command set OMP advertises.
   *
   * OMP emits this at startup and whenever command metadata changes, so the
   * latest frame wins rather than accumulating stale entries.
   */
  private captureSlashCommands(frame: OmpFrame): void {
    if (!('commands' in frame) || !Array.isArray(frame.commands)) return;
    const names: string[] = [];
    for (const command of frame.commands) {
      if (typeof command !== 'object' || command === null) continue;
      if (!('name' in command) || typeof command.name !== 'string' || !command.name) continue;
      names.push(command.name);
    }
    if (names.length > 0) this.slashCommandNames = names;
  }

  private handleMessageUpdate(frame: OmpFrame): OmpStreamDelta | undefined {
    if (!('assistantMessageEvent' in frame)) return undefined;
    const event = frame.assistantMessageEvent;
    if (typeof event !== 'object' || event === null) return undefined;
    if (!('type' in event) || typeof event.type !== 'string') return undefined;
    if (!('delta' in event) || typeof event.delta !== 'string' || event.delta === '') {
      return undefined;
    }
    if (event.type === 'text_delta') return { kind: 'text', text: event.delta };
    if (event.type === 'thinking_delta') return { kind: 'thinking', text: event.delta };
    return undefined;
  }

  /**
   * Fold a completed message in. Only assistant messages contribute content;
   * the user echo is already in Agor's transcript.
   */
  private handleMessageEnd(frame: OmpFrame): void {
    if (!('message' in frame)) return;
    const message = frame.message;
    if (typeof message !== 'object' || message === null) return;
    if (!('role' in message) || message.role !== 'assistant') return;

    this.foldUsage(message);
    if ('model' in message && typeof message.model === 'string') this.model = message.model;
    if ('provider' in message && typeof message.provider === 'string') {
      this.provider = message.provider;
    }
    if ('stopReason' in message && typeof message.stopReason === 'string') {
      this.stopReason = message.stopReason;
    }

    if (!('content' in message) || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (typeof block !== 'object' || block === null) continue;
      if (!('type' in block)) continue;
      if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
        if (block.text.trim()) this.blocks.push({ type: 'text', text: block.text });
      } else if (
        block.type === 'thinking' &&
        'thinking' in block &&
        typeof block.thinking === 'string'
      ) {
        if (block.thinking.trim()) this.blocks.push({ type: 'thinking', thinking: block.thinking });
      }
    }
  }

  private foldUsage(message: OmpMessage | Record<string, unknown>): void {
    if (!('usage' in message)) return;
    const usage = message.usage;
    if (typeof usage !== 'object' || usage === null) return;
    this.usage = {
      inputTokens: this.usage.inputTokens + readNumber(usage, 'input'),
      outputTokens: this.usage.outputTokens + readNumber(usage, 'output'),
      cacheReadTokens: this.usage.cacheReadTokens + readNumber(usage, 'cacheRead'),
      cacheCreationTokens: this.usage.cacheCreationTokens + readNumber(usage, 'cacheWrite'),
      totalTokens: this.usage.totalTokens + readNumber(usage, 'totalTokens'),
      costUsd: this.usage.costUsd + this.readCostTotal(usage),
    };
  }

  private readCostTotal(usage: object): number {
    if (!('cost' in usage)) return 0;
    const cost = usage.cost;
    if (typeof cost !== 'object' || cost === null) return 0;
    return readNumber(cost, 'total');
  }

  private handleToolStart(frame: OmpFrame): void {
    if (!('toolCallId' in frame) || typeof frame.toolCallId !== 'string') return;
    if (!('toolName' in frame) || typeof frame.toolName !== 'string') return;
    if (this.seenToolCalls.has(frame.toolCallId)) return;
    this.seenToolCalls.add(frame.toolCallId);

    const args =
      'args' in frame && typeof frame.args === 'object' && frame.args !== null
        ? { ...frame.args }
        : {};
    const block: ContentBlock = {
      type: 'tool_use',
      id: frame.toolCallId,
      name: frame.toolName,
      input: args,
    };
    // OMP annotates each call with a short natural-language intent; surface it
    // so Agor's tool blocks read the way they do in the OMP TUI.
    if ('intent' in frame && typeof frame.intent === 'string' && frame.intent) {
      block.intent = frame.intent;
    }
    this.blocks.push(block);
    this.toolUses.push({ id: frame.toolCallId, name: frame.toolName, input: args });
  }

  /**
   * Record a finished tool call.
   *
   * A failing tool is NOT a failed turn. Agents routinely probe, get an error,
   * and adapt — that is normal progress, not a task failure. The error is
   * flagged on the block so the UI renders it as such, but only transport and
   * agent-level failures set `hadError`.
   *
   * Deduplicated by call id, mirroring `handleToolStart`: a repeated end frame
   * would otherwise append a second `tool_result` with no matching `tool_use`.
   */
  private handleToolEnd(frame: OmpFrame): void {
    if (!('toolCallId' in frame) || typeof frame.toolCallId !== 'string') return;
    if (this.settledToolCalls.has(frame.toolCallId)) return;
    this.settledToolCalls.add(frame.toolCallId);
    const isError = 'isError' in frame && frame.isError === true;
    this.blocks.push({
      type: 'tool_result',
      tool_use_id: frame.toolCallId,
      content: this.flattenToolResult(frame),
      is_error: isError,
    });
  }

  /** Collapse an OMP tool result's content array into displayable text. */
  private flattenToolResult(frame: OmpFrame): string {
    if (!('result' in frame)) return '';
    const result = frame.result;
    if (typeof result !== 'object' || result === null) return '';
    if (!('content' in result) || !Array.isArray(result.content)) return '';
    const parts: string[] = [];
    for (const entry of result.content) {
      if (typeof entry !== 'object' || entry === null) continue;
      if ('text' in entry && typeof entry.text === 'string') parts.push(entry.text);
    }
    return parts.join('\n');
  }

  /** Snapshot the accumulated turn. */
  result(): OmpTurnResult {
    return {
      contentBlocks: [...this.blocks],
      toolUses: [...this.toolUses],
      usage: { ...this.usage },
      model: this.model,
      provider: this.provider,
      stopReason: this.stopReason,
      hadError: this.sawError,
      errorDetails: [...this.errors],
      ended: this.ended,
      commandOutputs: [...this.commandOutputs],
      slashCommands: [...this.slashCommandNames],
    };
  }
}

/**
 * A prompt is a slash command when it starts with `/` — OMP expands these
 * itself and may complete them without ever invoking the model.
 */
export function isSlashCommandPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith('/');
}
