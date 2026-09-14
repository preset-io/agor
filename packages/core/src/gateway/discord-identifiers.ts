import { createHash } from 'node:crypto';
import type { DiscordMessageDeliveryID } from '../types/gateway';
import {
  type DiscordThreadCoordinates,
  isDiscordSnowflake,
  isDiscordThreadCoordinates,
} from '../types/gateway';
import { isCanonicalFullUuid } from '../types/id';

/**
 * Core-owned names for Discord metadata that participates in authorization,
 * routing, or provider-effect fencing. Consumers must not spell these keys
 * independently: the metadata crosses the core/daemon boundary as JSON.
 */
export const DISCORD_METADATA_KEY = {
  guildId: 'discord_guild_id',
  channelId: 'discord_channel_id',
  messageId: 'discord_message_id',
  authorId: 'discord_author_id',
  roleIds: 'discord_role_ids',
  botUserId: 'discord_bot_user_id',
  isThread: 'discord_is_thread',
  parentChannelId: 'discord_parent_channel_id',
  replyToMessageId: 'discord_reply_to_message_id',
  hasMention: 'discord_has_mention',
  threadId: 'discord_thread_id',
  thread: 'discord_thread',
  threadType: 'discord_thread_type',
  threadAccessible: 'discord_thread_accessible',
  starterMessageAccessible: 'discord_starter_message_accessible',
  deliveryNonce: 'discord_delivery_nonce',
  enforceNonce: 'discord_enforce_nonce',
} as const;

export type DiscordMetadataKey = (typeof DISCORD_METADATA_KEY)[keyof typeof DISCORD_METADATA_KEY];

/** A nonce accepted by Discord's nonce-protected delivery path. */
export type DiscordDeliveryNonce = string & { readonly __brand: 'DiscordDeliveryNonce' };

type DiscordMetadataValues = Partial<{
  [DISCORD_METADATA_KEY.guildId]: string;
  [DISCORD_METADATA_KEY.channelId]: string;
  [DISCORD_METADATA_KEY.messageId]: string;
  [DISCORD_METADATA_KEY.authorId]: string;
  [DISCORD_METADATA_KEY.roleIds]: string[];
  [DISCORD_METADATA_KEY.botUserId]: string;
  [DISCORD_METADATA_KEY.isThread]: boolean;
  [DISCORD_METADATA_KEY.parentChannelId]: string;
  [DISCORD_METADATA_KEY.replyToMessageId]: string;
  [DISCORD_METADATA_KEY.hasMention]: boolean;
  [DISCORD_METADATA_KEY.threadId]: string;
  [DISCORD_METADATA_KEY.thread]: DiscordThreadCoordinates;
  [DISCORD_METADATA_KEY.threadType]: number;
  [DISCORD_METADATA_KEY.threadAccessible]: boolean;
  [DISCORD_METADATA_KEY.starterMessageAccessible]: boolean;
  [DISCORD_METADATA_KEY.deliveryNonce]: DiscordDeliveryNonce;
  [DISCORD_METADATA_KEY.enforceNonce]: true;
}>;

/** Parsed authority metadata; unrelated provider metadata is intentionally omitted. */
export type DiscordAuthorityMetadata = DiscordMetadataValues;

const DISCORD_NONCE_RE = /^agor-([0-9a-f]{16})-([0-9a-z]+)$/;
const MAX_DISCORD_NONCE_CHUNK_INDEX = 999;

function hasOwn(value: Record<string, unknown>, key: DiscordMetadataKey): boolean {
  return Object.hasOwn(value, key);
}

function readSnowflake(
  value: Record<string, unknown>,
  key: DiscordMetadataKey
): string | undefined | null {
  if (!hasOwn(value, key)) return undefined;
  return isDiscordSnowflake(value[key]) ? value[key] : null;
}

function readBoolean(
  value: Record<string, unknown>,
  key: DiscordMetadataKey
): boolean | undefined | null {
  if (!hasOwn(value, key)) return undefined;
  return typeof value[key] === 'boolean' ? value[key] : null;
}

function requireDiscordSnowflake(value: unknown, label: string): string {
  if (!isDiscordSnowflake(value)) {
    throw new Error(`${label} must be a canonical Discord Snowflake`);
  }
  return value;
}

/**
 * Parse the known Discord authority fields without trusting a cast from JSON.
 * Unknown provider metadata remains available to provider-neutral code, but a
 * known field with the wrong shape rejects the whole authority view.
 */
