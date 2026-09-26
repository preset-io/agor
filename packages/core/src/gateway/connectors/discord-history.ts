import { RateLimitError } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import type {
  DiscordCatchUpConfig,
  DiscordChannelHistoryMessage,
  DiscordChannelHistoryRequest,
  DiscordChannelHistoryResult,
  DiscordGatewayConfig,
} from '../../types/gateway';
import { compareDiscordSnowflakes, isDiscordSnowflake } from '../../types/gateway';
import type {
  GatewayProviderHistoryMessage,
  GatewayProviderHistoryRequest,
  GatewayProviderHistoryResult,
} from '../connector';
import { gatewayFailureCode } from '../provider-error';

/** The only REST surface needed by the Discord history reader. */
export interface DiscordHistoryRestTransport {
  get(route: string): Promise<unknown>;
}

export type DiscordHistoryFailureKind =
  | 'invalid_request'
  | 'malformed_response'
  | 'incomplete_coverage'
  | 'limit_exceeded'
  | 'rate_limit'
  | 'request_timeout'
  | 'provider';

/** Typed, content-free failure for a bounded provider-history attempt. */
export class DiscordHistoryError extends Error {
  readonly name = 'DiscordHistoryError';
  constructor(
    readonly kind: DiscordHistoryFailureKind,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
  }
}

const DISCORD_HISTORY_PAGE_SIZE = 100;
const DISCORD_TEXT_MESSAGE_TYPES = new Set([0, 19]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function configWithDefaults(config: DiscordGatewayConfig): DiscordCatchUpConfig {
  return {
    max_pages: config.catch_up?.max_pages ?? 5,
    max_messages: config.catch_up?.max_messages ?? 200,
    max_prompt_bytes: config.catch_up?.max_prompt_bytes ?? 32 * 1024,
    request_timeout_ms: config.catch_up?.request_timeout_ms ?? 30_000,
    rate_limit_max_retries: config.catch_up?.rate_limit_max_retries ?? 2,
    rate_limit_max_total_delay_ms: config.catch_up?.rate_limit_max_total_delay_ms ?? 10_000,
  };
}

function messageRoute(threadId: string, messageId: string): string {
  return Routes.channelMessage(threadId, messageId);
}

function pageRoute(threadId: string, beforeProviderCursor: string): string {
  const params = new URLSearchParams({
    before: beforeProviderCursor,
    limit: String(DISCORD_HISTORY_PAGE_SIZE),
  });
  return `${Routes.channelMessages(threadId)}?${params.toString()}`;
}

function rateLimitStatus(error: unknown): boolean {
  // A REST client built with rejectOnRateLimit throws RateLimitError (retryAfter in ms, no status).
  if (error instanceof RateLimitError) return true;
  const record = asRecord(error);
  return record?.status === 429 || record?.statusCode === 429 || record?.code === 429;
}

function retryAfterMs(error: unknown): number {
  const record = asRecord(error);
  const candidates: unknown[] = [
    record?.retry_after_ms,
    record?.retryAfterMs,
    record?.retryAfter,
    asRecord(record?.rawError)?.retry_after,
    asRecord(record?.data)?.retry_after,
    asRecord(record?.body)?.retry_after,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      // Discord's JSON retry_after is seconds; the explicit *_ms fields are ms.
      return candidate === record?.retry_after_ms ||
        candidate === record?.retryAfterMs ||
        candidate === record?.retryAfter
        ? Math.ceil(candidate)
        : Math.ceil(candidate * 1000);
    }
  }
  const headers = asRecord(record?.headers);
  const header = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (typeof header === 'string' && Number.isFinite(Number(header))) {
    return Math.max(0, Math.ceil(Number(header) * 1000));
  }
  return 0;
}

function makeError(kind: DiscordHistoryFailureKind, message: string): DiscordHistoryError {
  return new DiscordHistoryError(kind, message);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) throw makeError('request_timeout', 'Discord history request timed out');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(makeError('request_timeout', 'Discord history request timed out')),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One deadline and one cumulative rate-limit budget for every request of an
 * agent channel-history read, including its access checks.
 */
export interface DiscordReadBudget {
  limits: DiscordCatchUpConfig;
  deadline: number;
  retries: number;
  totalDelay: number;
}

