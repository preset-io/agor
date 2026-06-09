/**
 * JSONL event types written by `claude` v2.1.x to the on-disk transcript at
 * `~/.claude/projects/<slug>/<session-id>.jsonl`.
 *
 * These are deliberately structural / `unknown`-tolerant. Anthropic owns the
 * schema and can rename or add fields between CLI versions. The watcher's
 * defensive parser logs+skips unknown shapes rather than crashing — once
 * ccusage is wired in (see analysis doc Appendix C) its valibot schemas
 * replace these for line-validation, but we keep these for adapter code that
 * doesn't pull in valibot.
 *
 * The complete enumeration of `type` values observed in a real CLI session
 * (Appendix A) is: ai-title, assistant, attachment, create, deferred_tools_delta,
 * direct, last-prompt, mcp_instructions_delta, message, messages_changed,
 * pr-link, previous_message_not_found, queue-operation, skill_listing,
 * system_changed, text, thinking, todo_reminder, tool_reference, tool_result,
 * tool_use, tools_changed, unavailable, update, user.
 *
 * Only a small subset drive the Agor message/task surfaces; everything else is
 * either a nested content block (rendered inside an `assistant` event) or
 * attachment metadata we log but don't persist in v1.
 */

/** Fields every JSONL line carries (with rare exceptions like `queue-operation`). */
export interface JsonlLineCommon {
  /** v4 UUID per-line. NOT the same as `message.id` — multiple lines can
   *  share one `message.id` (the cumulative-snapshot footgun). */
  uuid?: string;
  /** ISO 8601 timestamp. */
  timestamp?: string;
  /** The CLI session UUID — same value across every line in the file. */
  sessionId?: string;
  /** `claude` binary version (e.g. "2.1.170"). */
  version?: string;
  /** Working dir the session was launched from. */
  cwd?: string;
  /** Git branch name at the time the line was written. */
  gitBranch?: string;
  /** UUID of the JSONL line that triggered this one (turn ancestry). */
  parentUuid?: string | null;
  /** `true` for sub-agent (Task() tool) lines living in
   *  `<sessionId>/subagents/agent-<id>.jsonl`. */
  isSidechain?: boolean;
}

/** Queue lifecycle around each turn. */
export interface QueueOperationLine extends JsonlLineCommon {
  type: 'queue-operation';
  operation: 'enqueue' | 'dequeue' | string;
}

/** Auto-generated session title (e.g. "Analyze Claude Code CLI agentic-tool integration"). */
export interface AiTitleLine extends JsonlLineCommon {
  type: 'ai-title';
  aiTitle?: string;
}

/** Preview of the most recent user prompt, truncated ~120 chars. */
export interface LastPromptLine extends JsonlLineCommon {
  type: 'last-prompt';
  lastPrompt?: string;
}

/** User-driven message — top-level prompt OR `tool_result` envelope. */
export interface UserLine extends JsonlLineCommon {
  type: 'user';
  userType?: string;
  permissionMode?: string;
  /** Present when this line is a tool_result; the assistant turn's tool_use
   *  uuid being reported on. */
  sourceToolAssistantUUID?: string;
  /** `tool_result` payload from the previous assistant `tool_use`. */
  toolUseResult?: unknown;
  message?: {
    role?: 'user';
    content?: unknown;
  };
}

/** Assistant turn — the meat of the conversation surface. */
export interface AssistantLine extends JsonlLineCommon {
  type: 'assistant';
  /** API request id that produced this turn. 1:1 with `message.id`. */
  requestId?: string;
  userType?: string;
  /** Always `"sdk-ts"` for `claude` v2.1.x regardless of how the session
   *  was launched — not a useful discriminator. */
  entrypoint?: string;
  message?: {
    /** The Anthropic API message id (`msg_…`). **Mandatory dedup key** —
     *  one assistant turn writes one JSONL line per content block emitted,
     *  each with the same `message.id` and the cumulative-to-that-point
     *  `usage`. Naive sum across lines over-counts ~6× in our live sample. */
    id?: string;
    type?: 'message';
    role?: 'assistant';
    model?: string;
    content?: AssistantContentBlock[];
    stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | string | null;
    stop_sequence?: string | null;
    stop_details?: unknown;
    usage?: AssistantUsage;
    diagnostics?: unknown;
  };
}

/** Per-turn token usage with cache tiering. */
export interface AssistantUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  };
  service_tier?: string;
  iterations?: AssistantUsage[];
}

/** Content blocks within an assistant turn. */
export type AssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking?: string; signature?: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input?: Record<string, unknown>;
    }
  | { type: string; [k: string]: unknown }; // permissive fallback

/** Attachment metadata — system notes attached around turns. */
export interface AttachmentLine extends JsonlLineCommon {
  type: 'attachment';
  /** Specific attachment subtype, e.g. `skill_listing`, `budget_usd`,
   *  `deferred_tools_delta`, `pendingMcpServers`. The shape inside varies. */
  attachmentType?: string;
  [k: string]: unknown;
}

/** Catch-all for shapes we don't explicitly model. */
export interface UnknownLine extends JsonlLineCommon {
  type: string;
  [k: string]: unknown;
}

/** Discriminated union of all events we explicitly model. */
export type JsonlLine =
  | QueueOperationLine
  | AiTitleLine
  | LastPromptLine
  | UserLine
  | AssistantLine
  | AttachmentLine
  | UnknownLine;

/**
 * The dedup key recommended by ccusage and validated in our live sample:
 * `message.id` is 1:1 with `requestId`. Either field works; we prefer
 * `message.id` because it's semantically anchored to the Anthropic API.
 */
export function dedupKeyForAssistantLine(line: AssistantLine): string | null {
  return line.message?.id ?? line.requestId ?? null;
}
