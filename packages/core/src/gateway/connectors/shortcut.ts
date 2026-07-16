/**
 * Shortcut Connector
 *
 * Polls the Shortcut API for @agent-mention comments on stories and posts
 * threaded replies back via the Shortcut API. Authenticates with a Shortcut
 * API token (sent in the `Shortcut-Token` header). No SDK dependency — uses
 * `fetch` directly against https://api.app.shortcut.com/api/v3.
 *
 * Discovery is two-stage (the Shortcut search API exposes no `mention:` /
 * `%self%` operator):
 *   1. Coarse filter — search stories whose comments textually mention the
 *      agent's handle, updated since the last poll:
 *        `comment:<mention_name> updated:<cutoff>..*`  (page_size 25)
 *   2. Precise per-comment check — a comment targets the agent IFF
 *      `comment.member_mention_ids` includes the agent's member id, OR
 *      `comment.text` contains `shortcutapp://members/<agent_member_id>`.
 *
 * Config shape (stored encrypted in gateway_channels.config):
 *   {
 *     api_token: string,             // Shortcut API token, encrypted at rest
 *     agent_member_id?: string,      // override mention target; defaults to the token's own member
 *     mention_name?: string,         // handle for the discovery search; auto-resolved from the agent member if omitted
 *     poll_interval_ms?: number,     // default 15000
 *     search_query_extra?: string,   // appended to the discovery query for scoping (e.g. 'team:"Backend"')
 *     require_mention?: boolean,     // default true
 *     align_shortcut_users?: boolean,// map Shortcut member → Agor user
 *     user_map?: Record<string, string>, // Shortcut member id → Agor email
 *   }
 *
 * Thread ID format: "{storyId}|{rootCommentId}"
 *   e.g. "12345|67890"
 *
 * Shortcut threads are one level deep. A reply must set `parent_id` to the
 * THREAD ROOT (`comment.parent_id ?? comment.id`); posting under a comment
 * that is itself a reply lands top-level. The thread root is encoded into the
 * thread id so outbound replies stay in-thread.
 */

import type {
  ChannelType,
  GatewayConnectionTestFailure,
  GatewayConnectionTestResult,
  GatewayEnvVar,
} from '../../types/gateway';
import type { GatewayConnector, InboundMessage } from '../connector';
import { addToRingBuffer, escapeRegex } from './shared';

// ============================================================================
// Config & State Types
// ============================================================================

export interface ShortcutChannelConfig {
  // ── Authentication (encrypted at rest) ──────────────────
  api_token: string;

  // ── Mention target (optional) ───────────────────────────
  /** Override the mention target. Defaults to the API token's own member (resolved via GET /member). */
  agent_member_id?: string;

  // ── Discovery ───────────────────────────────────────────
  /** Handle used in the `comment:<name>` discovery search. Auto-resolved from the agent member's mention_name when omitted. */
  mention_name?: string;
  /** Appended verbatim to the discovery query — use for per-channel scoping (e.g. `team:"Backend"`). */
  search_query_extra?: string;
  poll_interval_ms?: number; // default 15000

  // ── Trigger Behavior ───────────────────────────────────
  require_mention?: boolean; // default true

  // ── User Alignment ─────────────────────────────────────
  align_shortcut_users?: boolean;
  /** Explicit Shortcut member id → Agor email mapping (checked first, before email lookup) */
  user_map?: Record<string, string>;
}

/** Minimal Shortcut API shapes (only the fields this connector reads). */
interface ShortcutComment {
  id: number;
  author_id?: string;
  text?: string;
  member_mention_ids?: string[];
  parent_id?: number | null;
  created_at?: string;
  updated_at?: string;
  deleted?: boolean;
}

interface ShortcutStorySearchSlim {
  id: number;
}

interface ShortcutStorySearchResponse {
  data: ShortcutStorySearchSlim[];
  next?: string | null;
}

interface ShortcutStory {
  id: number;
  name?: string;
  app_url?: string;
  comments?: ShortcutComment[];
}

interface ShortcutMember {
  id: string;
  profile?: {
    email_address?: string | null;
    name?: string | null;
    mention_name?: string | null;
  };
}

/** Poll state for exactly-once processing across the watched workspace. */
interface ShortcutPollState {
  lastPollAt: string; // ISO timestamp — drives the `updated:` watermark
  processedCommentIds: Set<number>; // ring buffer for dedup
}

