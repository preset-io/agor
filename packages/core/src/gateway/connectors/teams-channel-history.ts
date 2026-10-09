/** Agent reads of standard-channel threads and posts over Graph; nothing here is stored or logged. */

import {
  TEAMS_CHANNEL_ID_PATTERN,
  type TeamsChannelHistoryMessage,
  type TeamsChannelPost,
  type TeamsChannelPostsResult,
  type TeamsGatewayConfig,
  type TeamsThreadHistoryResult,
} from '../../types/gateway';
import {
  authorizedJson,
  GRAPH_ORIGIN,
  GRAPH_SCOPE,
  graphNextLink,
  type ParsedGraphChatMessage,
  parseGraphChatMessage,
  resolveTeamGroupId,
  TEAMS_MESSAGE_ID,
  type TeamsGraphCacheScope,
  TeamsGraphHttpError,
  type TeamsGraphRetryPolicy,
  type TeamsGraphRuntime,
  type TeamsTeamReference,
} from './teams-graph';

export const TEAMS_THREAD_HISTORY_DEFAULT_LIMIT = 50;
export const TEAMS_CHANNEL_POSTS_DEFAULT_LIMIT = 20;
/** Graph pages hold at most 50 messages and the cursor is a page token, so one call reads one page. */
export const TEAMS_HISTORY_MAX_LIMIT = 50;
const TEAMS_HISTORY_DEADLINE_MS = 20_000;
const TEAMS_HISTORY_MAX_TEXT_BYTES = 64 * 1024;
const TEAMS_POST_PREVIEW_CHARS = 300;
const TEAMS_CURSOR_MAX_LENGTH = 4_096;
// Graph allows 1 request per second per channel, so a read may wait out a short Retry-After.
const TEAMS_TOOL_RETRY: TeamsGraphRetryPolicy = { maxRetries: 3, maxDelayMs: 5_000 };

export type TeamsChannelHistoryErrorCode =
  | 'invalid_request'
  | 'rsc_not_granted'
  | 'rate_limited'
  | 'timeout'
  | 'provider';

/** Sanitized read failure; never carries tokens, URLs, or provider prose. */
export class TeamsChannelHistoryError extends Error {
  constructor(
    readonly code: TeamsChannelHistoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TeamsChannelHistoryError';
  }
}

interface TeamsReadBase {
  team: TeamsTeamReference;
  channelId: string;
  /** Opaque page token from a previous result's `next_cursor`. */
  cursor?: string;
  limit?: number;
  cacheScope?: TeamsGraphCacheScope | null;
  signal?: AbortSignal;
}

export interface TeamsThreadHistoryRequest extends TeamsReadBase {
  rootMessageId: string;
  includeBotMessages?: boolean;
}

export type TeamsChannelPostsRequest = TeamsReadBase;

function validLimit(limit: number | undefined, fallback: number): number {
  const value = limit ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > TEAMS_HISTORY_MAX_LIMIT) {
    throw new TeamsChannelHistoryError('invalid_request', 'Teams history limit is out of range');
  }
  return value;
}

function validCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  if (!cursor || cursor.length > TEAMS_CURSOR_MAX_LENGTH) {
    throw new TeamsChannelHistoryError('invalid_request', 'Teams history cursor is invalid');
  }
  return cursor;
}

// The agent only ever sees the page token; the URL is rebuilt from validated IDs.
function nextPage(link: unknown): { has_more: boolean; next_cursor: string | null } {
  const nextLink = graphNextLink(link);
  return {
    has_more: nextLink !== null,
    next_cursor: nextLink ? new URL(nextLink).searchParams.get('$skiptoken') : null,
  };
}

function pageUrl(base: string, limit: number, cursor: string | undefined): string {
  const params = new URLSearchParams({ $top: String(limit) });
  if (cursor) params.set('$skiptoken', cursor);
  return `${base}?${params.toString()}`;
}

function sanitized(error: unknown, signal: AbortSignal): TeamsChannelHistoryError {
  if (error instanceof TeamsChannelHistoryError) return error;
  if (signal.aborted)
    return new TeamsChannelHistoryError('timeout', 'Teams history read timed out');
  if (error instanceof TeamsGraphHttpError) {
    if (error.status === 429) {
      return new TeamsChannelHistoryError(
        'rate_limited',
        'Teams history rate limit budget exhausted'
      );
    }
    return new TeamsChannelHistoryError(
      'provider',
      `Teams history request failed: HTTP ${error.status}`
    );
  }
  return new TeamsChannelHistoryError('provider', 'Teams history request failed');
}

function rscNotGranted(): TeamsChannelHistoryError {
  return new TeamsChannelHistoryError(
    'rsc_not_granted',
    "A team owner must grant the app's resource-specific consent (ChannelMessage.Read.Group) when installing it in this team."
  );
}

