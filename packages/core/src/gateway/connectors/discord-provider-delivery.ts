import type { REST } from '@discordjs/rest';
import { type RESTPostAPIChannelMessageResult, Routes } from 'discord-api-types/v10';

import type { DiscordSnowflake } from '../../types';
import { isDiscordSnowflake } from './discord-config';
import {
  discordAllowedMentionsNone,
  discordMessageNonce,
  formatDiscordMarkdown,
} from './discord-format';
import { parseDiscordThreadId } from './discord-helpers';
import {
  DiscordNonceRecoveryIncompleteError,
  type DiscordNonceRecoveryWindow,
  recoverDiscordMessageByNonce,
} from './discord-nonce-recovery';

export interface DiscordRecoverableSendOptions {
  botUserId?: DiscordSnowflake;
  recoveryWindow?: DiscordNonceRecoveryWindow;
  signal?: AbortSignal;
  /** Exact listener/action DB admission immediately before each REST call. */
  beforeProviderCall?: () => Promise<void>;
}

export interface DiscordDeliveryChunkRequest {
  threadId: string;
  content: string;
  nonce: string;
  overflowAttachment?: {
    filename: 'agor-response.md';
    markdown: string;
    byteLength: number;
  };
}

export class DiscordDeliveryCoordinateError extends Error {
  constructor() {
    super('Discord delivery coordinates did not match the frozen request');
    this.name = 'DiscordDeliveryCoordinateError';
  }
}

function attachmentCoordinatesMatch(
  attachments: Array<{ filename: string; size: number }>,
  expected?: DiscordDeliveryChunkRequest['overflowAttachment']
): boolean {
  if (!expected) return attachments.length === 0;
  return (
    attachments.length === 1 &&
    attachments[0]?.filename === expected.filename &&
    attachments[0]?.size === expected.byteLength
  );
}

/** Recover or create exactly one pre-rendered, formatter-frozen Discord row. */
export async function sendDiscordDeliveryChunk(
  rest: REST,
  req: DiscordDeliveryChunkRequest,
  options: DiscordRecoverableSendOptions = {}
): Promise<string> {
  const channelId = parseDiscordThreadId(req.threadId);
  if (
    !req.content ||
    Array.from(req.content).length > 2_000 ||
    !req.nonce ||
    Buffer.byteLength(req.nonce, 'utf8') > 25 ||
    (req.overflowAttachment &&
      Buffer.byteLength(req.overflowAttachment.markdown, 'utf8') !==
        req.overflowAttachment.byteLength)
  ) {
    throw new Error('Invalid frozen Discord delivery chunk');
  }
  if (options.recoveryWindow) {
    if (!options.botUserId) throw new DiscordNonceRecoveryIncompleteError();
    const recovered = await recoverDiscordMessageByNonce({
      rest,
      channelId,
      botUserId: options.botUserId,
      nonce: req.nonce,
      window: options.recoveryWindow,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.beforeProviderCall ? { beforeRest: options.beforeProviderCall } : {}),
    });
    if (recovered.outcome === 'found') {
      if (!attachmentCoordinatesMatch(recovered.attachments, req.overflowAttachment)) {
        throw new DiscordDeliveryCoordinateError();
      }
      return recovered.providerMessageId;
    }
    if (recovered.outcome === 'incomplete') throw new DiscordNonceRecoveryIncompleteError();
  }

  options.signal?.throwIfAborted();
  await options.beforeProviderCall?.();
  options.signal?.throwIfAborted();
  const result = (await rest.post(Routes.channelMessages(channelId), {
    body: {
      content: req.content,
      allowed_mentions: discordAllowedMentionsNone(),
      nonce: req.nonce,
      enforce_nonce: true,
    },
    ...(options.signal ? { signal: options.signal } : {}),
    ...(req.overflowAttachment
      ? {
          files: [
            {
              data: Buffer.from(req.overflowAttachment.markdown, 'utf8'),
              name: req.overflowAttachment.filename,
            },
          ],
        }
      : {}),
  })) as RESTPostAPIChannelMessageResult;
  if (
    !isDiscordSnowflake(result.id) ||
    result.nonce === undefined ||
    String(result.nonce) !== req.nonce ||
    (options.botUserId && result.author?.id !== options.botUserId) ||
    !attachmentCoordinatesMatch(result.attachments ?? [], req.overflowAttachment)
  ) {
    throw new DiscordDeliveryCoordinateError();
  }
  return result.id;
}

/** Existing generic connector send, implemented over the same chunk primitive. */
export async function sendDiscordMessage(
  rest: REST,
  req: { threadId: string; text: string; metadata?: Record<string, unknown> },
  options: DiscordRecoverableSendOptions = {}
): Promise<string> {
  const channelId = parseDiscordThreadId(req.threadId);
  const formatted = formatDiscordMarkdown(req.text);
  if (formatted.chunks.length === 0) return '';
  const updateMessageId =
    typeof req.metadata?.discord_update_message_id === 'string'
      ? req.metadata.discord_update_message_id
      : undefined;
  if (updateMessageId) {
    if (formatted.chunks.length !== 1 || formatted.overflowMarkdown) {
      throw new Error('Discord message edits must fit in one message');
    }
    options.signal?.throwIfAborted();
    await options.beforeProviderCall?.();
    options.signal?.throwIfAborted();
    await rest.patch(Routes.channelMessage(channelId, updateMessageId), {
      body: { content: formatted.chunks[0], allowed_mentions: discordAllowedMentionsNone() },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return updateMessageId;
  }

  const nonceSeed =
    typeof req.metadata?.discord_nonce_seed === 'string'
      ? req.metadata.discord_nonce_seed
      : typeof req.metadata?.agor_message_id === 'string'
        ? req.metadata.agor_message_id
        : `${req.threadId}\0${req.text}`;
  let lastMessageId = '';
  for (const [index, content] of formatted.chunks.entries()) {
    lastMessageId = await sendDiscordDeliveryChunk(
      rest,
      {
        threadId: req.threadId,
        content,
        nonce: discordMessageNonce(nonceSeed, index),
        ...(formatted.overflowMarkdown && index === formatted.chunks.length - 1
          ? {
              overflowAttachment: {
                filename: 'agor-response.md',
                markdown: formatted.overflowMarkdown,
                byteLength: Buffer.byteLength(formatted.overflowMarkdown, 'utf8'),
              },
            }
          : {}),
      },
      options
    );
  }
  return lastMessageId;
}
