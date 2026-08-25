import { describe, expect, it } from 'vitest';
import type { DiscordMessageDeliveryID } from '../types/gateway';
import {
  buildDiscordDeliveryMetadata,
  buildDiscordDeliveryNonce,
  buildDiscordInboundMetadata,
  buildDiscordMessageThreadKey,
  DISCORD_METADATA_KEY,
  extractDiscordStarterMessageId,
  parseDiscordAuthorityMetadata,
  parseDiscordDeliveryNonce,
  parseDiscordThreadKey,
} from './discord-identifiers';

const deliveryId = '018f5f63-0fd1-7c2e-9e7d-8fb27d4a6e1a' as DiscordMessageDeliveryID;

describe('Discord authority identifiers', () => {
  it('round-trips constructed metadata through the strict parser', () => {
    const metadata = buildDiscordInboundMetadata({
      guildId: '222222222222222222',
      channelId: '333333333333333333',
      messageId: '444444444444444444',
      authorId: '555555555555555555',
      roleIds: ['666666666666666666'],
      botUserId: '777777777777777777',
      isThread: false,
    });
    expect(parseDiscordAuthorityMetadata(metadata)).toEqual(metadata);
    expect(metadata[DISCORD_METADATA_KEY.hasMention]).toBe(true);
  });

  it('extracts only a strictly validated starter coordinate', () => {
    const metadata = {
      [DISCORD_METADATA_KEY.thread]: {
        guild_id: '222222222222222222',
        parent_channel_id: '333333333333333333',
        thread_channel_id: '444444444444444444',
        starter_message_id: '555555555555555555',
      },
    };

    expect(extractDiscordStarterMessageId(metadata)).toBe('555555555555555555');
    expect(
      extractDiscordStarterMessageId({
        [DISCORD_METADATA_KEY.thread]: {
          ...metadata[DISCORD_METADATA_KEY.thread],
          starter_message_id: 'not-a-snowflake',
        },
      })
    ).toBeUndefined();
  });

  it.each([
    { [DISCORD_METADATA_KEY.guildId]: 'not-a-snowflake' },
    { [DISCORD_METADATA_KEY.roleIds]: ['not-a-snowflake'] },
    { [DISCORD_METADATA_KEY.isThread]: 'false' },
    {
      [DISCORD_METADATA_KEY.thread]: {
        guild_id: '222222222222222222',
        parent_channel_id: '333333333333333333',
        thread_channel_id: 'bad',
        starter_message_id: '444444444444444444',
      },
    },
    { [DISCORD_METADATA_KEY.deliveryNonce]: 'drifted-nonce' },
    { [DISCORD_METADATA_KEY.enforceNonce]: false },
  ])('rejects malformed authority metadata: %j', (metadata) => {
    expect(parseDiscordAuthorityMetadata(metadata)).toBeNull();
  });

  it('requires the nonce and enforcement decision to travel as a pair', () => {
    const nonce = buildDiscordDeliveryNonce(deliveryId, 0);
    expect(parseDiscordAuthorityMetadata(buildDiscordDeliveryMetadata(nonce))).toEqual(
      buildDiscordDeliveryMetadata(nonce)
    );
    expect(parseDiscordAuthorityMetadata({ [DISCORD_METADATA_KEY.enforceNonce]: true })).toBeNull();
    expect(parseDiscordDeliveryNonce(`${nonce}-drift`)).toBeNull();
    expect(parseDiscordDeliveryNonce(nonce.toUpperCase())).toBeNull();
  });

  it('rejects drifted thread keys and malformed nonce construction inputs', () => {
    expect(
      parseDiscordThreadKey(
        buildDiscordMessageThreadKey('333333333333333333', '444444444444444444')
      )
    ).toEqual({
      kind: 'message',
      channelId: '333333333333333333',
      messageId: '444444444444444444',
    });
    expect(parseDiscordThreadKey('discord:message:333333333333333333:bad')).toBeNull();
    expect(
      parseDiscordThreadKey('discord:thread:333333333333333333:444444444444444444:drift')
    ).toBeNull();
    expect(() => buildDiscordDeliveryNonce('not-a-uuid' as DiscordMessageDeliveryID, 0)).toThrow(
      /canonical delivery UUID/
    );
    expect(() => buildDiscordDeliveryNonce(deliveryId, 1000)).toThrow(/chunk index/);
  });

  it('rejects malformed authority and nonce construction inputs', () => {
    expect(() =>
      buildDiscordInboundMetadata({
        guildId: 'bad',
        channelId: '333333333333333333',
        messageId: '444444444444444444',
        authorId: '555555555555555555',
        roleIds: [],
        botUserId: '777777777777777777',
        isThread: false,
      })
    ).toThrow(/guild ID/);
    expect(() => buildDiscordDeliveryMetadata('drifted-nonce' as never)).toThrow(
      /canonical delivery nonce/
    );
  });
});
