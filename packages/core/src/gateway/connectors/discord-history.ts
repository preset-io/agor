import { Routes } from 'discord-api-types/v10';
import type { DiscordCatchUpConfig, DiscordGatewayConfig } from '../../types/gateway';
import { compareDiscordSnowflakes, isDiscordSnowflake } from '../../types/gateway';
import type {
  GatewayProviderHistoryMessage,
  GatewayProviderHistoryRequest,
  GatewayProviderHistoryResult,
} from '../connector';

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

async function getWithBudget(
  rest: DiscordHistoryRestTransport,
  route: string,
  config: DiscordCatchUpConfig,
  deadline: number
): Promise<unknown> {
  let retries = 0;
  let totalDelay = 0;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw makeError('request_timeout', 'Discord history request timed out');
    try {
      return await withTimeout(rest.get(route), remaining);
    } catch (error) {
      if (!rateLimitStatus(error)) {
        if (error instanceof DiscordHistoryError) throw error;
        throw makeError('provider', 'Discord history provider request failed');
      }
      const delay = retryAfterMs(error);
      if (
        retries >= config.rate_limit_max_retries ||
        totalDelay + delay > config.rate_limit_max_total_delay_ms ||
        Date.now() + delay > deadline
      ) {
        throw new DiscordHistoryError(
          'rate_limit',
          'Discord history rate limit budget exhausted',
          delay
        );
      }
      retries += 1;
      totalDelay += delay;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeMessage(
  raw: Record<string, unknown>,
  threadId: string,
  triggerProviderCursor: string
): GatewayProviderHistoryMessage {
  const id = nonEmptyString(raw.id);
  const channelId = nonEmptyString(raw.channel_id);
  const timestamp = nonEmptyString(raw.timestamp);
  const author = asRecord(raw.author);
  if (
    !id ||
    !isDiscordSnowflake(id) ||
    channelId !== threadId ||
    !timestamp ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    throw makeError('malformed_response', 'Discord history message identity was malformed');
  }

  const type = typeof raw.type === 'number' ? raw.type : undefined;
  const isSystem =
    author?.system === true || (type !== undefined && !DISCORD_TEXT_MESSAGE_TYPES.has(type));
  const isBot = author?.bot === true;
  const hasRichPayload =
    (Array.isArray(raw.attachments) && raw.attachments.length > 0) ||
    (Array.isArray(raw.embeds) && raw.embeds.length > 0) ||
    (Array.isArray(raw.components) && raw.components.length > 0) ||
    (Array.isArray(raw.sticker_items) && raw.sticker_items.length > 0) ||
    (raw.poll !== undefined && raw.poll !== null);
  if (
    !isSystem &&
    !isBot &&
    DISCORD_TEXT_MESSAGE_TYPES.has(type ?? -1) &&
    (typeof raw.content !== 'string' || raw.content.length === 0) &&
    !hasRichPayload
  ) {
    throw makeError(
      'incomplete_coverage',
      'Discord history content was redacted without a supported rich payload'
    );
  }
  const rich = !('content' in raw) || typeof raw.content !== 'string' || hasRichPayload;
  const authorId = nonEmptyString(author?.id);
  const actorLabel =
    nonEmptyString(author?.global_name) ??
    nonEmptyString(author?.username) ??
    authorId ??
    (isSystem ? 'Discord system' : 'Discord user');
  const mentions = Array.isArray(raw.mentions) ? raw.mentions : [];

  return {
    providerMessageId: id,
    timestamp,
    actorLabel,
    text: typeof raw.content === 'string' ? raw.content : '',
    isBot,
    isSystem,
    isRich: rich,
    isTrigger: id === triggerProviderCursor,
    isMention: mentions.length > 0,
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
  const live = validateBoundary(
    await getWithBudget(
      rest,
      messageRoute(request.threadId, request.throughProviderCursor),
      limits,
      deadline
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
        limits,
        deadline
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