export function createDiscordReadBudget(config: DiscordGatewayConfig): DiscordReadBudget {
  const limits = configWithDefaults(config);
  return { limits, deadline: Date.now() + limits.request_timeout_ms, retries: 0, totalDelay: 0 };
}

async function getWithBudget(
  rest: DiscordHistoryRestTransport,
  route: string,
  budget: DiscordReadBudget,
  notFoundAsNull = false
): Promise<unknown> {
  const { limits, deadline } = budget;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw makeError('request_timeout', 'Discord history request timed out');
    try {
      return await withTimeout(rest.get(route), remaining);
    } catch (error) {
      if (!rateLimitStatus(error)) {
        if (error instanceof DiscordHistoryError) throw error;
        const code = gatewayFailureCode(error);
        if (notFoundAsNull && code === 'provider_not_found') return null;
        throw makeError('provider', `Discord history provider request failed: ${code}`);
      }
      const delay = retryAfterMs(error);
      if (
        budget.retries >= limits.rate_limit_max_retries ||
        budget.totalDelay + delay > limits.rate_limit_max_total_delay_ms ||
        Date.now() + delay > deadline
      ) {
        throw new DiscordHistoryError(
          'rate_limit',
          'Discord history rate limit budget exhausted',
          delay
        );
      }
      budget.retries += 1;
      budget.totalDelay += delay;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * GET one Discord resource inside a read budget. A 404 becomes null so access
 * checks can refuse an unknown channel without a provider error.
 */
export async function getDiscordRecordWithinBudget(
  rest: DiscordHistoryRestTransport,
  route: string,
  budget: DiscordReadBudget
): Promise<Record<string, unknown> | null> {
  return asRecord(await getWithBudget(rest, route, budget, true));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface ClassifiedDiscordMessage {
  id: string;
  timestamp: string;
  author: Record<string, unknown> | null;
  text: string;
  isBot: boolean;
  isSystem: boolean;
  isRich: boolean;
  isMention: boolean;
  isForwarded: boolean;
  /** The message whose content and attachments are shown: a forward's snapshot, else the message. */
  body: Record<string, unknown>;
  actorLabel: string;
}

/**
 * Validate one raw Discord message for a known channel and classify it. A
 * plain user text message with empty content and no rich payload means the
 * Message Content capability was not applied, so the read fails closed rather
 * than presenting a silently blank message.
 */
function classifyMessage(
  raw: Record<string, unknown>,
  channelId: string
): ClassifiedDiscordMessage {
  const id = nonEmptyString(raw.id);
  const rawChannelId = nonEmptyString(raw.channel_id);
  const timestamp = nonEmptyString(raw.timestamp);
  const author = asRecord(raw.author);
  if (
    !id ||
    !isDiscordSnowflake(id) ||
    rawChannelId !== channelId ||
    !timestamp ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    throw makeError('malformed_response', 'Discord history message identity was malformed');
  }

  const type = typeof raw.type === 'number' ? raw.type : undefined;
  const isSystem =
    author?.system === true || (type !== undefined && !DISCORD_TEXT_MESSAGE_TYPES.has(type));
  const isBot = author?.bot === true;
  // A forward has empty content of its own; the forwarded message is its first snapshot.
  const snapshot = Array.isArray(raw.message_snapshots)
    ? asRecord(asRecord(raw.message_snapshots[0])?.message)
    : null;
  const body = snapshot ?? raw;
  const hasRichPayload =
    (Array.isArray(body.attachments) && body.attachments.length > 0) ||
    (Array.isArray(body.embeds) && body.embeds.length > 0) ||
    (Array.isArray(body.components) && body.components.length > 0) ||
    (Array.isArray(body.sticker_items) && body.sticker_items.length > 0) ||
    (body.poll !== undefined && body.poll !== null);
  if (
    !isSystem &&
    !isBot &&
    DISCORD_TEXT_MESSAGE_TYPES.has(type ?? -1) &&
    (typeof body.content !== 'string' || body.content.length === 0) &&
    !hasRichPayload
  ) {
    throw makeError(
      'incomplete_coverage',
      'Discord history content was redacted without a supported rich payload'
    );
  }
  const authorId = nonEmptyString(author?.id);
  const mentions = Array.isArray(raw.mentions) ? raw.mentions : [];
  return {
    id,
    timestamp,
    author,
    text: typeof body.content === 'string' ? body.content : '',
    isBot,
    isSystem,
    isRich: !('content' in body) || typeof body.content !== 'string' || hasRichPayload,
    isMention: mentions.length > 0,
    isForwarded: snapshot !== null,
    body,
    actorLabel:
      nonEmptyString(author?.global_name) ??
      nonEmptyString(author?.username) ??
      authorId ??
      (isSystem ? 'Discord system' : 'Discord user'),
  };
}

function normalizeMessage(
  raw: Record<string, unknown>,
  threadId: string,
  triggerProviderCursor: string
): GatewayProviderHistoryMessage {
  const message = classifyMessage(raw, threadId);
  return {
    providerMessageId: message.id,
    timestamp: message.timestamp,
    actorLabel: message.actorLabel,
    text: message.text,
    isBot: message.isBot,
    isSystem: message.isSystem,
    isRich: message.isRich,
    isTrigger: message.id === triggerProviderCursor,
    isMention: message.isMention,
  };
}

function validateBoundary(
  raw: unknown,
  threadId: string,
  throughProviderCursor: string,
  triggerProviderCursor: string
): GatewayProviderHistoryMessage {
  const record = asRecord(raw);
  if (!record) throw makeError('malformed_response', 'Discord history boundary was malformed');
  const normalized = normalizeMessage(record, threadId, triggerProviderCursor);
  if (normalized.providerMessageId !== throughProviderCursor) {
    throw makeError('incomplete_coverage', 'Discord history live boundary was not returned');
  }
  return normalized;
}

/**
 * Fetch one exact `(after, through]` interval from Discord. Discord returns
 * pages newest-first, so every page and page boundary is checked before the
 * result is reversed into chronological order. The live boundary is fetched
 * separately because Discord's `before` query is exclusive.
 */
export async function fetchDiscordProviderHistory(
  rest: DiscordHistoryRestTransport,
  config: DiscordGatewayConfig,
  request: GatewayProviderHistoryRequest
): Promise<GatewayProviderHistoryResult> {
  if (
    !isDiscordSnowflake(request.threadId) ||
    !isDiscordSnowflake(request.throughProviderCursor) ||
    !isDiscordSnowflake(request.triggerProviderCursor) ||
    request.throughProviderCursor !== request.triggerProviderCursor ||
    (request.afterProviderCursor !== undefined && !isDiscordSnowflake(request.afterProviderCursor))
  ) {
    throw makeError('invalid_request', 'Discord history request identity was invalid');
  }
  if (
    request.afterProviderCursor &&
    compareDiscordSnowflakes(request.afterProviderCursor, request.throughProviderCursor) > 0
  ) {
    throw makeError('invalid_request', 'Discord history interval was not increasing');
  }

  const limits = configWithDefaults(config);
  const deadline = Date.now() + limits.request_timeout_ms;
  // Catch-up shares one deadline but gives each request its own rate-limit retry budget.
  const requestBudget = (): DiscordReadBudget => ({ limits, deadline, retries: 0, totalDelay: 0 });
  const live = validateBoundary(
    await getWithBudget(
      rest,
      messageRoute(request.threadId, request.throughProviderCursor),
      requestBudget()
    ),
    request.threadId,
    request.throughProviderCursor,
    request.triggerProviderCursor
  );
  const messages: GatewayProviderHistoryMessage[] = [];
  let before = request.throughProviderCursor;
  let previousPageOldest: string | undefined;
  let complete = false;
  let pageCount = 0;

  if (
    !request.afterProviderCursor ||
    compareDiscordSnowflakes(request.afterProviderCursor, request.throughProviderCursor) < 0
  ) {
    while (!complete) {
      if (pageCount >= limits.max_pages) {
        throw makeError('limit_exceeded', 'Discord history page budget exhausted');
      }
      const rawPage = await getWithBudget(
        rest,
        pageRoute(request.threadId, before),
        requestBudget()
      );
      if (!Array.isArray(rawPage) || rawPage.length > DISCORD_HISTORY_PAGE_SIZE) {
        throw makeError('malformed_response', 'Discord history page was malformed');
      }
      pageCount += 1;
      let newest: string | undefined;
      let oldest: string | undefined;
      const pageMessages: GatewayProviderHistoryMessage[] = [];
      for (const raw of rawPage) {
        const record = asRecord(raw);
        if (!record) throw makeError('malformed_response', 'Discord history message was malformed');
        const normalized = normalizeMessage(
          record,
          request.threadId,
          request.triggerProviderCursor
        );
        const id = normalized.providerMessageId;
        if (compareDiscordSnowflakes(id, before) >= 0) {
          throw makeError(
            'incomplete_coverage',
            'Discord history page did not honor its exclusive before cursor'
          );
        }
        if (newest && compareDiscordSnowflakes(newest, id) <= 0) {
          throw makeError('malformed_response', 'Discord history page was not newest-first');
        }
        newest ??= id;
        oldest = id;
        if (
          !request.afterProviderCursor ||
          compareDiscordSnowflakes(id, request.afterProviderCursor) > 0
        ) {
          pageMessages.push(normalized);
        }
      }
      if (
        previousPageOldest &&
        newest &&
        compareDiscordSnowflakes(newest, previousPageOldest) >= 0
      ) {
        throw makeError('malformed_response', 'Discord history pages overlapped or regressed');
      }
      if (oldest) {
        previousPageOldest = oldest;
        before = oldest;
      }
      messages.push(...pageMessages);
      if (messages.length + 1 > limits.max_messages) {
        throw makeError('limit_exceeded', 'Discord history message budget exhausted');
      }
      // Discord's pagination contract uses a short page as the end marker.
      // An empty page is complete too; an exact page requires another request
      // so the boundary is proven rather than guessed.
      complete = rawPage.length < DISCORD_HISTORY_PAGE_SIZE;
      if (
        request.afterProviderCursor &&
        oldest !== undefined &&
        compareDiscordSnowflakes(oldest, request.afterProviderCursor) <= 0
      ) {
        complete = true;
      }
      if (rawPage.length === 0) complete = true;
    }
  } else {
    complete = true;
  }

  messages.reverse();
  messages.push(live);
  if (messages.length > limits.max_messages) {
    throw makeError('limit_exceeded', 'Discord history message budget exhausted');
  }
  return { threadId: request.threadId, messages, complete };
}

export const DISCORD_CHANNEL_HISTORY_DEFAULT_LIMIT = 50;
export const DISCORD_CHANNEL_HISTORY_MAX_LIMIT = 200;

const utf8 = new TextEncoder();

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = utf8.encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/�+$/, '');
}

function toChannelHistoryMessage(
  raw: Record<string, unknown>,
  message: ClassifiedDiscordMessage
): DiscordChannelHistoryMessage {
  const authorId = nonEmptyString(message.author?.id);
  const attachments = (Array.isArray(message.body.attachments) ? message.body.attachments : [])
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      filename: nonEmptyString(item.filename) ?? 'attachment',
      ...(nonEmptyString(item.content_type) ? { content_type: item.content_type as string } : {}),
      size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0,
    }));
  const threadId = nonEmptyString(asRecord(raw.thread)?.id);
  return {
    id: message.id,
    iso_time: message.timestamp,
    actor_label: message.actorLabel,
    ...(authorId ? { author_id: authorId } : {}),
    text: message.text,
    is_bot: message.isBot,
    is_system: message.isSystem,
    is_mention: message.isMention,
    ...(message.isForwarded ? { is_forwarded: true as const } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(threadId && isDiscordSnowflake(threadId) ? { thread_id: threadId } : {}),
  };
}

