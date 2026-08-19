import { type GatewayMessageCreateDispatchData, MessageType } from 'discord-api-types/v10';

import type { DiscordGatewayConfig, DiscordSnowflake } from '../../types/gateway';
import type { GatewayInboundCallback, InboundFile } from '../connector';
import { isDiscordSnowflake } from './discord-config';
import {
  buildDiscordProviderEventId,
  buildDiscordThreadId,
  discordMessageHasInvocationMention,
  discordMessageHasStructuredMention,
  stripDiscordBotMention,
} from './discord-helpers';
import type { DiscordProvider } from './discord-provider';

const ACCEPTED_MESSAGE_TYPES = new Set<MessageType>([MessageType.Default, MessageType.Reply]);
export const DISCORD_INBOUND_ATTACHMENT_MAX_COUNT = 10;
export const DISCORD_INBOUND_ATTACHMENT_MAX_NAME_BYTES = 255;
export const DISCORD_INBOUND_ATTACHMENT_MAX_MIME_BYTES = 100;
export const DISCORD_INBOUND_ATTACHMENT_MAX_URL_BYTES = 4_096;

const DISCORD_ATTACHMENT_MIME_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const DISCORD_SIGNED_TIME_PATTERN = /^[0-9a-fA-F]{8,16}$/;
const DISCORD_SIGNED_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasUnsafeAttachmentNameCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127 || character === '/' || character === '\\') {
      return true;
    }
  }
  return false;
}

/** Exact launch URL shape for freshly issued Discord attachment CDN links. */
export function isDiscordAttachmentCdnUrl(
  value: unknown,
  expectedAttachmentId?: DiscordSnowflake,
  expectedFilename?: string
): value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > DISCORD_INBOUND_ATTACHMENT_MAX_URL_BYTES) {
    return false;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'cdn.discordapp.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return false;
    }
    const parts = url.pathname.split('/');
    if (
      parts.length !== 5 ||
      parts[0] !== '' ||
      parts[1] !== 'attachments' ||
      !isDiscordSnowflake(parts[2]) ||
      !isDiscordSnowflake(parts[3]) ||
      (expectedAttachmentId !== undefined && parts[3] !== expectedAttachmentId)
    ) {
      return false;
    }
    let filename: string;
    try {
      filename = decodeURIComponent(parts[4]);
    } catch {
      return false;
    }
    if (!filename || filename.includes('/') || filename.includes('\\')) return false;
    if (expectedFilename !== undefined && filename !== expectedFilename) return false;
    const keys = [...url.searchParams.keys()];
    if (
      keys.length !== 3 ||
      new Set(keys).size !== 3 ||
      !keys.includes('ex') ||
      !keys.includes('is') ||
      !keys.includes('hm') ||
      !DISCORD_SIGNED_TIME_PATTERN.test(url.searchParams.get('ex') ?? '') ||
      !DISCORD_SIGNED_TIME_PATTERN.test(url.searchParams.get('is') ?? '') ||
      !DISCORD_SIGNED_HASH_PATTERN.test(url.searchParams.get('hm') ?? '')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Minimize one provider Attachment into the shared inbound descriptor. */
export function normalizeDiscordInboundAttachments(value: unknown): {
  files: InboundFile[];
  rejected: number;
} {
  if (!Array.isArray(value)) return { files: [], rejected: 0 };
  const files: InboundFile[] = [];
  let rejected = Math.max(0, value.length - DISCORD_INBOUND_ATTACHMENT_MAX_COUNT);
  for (const candidate of value.slice(0, DISCORD_INBOUND_ATTACHMENT_MAX_COUNT)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      rejected++;
      continue;
    }
    const raw = candidate as Record<string, unknown>;
    const name = raw.filename;
    const rawMime = raw.content_type;
    const mime = typeof rawMime === 'string' ? rawMime.trim().toLowerCase() : '';
    if (
      !isDiscordSnowflake(raw.id) ||
      typeof name !== 'string' ||
      !name ||
      utf8Bytes(name) > DISCORD_INBOUND_ATTACHMENT_MAX_NAME_BYTES ||
      hasUnsafeAttachmentNameCharacter(name) ||
      !mime ||
      utf8Bytes(mime) > DISCORD_INBOUND_ATTACHMENT_MAX_MIME_BYTES ||
      !DISCORD_ATTACHMENT_MIME_PATTERN.test(mime) ||
      !Number.isSafeInteger(raw.size) ||
      Number(raw.size) < 0 ||
      !isDiscordAttachmentCdnUrl(raw.url, raw.id, name)
    ) {
      rejected++;
      continue;
    }
    files.push({
      id: raw.id,
      name,
      mimetype: mime,
      size: Number(raw.size),
      url_private_download: raw.url,
    });
  }
  return { files, rejected };
}

/** Validate and normalize one live or recovered MESSAGE_CREATE identically. */
export async function admitDiscordMessage(args: {
  config: DiscordGatewayConfig;
  provider: DiscordProvider;
  botUserId: DiscordSnowflake | null;
  message: GatewayMessageCreateDispatchData;
  callback: GatewayInboundCallback;
}): Promise<'admitted' | 'ignored'> {
  const { botUserId, config, message, provider } = args;
  if (
    !botUserId ||
    message.guild_id !== config.guild_id ||
    message.author.bot === true ||
    message.webhook_id ||
    !ACCEPTED_MESSAGE_TYPES.has(message.type) ||
    !discordMessageHasStructuredMention(message.mentions, botUserId) ||
    !discordMessageHasInvocationMention(message.content ?? '', botUserId)
  ) {
    return 'ignored';
  }
  if (
    !isDiscordSnowflake(message.id) ||
    !isDiscordSnowflake(message.channel_id) ||
    !isDiscordSnowflake(message.author.id)
  ) {
    return 'ignored';
  }

  const surface = await provider.resolveSurface(message.channel_id);
  if (!surface) return 'ignored';
  const externalThreadChannelId = surface.kind === 'parent_text' ? message.id : surface.channelId;
  const attachments =
    config.ingest_files === true
      ? normalizeDiscordInboundAttachments(message.attachments)
      : { files: [], rejected: 0 };
  await args.callback({
    providerEventId: buildDiscordProviderEventId(config.application_id, message.id),
    threadId: buildDiscordThreadId(externalThreadChannelId),
    text: stripDiscordBotMention(message.content ?? '', botUserId),
    userId: message.author.id,
    timestamp: message.timestamp,
    ...(attachments.files.length > 0 ? { files: attachments.files } : {}),
    metadata: {
      discord_application_id: config.application_id,
      discord_guild_id: config.guild_id,
      discord_channel_id: externalThreadChannelId,
      discord_parent_channel_id: surface.parentId,
      discord_message_id: message.id,
      discord_message_timestamp: message.timestamp,
      discord_user_id: message.author.id,
      discord_has_mention: true,
      discord_channel_type: surface.channelType,
      discord_is_thread: surface.kind === 'public_thread',
      ...(attachments.rejected > 0
        ? { discord_attachment_rejected_count: attachments.rejected }
        : {}),
      ...(config.align_discord_users ? { align_discord_users: true } : {}),
    },
    ...(surface.kind === 'parent_text'
      ? {
          prepareDelivery: () => provider.preparePublicThread(surface, message.id),
        }
      : {}),
  });
  return 'admitted';
}
