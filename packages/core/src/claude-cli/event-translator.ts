/**
 * Translate `claude` CLI JSONL lines into structured events the
 * daemon-side watcher writes to MessagesService / TasksService.
 *
 * Three responsibilities:
 *  1. Parse one JSONL line into a typed event. Unknown lines are surfaced
 *     as `unknown` events (caller logs+skips).
 *  2. Dedup assistant turns by `message.id` so the cumulative-snapshot
 *     repetition (one JSONL line per content block, each carrying the
 *     same cumulative usage — verified live to over-count ~6×) collapses
 *     to a single emit per turn.
 *  3. Emit a `turn_end` event when an assistant line carries
 *     `stop_reason: "end_turn"` — this is the signal the prompt-injection
 *     queue drains on.
 *
 * Cost math (price × usage with the cache-tier ratios) lives in a separate
 * module — see `./cost.ts` once ccusage is wired in.
 */

import {
  type AssistantContentBlock,
  type AssistantLine,
  type AssistantUsage,
  type AttachmentLine,
  dedupKeyForAssistantLine,
  type JsonlLine,
  type UnknownLine,
  type UserLine,
} from './event-types.js';

/** A normalized assistant turn — what the watcher writes to `messages`. */
export interface NormalizedAssistantTurn {
  /** Anthropic API message id, also the dedup key. */
  messageId: string;
  /** The JSONL `uuid` of the FIRST line that carried this message id.
   *  Useful for `parentUuid` references on subsequent user/tool_result lines. */
  firstLineUuid: string | null;
  timestamp: string | null;
  model: string | null;
  content: AssistantContentBlock[];
  usage: AssistantUsage | null;
  stopReason: string | null;
  /** Sub-agent (Task() tool) turns are marked so the UI can render them
   *  as collapsible internal rows. */
  isSidechain: boolean;
}

/** Output shape from the translator. One JSONL line can emit multiple events
 *  (e.g. an assistant `end_turn` line emits both `assistant_message` and
 *  `turn_end`). */
export type TranslatedEvent =
  | {
      type: 'user_message';
      uuid: string | null;
      timestamp: string | null;
      permissionMode: string | null;
      /** Plain text or content array — caller normalizes for storage. */
      content: unknown;
      isSidechain: boolean;
    }
  | {
      type: 'tool_result';
      uuid: string | null;
      timestamp: string | null;
      /** The assistant turn's `tool_use.id` this result corresponds to. */
      sourceToolAssistantUUID: string | null;
      /** Raw `toolUseResult` payload from the JSONL — schema varies by tool. */
      result: unknown;
      isSidechain: boolean;
    }
  | {
      type: 'assistant_message';
      turn: NormalizedAssistantTurn;
    }
  | {
      type: 'turn_start';
      timestamp: string | null;
    }
  | {
      type: 'turn_end';
      /** `messageId` of the turn that closed (always populated since we only
       *  emit on an `assistant` line). */
      messageId: string;
      timestamp: string | null;
    }
  | {
      type: 'ai_title';
      title: string;
    }
  | {
      type: 'last_prompt';
      preview: string;
    }
  | {
      type: 'attachment';
      attachmentType: string | null;
      payload: Record<string, unknown>;
    }
  | {
      type: 'unknown';
      jsonType: string;
      raw: Record<string, unknown>;
    };

/**
 * Stateful translator for one JSONL transcript.
 *
 * Holds the "seen message ids" set in memory. Construct one per session.
 * Construct fresh on watcher restart — the offset bookkeeping (in
 * claude-cli-watcher.ts) ensures we don't re-process lines, so the in-memory
 * Set never needs to survive restart.
 */
export class JsonlEventTranslator {
  private readonly seenMessageIds = new Set<string>();

  /**
   * Parse one JSONL line (string) and emit zero or more translated events.
   * Returns `[]` for lines that produced no events (e.g. duplicate assistant
   * lines with a `message.id` already seen — the snapshot footgun handled).
   */
  translateLine(rawLine: string): TranslatedEvent[] {
    const trimmed = rawLine.trim();
    if (!trimmed) return [];

    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(trimmed) as JsonlLine;
    } catch {
      return [
        {
          type: 'unknown',
          jsonType: 'parse_error',
          raw: { rawLine: trimmed.slice(0, 500) },
        },
      ];
    }