/**
 * Read recent messages from one channel for an agent tool. Unlike catch-up,
 * this is a bounded browse: it scans at most `catch_up.max_pages` pages and
 * returns at most `catch_up.max_prompt_bytes` of text, and when a budget stops
 * it early it returns what it collected with a cursor to continue. Only a
 * short provider page proves there is nothing more in the read direction.
 * Access and allowlist checks belong to the caller.
 */
export async function fetchDiscordChannelHistory(
  rest: DiscordHistoryRestTransport,
  config: DiscordGatewayConfig,
  request: DiscordChannelHistoryRequest,
  budget: DiscordReadBudget = createDiscordReadBudget(config)
): Promise<DiscordChannelHistoryResult> {
  const limit = request.limit ?? DISCORD_CHANNEL_HISTORY_DEFAULT_LIMIT;
  if (
    !isDiscordSnowflake(request.channelId) ||
    (request.before !== undefined && !isDiscordSnowflake(request.before)) ||
    (request.after !== undefined && !isDiscordSnowflake(request.after)) ||
    (request.before !== undefined && request.after !== undefined) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > DISCORD_CHANNEL_HISTORY_MAX_LIMIT
  ) {
    throw makeError('invalid_request', 'Discord channel history request was invalid');
  }

  const { limits } = budget;
  const forward = request.after !== undefined;
  const direction = forward ? 'after' : 'before';
  let cursor = forward ? request.after : request.before;
  const collected: DiscordChannelHistoryMessage[] = [];
  let bytes = 0;
  let lastScanned: string | undefined;
  let exhausted = false;
  let stopped = false;

  for (let page = 0; page < limits.max_pages && !stopped && !exhausted; page++) {
    const params = new URLSearchParams({ limit: String(DISCORD_HISTORY_PAGE_SIZE) });
    if (cursor) params.set(direction, cursor);
    const rawPage = await getWithBudget(
      rest,
      `${Routes.channelMessages(request.channelId)}?${params.toString()}`,
      budget
    );
    if (!Array.isArray(rawPage) || rawPage.length > DISCORD_HISTORY_PAGE_SIZE) {
      throw makeError('malformed_response', 'Discord history page was malformed');
    }
    const entries = rawPage.map((raw) => {
      const record = asRecord(raw);
      if (!record) throw makeError('malformed_response', 'Discord history message was malformed');
      return { raw: record, message: classifyMessage(record, request.channelId) };
    });
    // Order in the read direction rather than trusting provider order.
    entries.sort((a, b) =>
      forward
        ? compareDiscordSnowflakes(a.message.id, b.message.id)
        : compareDiscordSnowflakes(b.message.id, a.message.id)
    );
    for (let i = 0; i < entries.length; i++) {
      const id = entries[i]!.message.id;
      if (i > 0 && id === entries[i - 1]!.message.id) {
        throw makeError('malformed_response', 'Discord history page repeated a message');
      }
      if (cursor) {
        const order = compareDiscordSnowflakes(id, cursor);
        if (forward ? order <= 0 : order >= 0) {
          throw makeError(
            'incomplete_coverage',
            `Discord history page did not honor its exclusive ${direction} cursor`
          );
        }
      }
    }

    for (const { raw, message } of entries) {
      if (!request.includeBotMessages && (message.isBot || message.isSystem)) {
        lastScanned = message.id;
        continue;
      }
      // Stop only at the next match, so trailing filtered messages on a
      // short final page do not leave a misleading has_more.
      if (collected.length >= limit) {
        stopped = true;
        break;
      }
      const output = toChannelHistoryMessage(raw, message);
      const size = utf8.encode(output.text).length;
      if (bytes + size > limits.max_prompt_bytes) {
        stopped = true;
        if (collected.length > 0) break;
        // A single oversized message is cut rather than blocking all progress.
        output.text = truncateUtf8(output.text, limits.max_prompt_bytes);
        output.text_truncated = true;
        collected.push(output);
        lastScanned = message.id;
        break;
      }
      collected.push(output);
      bytes += size;
      lastScanned = message.id;
    }

    if (!stopped) {
      if (rawPage.length < DISCORD_HISTORY_PAGE_SIZE) exhausted = true;
      else cursor = entries[entries.length - 1]!.message.id;
      if (collected.length >= limit) stopped = true;
    }
  }

  if (!forward) collected.reverse();
  const hasMore = !exhausted;
  return {
    channelId: request.channelId,
    messages: collected,
    has_more: hasMore,
    next_cursor:
      hasMore && lastScanned ? (forward ? { after: lastScanned } : { before: lastScanned }) : null,
  };
}
