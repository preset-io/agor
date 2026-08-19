import { createHash } from 'node:crypto';

import type {
  GatewayDiscordDeliveryExecutionMetadata,
  GatewayDiscordDeliveryOverflowCheckpoint,
} from '../../types';
import {
  DISCORD_MESSAGE_MAX_CHUNKS,
  discordMessageNonce,
  formatDiscordMarkdown,
} from './discord-format';

/** Bump only with an intentional launch formatter contract migration. */
export const DISCORD_DELIVERY_FORMATTER_VERSION = 1;
export const DISCORD_DELIVERY_OVERFLOW_FILENAME = 'agor-response.md' as const;
/** Below Discord's documented default 10 MiB per-file ceiling. */
export const DISCORD_DELIVERY_MAX_OVERFLOW_BYTES = 8 * 1024 * 1024;
export const DISCORD_DELIVERY_EXECUTION_METADATA_MAX_BYTES = 4_096;
export const DISCORD_DELIVERY_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface DiscordDeliveryChunk {
  index: number;
  content: string;
  nonce: string;
  descriptorSha256: string;
  overflowAttachment?: {
    filename: typeof DISCORD_DELIVERY_OVERFLOW_FILENAME;
    markdown: string;
    contentSha256: string;
    byteLength: number;
  };
}

export interface DiscordDeliveryPlan {
  metadata: GatewayDiscordDeliveryExecutionMetadata;
  chunks: DiscordDeliveryChunk[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function descriptorHash(input: {
  index: number;
  contentSha256: string;
  overflow?: GatewayDiscordDeliveryOverflowCheckpoint;
}): string {
  // This exact key order is part of formatter v1. Persist only the resulting
  // hash, never this descriptor's rendered content.
  return sha256(
    JSON.stringify({
      formatter_version: DISCORD_DELIVERY_FORMATTER_VERSION,
      index: input.index,
      content_sha256: input.contentSha256,
      overflow_attachment: input.overflow ?? null,
    })
  );
}

/** Build the in-memory render plus the content-free state frozen before REST. */
export function createDiscordDeliveryPlan(
  renderedSource: string,
  nonceSeed: string,
  canonicalSource = renderedSource
): DiscordDeliveryPlan {
  const formatted = formatDiscordMarkdown(renderedSource);
  if (formatted.chunks.length < 1 || formatted.chunks.length > DISCORD_MESSAGE_MAX_CHUNKS) {
    throw new Error('Discord delivery must contain a bounded non-empty chunk set');
  }
  const overflowMarkdown = formatted.overflowMarkdown;
  let overflow: GatewayDiscordDeliveryOverflowCheckpoint | undefined;
  if (overflowMarkdown !== undefined) {
    const byteLength = utf8Bytes(overflowMarkdown);
    if (byteLength < 1 || byteLength > DISCORD_DELIVERY_MAX_OVERFLOW_BYTES) {
      throw new Error('Discord overflow attachment exceeds the launch byte limit');
    }
    overflow = {
      chunk_index: formatted.chunks.length - 1,
      filename: DISCORD_DELIVERY_OVERFLOW_FILENAME,
      content_sha256: sha256(overflowMarkdown),
      byte_length: byteLength,
    };
  }

  const chunks = formatted.chunks.map((content, index): DiscordDeliveryChunk => {
    const attachment = overflow?.chunk_index === index ? overflow : undefined;
    const descriptorSha256 = descriptorHash({
      index,
      contentSha256: sha256(content),
      ...(attachment ? { overflow: attachment } : {}),
    });
    return {
      index,
      content,
      nonce: discordMessageNonce(nonceSeed, index),
      descriptorSha256,
      ...(attachment && overflowMarkdown !== undefined
        ? {
            overflowAttachment: {
              filename: attachment.filename,
              markdown: overflowMarkdown,
              contentSha256: attachment.content_sha256,
              byteLength: attachment.byte_length,
            },
          }
        : {}),
    };
  });
  return {
    chunks,
    metadata: {
      kind: 'discord_delivery',
      formatter_version: DISCORD_DELIVERY_FORMATTER_VERSION,
      source_sha256: sha256(canonicalSource),
      chunks: chunks.map((chunk) => ({
        index: chunk.index,
        descriptor_sha256: chunk.descriptorSha256,
      })),
      ...(overflow ? { overflow_attachment: overflow } : {}),
    },
  };
}

export function discordDeliveryIdentityMatches(
  left: GatewayDiscordDeliveryExecutionMetadata,
  right: GatewayDiscordDeliveryExecutionMetadata
): boolean {
  return (
    left.formatter_version === right.formatter_version &&
    left.source_sha256 === right.source_sha256 &&
    left.chunks.length === right.chunks.length &&
    left.chunks.every(
      (chunk, index) =>
        chunk.index === right.chunks[index]?.index &&
        chunk.descriptor_sha256 === right.chunks[index]?.descriptor_sha256
    ) &&
    JSON.stringify(left.overflow_attachment ?? null) ===
      JSON.stringify(right.overflow_attachment ?? null)
  );
}