const SHORTCUT_API_BASE = 'https://api.app.shortcut.com/api/v3';
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_SEARCH_PAGE_SIZE = 25;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a thread ID into its story id and thread-root comment id.
 *
 * Format: "{storyId}|{rootCommentId}"
 * e.g. "12345|67890" → { storyId: 12345, rootCommentId: 67890 }
 */
export function parseThreadId(threadId: string): { storyId: number; rootCommentId: number } {
  const parts = threadId.split('|');
  const storyId = Number(parts[0]);
  const rootCommentId = Number(parts[1]);
  if (parts.length !== 2 || !Number.isFinite(storyId) || !Number.isFinite(rootCommentId)) {
    throw new Error(
      `Invalid Shortcut thread ID format: "${threadId}" (expected "storyId|rootCommentId")`
    );
  }
  return { storyId, rootCommentId };
}

/** Build a thread id from a story id and a triggering comment. */
export function buildThreadId(
  storyId: number,
  comment: { id: number; parent_id?: number | null }
): string {
  const rootCommentId = comment.parent_id ?? comment.id;
  return `${storyId}|${rootCommentId}`;
}

/**
 * A comment targets the agent IFF it lists the agent in member_mention_ids OR
 * embeds a `shortcutapp://members/<agentId>` link in its text. (Not a fuzzy
 * @name string match — those are coarse-filtered by the discovery search.)
 */
export function commentMentionsAgent(comment: ShortcutComment, agentMemberId: string): boolean {
  if (comment.member_mention_ids?.includes(agentMemberId)) return true;
  if (comment.text?.includes(`shortcutapp://members/${agentMemberId}`)) return true;
  return false;
}

/**
 * Strip the agent mention from comment text, returning the cleaned message body.
 * Removes markdown-link mention forms, bare shortcutapp links, and a leading
 * `@<mentionName>` handle.
 */
export function stripAgentMention(
  text: string,
  agentMemberId: string,
  mentionName?: string
): string {
  let out = text;
  // [Display Name](shortcutapp://members/<id>) or [..](shortcut://members/<id>)
  out = out.replace(
    new RegExp(`\\[[^\\]]*\\]\\(shortcut(?:app)?://members/${escapeRegex(agentMemberId)}\\)`, 'g'),
    ''
  );
  // bare shortcutapp://members/<id>
  out = out.replace(
    new RegExp(`shortcut(?:app)?://members/${escapeRegex(agentMemberId)}`, 'g'),
    ''
  );
  // @mentionName handle
  if (mentionName) {
    out = out.replace(new RegExp(`@${escapeRegex(mentionName)}\\b`, 'gi'), '');
  }
  return out.trim();
}

/** ISO timestamp → `YYYY-MM-DD` for the Shortcut `updated:` range operator. */
function toSearchDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The things a Shortcut connection probe fundamentally cannot prove. Surfaced
 * verbatim in {@link GatewayConnectionTestResult.notVerifiable} so a green result is never
 * read as "fully verified".
 */
const SHORTCUT_NOT_VERIFIABLE = [
  'Whether the people who summon the agent can @-mention this member in their Shortcut workspace.',
  "Whether commenters' Shortcut email addresses match Agor accounts — only relevant when user alignment is enabled.",
];

// ============================================================================
// ShortcutConnector
// ============================================================================

export class ShortcutConnector implements GatewayConnector {
  readonly channelType: ChannelType = 'shortcut';

  private config: ShortcutChannelConfig;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private state: ShortcutPollState = {
    lastPollAt: new Date().toISOString(),
    processedCommentIds: new Set(),
  };
  /** Resolved agent mention handle for the discovery search (config override or member lookup). */
  private mentionName: string | null = null;
  /** Resolved agent member id (mention target). Defaults to the API token's own member. */
  private agentMemberId: string | null = null;

  constructor(config: Record<string, unknown>) {
    this.config = config as unknown as ShortcutChannelConfig;

    if (!this.config.api_token) {
      throw new Error('Shortcut connector requires api_token in config');
    }
  }

