import { ChannelType as DiscordChannelType } from 'discord-api-types/v10';
import { describe, expect, it } from 'vitest';

import {
  buildDiscordProviderEventId,
  buildDiscordThreadId,
  discordMessageHasInvocationMention,
  discordMessageHasStructuredMention,
  isDiscordAllowedParentType,
  isDiscordSupportedThreadType,
  parseDiscordThreadId,
  stripDiscordBotMention,
} from './discord-helpers';

const BOT_ID = '123456789012345678';

describe('Discord routing and mention helpers', () => {
  it('uses one canonical provider-prefixed thread encoding', () => {
    expect(buildDiscordThreadId('223456789012345678')).toBe('discord:223456789012345678');
    expect(parseDiscordThreadId('discord:223456789012345678')).toBe('223456789012345678');
    expect(() => parseDiscordThreadId('223456789012345678')).toThrow(/discord:<snowflake>/);
    expect(buildDiscordProviderEventId(BOT_ID, '323456789012345678')).toBe(
      'discord:message:123456789012345678:323456789012345678'
    );
  });

  it('accepts only public text/forum parents and public/forum-post threads', () => {
    expect(isDiscordAllowedParentType(DiscordChannelType.GuildText)).toBe(true);
    expect(isDiscordAllowedParentType(DiscordChannelType.GuildForum)).toBe(true);
    expect(isDiscordAllowedParentType(DiscordChannelType.GuildAnnouncement)).toBe(false);
    expect(isDiscordAllowedParentType(DiscordChannelType.GuildMedia)).toBe(false);
    expect(isDiscordSupportedThreadType(DiscordChannelType.PublicThread)).toBe(true);
    expect(isDiscordSupportedThreadType(DiscordChannelType.AnnouncementThread)).toBe(false);
    expect(isDiscordSupportedThreadType(DiscordChannelType.PrivateThread)).toBe(false);
  });

  it('requires a structured bot mention rather than raw/code lookalikes', () => {
    expect(discordMessageHasStructuredMention([{ id: BOT_ID }], BOT_ID)).toBe(true);
    expect(discordMessageHasStructuredMention([], BOT_ID)).toBe(false);
    expect(discordMessageHasStructuredMention([{ id: '223456789012345678' }], BOT_ID)).toBe(false);
    expect(discordMessageHasStructuredMention(`<@${BOT_ID}>`, BOT_ID)).toBe(false);
  });

  it('strips active invocation tokens but preserves mention text inside code', () => {
    const content = [
      `<@${BOT_ID}> please inspect \`<@${BOT_ID}>\``,
      '```ts',
      `const example = '<@${BOT_ID}>';`,
      '```',
      `<@!${BOT_ID}> follow up`,
    ].join('\n');

    expect(stripDiscordBotMention(content, BOT_ID)).toBe(
      [
        `please inspect \`<@${BOT_ID}>\``,
        '```ts',
        `const example = '<@${BOT_ID}>';`,
        '```',
        'follow up',
      ].join('\n')
    );
    expect(discordMessageHasInvocationMention(content, BOT_ID)).toBe(true);
    expect(discordMessageHasInvocationMention(`\`<@${BOT_ID}>\``, BOT_ID)).toBe(false);
    expect(
      discordMessageHasInvocationMention(['```', `<@${BOT_ID}>`, '```'].join('\n'), BOT_ID)
    ).toBe(false);
  });
});