export function parseDiscordAuthorityMetadata(value: unknown): DiscordAuthorityMetadata | null {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const parsed: DiscordAuthorityMetadata = {};

  const snowflakeFields = [
    DISCORD_METADATA_KEY.guildId,
    DISCORD_METADATA_KEY.channelId,
    DISCORD_METADATA_KEY.messageId,
    DISCORD_METADATA_KEY.authorId,
    DISCORD_METADATA_KEY.botUserId,
    DISCORD_METADATA_KEY.parentChannelId,
    DISCORD_METADATA_KEY.replyToMessageId,
    DISCORD_METADATA_KEY.threadId,
  ] as const;
  for (const key of snowflakeFields) {
    const parsedValue = readSnowflake(raw, key);
    if (parsedValue === null) return null;
    if (parsedValue !== undefined) parsed[key] = parsedValue;
  }

  if (hasOwn(raw, DISCORD_METADATA_KEY.roleIds)) {
    const roleIds = raw[DISCORD_METADATA_KEY.roleIds];
    if (!Array.isArray(roleIds) || !roleIds.every((role: unknown) => isDiscordSnowflake(role))) {
      return null;
    }
    parsed[DISCORD_METADATA_KEY.roleIds] = roleIds;
  }

  const booleanFields = [
    DISCORD_METADATA_KEY.isThread,
    DISCORD_METADATA_KEY.hasMention,
    DISCORD_METADATA_KEY.threadAccessible,
    DISCORD_METADATA_KEY.starterMessageAccessible,
  ] as const;
  for (const key of booleanFields) {
    const parsedValue = readBoolean(raw, key);
    if (parsedValue === null) return null;
    if (parsedValue !== undefined) parsed[key] = parsedValue;
  }

  if (hasOwn(raw, DISCORD_METADATA_KEY.thread)) {
    const thread = raw[DISCORD_METADATA_KEY.thread];
    if (!isDiscordThreadCoordinates(thread)) return null;
    parsed[DISCORD_METADATA_KEY.thread] = thread;
  }
  if (hasOwn(raw, DISCORD_METADATA_KEY.threadType)) {
    const threadType = raw[DISCORD_METADATA_KEY.threadType];
    if (typeof threadType !== 'number' || !Number.isSafeInteger(threadType)) return null;
    parsed[DISCORD_METADATA_KEY.threadType] = threadType;
  }

  if (hasOwn(raw, DISCORD_METADATA_KEY.deliveryNonce)) {
    const nonce = parseDiscordDeliveryNonce(raw[DISCORD_METADATA_KEY.deliveryNonce]);
    if (!nonce) return null;
    parsed[DISCORD_METADATA_KEY.deliveryNonce] = nonce;
  }
  if (hasOwn(raw, DISCORD_METADATA_KEY.enforceNonce)) {
    if (raw[DISCORD_METADATA_KEY.enforceNonce] !== true) return null;
    parsed[DISCORD_METADATA_KEY.enforceNonce] = true;
  }
  if (
    hasOwn(raw, DISCORD_METADATA_KEY.deliveryNonce) !==
    hasOwn(raw, DISCORD_METADATA_KEY.enforceNonce)
  ) {
    return null;
  }

  return parsed;
}

/** Extract the verified starter message from stored Discord authority metadata. */
export function extractDiscordStarterMessageId(value: unknown): string | undefined {
  return parseDiscordAuthorityMetadata(value)?.[DISCORD_METADATA_KEY.thread]?.starter_message_id;
}

/** Construct the authority metadata emitted by the Discord adapter. */
export function buildDiscordInboundMetadata(input: {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  roleIds: string[];
  botUserId: string;
  isThread: boolean;
  parentChannelId?: string;
  replyToMessageId?: string;
}): DiscordAuthorityMetadata {
  const guildId = requireDiscordSnowflake(input.guildId, 'Discord guild ID');
  const channelId = requireDiscordSnowflake(input.channelId, 'Discord channel ID');
  const messageId = requireDiscordSnowflake(input.messageId, 'Discord message ID');
  const authorId = requireDiscordSnowflake(input.authorId, 'Discord author ID');
  const botUserId = requireDiscordSnowflake(input.botUserId, 'Discord bot user ID');
  if (
    !Array.isArray(input.roleIds) ||
    !input.roleIds.every((roleId) => isDiscordSnowflake(roleId))
  ) {
    throw new Error('Discord role IDs must be canonical Discord Snowflakes');
  }
  if (typeof input.isThread !== 'boolean') {
    throw new Error('Discord thread flag must be boolean');
  }
  const metadata: DiscordAuthorityMetadata = {
    [DISCORD_METADATA_KEY.guildId]: guildId,
    [DISCORD_METADATA_KEY.channelId]: channelId,
    [DISCORD_METADATA_KEY.messageId]: messageId,
    [DISCORD_METADATA_KEY.authorId]: authorId,
    [DISCORD_METADATA_KEY.roleIds]: input.roleIds,
    [DISCORD_METADATA_KEY.botUserId]: botUserId,
    [DISCORD_METADATA_KEY.isThread]: input.isThread,
    [DISCORD_METADATA_KEY.hasMention]: true,
  };
  if (input.parentChannelId !== undefined) {
    metadata[DISCORD_METADATA_KEY.parentChannelId] = requireDiscordSnowflake(
      input.parentChannelId,
      'Discord parent channel ID'
    );
  }
  if (input.replyToMessageId !== undefined) {
    metadata[DISCORD_METADATA_KEY.replyToMessageId] = requireDiscordSnowflake(
      input.replyToMessageId,
      'Discord reply message ID'
    );
  }
  return metadata;
}

