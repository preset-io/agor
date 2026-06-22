/**
 * Slack Connector
 *
 * Sends messages via Slack Web API and optionally listens for
 * inbound messages via Socket Mode.
 *
 * Config shape (stored encrypted in gateway_channels.config):
 *   {
 *     bot_token: string,
 *     app_token?: string,
 *     default_channel?: string,
 *     enable_channels?: boolean,                    // Listen in public channels
 *     enable_groups?: boolean,                      // Listen in private channels
 *     enable_mpim?: boolean,                        // Listen in group DMs
 *     require_mention?: boolean,                    // Require @mention in channels
 *     allow_thread_replies_without_mention?: boolean, // Allow thread replies without @mention (default: true)
 *     allowed_channel_ids?: string[]                // Channel ID whitelist
 *   }
 *
 * Thread ID format: "{channel_id}-{thread_ts}"
 *   e.g. "C07ABC123-1707340800.123456"
 */

import { SocketModeClient } from '@slack/socket-mode';
import type { KnownBlock, RawTextElement, SectionBlock, TableBlock } from '@slack/types';
import { WebClient } from '@slack/web-api';
import { slackifyMarkdown } from 'slackify-markdown';

import type { ChannelType } from '../../types/gateway';
import type { GatewayConnector, InboundMessage, OutboundPayload } from '../connector';

// Block Kit table block limits (Slack docs, native block introduced Aug 2025).
const TABLE_MAX_ROWS = 100;
const TABLE_MAX_COLS = 20;
// No explicit per-cell limit is documented; this is a conservative local cap
// matching the section-block text ceiling so the same cell can never overflow
// either path. Beyond this we drop to monospace, then text-only.
const TABLE_MAX_CELL_CHARS = 3000;
const SECTION_MAX_CHARS = 3000;
// Slack's native markdown block currently caps cumulative markdown text at 12k chars.
const MARKDOWN_BLOCK_MAX_CHARS = 12000;
// Slack rejects messages with more than one `table` block.
const MAX_TABLES_PER_MESSAGE = 1;
// Slack rejects `chat.postMessage` with more than 50 blocks; if we'd exceed
// this we drop the blocks payload entirely and let `text` carry the message.
const MAX_BLOCKS_PER_MESSAGE = 50;
// Slack error codes that indicate the `blocks` payload was malformed/rejected,
// where retrying with text-only is the right fallback.
const BLOCK_PAYLOAD_ERRORS = new Set([
  'invalid_blocks',
  'invalid_blocks_format',
  'invalid_block_type',
  'message_blocks_too_long',
  'unknown_block_type',
  'unsupported_block_type',
]);