// One deadline and one retry policy cover the group-ID lookup and every Graph page.
async function withGraphRead<T>(
  config: TeamsGatewayConfig,
  req: TeamsReadBase,
  fetchImpl: typeof fetch,
  read: (runtime: TeamsGraphRuntime, channelBase: string) => Promise<T>
): Promise<T> {
  if (!TEAMS_CHANNEL_ID_PATTERN.test(req.channelId)) {
    throw new TeamsChannelHistoryError('invalid_request', 'Teams channel ID is invalid');
  }
  const deadline = AbortSignal.timeout(TEAMS_HISTORY_DEADLINE_MS);
  const signal = req.signal ? AbortSignal.any([req.signal, deadline]) : deadline;
  const runtime: TeamsGraphRuntime = {
    fetchImpl,
    config,
    cacheScope: req.cacheScope,
    signal,
    retry: TEAMS_TOOL_RETRY,
  };
  let groupId: string | undefined;
  try {
    groupId = await resolveTeamGroupId(runtime, req.team);
    const channelBase = `${GRAPH_ORIGIN}/v1.0/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(req.channelId)}/messages`;
    return await read(runtime, channelBase);
  } catch (error) {
    // Not cached team-wide: a 403 here may be specific to this channel, and catch-up shares that cache.
    if (groupId && error instanceof TeamsGraphHttpError && error.status === 403) {
      throw rscNotGranted();
    }
    throw sanitized(error, signal);
  }
}

const utf8 = new TextEncoder();

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = utf8.encode(value);
  if (bytes.length <= maxBytes) return value;
  return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/�+$/, '');
}

function toHistoryMessage(message: ParsedGraphChatMessage): TeamsChannelHistoryMessage {
  return {
    id: message.id,
    iso_time: message.createdAt,
    actor_label: message.actorLabel,
    ...(message.authorAadId ? { author_aad_id: message.authorAadId } : {}),
    text: message.text,
    is_bot: message.isBot,
    is_system: message.isSystem,
    is_mention: message.isMention,
    ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
  };
}

/** Cut text to one shared budget, so a page is never dropped or split and the cursor stays exact. */
function applyByteBudget(messages: TeamsChannelHistoryMessage[]): void {
  let remaining = TEAMS_HISTORY_MAX_TEXT_BYTES;
  for (const message of messages) {
    const size = utf8.encode(message.text).length;
    if (size > remaining) {
      message.text = truncateUtf8(message.text, remaining);
      message.text_truncated = true;
    }
    remaining = Math.max(0, remaining - utf8.encode(message.text).length);
  }
}

/** One page of a standard-channel reply chain; the first page (no cursor) also carries the root post. */
export async function fetchTeamsThreadHistory(
  config: TeamsGatewayConfig,
  req: TeamsThreadHistoryRequest,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<TeamsThreadHistoryResult> {
  const limit = validLimit(req.limit, TEAMS_THREAD_HISTORY_DEFAULT_LIMIT);
  const cursor = validCursor(req.cursor);
  if (!TEAMS_MESSAGE_ID.test(req.rootMessageId)) {
    throw new TeamsChannelHistoryError('invalid_request', 'Teams root message ID is invalid');
  }
  return withGraphRead(config, req, options.fetchImpl ?? fetch, async (runtime, channelBase) => {
    const rootUrl = `${channelBase}/${encodeURIComponent(req.rootMessageId)}`;
    const parsed: ParsedGraphChatMessage[] = [];
    if (!cursor) {
      const root = parseGraphChatMessage(
        await authorizedJson(runtime, GRAPH_SCOPE, rootUrl),
        config.app_id
      );
      if (root) parsed.push(root);
    }
    const page = await authorizedJson(
      runtime,
      GRAPH_SCOPE,
      pageUrl(`${rootUrl}/replies`, limit, cursor)
    );
    for (const raw of Array.isArray(page.value) ? page.value : []) {
      const message = parseGraphChatMessage(raw, config.app_id);
      if (message) parsed.push(message);
    }
    const messages = parsed
      .filter(
        (message) =>
          message.id === req.rootMessageId ||
          req.includeBotMessages ||
          (!message.isBot && !message.isSystem)
      )
      .sort((left, right) =>
        BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0
      )
      .map(toHistoryMessage);
    applyByteBudget(messages);
    return {
      channelId: req.channelId,
      rootMessageId: req.rootMessageId,
      messages,
      ...nextPage(page['@odata.nextLink']),
    };
  });
}

/** List one page of a standard channel's top-level posts, without their replies. */
export async function listTeamsChannelPosts(
  config: TeamsGatewayConfig,
  req: TeamsChannelPostsRequest,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<TeamsChannelPostsResult> {
  const limit = validLimit(req.limit, TEAMS_CHANNEL_POSTS_DEFAULT_LIMIT);
  const cursor = validCursor(req.cursor);
  return withGraphRead(config, req, options.fetchImpl ?? fetch, async (runtime, channelBase) => {
    const page = await authorizedJson(runtime, GRAPH_SCOPE, pageUrl(channelBase, limit, cursor));
    const posts: TeamsChannelPost[] = [];
    for (const raw of Array.isArray(page.value) ? page.value : []) {
      const message = parseGraphChatMessage(raw, config.app_id);
      if (!message || message.isSystem) continue;
      posts.push({
        id: message.id,
        created_at: message.createdAt,
        last_modified_at: message.lastModifiedAt,
        actor_label: message.actorLabel,
        ...(message.subject ? { subject: message.subject.slice(0, TEAMS_POST_PREVIEW_CHARS) } : {}),
        text_preview: message.text.slice(0, TEAMS_POST_PREVIEW_CHARS),
        is_bot: message.isBot,
        ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
      });
    }
    return { channelId: req.channelId, posts, ...nextPage(page['@odata.nextLink']) };
  });
}