    return this.translateParsed(parsed);
  }

  /** Same as `translateLine` but for already-parsed objects (useful in
   *  tests + fixture replay). */
  translateParsed(parsed: JsonlLine): TranslatedEvent[] {
    switch (parsed.type) {
      case 'queue-operation':
        return this.handleQueueOperation(parsed);
      case 'ai-title':
        return this.handleAiTitle(parsed as { aiTitle?: string });
      case 'last-prompt':
        return this.handleLastPrompt(parsed as { lastPrompt?: string });
      case 'user':
        return this.handleUser(parsed as UserLine);
      case 'assistant':
        return this.handleAssistant(parsed as AssistantLine);
      case 'attachment':
        return this.handleAttachment(parsed as AttachmentLine);
      default:
        return [
          {
            type: 'unknown',
            jsonType: parsed.type ?? 'missing_type',
            raw: parsed as unknown as Record<string, unknown>,
          },
        ];
    }
  }

  private handleQueueOperation(line: JsonlLine & { operation?: string }): TranslatedEvent[] {
    // Only `enqueue` is interesting as a turn-start signal. `dequeue` lags
    // actual end-of-turn — we use the assistant `stop_reason: "end_turn"`
    // for that instead.
    if (line.operation !== 'enqueue') return [];
    return [{ type: 'turn_start', timestamp: line.timestamp ?? null }];
  }

  private handleAiTitle(line: { aiTitle?: string }): TranslatedEvent[] {
    if (!line.aiTitle) return [];
    return [{ type: 'ai_title', title: line.aiTitle }];
  }

  private handleLastPrompt(line: { lastPrompt?: string }): TranslatedEvent[] {
    if (!line.lastPrompt) return [];
    return [{ type: 'last_prompt', preview: line.lastPrompt }];
  }

  private handleUser(line: UserLine): TranslatedEvent[] {
    const isSidechain = line.isSidechain === true;
    if (line.toolUseResult !== undefined || line.sourceToolAssistantUUID) {
      return [
        {
          type: 'tool_result',
          uuid: line.uuid ?? null,
          timestamp: line.timestamp ?? null,
          sourceToolAssistantUUID: line.sourceToolAssistantUUID ?? null,
          result: line.toolUseResult,
          isSidechain,
        },
      ];
    }
    return [
      {
        type: 'user_message',
        uuid: line.uuid ?? null,
        timestamp: line.timestamp ?? null,
        permissionMode: line.permissionMode ?? null,
        content: line.message?.content,
        isSidechain,
      },
    ];
  }

  private handleAssistant(line: AssistantLine): TranslatedEvent[] {
    const dedupKey = dedupKeyForAssistantLine(line);
    // Lines without a usable dedup key — emit defensively but flag in the
    // shape so the watcher can choose to log. In practice every assistant
    // line in our live sample has `message.id`.
    if (!dedupKey) {
      return [
        {
          type: 'unknown',
          jsonType: 'assistant_missing_message_id',
          raw: line as unknown as Record<string, unknown>,
        },
      ];
    }

    const events: TranslatedEvent[] = [];

    if (!this.seenMessageIds.has(dedupKey)) {
      this.seenMessageIds.add(dedupKey);
      const message = line.message;
      events.push({
        type: 'assistant_message',
        turn: {
          messageId: dedupKey,
          firstLineUuid: line.uuid ?? null,
          timestamp: line.timestamp ?? null,
          model: message?.model ?? null,
          content: message?.content ?? [],
          usage: message?.usage ?? null,
          stopReason: message?.stop_reason ?? null,
          isSidechain: line.isSidechain === true,
        },
      });
    }

    // Turn-end fires for ANY terminal stop reason except `tool_use`:
    //
    //   - `end_turn`: normal completion.
    //   - `max_tokens`: assistant ran out of output budget mid-stream.
    //   - `stop_sequence`: emitted a configured stop sequence.
    //   - `refusal`: claude declined to continue.
    //   - any future top-level terminal value Anthropic adds (string is
    //     deliberately open in `event-types.ts`).
    //
    // Only `tool_use` (and `null`/missing, which means "still streaming")
    // leaves the turn open — claude returns with another assistant line
    // once the tool result is reported. Without this widening, a
    // `max_tokens` turn left the task RUNNING forever and blocked the
    // session's queue gate.
    const stop = line.message?.stop_reason;
    if (stop && stop !== 'tool_use') {
      events.push({
        type: 'turn_end',
        messageId: dedupKey,
        timestamp: line.timestamp ?? null,
      });
    }

    return events;
  }

  private handleAttachment(line: AttachmentLine): TranslatedEvent[] {
    // Attachments carry various sub-shapes (skill_listing, budget_usd,
    // deferred_tools_delta, pendingMcpServers, ...). v1 logs them only —
    // no MessagesService write. Surface for telemetry / log lines.
    const { type: _t, attachmentType, ...rest } = line as UnknownLine;
    return [
      {
        type: 'attachment',
        attachmentType: typeof attachmentType === 'string' ? attachmentType : null,
        payload: rest as Record<string, unknown>,
      },
    ];
  }

  /** Test/debug hook. Returns the set of message ids the translator has
   *  already emitted for. */
  getSeenMessageIds(): ReadonlySet<string> {
    return this.seenMessageIds;
  }
}
