import { describe, expect, it, vi } from 'vitest';
import {
  DISCORD_NONCE_RECOVERY_MAX_PAGES,
  discordNonceRecoveryWindowFromTimes,
  recoverDiscordMessageByNonce,
} from './discord-nonce-recovery';

const CHANNEL_ID = '423456789012345678';
const BOT_ID = '123456789012345678';
const OTHER_BOT_ID = '223456789012345678';

function message(id: string, nonce: string, authorId = BOT_ID) {
  return {
    id,
    nonce,
    author: { id: authorId, bot: true, username: 'bot' },
    webhook_id: undefined,
  } as never;
}

describe('Discord deterministic nonce recovery', () => {
  it('derives bounded Snowflake cursors from canonical DB timestamps', () => {
    const window = discordNonceRecoveryWindowFromTimes(
      '2026-08-18T12:00:00.000Z',
      '2026-08-18T12:05:00.000Z'
    );
    expect(BigInt(window.after)).toBeLessThan(BigInt(window.before));
  });

  it('finds only an exact bot-authored nonce and fences every history page', async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      message(String(900 - index), 'target-nonce', OTHER_BOT_ID)
    );
    const get = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([message('750', 'target-nonce')]);
    const beforeRest = vi.fn(async () => undefined);

    await expect(
      recoverDiscordMessageByNonce({
        rest: { get } as never,
        channelId: CHANNEL_ID,
        botUserId: BOT_ID,
        nonce: 'target-nonce',
        window: { after: '100', before: '1000' },
        beforeRest,
      })
    ).resolves.toMatchObject({ outcome: 'found', providerMessageId: '750', pages: 2 });
    expect(beforeRest).toHaveBeenCalledTimes(2);
  });

  it('proves absence only after reaching a boundary or short final page', async () => {
    const get = vi.fn().mockResolvedValue([message('500', 'different-nonce')]);
    await expect(
      recoverDiscordMessageByNonce({
        rest: { get } as never,
        channelId: CHANNEL_ID,
        botUserId: BOT_ID,
        nonce: 'target-nonce',
        window: { after: '100', before: '1000' },
      })
    ).resolves.toMatchObject({ outcome: 'absent', pages: 1, messages: 1 });
  });

  it('returns incomplete instead of authorizing a blind POST after the page bound', async () => {
    let upper = 20_000;
    const get = vi.fn(async () => {
      const page = Array.from({ length: 100 }, (_, index) =>
        message(String(upper - index), 'different-nonce')
      );
      upper -= 100;
      return page;
    });
    await expect(
      recoverDiscordMessageByNonce({
        rest: { get } as never,
        channelId: CHANNEL_ID,
        botUserId: BOT_ID,
        nonce: 'target-nonce',
        window: { after: '100', before: '21000' },
      })
    ).resolves.toMatchObject({
      outcome: 'incomplete',
      pages: DISCORD_NONCE_RECOVERY_MAX_PAGES,
      messages: 1_000,
    });
    expect(get).toHaveBeenCalledTimes(DISCORD_NONCE_RECOVERY_MAX_PAGES);
  });

  it('aborts before another history page when its owner fence is lost', async () => {
    const controller = new AbortController();
    const get = vi.fn();
    const beforeRest = vi.fn(async () => controller.abort(new Error('owner lost')));
    await expect(
      recoverDiscordMessageByNonce({
        rest: { get } as never,
        channelId: CHANNEL_ID,
        botUserId: BOT_ID,
        nonce: 'target-nonce',
        window: { after: '100', before: '1000' },
        signal: controller.signal,
        beforeRest,
      })
    ).rejects.toThrow('owner lost');
    expect(get).not.toHaveBeenCalled();
  });
});
