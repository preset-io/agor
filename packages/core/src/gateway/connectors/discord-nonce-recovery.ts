import type { REST } from '@discordjs/rest';
import {
  type APIMessage,
  type RESTGetAPIChannelMessagesResult,
  Routes,
} from 'discord-api-types/v10';
import type { DiscordSnowflake } from '../../types';
import {
  compareDiscordSnowflakes,
  discordSnowflakeLowerBound,
  discordSnowflakePredecessor,
  isDiscordSnowflake,
} from './discord-config';

export const DISCORD_NONCE_RECOVERY_PAGE_SIZE = 100;
export const DISCORD_NONCE_RECOVERY_MAX_PAGES = 10;
export const DISCORD_NONCE_RECOVERY_MAX_MESSAGES =
  DISCORD_NONCE_RECOVERY_PAGE_SIZE * DISCORD_NONCE_RECOVERY_MAX_PAGES;
export const DISCORD_NONCE_RECOVERY_BOUNDARY_SKEW_MS = 5 * 60_000;

export interface DiscordNonceRecoveryWindow {
  /** Exclusive oldest provider cursor derived from canonical Task/Message time. */
  after: DiscordSnowflake;
  /** Exclusive newest provider cursor derived from the DB action-claim time. */
  before: DiscordSnowflake;
}

export type DiscordNonceRecoveryResult =
  | {
      outcome: 'found';
      providerMessageId: DiscordSnowflake;
      attachments: Array<{ filename: string; size: number }>;
      pages: number;
      messages: number;
    }
  | { outcome: 'absent'; pages: number; messages: number }
  | { outcome: 'incomplete'; pages: number; messages: number };

export class DiscordNonceRecoveryIncompleteError extends Error {
  constructor() {
    super('Discord nonce recovery could not prove prior-message absence');
    this.name = 'DiscordNonceRecoveryIncompleteError';
  }
}

export function discordNonceRecoveryWindowFromTimes(
  canonicalCreatedAt: string,
  databaseClaimedAt: string
): DiscordNonceRecoveryWindow {
  const createdAt = Date.parse(canonicalCreatedAt);
  const claimedAt = Date.parse(databaseClaimedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(claimedAt) || claimedAt < createdAt) {
    throw new Error('Discord nonce recovery requires ordered canonical timestamps');
  }
  const lower = discordSnowflakeLowerBound(
    Math.max(1_420_070_400_001, createdAt - DISCORD_NONCE_RECOVERY_BOUNDARY_SKEW_MS)
  );
  const upper = discordSnowflakeLowerBound(claimedAt + DISCORD_NONCE_RECOVERY_BOUNDARY_SKEW_MS);
  return { after: discordSnowflakePredecessor(lower), before: upper };
}

function messageHasExactBotNonce(
  message: APIMessage,
  botUserId: DiscordSnowflake,
  nonce: string
): boolean {
  return (
    message.author.id === botUserId &&
    message.author.bot === true &&
    !message.webhook_id &&
    message.nonce !== undefined &&
    String(message.nonce) === nonce
  );
}

/**
 * Search newest-to-oldest within one canonical time window. `absent` is
 * returned only after the lower bound is reached; exhausting the bounded page
 * budget is explicitly incomplete and must never authorize a blind re-POST.
 */
export async function recoverDiscordMessageByNonce(input: {
  rest: REST;
  channelId: DiscordSnowflake;
  botUserId: DiscordSnowflake;
  nonce: string;
  window: DiscordNonceRecoveryWindow;
  signal?: AbortSignal;
  beforeRest?: () => Promise<void>;
  maxPages?: number;
}): Promise<DiscordNonceRecoveryResult> {
  const maxPages = input.maxPages ?? DISCORD_NONCE_RECOVERY_MAX_PAGES;
  if (
    !isDiscordSnowflake(input.channelId) ||
    !isDiscordSnowflake(input.botUserId) ||
    !isDiscordSnowflake(input.window.after) ||
    !isDiscordSnowflake(input.window.before) ||
    compareDiscordSnowflakes(input.window.before, input.window.after) <= 0 ||
    !input.nonce ||
    new TextEncoder().encode(input.nonce).byteLength > 25 ||
    !Number.isInteger(maxPages) ||
    maxPages <= 0 ||
    maxPages > DISCORD_NONCE_RECOVERY_MAX_PAGES
  ) {
    throw new Error('Invalid Discord nonce recovery request');
  }

  let before = input.window.before;
  let pages = 0;
  let messages = 0;
  while (pages < maxPages) {
    input.signal?.throwIfAborted();
    await input.beforeRest?.();
    input.signal?.throwIfAborted();
    const page = (await input.rest.get(Routes.channelMessages(input.channelId), {
      query: new URLSearchParams({
        before,
        limit: String(DISCORD_NONCE_RECOVERY_PAGE_SIZE),
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    })) as RESTGetAPIChannelMessagesResult;
    pages += 1;
    messages += page.length;
    if (page.length === 0) return { outcome: 'absent', pages, messages };
    if (page.some((message) => !isDiscordSnowflake(message.id))) {
      return { outcome: 'incomplete', pages, messages };
    }

    let oldest = before;
    for (const message of page) {
      if (compareDiscordSnowflakes(message.id, oldest) < 0) oldest = message.id;
      if (
        compareDiscordSnowflakes(message.id, input.window.after) > 0 &&
        compareDiscordSnowflakes(message.id, input.window.before) < 0 &&
        messageHasExactBotNonce(message, input.botUserId, input.nonce)
      ) {
        return {
          outcome: 'found',
          providerMessageId: message.id,
          attachments: (message.attachments ?? []).map((attachment) => ({
            filename: attachment.filename,
            size: attachment.size,
          })),
          pages,
          messages,
        };
      }
    }
    if (
      compareDiscordSnowflakes(oldest, input.window.after) <= 0 ||
      page.length < DISCORD_NONCE_RECOVERY_PAGE_SIZE
    ) {
      return { outcome: 'absent', pages, messages };
    }
    if (oldest === before) return { outcome: 'incomplete', pages, messages };
    before = oldest;
  }
  return { outcome: 'incomplete', pages, messages };
}