// GFM scanner regexes — hoisted so both `segmentMarkdown` and helpers share
// the same definitions (DRY) and they're cheap to test against.
const FENCE_LINE_RE = /^(`{3,}|~{3,})/;
const PIPE_LINE_RE = /^\s*\|/;
const TABLE_SEPARATOR_LINE_RE = /^\s*\|[\s:]*-[\s:-]*\|/;
const TABLE_SEPARATOR_BLOCK_RE = /^\|[\s:]*-[\s:-]*\|/m;

interface SlackMarkdownBlock {
  type: 'markdown';
  text: string;
}

interface SlackConfig {
  bot_token: string;
  app_token?: string;
  default_channel?: string;

  // Message source configuration
  enable_channels?: boolean;
  enable_groups?: boolean;
  enable_mpim?: boolean;
  require_mention?: boolean;
  allow_thread_replies_without_mention?: boolean;
  allowed_channel_ids?: string[];

  // User alignment: resolve Slack user email → Agor user
  align_slack_users?: boolean;
}

/**
 * Parse a composite thread ID into Slack channel + thread_ts
 *
 * Format: "{channel_id}-{thread_ts}" where thread_ts contains a dot
 * e.g. "C07ABC123-1707340800.123456" → { channel: "C07ABC123", thread_ts: "1707340800.123456" }
 */
function parseThreadId(threadId: string): { channel: string; thread_ts: string } {
  // thread_ts always contains a dot, so split on the last hyphen before the numeric part
  const lastHyphen = threadId.lastIndexOf('-');
  if (lastHyphen === -1) {
    throw new Error(
      `Invalid Slack thread ID format: "${threadId}" (expected "{channel}-{thread_ts}")`
    );
  }

  const channel = threadId.substring(0, lastHyphen);
  const thread_ts = threadId.substring(lastHyphen + 1);

  if (!channel || !thread_ts) {
    throw new Error(
      `Invalid Slack thread ID format: "${threadId}" (expected "{channel}-{thread_ts}")`
    );
  }

  return { channel, thread_ts };
}

/**
 * Check if a bot mention pattern appears *outside* code blocks in Slack message text.
 *
 * Slack sends `<@U12345>` in `event.text` regardless of whether the mention is
 * inside a code block or not. However, `app_mention` events only fire for
 * "active" mentions (outside code blocks). This function strips code blocks
 * first, then tests for the mention pattern — so code-block mentions return false.
 *
 * Handles both triple-backtick blocks and inline backtick spans.
 */
function hasActiveMention(text: string, mentionPattern: RegExp): boolean {
  // Strip triple-backtick blocks first (```...```), then inline code (`...`)
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  // Reset lastIndex in case the pattern has global/sticky flags (defensive)
  mentionPattern.lastIndex = 0;
  return mentionPattern.test(stripped);
}

interface Segment {
  kind: 'text' | 'table';
  lines: string[];
}

/**
 * Split markdown into alternating text and GFM-table segments.
 *
 * Single source of truth for GFM table detection inside this connector;
 * {@link wrapTablesInCodeBlocks} and {@link markdownToSlackPayload} both
 * build on top of it. Tables are only recognized outside fenced code
 * blocks and require a GFM separator row (`|---|`). Pipe lines without a
 * separator are folded back into the surrounding text segment.
 *
 * CRLF input is normalized — splitting on `\r?\n` so downstream consumers
 * never see trailing `\r` in line buffers.
 */
function segmentMarkdown(md: string): Segment[] {
  const lines = md.split(/\r?\n/);
  const segments: Segment[] = [];
  let textBuf: string[] = [];
  let tableBuf: string[] = [];
  let inCodeBlock = false;

  const flushText = (): void => {
    if (textBuf.length > 0) {
      segments.push({ kind: 'text', lines: textBuf });
      textBuf = [];
    }
  };
  const flushTable = (): void => {
    if (tableBuf.length === 0) return;
    if (TABLE_SEPARATOR_BLOCK_RE.test(tableBuf.join('\n'))) {
      flushText();
      segments.push({ kind: 'table', lines: tableBuf });
    } else {
      // No separator row → not a real GFM table; treat as text.
      textBuf.push(...tableBuf);
    }
    tableBuf = [];
  };

  for (const line of lines) {
    if (FENCE_LINE_RE.test(line)) {
      flushTable();
      inCodeBlock = !inCodeBlock;
      textBuf.push(line);
      continue;
    }
    if (inCodeBlock) {
      textBuf.push(line);
      continue;
    }
    if (PIPE_LINE_RE.test(line)) {
      tableBuf.push(line);
    } else {
      flushTable();
      textBuf.push(line);
    }
  }
  flushTable();
  flushText();

  return segments;
}

/**
 * Wrap GFM tables in code fences so Slack renders them monospace.
 *
 * Re-assembles the output of {@link segmentMarkdown}, surrounding each table
 * segment with triple-backtick fences. Used by {@link markdownToMrkdwn} for
 * the plain-text/notification fallback path and by tests.
 */
export function wrapTablesInCodeBlocks(md: string): string {
  const result: string[] = [];
  for (const seg of segmentMarkdown(md)) {
    if (seg.kind === 'table') {
      result.push('```', ...seg.lines, '```');
    } else {
      result.push(...seg.lines);
    }
  }
  return result.join('\n');
}

/**
 * Convert GitHub-flavored markdown to Slack mrkdwn format.
 *
 * Delegates to `slackify-markdown` which uses `unified`/`remark` with
 * custom Slack handlers. Handles bold, italic, strikethrough, links,
 * headings (→ bold), images (→ links), code blocks (strips lang),
 * lists, blockquotes, tables (→ code blocks), and Slack character escaping.
 *
 * This is the plain-text/notification fallback; for the block-aware payload
 * (which renders tables as native Block Kit `table` blocks when possible),
 * see {@link markdownToSlackPayload}.
 *
 * @see https://github.com/jsarafajr/slackify-markdown
 */
export function markdownToMrkdwn(markdown: string): string {
  return slackifyMarkdown(wrapTablesInCodeBlocks(markdown)).trim();
}

/**
 * Split a single GFM table row body into trimmed cells, honoring escaped
 * pipes (`\|`) which GFM allows as literal pipe characters inside a cell.
 */
function splitCells(rowBody: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < rowBody.length; i++) {
    const ch = rowBody[i];
    if (ch === '\\' && rowBody[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Strip the optional leading/trailing pipes from a GFM table row line and
 * return the cell-body substring.
 */
function rowBody(line: string): string {
  const trimmed = line.trim();
  const noLead = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  return noLead.endsWith('|') ? noLead.slice(0, -1) : noLead;
}

/**
 * Parse a GFM separator row (e.g. `|:---|---:|:---:|`) into the per-column
 * Block Kit alignment values. Returns the same alignment array shape Block
 * Kit's `column_settings` expects.
 */
function parseColumnAlignments(separatorLine: string): ('left' | 'center' | 'right')[] {
  return splitCells(rowBody(separatorLine)).map((cell) => {
    const startsWithColon = cell.startsWith(':');
    const endsWithColon = cell.endsWith(':');
    if (startsWithColon && endsWithColon) return 'center';
    if (endsWithColon) return 'right';
    return 'left';
  });
}

/**
 * Parse the lines of a GFM table into a 2D array of trimmed cell strings.
 *
 * Drops the separator row, honors escaped pipes via {@link splitCells}, and
 * returns each row at the length of the source row — callers normalize widths.
 */
function parseTableRows(tableLines: string[]): string[][] {
  return tableLines
    .filter((line) => !TABLE_SEPARATOR_LINE_RE.test(line))
    .map((line) => splitCells(rowBody(line)));
}

/**
 * Convert parsed GFM rows into a Block Kit `table` block, or null when the
 * table can't be rendered natively (oversized, malformed, empty).
 *
 * Returning null is the signal to the caller to use the monospace fallback.
 */
function tableToBlockKit(tableLines: string[]): TableBlock | null {
  const rows = parseTableRows(tableLines);
  if (rows.length === 0) return null;

  // Width is fixed by the header row; the separator (already filtered out)
  // had previously confirmed the table shape.
  const cols = rows[0].length;
  if (cols === 0 || cols > TABLE_MAX_COLS) return null;
  if (rows.length > TABLE_MAX_ROWS) return null;

  for (const row of rows) {
    for (const cell of row) {
      if (cell.length > TABLE_MAX_CELL_CHARS) return null;
    }
  }

  const normalized: RawTextElement[][] = rows.map((row) => {
    const cells: RawTextElement[] = [];
    for (let i = 0; i < cols; i++) {
      const raw = row[i] ?? '';
      // Slack's RawTextElement requires text of length ≥ 1; substitute a
      // single space for empty cells so the block validates.
      cells.push({ type: 'raw_text', text: raw === '' ? ' ' : raw });
    }
    return cells;
  });

  // Carry GFM alignment markers (`:---`, `---:`, `:---:`) through to Block
  // Kit's `column_settings`. Only emit when at least one column is non-default
  // to keep the JSON minimal for the common case.
  const separatorLine = tableLines.find((l) => TABLE_SEPARATOR_LINE_RE.test(l));
  const alignments = separatorLine ? parseColumnAlignments(separatorLine) : [];
  const block: TableBlock = { type: 'table', rows: normalized };
  if (alignments.some((a) => a !== 'left')) {
    block.column_settings = alignments.slice(0, cols).map((align) => ({ align }));
  }
  return block;
}

/**
 * Slackify a text segment and split it into one or more section blocks,
 * each respecting the 3000-char section text limit. Returns null if any
 * resulting block would exceed Slack's section text cap — though the
 * splitting prevents that by construction; null is reserved for future
 * stricter validation.
 */
function buildTextBlocks(lines: string[]): SectionBlock[] {
  const mrkdwn = slackifyMarkdown(lines.join('\n')).trim();
  if (mrkdwn.length === 0) return [];

  const blocks: SectionBlock[] = [];
  let remaining = mrkdwn;
  while (remaining.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: remaining.slice(0, SECTION_MAX_CHARS) },
    });
    remaining = remaining.slice(SECTION_MAX_CHARS);
  }
  return blocks;
}

/**
 * Wrap the original GFM table lines in a triple-backtick code block.
 *
 * Returns null when the wrapped content would exceed Slack's section text
 * cap — the caller is expected to drop `blocks` entirely and rely on the
 * mrkdwn `text` field (40k char budget) so we never silently truncate.
 */
function monospaceFallbackBlock(tableLines: string[]): SectionBlock | null {
  const wrapped = `\`\`\`\n${tableLines.join('\n')}\n\`\`\``;
  if (wrapped.length > SECTION_MAX_CHARS) return null;
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: wrapped },
  };
}