  // ── HTTP ──────────────────────────────────────────────────

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    // Search pagination returns the next page as an `/api/v3/...` path, while
    // connector calls use paths relative to the API base. Normalize both forms
    // onto the same trusted Shortcut origin instead of duplicating `/api/v3`.
    const relativePath = path.startsWith('/api/v3/') ? path.slice('/api/v3'.length) : path;
    const res = await fetch(`${SHORTCUT_API_BASE}${relativePath}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'Shortcut-Token': this.config.api_token,
        ...(init?.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Shortcut API ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText}${
          body ? ` — ${body.slice(0, 300)}` : ''
        }`
      );
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async getMember(memberId: string): Promise<ShortcutMember | null> {
    try {
      return await this.request<ShortcutMember>(`/members/${memberId}`);
    } catch (err) {
      console.warn(`[shortcut] Failed to fetch member ${memberId}:`, err);
      return null;
    }
  }

  // ── Connection probe ──────────────────────────────────────

  /**
   * Best-effort probe of the configured Shortcut credentials and reachability.
   *
   * `GET /member` validates the api_token and identifies the token owner. The
   * mention target — the configured `agent_member_id` or the token owner — is
   * then resolved via `GET /members/{id}` to surface the agent's `@handle` (the
   * current-member endpoint omits `mention_name`). An explicit `agent_member_id`
   * that Shortcut cannot resolve is a real failure: the per-comment mention
   * check would silently match nothing. Never returns the token.
   */
  async testConnection(): Promise<GatewayConnectionTestResult> {
    const failures: GatewayConnectionTestFailure[] = [];
    const notVerifiable = [...SHORTCUT_NOT_VERIFIABLE];

    // 1. Validate the token: GET /member returns the token owner (or 401s).
    let me: ShortcutMember;
    try {
      me = await this.request<ShortcutMember>('/member');
    } catch (error) {
      failures.push({
        capability: 'api_token',
        reason: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, failures, notVerifiable };
    }

    // 2. Resolve/validate the mention target. Always verify an *explicit*
    //    agent_member_id (a bad one silently matches no comments); for the token
    //    owner, only look it up when we still need its @handle (GET /member omits
    //    mention_name). This mirrors the poll loop's discovery-handle resolution.
    const agentMemberId = this.config.agent_member_id ?? me.id;
    let handle = this.config.mention_name?.trim() || undefined;
    if (this.config.agent_member_id || !handle) {
      try {
        const agent = await this.request<ShortcutMember>(`/members/${agentMemberId}`);
        handle = handle ?? agent.profile?.mention_name ?? undefined;
      } catch (error) {
        if (this.config.agent_member_id) {
          failures.push({
            capability: 'agent_member_id',
            reason: `Could not resolve agent_member_id "${agentMemberId}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }
    }
    if (!handle) {
      notVerifiable.push(
        'The agent @handle used to narrow the mention search could not be resolved — discovery falls back to scanning all recently-updated stories. Set mention_name to make the search precise.'
      );
    }

    return {
      ok: failures.length === 0,
      bot: { userId: agentMemberId, name: handle ? `@${handle}` : agentMemberId },
      failures,
      notVerifiable,
    };
  }

  // ── Listening (poll loop) ─────────────────────────────────

  async startListening(callback: (msg: InboundMessage) => void): Promise<void> {
    console.log('[shortcut] startListening called');

    // Validate the token and resolve the agent's own identity (the token owner).
    // The API token already identifies the agent, so agent_member_id defaults to
    // the token owner — no separate member id needs to be configured.
    let me: ShortcutMember;
    try {
      me = await this.request<ShortcutMember>('/member');
      console.log(`[shortcut] Authenticated (token member ${me.id})`);
    } catch (error) {
      console.error('[shortcut] Failed to validate api_token:', error);
      throw new Error('Shortcut authentication failed — check api_token');
    }

    // Mention target: explicit override, else the token owner.
    this.agentMemberId = this.config.agent_member_id ?? me.id;

    // Resolve the discovery-search handle from the FULL member profile. The
    // current-member endpoint (GET /member) omits profile.mention_name, so we
    // always look the agent member up via GET /members/{id}.
    this.mentionName = this.config.mention_name ?? null;
    if (!this.mentionName) {
      const agent = await this.getMember(this.agentMemberId);
      this.mentionName = agent?.profile?.mention_name ?? null;
    }
    if (!this.mentionName) {
      // No handle resolvable (e.g. an integration member, or a stale member id).
      // Don't fail — fall back to scanning recently-updated stories. The
      // per-comment member_mention_ids check is the authoritative trigger; the
      // handle only narrows the discovery search.
      console.warn(
        '[shortcut] No mention_name resolved — scanning recently-updated stories (set mention_name in config to narrow the search)'
      );
    }
    console.log(
      `[shortcut] Watching for mentions of member ${this.agentMemberId}${
        this.mentionName ? ` (@${this.mentionName})` : ''
      }`
    );

    const intervalMs = this.config.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
    console.log(`[shortcut] Starting poll loop (interval: ${intervalMs}ms)`);

    await this.pollTick(callback);
    this.pollTimer = setInterval(() => {
      void this.pollTick(callback);
    }, intervalMs);
  }

  /** Single poll tick, guarded against overlap. */
  private async pollTick(callback: (msg: InboundMessage) => void): Promise<void> {
    if (this.polling) {
      console.warn('[shortcut] Poll tick skipped (previous tick still running)');
      return;
    }
    this.polling = true;
    try {
      const messages = await this.poll();
      for (const msg of messages) {
        callback(msg);
      }
    } catch (error) {
      console.error('[shortcut] Poll tick error:', error);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Poll for new agent-mention comments since the last watermark.
   * Returns InboundMessages for the gateway.
   */
  private async poll(): Promise<InboundMessage[]> {
    const mentionName = this.mentionName;
    const agentMemberId = this.agentMemberId;
    if (!agentMemberId) return [];

    const requireMention = this.config.require_mention ?? true;
    const messages: InboundMessage[] = [];
    // Snapshot the watermark up front so concurrent edits don't move it.
    const cutoff = this.state.lastPollAt;
    const nextWatermark = new Date().toISOString();

    // ── Stage 1: discover candidate stories ──────────────────
    // With a handle, narrow to comments that mention it; otherwise scan all
    // recently-updated stories and rely on the per-comment mention check.
    const queryParts = [`updated:${toSearchDate(cutoff)}..*`];
    if (mentionName && requireMention) {
      queryParts.unshift(`comment:${mentionName}`);
    }
    if (this.config.search_query_extra?.trim()) {
      queryParts.push(this.config.search_query_extra.trim());
    }
    const params = new URLSearchParams({
      query: queryParts.join(' '),
      page_size: String(DEFAULT_SEARCH_PAGE_SIZE),
    });

    const candidateStoryIds = new Set<number>();
    let searchPath: string | null = `/search/stories?${params}`;
    try {
      while (searchPath) {
        const search: ShortcutStorySearchResponse =
          await this.request<ShortcutStorySearchResponse>(searchPath);
        for (const story of search.data ?? []) candidateStoryIds.add(story.id);
        searchPath = search.next ?? null;
      }
    } catch (error) {
      console.error('[shortcut] Story search failed:', error);
      return messages; // don't advance the watermark on error — retry next tick
    }

    // ── Stage 2: precise per-comment check on each story ─────
    let storyFetchFailed = false;
    for (const storyId of candidateStoryIds) {
      let story: ShortcutStory;
      try {
        story = await this.request<ShortcutStory>(`/stories/${storyId}`);
      } catch (error) {
        console.warn(`[shortcut] Failed to fetch story ${storyId}:`, error);
        storyFetchFailed = true;
        continue;
      }

      for (const comment of story.comments ?? []) {
        if (comment.deleted) continue;
        if (this.state.processedCommentIds.has(comment.id)) continue;
        // Skip the agent's own comments (avoid loops).
        if (comment.author_id === agentMemberId) {
          addToRingBuffer(this.state.processedCommentIds, comment.id);
          continue;
        }
        // Only react to comments created/updated since the watermark.
        const stamp = comment.updated_at ?? comment.created_at;
        if (stamp && stamp < cutoff) continue;
        // Precise mention check.
        if (requireMention && !commentMentionsAgent(comment, agentMemberId)) {
          continue;
        }

        const authorId = comment.author_id ?? 'unknown';
        const rootCommentId = comment.parent_id ?? comment.id;
        const threadId = buildThreadId(story.id, comment);
        const text = stripAgentMention(comment.text ?? '', agentMemberId, mentionName ?? undefined);

        // Post an immediate "👀 on it" ack, threaded under the root. The gateway
        // later edits this comment into the final reply (mirrors GitHub's
        // Processing comment) so the thread stays a single bot comment.
        // Non-fatal — if it fails, the final reply just posts as a new comment.
        let processingCommentId: number | undefined;
        try {
          const ack = await this.request<{ id: number }>(`/stories/${story.id}/comments`, {
            method: 'POST',
            body: JSON.stringify({ text: '👀 on it', parent_id: rootCommentId }),
          });
          processingCommentId = ack.id;
          addToRingBuffer(this.state.processedCommentIds, ack.id);
        } catch (err) {
          console.warn('[shortcut] Failed to post ack comment:', err);
        }

        // Resolve author identity for alignment (only when aligning, like GitHub).
        // The user_map tier-1 lookup happens in the gateway (it reads fresh
        // channel config on every message); the connector only emits the
        // author id + resolved email + align flag.
        let authorEmail: string | undefined;
        let authorName: string | undefined;
        if (this.config.align_shortcut_users && comment.author_id) {
          const member = await this.getMember(comment.author_id);
          authorEmail = member?.profile?.email_address ?? undefined;
          authorName = member?.profile?.name ?? member?.profile?.mention_name ?? undefined;
        }

        messages.push({
          threadId,
          text,
          userId: authorId,
          timestamp: comment.created_at ?? nextWatermark,
          metadata: {
            comment_id: comment.id,
            shortcut_user: authorId,
            shortcut_story_id: story.id,
            shortcut_story_name: story.name,
            shortcut_story_url: story.app_url,
            shortcut_root_comment_id: rootCommentId,
            ...(processingCommentId ? { processing_comment_id: processingCommentId } : {}),
            ...(authorName ? { shortcut_user_name: authorName } : {}),
            ...(this.config.align_shortcut_users ? { align_shortcut_users: true } : {}),
            ...(authorEmail ? { shortcut_user_email: authorEmail } : {}),
          },
        });

        addToRingBuffer(this.state.processedCommentIds, comment.id);
      }
    }

    // Advance only after every candidate story was fetched. Successfully
    // processed comments are deduped, so retaining the old watermark retries a
    // transiently-failed story next tick without duplicating earlier messages.
    if (!storyFetchFailed) this.state.lastPollAt = nextWatermark;
    return messages;
  }

  async stopListening(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling = false;
    console.log('[shortcut] Poll loop stopped');
  }

  // ── Outbound ──────────────────────────────────────────────

  /**
   * Post a threaded reply on a story, OR edit an existing comment when
   * `metadata.edit_comment_id` is set (used to turn the "👀 on it" ack into the
   * final reply — one clean comment). `parent_id` is the THREAD ROOT encoded in
   * the thread id (Shortcut threads one level deep). Media is referenced by URL
   * in the text (raw video URLs render inline; `file_ids` is rejected by the
   * comment API), so no attachment handling is needed here.
   */
  async sendMessage(req: {
    threadId: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const { storyId, rootCommentId } = parseThreadId(req.threadId);

    const editCommentId = req.metadata?.edit_comment_id;
    if (editCommentId != null) {
      await this.request(`/stories/${storyId}/comments/${editCommentId}`, {
        method: 'PUT',
        body: JSON.stringify({ text: req.text }),
      });
      return String(editCommentId);
    }

    const created = await this.request<{ id: number }>(`/stories/${storyId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ text: req.text, parent_id: rootCommentId }),
    });
    return String(created.id);
  }

  /** Shortcut comments support markdown — pass through with no conversion. */
  formatMessage(markdown: string): string {
    return markdown;
  }

  /**
   * Credentials the in-session Shortcut skills read from the environment. The
   * `media-intake` skill fetches ticket attachments with
   * `curl -H "Shortcut-Token: $SHORTCUT_API_TOKEN"`, so a gateway session needs
   * the channel's token without the operator wiring it by hand. Returned as
   * defaults — operator `agentic_config.envVars` still override.
   */
  sessionEnv(): GatewayEnvVar[] {
    return [
      { key: 'SHORTCUT_API_TOKEN', value: this.config.api_token, forceOverride: true },
      { key: 'SHORTCUT_API_BASE', value: SHORTCUT_API_BASE, forceOverride: true },
    ];
  }
}