/** Add the verified public-thread coordinates returned by the provider. */
export function buildDiscordVerifiedThreadMetadata(
  coordinates: DiscordThreadCoordinates,
  threadType: number
): DiscordAuthorityMetadata {
  if (!isDiscordThreadCoordinates(coordinates)) {
    throw new Error('Discord verified thread coordinates are invalid');
  }
  if (!Number.isSafeInteger(threadType)) {
    throw new Error('Discord verified thread type must be a safe integer');
  }
  return {
    [DISCORD_METADATA_KEY.threadId]: coordinates.thread_channel_id,
    [DISCORD_METADATA_KEY.thread]: coordinates,
    [DISCORD_METADATA_KEY.threadType]: threadType,
    [DISCORD_METADATA_KEY.threadAccessible]: true,
    [DISCORD_METADATA_KEY.starterMessageAccessible]: true,
  };
}

/** Construct the only nonce-bearing outbound metadata accepted by the adapter. */
export function buildDiscordDeliveryMetadata(
  nonce: DiscordDeliveryNonce
): DiscordAuthorityMetadata {
  if (!parseDiscordDeliveryNonce(nonce)) {
    throw new Error('Discord delivery metadata requires a canonical delivery nonce');
  }
  return {
    [DISCORD_METADATA_KEY.deliveryNonce]: nonce,
    [DISCORD_METADATA_KEY.enforceNonce]: true,
  };
}

/** Build a deterministic, canonical Discord nonce for one delivery chunk. */
export function buildDiscordDeliveryNonce(
  deliveryId: DiscordMessageDeliveryID,
  chunkIndex: number
): DiscordDeliveryNonce {
  if (!isCanonicalFullUuid(deliveryId)) {
    throw new Error('Discord delivery nonce requires a canonical delivery UUID');
  }
  if (
    !Number.isSafeInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex > MAX_DISCORD_NONCE_CHUNK_INDEX
  ) {
    throw new Error('Discord delivery nonce chunk index is outside the supported range');
  }
  const digest = createHash('sha256').update(deliveryId).digest('hex').slice(0, 16);
  return `agor-${digest}-${chunkIndex.toString(36)}` as DiscordDeliveryNonce;
}

/** Strictly parse a nonce before it crosses into provider request metadata. */
export function parseDiscordDeliveryNonce(value: unknown): DiscordDeliveryNonce | null {
  if (typeof value !== 'string') return null;
  const match = DISCORD_NONCE_RE.exec(value);
  if (!match) return null;
  const chunkIndex = Number.parseInt(match[2], 36);
  if (
    !Number.isSafeInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex > MAX_DISCORD_NONCE_CHUNK_INDEX ||
    chunkIndex.toString(36) !== match[2]
  ) {
    return null;
  }
  return value as DiscordDeliveryNonce;
}

export type DiscordThreadKey = string & { readonly __brand: 'DiscordThreadKey' };

export type ParsedDiscordThreadKey =
  | {
      kind: 'message';
      channelId: string;
      messageId: string;
    }
  | {
      kind: 'legacy_thread';
      parentChannelId: string;
      threadChannelId: string;
    }
  | { kind: 'provider_thread'; channelId: string };

export function buildDiscordMessageThreadKey(
  channelId: string,
  messageId: string
): DiscordThreadKey {
  if (!isDiscordSnowflake(channelId) || !isDiscordSnowflake(messageId)) {
    throw new Error('Discord message thread key requires canonical Snowflakes');
  }
  return `discord:message:${channelId}:${messageId}` as DiscordThreadKey;
}

export function buildDiscordLegacyThreadKey(
  parentChannelId: string,
  threadChannelId: string
): DiscordThreadKey {
  if (!isDiscordSnowflake(parentChannelId) || !isDiscordSnowflake(threadChannelId)) {
    throw new Error('Discord thread key requires canonical Snowflakes');
  }
  return `discord:thread:${parentChannelId}:${threadChannelId}` as DiscordThreadKey;
}

export function parseDiscordThreadKey(value: unknown): ParsedDiscordThreadKey | null {
  if (typeof value !== 'string') return null;
  const legacy = /^discord:thread:(\d{17,20}):(\d{17,20})$/.exec(value);
  if (legacy && isDiscordSnowflake(legacy[1]) && isDiscordSnowflake(legacy[2])) {
    return {
      kind: 'legacy_thread',
      parentChannelId: legacy[1],
      threadChannelId: legacy[2],
    };
  }
  const message = /^discord:message:(\d{17,20}):(\d{17,20})$/.exec(value);
  if (message && isDiscordSnowflake(message[1]) && isDiscordSnowflake(message[2])) {
    return { kind: 'message', channelId: message[1], messageId: message[2] };
  }
  if (isDiscordSnowflake(value)) return { kind: 'provider_thread', channelId: value };
  return null;
}