function buildMarkdownBlock(markdown: string): SlackMarkdownBlock | null {
  const trimmed = markdown.trim();
  if (trimmed.length === 0 || trimmed.length > MARKDOWN_BLOCK_MAX_CHARS) return null;
  return { type: 'markdown', text: markdown };
}

function tableHasRichMarkdown(tableLines: string[]): boolean {
  return tableLines.some((line) =>
    /(\*\*|__|~~|`|\[[^\]]+\]\([^)]*\)|<br\s*\/?\s*>|_[^_|]+_|(^|\|)\s*[-*+]\s+)/i.test(line)
  );
}

function shouldUseNativeMarkdownBlock(markdown: string, segments: Segment[]): boolean {
  if (!buildMarkdownBlock(markdown)) return false;

  const tableSegments = segments.filter((segment) => segment.kind === 'table');
  if (tableSegments.length > 1) return true;
  return tableSegments.some((segment) => tableHasRichMarkdown(segment.lines));
}

/**
 * Build a Slack outbound payload from GitHub-flavored markdown.
 *
 * If the message contains rich or multiple GFM tables and fits Slack's native
 * markdown block budget, emits a `markdown` block so Slack can preserve richer
 * table Markdown. Otherwise emits a `blocks` array that uses
 * Block Kit's native `table` block (Aug 2025) for the first qualifying
 * table and falls back to a monospace code block for any table that
 * exceeds Slack's caps (>{@link TABLE_MAX_ROWS} rows, >{@link TABLE_MAX_COLS}
 * cols, oversized cell) or for additional tables beyond Slack's
 * one-table-per-message limit.
 *
 * Whenever a fallback table or the assembled block array would exceed
 * Slack's limits (section text >{@link SECTION_MAX_CHARS}, total blocks
 * >{@link MAX_BLOCKS_PER_MESSAGE}), the entire `blocks` payload is dropped
 * and the message is sent text-only — `text` has a 40k-char budget and
 * never silently truncates.
 *
 * If there are no tables, returns `{ text }` only — the same mrkdwn string
 * the legacy path produced, so non-table messages are unchanged on the wire.
 */
export function markdownToSlackPayload(markdown: string): OutboundPayload {
  const text = markdownToMrkdwn(markdown);

  const segments = segmentMarkdown(markdown);
  const hasTable = segments.some((s) => s.kind === 'table');
  if (!hasTable) {
    return { text };
  }

  if (shouldUseNativeMarkdownBlock(markdown, segments)) {
    const markdownBlock = buildMarkdownBlock(markdown);
    if (markdownBlock) {
      return { text, blocks: [markdownBlock] };
    }
  }

  const blocks: KnownBlock[] = [];
  let tablesEmitted = 0;
  for (const seg of segments) {
    if (seg.kind === 'text') {
      blocks.push(...buildTextBlocks(seg.lines));
      continue;
    }

    const native = tablesEmitted < MAX_TABLES_PER_MESSAGE ? tableToBlockKit(seg.lines) : null;
    if (native) {
      blocks.push(native);
      tablesEmitted++;
      continue;
    }

    const fallback = monospaceFallbackBlock(seg.lines);
    if (!fallback) {
      // Can't fit this table even as a monospace section — abandon the
      // blocks payload entirely; `text` carries the full message.
      return { text };
    }
    blocks.push(fallback);
  }

  // Slack's chat.postMessage caps total blocks per message; if we'd exceed
  // it, fall back to text-only rather than have Slack reject the payload.
  if (blocks.length === 0 || blocks.length > MAX_BLOCKS_PER_MESSAGE) {
    return { text };
  }

  return { text, blocks };
}

/**
 * Extract a Slack error code from either a non-OK response object
 * (`{ error: 'invalid_blocks' }`) or a thrown `WebAPIPlatformError`
 * (`err.data.error === 'invalid_blocks'`).
 */
function extractSlackErrorCode(resultOrError: unknown): string | undefined {
  if (typeof resultOrError !== 'object' || resultOrError === null) return undefined;
  const candidate = resultOrError as { error?: string; data?: { error?: string } };
  return candidate.data?.error ?? candidate.error;
}

export class SlackConnector implements GatewayConnector {
  readonly channelType: ChannelType = 'slack';

  private web: WebClient;
  private socketMode: SocketModeClient | null = null;
  private config: SlackConfig;
  private botUserId: string | null = null;

  /** Cache: Slack user ID → profile (email + display name, or null if unavailable). */
  private userProfileCache = new Map<
    string,
    { email: string | null; displayName: string | null; expiresAt: number }
  >();
  private inboundEventDedup = new Map<string, number>();

  /** Cache: Slack channel ID → channel name */
  private channelNameCache = new Map<string, { name: string | null; expiresAt: number }>();
  private static USER_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min for successful lookups
  private static USER_CACHE_ERROR_TTL_MS = 60 * 1000; // 1 min for errors (transient recovery)
  private static INBOUND_EVENT_DEDUP_TTL_MS = 5 * 60 * 1000; // Slack may send message + app_mention for one user action

  /**
   * Cache: Slack channel ID → channel type string (channel/group/mpim/im).
   *
   * Populated from:
   * 1. `message` events (which include reliable `channel_type`)
   * 2. `conversations.info` API calls (fallback for `app_mention` events)
   *
   * This avoids relying on the channel ID prefix (C/G/D) which is unreliable —
   * Slack private channels can have a `C` prefix.
   */
  private channelTypeCache = new Map<string, { type: string; expiresAt: number }>();
  private static CHANNEL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
  private static CHANNEL_CACHE_ERROR_TTL_MS = 60 * 1000; // 1 min for API errors

  constructor(config: Record<string, unknown>) {
    this.config = config as unknown as SlackConfig;

    if (!this.config.bot_token) {
      throw new Error('Slack connector requires bot_token in config');
    }

    // Debug: Log token status (not the actual token!)
    // Initialization - tokens validated during startListening

    this.web = new WebClient(this.config.bot_token);
  }

  /**
   * Look up a Slack user's email address by their user ID.
   *
   * Delegates to lookupUserProfile() and returns just the email.
   */
  async lookupUserEmail(slackUserId: string): Promise<string | null> {
    const profile = await this.lookupUserProfile(slackUserId);
    return profile.email;
  }

  /**
   * Look up a Slack user's profile (email + display name) by their user ID.
   *
   * Caches successful results for 15 minutes and errors for 1 minute
   * (so transient failures recover quickly). Evicts expired entries on
   * each call to prevent unbounded cache growth.
   *
   * Returns `{ email: null, displayName: null }` if unavailable.
   */
  async lookupUserProfile(
    slackUserId: string
  ): Promise<{ email: string | null; displayName: string | null }> {
    const now = Date.now();

    // Evict expired entries to prevent unbounded growth
    for (const [key, entry] of this.userProfileCache) {
      if (entry.expiresAt <= now) this.userProfileCache.delete(key);
    }

    const cached = this.userProfileCache.get(slackUserId);
    if (cached && cached.expiresAt > now) {
      return { email: cached.email, displayName: cached.displayName };
    }

    try {
      const result = await this.web.users.info({ user: slackUserId });
      const email = result.user?.profile?.email ?? null;
      const displayName =
        result.user?.profile?.display_name ||
        result.user?.profile?.real_name ||
        result.user?.real_name ||
        null;

      this.userProfileCache.set(slackUserId, {
        email,
        displayName,
        expiresAt: now + SlackConnector.USER_CACHE_TTL_MS,
      });

      if (!email) {
        console.log(
          `[slack] User ${slackUserId} has no email (missing users:read.email scope or restricted account)`
        );
      }

      return { email, displayName };
    } catch (error) {
      console.warn(`[slack] Failed to look up profile for user ${slackUserId}:`, error);
      // Short TTL for errors so transient failures (rate limits, network) recover quickly
      this.userProfileCache.set(slackUserId, {
        email: null,
        displayName: null,
        expiresAt: now + SlackConnector.USER_CACHE_ERROR_TTL_MS,
      });
      return { email: null, displayName: null };
    }
  }

  /**
   * Look up a Slack channel's name by its ID.
   *
   * Often a cache hit because resolveChannelType() populates the
   * channelNameCache when it calls conversations.info.
   * Falls back to its own conversations.info call if not cached.
   */
  async lookupChannelName(channelId: string): Promise<string | null> {
    const now = Date.now();

    // Evict expired entries
    for (const [key, entry] of this.channelNameCache) {
      if (entry.expiresAt <= now) this.channelNameCache.delete(key);
    }

    const cached = this.channelNameCache.get(channelId);
    if (cached && cached.expiresAt > now) {
      return cached.name;
    }

    try {
      const result = await this.web.conversations.info({ channel: channelId });
      const name = result.channel?.name ?? null;

      this.channelNameCache.set(channelId, {
        name,
        expiresAt: now + SlackConnector.CHANNEL_CACHE_TTL_MS,
      });

      return name;
    } catch (error) {
      console.warn(`[slack] Failed to look up channel name for ${channelId}:`, error);
      this.channelNameCache.set(channelId, {
        name: null,
        expiresAt: now + SlackConnector.USER_CACHE_ERROR_TTL_MS,
      });
      return null;
    }
  }

  private async lookupLatestThreadReply(
    event: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    const channel = typeof event.channel === 'string' ? event.channel : undefined;
    const message =
      typeof event.message === 'object' && event.message !== null
        ? (event.message as Record<string, unknown>)
        : undefined;
    const threadTs =
      (typeof message?.thread_ts === 'string' ? message.thread_ts : undefined) ??
      (typeof message?.ts === 'string' ? message.ts : undefined) ??
      (typeof event.thread_ts === 'string' ? event.thread_ts : undefined);
    const replies = Array.isArray(message?.replies)
      ? message.replies.filter((reply): reply is Record<string, unknown> => {
          return typeof reply === 'object' && reply !== null;
        })
      : [];
    const latestReplyTs =
      (typeof message?.latest_reply === 'string' ? message.latest_reply : undefined) ??
      (typeof event.latest_reply === 'string' ? event.latest_reply : undefined) ??
      [...replies]
        .reverse()
        .map((reply) => (typeof reply.ts === 'string' ? reply.ts : undefined))
        .find(Boolean);

    if (!channel || !threadTs || !latestReplyTs) return null;

    try {
      const result = await this.web.conversations.replies({
        channel,
        ts: threadTs,
        oldest: latestReplyTs,
        inclusive: true,
        limit: 1,
      });
      const reply =
        result.messages?.find((candidate) => candidate.ts === latestReplyTs) ??
        result.messages?.[0] ??
        null;
      if (!reply) return null;
      return {
        ...reply,
        channel,
        thread_ts: typeof reply.thread_ts === 'string' ? reply.thread_ts : threadTs,
        team: event.team,
      };
    } catch (error) {
      console.warn('[slack] Failed to fetch latest thread reply for message_replied event:', error);
      return null;
    }
  }

  private shouldProcessInboundEventOnce(
    channel: string | undefined,
    ts: string | undefined
  ): boolean {
    if (!channel || !ts) return true;

    const now = Date.now();
    for (const [key, expiresAt] of this.inboundEventDedup) {
      if (expiresAt <= now) this.inboundEventDedup.delete(key);
    }

    const key = `${channel}:${ts}`;
    if (this.inboundEventDedup.has(key)) return false;
    this.inboundEventDedup.set(key, now + SlackConnector.INBOUND_EVENT_DEDUP_TTL_MS);
    return true;
  }

  /**
   * Cache a known channel type from a trusted source (e.g. `message` event with explicit `channel_type`).
   */
  private cacheChannelType(channelId: string, type: string): void {
    this.channelTypeCache.set(channelId, {
      type,
      expiresAt: Date.now() + SlackConnector.CHANNEL_CACHE_TTL_MS,
    });
  }

  /**
   * Resolve the Slack channel type for a given channel ID.
   *
   * Resolution order:
   * 1. Explicit `channel_type` from the event (trusted, used by `message` events)
   * 2. In-memory cache (populated from prior `message` events or API calls)
   * 3. `conversations.info` API call (cached on success)
   * 4. Channel ID prefix inference (last resort, unreliable for private channels)
   */
  private async resolveChannelType(
    channelId: string,
    eventChannelType: string | undefined
  ): Promise<string | undefined> {
    // 1. Explicit channel_type from event — always trust it and cache for later
    if (eventChannelType) {
      this.cacheChannelType(channelId, eventChannelType);
      return eventChannelType;
    }

    // 2. Check cache (populated from message events or prior API calls)
    const now = Date.now();

    // Evict expired entries to prevent unbounded growth
    for (const [key, entry] of this.channelTypeCache) {
      if (entry.expiresAt <= now) this.channelTypeCache.delete(key);
    }

    const cached = this.channelTypeCache.get(channelId);
    if (cached) {
      return cached.type;
    }

    // 3. Call conversations.info API
    try {
      const result = await this.web.conversations.info({ channel: channelId });
      if (result.ok && result.channel) {
        const ch = result.channel;
        let resolvedType: string;
        if (ch.is_im) {
          resolvedType = 'im';
        } else if (ch.is_mpim) {
          resolvedType = 'mpim';
        } else if (ch.is_private || ch.is_group) {
          resolvedType = 'group';
        } else {
          resolvedType = 'channel';
        }
        this.cacheChannelType(channelId, resolvedType);

        // Also cache channel name to avoid a second conversations.info call
        // from lookupChannelName() later in the same message path.
        if (ch.name) {
          this.channelNameCache.set(channelId, {
            name: ch.name,
            expiresAt: now + SlackConnector.CHANNEL_CACHE_TTL_MS,
          });
        }

        return resolvedType;
      }
    } catch (error) {
      console.warn(`[slack] conversations.info failed for ${channelId}:`, error);
      // Cache the error briefly so we don't hammer the API
      // Fall through to prefix inference
    }

    // 4. Last resort: prefix inference for unambiguous prefixes only.
    // IMPORTANT: C-prefix is NOT used — private channels can have C-prefix,
    // and misclassifying them as public would recreate the original bug (#826).
    // G → group and D → DM are reliable inferences.
    const prefix = channelId.charAt(0);
    let inferredType: string | undefined;
    if (prefix === 'G') {
      inferredType = 'group';
    } else if (prefix === 'D') {
      inferredType = 'im';
    }
    if (inferredType) {
      console.warn(`[slack] Using prefix inference for channel ${channelId} → ${inferredType}`);
      // Short TTL for prefix-inferred types
      this.channelTypeCache.set(channelId, {
        type: inferredType,
        expiresAt: now + SlackConnector.CHANNEL_CACHE_ERROR_TTL_MS,
      });
    } else {
      console.warn(
        `[slack] Cannot determine channel type for ${channelId} (API failed, prefix ambiguous)`
      );
    }
    return inferredType;
  }

  /**
   * Send a message to a Slack thread.
   *
   * If `blocks` is provided (produced by {@link formatMessage}), it is sent as
   * the rich payload and `text` becomes the notification/fallback string. If
   * Slack rejects the blocks payload with a known block-validation error
   * (e.g. `invalid_blocks`), the call retries once as text-only so a
   * structural quirk in the generated blocks never drops the agent's
   * response on the floor.
   */
  async sendMessage(req: {
    threadId: string;
    text: string;
    blocks?: unknown[];
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const { channel, thread_ts } = parseThreadId(req.threadId);
    const blocks = req.blocks && req.blocks.length > 0 ? (req.blocks as KnownBlock[]) : undefined;
    const updateTs =
      typeof req.metadata?.slack_update_ts === 'string' ? req.metadata.slack_update_ts : undefined;

    const send = (withBlocks: boolean) => {
      const base = {
        channel,
        text: req.text,
        ...(withBlocks && blocks ? { blocks } : {}),
        unfurl_links: false,
        unfurl_media: false,
      };

      if (updateTs) {
        return this.web.chat.update({
          ...base,
          ts: updateTs,
        });
      }

      return this.web.chat.postMessage({
        ...base,
        thread_ts,
      });
    };

    let result: Awaited<ReturnType<typeof send>>;
    try {
      result = await send(true);
    } catch (err) {
      const code = extractSlackErrorCode(err);
      if (blocks && code && BLOCK_PAYLOAD_ERRORS.has(code)) {
        console.warn(`[slack] Block payload rejected (${code}); retrying as text-only`);
        result = await send(false);
      } else {
        throw err;
      }
    }

    if (!result.ok || !result.ts) {
      const code = extractSlackErrorCode(result);
      if (blocks && code && BLOCK_PAYLOAD_ERRORS.has(code)) {
        console.warn(`[slack] Block payload rejected (${code}); retrying as text-only`);
        const retry = await send(false);
        if (!retry.ok || !retry.ts) {
          throw new Error(`Slack API error: ${retry.error ?? 'unknown error'}`);
        }
        return retry.ts;
      }
      console.error(`[slack] Message send failed: ${result.error}`);
      throw new Error(`Slack API error: ${result.error ?? 'unknown error'}`);
    }

    return result.ts;
  }

  /**
   * Send directly to a Slack channel or thread. Used for proactive outbound
   * emits where no gateway thread_session_map exists yet.
   */
  async sendSlackMessage(req: {
    channel: string;
    text: string;
    blocks?: unknown[];
    thread_ts?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ ts: string; channel: string; thread_ts: string; permalink?: string | null }> {
    const blocks = req.blocks && req.blocks.length > 0 ? (req.blocks as KnownBlock[]) : undefined;
    const send = (withBlocks: boolean) =>
      this.web.chat.postMessage({
        channel: req.channel,
        text: req.text,
        ...(withBlocks && blocks ? { blocks } : {}),
        ...(req.thread_ts ? { thread_ts: req.thread_ts } : {}),
        unfurl_links: false,
        unfurl_media: false,
      });

    let result: Awaited<ReturnType<typeof send>>;
    try {
      result = await send(true);
    } catch (err) {
      const code = extractSlackErrorCode(err);
      if (blocks && code && BLOCK_PAYLOAD_ERRORS.has(code)) {
        console.warn(`[slack] Block payload rejected (${code}); retrying direct send as text-only`);
        result = await send(false);
      } else {
        throw err;
      }
    }

    if (!result.ok || !result.ts) {
      const code = extractSlackErrorCode(result);
      if (blocks && code && BLOCK_PAYLOAD_ERRORS.has(code)) {
        const retry = await send(false);
        if (!retry.ok || !retry.ts) {
          throw new Error(`Slack API error: ${retry.error ?? 'unknown error'}`);
        }
        result = retry;
      } else {
        throw new Error(`Slack API error: ${result.error ?? 'unknown error'}`);
      }
    }

    const sentTs = result.ts;
    if (!sentTs) {
      throw new Error('Slack API error: missing message timestamp');
    }
    let permalink: string | null = null;
    try {
      const link = await this.web.chat.getPermalink({ channel: req.channel, message_ts: sentTs });
      permalink = link.ok ? (link.permalink ?? null) : null;
    } catch {
      permalink = null;
    }

    return {
      ts: sentTs,
      channel: req.channel,
      thread_ts: req.thread_ts ?? sentTs,
      permalink,
    };
  }

  /** Resolve a Slack channel by its human name (with or without #). */
  async resolveChannelByName(name: string): Promise<{ channel: string; name: string }> {
    const normalized = name.replace(/^#/, '').trim().toLowerCase();
    if (!normalized) throw new Error('Slack channel name is required');

    let cursor: string | undefined;
    do {
      const result = await this.web.conversations.list({
        types: 'public_channel,private_channel',
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });

      if (!result.ok) {
        throw new Error(`Slack API error: ${result.error ?? 'unknown error'}`);
      }

      const channels = (result.channels ?? []) as Array<{
        id?: string;
        name?: string;
        name_normalized?: string;
        is_archived?: boolean;
      }>;
      const match = channels.find((channel) => {
        if (channel.is_archived) return false;
        return (channel.name_normalized ?? channel.name ?? '').toLowerCase() === normalized;
      });
      if (match?.id) {
        return { channel: match.id, name: match.name ?? normalized };
      }

      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    throw new Error(`Slack channel not found: #${normalized}`);
  }

  /** Resolve a Slack user email to a DM channel with that user. */
  async openDmByEmail(email: string): Promise<{ channel: string; user_id: string }> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) throw new Error('Slack user email is required');

    const userResult = await this.web.users.lookupByEmail({ email: normalized });
    if (!userResult.ok || !userResult.user?.id) {
      throw new Error(`Slack user lookup failed: ${userResult.error ?? 'user_not_found'}`);
    }

    const dmResult = await this.web.conversations.open({ users: userResult.user.id });
    if (!dmResult.ok || !dmResult.channel?.id) {
      throw new Error(`Slack DM open failed: ${dmResult.error ?? 'unknown error'}`);
    }

    return { channel: dmResult.channel.id, user_id: userResult.user.id };
  }

  async startStream(req: {
    threadId: string;
    text?: string;
    recipientUserId?: string;
    recipientTeamId?: string;
  }): Promise<string> {
    const { channel, thread_ts } = parseThreadId(req.threadId);
    const chat = this.web.chat as unknown as {
      startStream: (
        args: Record<string, unknown>
      ) => Promise<{ ok?: boolean; ts?: string; error?: string }>;
    };
    const result = await chat.startStream({
      channel,
      thread_ts,
      markdown_text: req.text?.trim() ? req.text : ' ',
      ...(req.recipientUserId ? { recipient_user_id: req.recipientUserId } : {}),
      ...(req.recipientTeamId ? { recipient_team_id: req.recipientTeamId } : {}),
    });
    if (!result.ok || !result.ts) {
      throw new Error(`Slack stream start error: ${result.error ?? 'unknown error'}`);
    }
    return result.ts;
  }

  async appendStream(req: { threadId: string; ts: string; text: string }): Promise<void> {
    const { channel } = parseThreadId(req.threadId);
    const chat = this.web.chat as unknown as {
      appendStream: (args: Record<string, unknown>) => Promise<{ ok?: boolean; error?: string }>;
    };
    const result = await chat.appendStream({
      channel,
      ts: req.ts,
      markdown_text: req.text,
    });
    if (!result.ok) {
      throw new Error(`Slack stream append error: ${result.error ?? 'unknown error'}`);
    }
  }

  async stopStream(req: { threadId: string; ts: string; text?: string }): Promise<void> {
    const { channel } = parseThreadId(req.threadId);
    const chat = this.web.chat as unknown as {
      stopStream: (args: Record<string, unknown>) => Promise<{ ok?: boolean; error?: string }>;
    };
    const result = await chat.stopStream({
      channel,
      ts: req.ts,
      ...(req.text ? { markdown_text: req.text } : {}),
    });
    if (!result.ok) {
      throw new Error(`Slack stream stop error: ${result.error ?? 'unknown error'}`);
    }
  }

  async deleteMessage(req: { threadId: string; messageId: string }): Promise<void> {
    const { channel } = parseThreadId(req.threadId);
    const result = await this.web.chat.delete({
      channel,
      ts: req.messageId,
    });
    if (!result.ok) {
      throw new Error(`Slack delete error: ${result.error ?? 'unknown error'}`);
    }
  }

  async setThreadStatus(req: {
    threadId: string;
    status: string;
    loadingMessages?: string[];
    iconEmoji?: string;
  }): Promise<void> {
    const { channel, thread_ts } = parseThreadId(req.threadId);
    const web = this.web as unknown as {
      assistant?: {
        threads?: {
          setStatus?: (args: Record<string, unknown>) => Promise<{ ok?: boolean; error?: string }>;
        };
      };
      apiCall?: (
        method: string,
        args: Record<string, unknown>
      ) => Promise<{ ok?: boolean; error?: string }>;
    };
    const args = {
      channel_id: channel,
      thread_ts,
      status: req.status,
      ...(req.loadingMessages?.length ? { loading_messages: req.loadingMessages } : {}),
      ...(req.iconEmoji ? { icon_emoji: req.iconEmoji } : {}),
    };
    const result = web.assistant?.threads?.setStatus
      ? await web.assistant.threads.setStatus(args)
      : await web.apiCall?.('assistant.threads.setStatus', args);
    if (!result?.ok) {
      throw new Error(`Slack assistant status error: ${result?.error ?? 'unknown error'}`);
    }
  }

  /**
   * Start listening for inbound messages via Socket Mode
   *
   * Requires app_token in config. Filters messages based on config:
   * - Direct messages (always enabled)
   * - Public channels (if enable_channels = true)
   * - Private channels (if enable_groups = true)
   * - Group DMs (if enable_mpim = true)
   * - Mention requirement (if require_mention = true)
   * - Channel whitelist (if allowed_channel_ids is set)
   */
  async startListening(callback: (msg: InboundMessage) => void): Promise<void> {
    if (!this.config.app_token) {
      console.error('[slack] ERROR: app_token is missing from config');
      throw new Error('Slack Socket Mode requires app_token in config');
    }

    this.socketMode = new SocketModeClient({
      appToken: this.config.app_token,
    });

    // Fetch bot user ID for mention detection
    let botMentionPattern: RegExp | null = null;
    let botMentionReplacePattern: RegExp | null = null;
    try {
      const authTest = await this.web.auth.test();
      this.botUserId = authTest.user_id as string;
      // Precompile regex patterns for performance
      botMentionPattern = new RegExp(`<@${this.botUserId}>`);
      botMentionReplacePattern = new RegExp(`<@${this.botUserId}>\\s*`, 'g');
    } catch (error) {
      console.error('[slack] Failed to fetch bot user ID:', error);
      console.error('[slack] This usually means the bot_token is invalid or expired');
      console.warn('[slack] Mention detection will be disabled');
    }

    // Read config options (with defaults matching UI)
    const enableChannels = this.config.enable_channels ?? false;
    const enableGroups = this.config.enable_groups ?? false;
    const enableMpim = this.config.enable_mpim ?? false;
    const requireMention = this.config.require_mention ?? true;
    // Default to true: once a user @mentions the bot to start a thread,
    // they can continue the conversation without re-tagging. The gateway
    // service's mapping verification prevents abuse in unmapped threads.
    const allowThreadRepliesWithoutMention =
      this.config.allow_thread_replies_without_mention ?? true;

    // Normalize allowed_channel_ids to string[] (handle malformed config)
    let allowedChannelIds: string[] | undefined;
    if (this.config.allowed_channel_ids) {
      if (Array.isArray(this.config.allowed_channel_ids)) {
        allowedChannelIds = this.config.allowed_channel_ids.filter(
          (id): id is string => typeof id === 'string'
        );
      } else if (typeof this.config.allowed_channel_ids === 'string') {
        // Handle case where config was persisted as string instead of array
        allowedChannelIds = [this.config.allowed_channel_ids];
      } else {
        console.warn(
          '[slack] Invalid allowed_channel_ids config (not array or string). Ignoring whitelist.'
        );
        allowedChannelIds = undefined;
      }
    }

    // Handle incoming Slack events
    this.socketMode.on('slack_event', async ({ type, body, ack }) => {
      // Event received - process based on type

      // Handle both 'message' events (DMs, threads) and 'app_mention' events (channel mentions)
      if (type !== 'events_api') {
        await ack();
        return;
      }

      const eventType = body?.event?.type;
      if (eventType !== 'message' && eventType !== 'app_mention') {
        await ack();
        return;
      }

      await ack();
      let event = body.event;
      const slackTeamId =
        typeof event.team === 'string'
          ? event.team
          : typeof body.team_id === 'string'
            ? body.team_id
            : Array.isArray(body.authorizations) &&
                typeof body.authorizations[0]?.team_id === 'string'
              ? body.authorizations[0].team_id
              : undefined;
      console.log(
        `[slack] Processing ${eventType} event - channel: ${event.channel}, channel_type: ${event.channel_type}`
      );

      // Skip bot messages to avoid loops
      if (event.bot_id || event.subtype === 'bot_message') {
        return;
      }

      // Skip message edits, deletes, and other subtypes — only handle new messages
      // Note: app_mention events don't have subtypes
      if (eventType === 'message' && event.subtype) {
        if (event.subtype === 'message_replied') {
          const replyEvent = await this.lookupLatestThreadReply(event);
          if (!replyEvent) {
            console.log(
              `[slack] Skipping message_replied event without fetchable latest reply channel=${event.channel ?? '(none)'} ts=${event.ts ?? '(none)'}`
            );
            return;
          }
          event = {
            ...replyEvent,
            type: 'message',
            channel_type: event.channel_type,
          };
          console.log(
            `[slack] Resolved message_replied event to latest reply thread_ts=${event.thread_ts ?? '(none)'} ts=${event.ts ?? '(none)'}`
          );
        } else {
          console.debug(
            `[slack] Skipping message subtype=${event.subtype} user=${event.user ?? '(none)'} thread_ts=${event.thread_ts ?? '(none)'} ts=${event.ts ?? '(none)'}`
          );
          return;
        }
      }

      // Skip bot replies resolved from message_replied events to avoid loops.
      if (event.bot_id || event.subtype === 'bot_message') {
        console.debug(
          `[slack] Skipping resolved bot message subtype=${event.subtype ?? '(none)'} thread_ts=${event.thread_ts ?? '(none)'} ts=${event.ts ?? '(none)'}`
        );
        return;
      }

      // Resolve channel type early — needed for both dedup and filtering.
      // Uses cache (populated from prior message events) + conversations.info fallback.
      // This replaces the unreliable channel ID prefix inference that misclassified
      // private channels with C-prefix as public channels.
      const channelType = event.channel
        ? await this.resolveChannelType(event.channel, event.channel_type)
        : undefined;

      // IMPORTANT: Prevent duplicate processing
      // When a bot is mentioned, Slack sends BOTH 'app_mention' and 'message' events.
      // This happens for top-level messages AND thread replies.
      //
      // Strategy:
      // - Process whichever event arrives first for an active mention (`message`
      //   or `app_mention`) and dedupe by channel+ts. Relying only on
      //   `app_mention` makes Socket Mode multi-connection/lost-event behavior
      //   look like missed prompts.
      // - Use `message` for DMs, non-mention messages, and code-block-only mentions.
      // - Skip `app_mention` events where the mention is only inside code blocks
      //   (those are not "real" mentions and should be handled as plain messages).
      const isThreadReply = !!event.thread_ts;
      const isChannelMessage = channelType === 'channel' || channelType === 'group';

      // CRITICAL: Prevent duplicates in channels/groups when bot ID unavailable
      // Strategy depends on require_mention setting:
      // - If require_mention=true: prefer app_mention (Slack guarantees mention), skip message
      // - If require_mention=false: prefer message (app_mention won't fire for non-mentions), skip app_mention
      if (isChannelMessage && !botMentionPattern) {
        if (eventType === 'message' && requireMention) {
          // Can't detect mentions - let app_mention handle (which Slack guarantees is a mention)
          return;
        }
        if (eventType === 'app_mention' && !requireMention) {
          // Avoid duplicates - prefer message events when mentions not required
          return;
        }
      }

      if (isChannelMessage && botMentionPattern) {
        const mentionOutsideCodeBlock = hasActiveMention(event.text ?? '', botMentionPattern);

        if (eventType === 'app_mention' && !mentionOutsideCodeBlock) {
          // app_mention fired but the mention is only inside a code block.
          // Skip — the parallel message event will handle it as a non-mention
          // (correctly rejected or routed via thread reply exception).
          return;
        }
      }

      // Channel type filtering based on config
      if (!channelType || channelType === 'im') {
        // Direct messages are always allowed
      } else if (channelType === 'channel' && !enableChannels) {
        return; // Public channels not enabled
      } else if (channelType === 'group' && !enableGroups) {
        return; // Private channels not enabled
      } else if (channelType === 'mpim' && !enableMpim) {
        return; // Group DMs not enabled
      } else if (
        channelType !== 'im' &&
        channelType !== 'channel' &&
        channelType !== 'group' &&
        channelType !== 'mpim'
      ) {
        console.warn(`[slack] Unknown channel_type="${channelType}"`);
        return;
      }

      // Channel whitelist check (applies to all channel types)
      if (allowedChannelIds && allowedChannelIds.length > 0) {
        if (!allowedChannelIds.includes(event.channel)) {
          return; // Not in whitelist
        }
      }

      // Mention requirement handling
      let messageText = event.text ?? '';
      let hasMention = false;
      let allowedViaThreadReplyException = false;

      if (requireMention) {
        if (!botMentionPattern || !botMentionReplacePattern) {
          // app_mention events are inherently mentions (Slack guarantees this)
          // Allow them even without bot ID pattern
          if (eventType === 'app_mention') {
            // Mention is implied by event type - allow without pattern validation
            // We can't strip the mention without the pattern, but that's acceptable
            // (messageText stays as-is since we don't have botMentionReplacePattern)
            hasMention = true;
          } else {
            // SECURITY: Fail closed - if we can't verify mentions on message events, reject
            console.warn(
              '[slack] Cannot enforce mention requirement (bot user ID not available). Rejecting message event.'
            );
            return;
          }
        } else {
          // Bot ID available - perform normal mention validation.
          // Only count mentions outside code blocks as active mentions.
          // Code-block mentions (e.g. `@bot`) are not "real" mentions and
          // should not trigger a response.
          hasMention = hasActiveMention(messageText, botMentionPattern);

          if (!hasMention) {
            // Check if this is a thread reply that's allowed without mention
            if (isThreadReply && allowThreadRepliesWithoutMention) {
              // Thread reply without mention - allow for conversation flow
              // SECURITY: Gateway service verifies a mapping exists before creating sessions.
              // Unmapped threads (where bot was never mentioned) will be rejected.
              // Set allow_thread_replies_without_mention: true only if you want to allow
              // continuing conversations in existing threads without requiring @mentions.
              allowedViaThreadReplyException = true;
            } else {
              // Reject: top-level message or thread reply not allowed without mention
              return;
            }
          }

          // Strip mention if present
          if (hasMention) {
            messageText = messageText.replace(botMentionReplacePattern, '').trim();
          }
        }
      }

      if (!this.shouldProcessInboundEventOnce(event.channel, event.ts)) {
        console.log(
          `[slack] Skipping duplicate inbound event type=${eventType} channel=${event.channel} ts=${event.ts}`
        );
        return;
      }

      const threadId = event.thread_ts
        ? `${event.channel}-${event.thread_ts}`
        : `${event.channel}-${event.ts}`;

      console.log(
        `[slack] Accepted inbound message: thread=${threadId} channel_type=${channelType} user=${event.user}`
      );

      // Resolve Slack user profile (email + display name)
      let slackUserEmail: string | null = null;
      let slackUserDisplayName: string | null = null;
      if (event.user) {
        // Always look up profile for context injection; email is needed
        // for user alignment but display name is useful regardless.
        const profile = await this.lookupUserProfile(event.user);
        slackUserEmail = profile.email;
        slackUserDisplayName = profile.displayName;
      }

      // Resolve channel name for context injection
      let slackChannelName: string | null = null;
      if (event.channel && channelType !== 'im') {
        slackChannelName = await this.lookupChannelName(event.channel);
      }

      callback({
        threadId,
        text: messageText,
        userId: event.user ?? 'unknown',
        timestamp: event.ts ?? new Date().toISOString(),
        metadata: {
          channel: event.channel,
          channel_type: channelType,
          ...(event.user ? { slack_user_id: event.user } : {}),
          ...(slackTeamId ? { slack_team_id: slackTeamId } : {}),
          requires_mapping_verification: allowedViaThreadReplyException,
          ...(slackUserEmail ? { slack_user_email: slackUserEmail } : {}),
          ...(slackUserDisplayName ? { slack_user_name: slackUserDisplayName } : {}),
          ...(slackChannelName ? { slack_channel_name: slackChannelName } : {}),
          // Signal that user alignment was attempted so the gateway can
          // reject (instead of silently falling back to channel owner)
          // when the email couldn't be resolved.
          ...(this.config.align_slack_users ? { align_slack_users: true } : {}),
        },
      });
    });

    await this.socketMode.start();
  }

  /**
   * Stop Socket Mode listener
   */
  async stopListening(): Promise<void> {
    if (this.socketMode) {
      await this.socketMode.disconnect();
      this.socketMode = null;
    }
  }

  /**
   * Convert markdown to a Slack outbound payload.
   *
   * Returns `{ text, blocks? }`. `text` is the mrkdwn fallback used for
   * notifications and clients that don't render Block Kit; `blocks` is set
   * when the message contains tables that can benefit from Slack's native
   * markdown/table blocks.
   */
  formatMessage(markdown: string): OutboundPayload {
    return markdownToSlackPayload(markdown);
  }
}
