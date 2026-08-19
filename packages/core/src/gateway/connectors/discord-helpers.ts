import { ChannelType as DiscordChannelType } from 'discord-api-types/v10';

import type { DiscordSnowflake } from '../../types/gateway';
import { isDiscordSnowflake } from './discord-config';

const DISCORD_THREAD_PREFIX = 'discord:';

/** One canonical external-conversation key for all Discord gateway paths. */
export function buildDiscordThreadId(threadChannelId: DiscordSnowflake): string {
  if (!isDiscordSnowflake(threadChannelId)) {
    throw new Error('Invalid Discord thread channel Snowflake');
  }
  return `${DISCORD_THREAD_PREFIX}${threadChannelId}`;
}

export function parseDiscordThreadId(threadId: string): DiscordSnowflake {
  if (!threadId.startsWith(DISCORD_THREAD_PREFIX)) {
    throw new Error('Invalid Discord thread ID (expected discord:<snowflake>)');
  }
  const snowflake = threadId.slice(DISCORD_THREAD_PREFIX.length);
  if (!isDiscordSnowflake(snowflake)) {
    throw new Error('Invalid Discord thread ID (expected discord:<snowflake>)');
  }
  return snowflake;
}

/** Stable durable occurrence identity; Gateway sequence is not part of it. */
export function buildDiscordProviderEventId(
  applicationId: DiscordSnowflake,
  messageId: DiscordSnowflake
): string {
  if (!isDiscordSnowflake(applicationId) || !isDiscordSnowflake(messageId)) {
    throw new Error('Invalid Discord application or message Snowflake');
  }
  return `discord:message:${applicationId}:${messageId}`;
}

/** Parent surfaces launch explicitly supports. */
export function isDiscordAllowedParentType(channelType: number): boolean {
  return (
    channelType === DiscordChannelType.GuildText || channelType === DiscordChannelType.GuildForum
  );
}

/** Public/forum posts share Discord's public-thread channel type. */
export function isDiscordSupportedThreadType(channelType: number): boolean {
  return channelType === DiscordChannelType.PublicThread;
}

/**
 * Invocation is authorized only by Discord's structured mentions array.
 * Text such as `<@123>` in code or a lookalike string is never sufficient.
 */
export function discordMessageHasStructuredMention(
  mentions: unknown,
  botUserId: DiscordSnowflake
): boolean {
  if (!isDiscordSnowflake(botUserId) || !Array.isArray(mentions)) return false;
  return mentions.some(
    (mention) =>
      !!mention &&
      typeof mention === 'object' &&
      (mention as Record<string, unknown>).id === botUserId
  );
}

interface DiscordMentionScanResult {
  text: string;
  hasInvocation: boolean;
}

function scanMentionOutsideInlineCode(
  line: string,
  mentionPatterns: readonly string[]
): DiscordMentionScanResult {
  let output = '';
  let cursor = 0;
  let inlineDelimiter = '';
  let hasInvocation = false;
  while (cursor < line.length) {
    if (line[cursor] === '`') {
      let end = cursor + 1;
      while (line[end] === '`') end += 1;
      const delimiter = line.slice(cursor, end);
      if (!inlineDelimiter) inlineDelimiter = delimiter;
      else if (delimiter === inlineDelimiter) inlineDelimiter = '';
      output += delimiter;
      cursor = end;
      continue;
    }

    if (!inlineDelimiter) {
      const mention = mentionPatterns.find((pattern) => line.startsWith(pattern, cursor));
      if (mention) {
        hasInvocation = true;
        cursor += mention.length;
        if (line[cursor] === ' ') cursor += 1;
        continue;
      }
    }

    const codePoint = line.codePointAt(cursor);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    output += character;
    cursor += character.length;
  }
  return { text: output, hasInvocation };
}

function scanDiscordBotMentions(
  content: string,
  botUserId: DiscordSnowflake
): DiscordMentionScanResult {
  if (!isDiscordSnowflake(botUserId)) return { text: content, hasInvocation: false };
  const mentionPatterns = [`<@${botUserId}>`, `<@!${botUserId}>`] as const;
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let fence: { marker: '`' | '~'; length: number } | null = null;
  let hasInvocation = false;
  const output = lines.map((line) => {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match) {
      const marker = match[1][0] as '`' | '~';
      if (!fence) {
        fence = { marker, length: match[1].length };
        return line;
      }
      if (marker === fence.marker && match[1].length >= fence.length) {
        fence = null;
      }
      return line;
    }
    if (fence) return line;
    const scanned = scanMentionOutsideInlineCode(line, mentionPatterns);
    hasInvocation ||= scanned.hasInvocation;
    return scanned.text;
  });

  return { text: output.join('\n').trim(), hasInvocation };
}

/** Require an actual bot mention token outside inline and fenced code. */
export function discordMessageHasInvocationMention(
  content: string,
  botUserId: DiscordSnowflake
): boolean {
  return scanDiscordBotMentions(content, botUserId).hasInvocation;
}

/**
 * Remove the authenticated bot invocation token while preserving lookalikes
 * inside inline/fenced code. Callers must separately require the structured
 * mentions array before treating the result as an invocation.
 */
export function stripDiscordBotMention(content: string, botUserId: DiscordSnowflake): string {
  return scanDiscordBotMentions(content, botUserId).text;
}
