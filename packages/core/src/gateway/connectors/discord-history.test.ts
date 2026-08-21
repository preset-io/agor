import { describe, expect, it, vi } from 'vitest';
import type { DiscordGatewayConfig } from '../../types/gateway';
import { DiscordHistoryError, fetchDiscordProviderHistory } from './discord-history';

const threadId = '111111111111111111';
const lower = 9_000_000_000_000_000_000n;
const id = (offset: bigint) => (lower + offset).toString();
const cursor = id(0n);
const live = id(102n);

const config: DiscordGatewayConfig = {
  catch_up: {
    max_pages: 5,
    max_messages: 200,
    max_prompt_bytes: 32768,
    request_timeout_ms: 1000,
    rate_limit_max_retries: 2,
    rate_limit_max_total_delay_ms: 100,
  },
};

function message(
  messageId: string,
  patch: Record<string, unknown> & { author?: Record<string, unknown> } = {}
) {
  const { author: authorPatch, ...rest } = patch;
  return {
    id: messageId,
    channel_id: threadId,
    timestamp: '2026-08-20T12:00:00.000Z',
    type: 0,
    author: { id: '222222222222222222', username: `user-${messageId}`, ...(authorPatch ?? {}) },
    content: `message-${messageId}`,
    ...rest,
  };
}

function pagedRest(pages: unknown[][]) {
  const get = vi.fn(async (route: string) => {
    if (route === `/channels/${threadId}/messages/${live}`) return message(live);
    const parsed = new URL(`https://discord.invalid${route}`);
    const paginationBounds = ['before', 'after', 'around'].filter((key) =>
      parsed.searchParams.has(key)
    );
    if (paginationBounds.length !== 1 || paginationBounds[0] !== 'before') {
      throw new Error('fake Discord REST rejected mixed pagination bounds');
    }
    const before = parsed.searchParams.get('before');
    const pageIndex = before === live ? 0 : 1;
    return pages[pageIndex] ?? [];
  });
  return { get };
}

describe('Discord bounded history', () => {
  it('proves a multi-page exact interval and orders Snowflakes beyond safe integer', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => message(id(BigInt(101 - index))));
    const secondPage = [message(id(1n), { author: { bot: true }, content: 'bot context' })];
    const rest = pagedRest([firstPage, secondPage]);

    const result = await fetchDiscordProviderHistory(rest, config, {
      threadId,
      afterProviderCursor: cursor,
      throughProviderCursor: live,
      triggerProviderCursor: live,
    });

    expect(result.complete).toBe(true);
    expect(result.messages).toHaveLength(102);
    expect(result.messages[0].providerMessageId).toBe(id(1n));
    expect(result.messages.at(-1)?.providerMessageId).toBe(live);
    expect(result.messages.find((item) => item.providerMessageId === id(1n))?.isBot).toBe(true);
    expect(rest.get).toHaveBeenCalledTimes(3); // live boundary + two history pages
  });

  it('counts bot, system and rich messages for coverage but marks them for prompt omission', async () => {
    const rest = pagedRest([
      [
        message(id(2n), { author: { system: true }, content: 'system context' }),
        message(id(1n), { embeds: [{ title: 'rich' }] }),
      ],
    ]);
    const result = await fetchDiscordProviderHistory(rest, config, {
      threadId,
      afterProviderCursor: cursor,
      throughProviderCursor: live,
      triggerProviderCursor: live,
    });

    expect(result.messages).toHaveLength(3);
    expect(result.messages.find((item) => item.providerMessageId === id(2n))?.isSystem).toBe(true);
    expect(result.messages.find((item) => item.providerMessageId === id(1n))?.isRich).toBe(true);
  });

  it('rejects page, message, duplicate, and provider-boundary violations without partial output', async () => {
    const cases: Array<[string, unknown[], string]> = [
      ['nonmonotonic page', [message(id(1n)), message(id(2n))], 'malformed_response'],
      ['duplicate page boundary', [message(id(2n)), message(id(2n))], 'malformed_response'],
      ['crossed live boundary', [message(id(103n))], 'incomplete_coverage'],
    ];

    for (const [, page, kind] of cases) {
      const rest = pagedRest([page]);
      await expect(
        fetchDiscordProviderHistory(rest, config, {
          threadId,
          afterProviderCursor: cursor,
          throughProviderCursor: live,
          triggerProviderCursor: live,
        })
      ).rejects.toMatchObject({ kind });
    }
  });

  it('excludes the lower cursor, stops when a page reaches it, and supports bootstrap', async () => {
    const rest = pagedRest([
      Array.from({ length: 100 }, (_, index) => message(id(BigInt(101 - index)))),
      [message(id(0n))],
    ]);
    const bounded = await fetchDiscordProviderHistory(rest, config, {
      threadId,
      afterProviderCursor: cursor,
      throughProviderCursor: live,
      triggerProviderCursor: live,
    });
    expect(bounded.messages).toHaveLength(101);
    expect(bounded.messages.some((item) => item.providerMessageId === cursor)).toBe(false);

    const bootstrap = await fetchDiscordProviderHistory(
      pagedRest([
        Array.from({ length: 100 }, (_, index) => message(id(BigInt(101 - index)))),
        [message(id(1n))],
      ]),
      config,
      {
        threadId,
        throughProviderCursor: live,
        triggerProviderCursor: live,
      }
    );
    expect(bootstrap.messages).toHaveLength(102);
    expect(bootstrap.messages[0].providerMessageId).toBe(id(1n));
  });

  it('fails closed for redacted human content but counts valid contentless rich history', async () => {
    await expect(
      fetchDiscordProviderHistory(pagedRest([[message(id(1n), { content: '' })]]), config, {
        threadId,
        afterProviderCursor: cursor,
        throughProviderCursor: live,
        triggerProviderCursor: live,
      })
    ).rejects.toMatchObject({ kind: 'incomplete_coverage' });

    await expect(
      fetchDiscordProviderHistory(
        pagedRest([
          [
            message(id(1n), {
              type: 19,
              content: '',
              attachments: [],
              embeds: [],
              components: [],
              sticker_items: [],
            }),
          ],
        ]),
        config,
        {
          threadId,
          afterProviderCursor: cursor,
          throughProviderCursor: live,
          triggerProviderCursor: live,
        }
      )
    ).rejects.toMatchObject({ kind: 'incomplete_coverage' });

    const result = await fetchDiscordProviderHistory(
      pagedRest([[message(id(1n), { content: '', embeds: [{ title: 'rich' }] })]]),
      config,
      {
        threadId,
        afterProviderCursor: cursor,
        throughProviderCursor: live,
        triggerProviderCursor: live,
      }
    );
    expect(result.messages.find((item) => item.providerMessageId === id(1n))).toMatchObject({
      text: '',
      isRich: true,
    });
  });

  it('enforces page and message ceilings', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => message(id(BigInt(101 - index))));
    await expect(
      fetchDiscordProviderHistory(
        pagedRest([firstPage, [message(id(1n))]]),
        { ...config, catch_up: { ...config.catch_up!, max_pages: 1 } },
        {
          threadId,
          afterProviderCursor: cursor,
          throughProviderCursor: live,
          triggerProviderCursor: live,
        }
      )
    ).rejects.toMatchObject({ kind: 'limit_exceeded' });

    await expect(
      fetchDiscordProviderHistory(
        pagedRest([[message(id(1n))]]),
        { ...config, catch_up: { ...config.catch_up!, max_messages: 1 } },
        {
          threadId,
          afterProviderCursor: cursor,
          throughProviderCursor: live,
          triggerProviderCursor: live,
        }
      )
    ).rejects.toMatchObject({ kind: 'limit_exceeded' });
  });

  it('retries rate limits within the retry-after budget and returns a typed failure after exhaustion', async () => {
    let attempts = 0;
    const rest = {
      get: vi.fn(async (route: string) => {
        attempts += 1;
        if (attempts === 1) throw { status: 429, rawError: { retry_after: 0 } };
        if (route === `/channels/${threadId}/messages/${live}`) return message(live);
        return [];
      }),
    };
    const result = await fetchDiscordProviderHistory(rest, config, {
      threadId,
      afterProviderCursor: live,
      throughProviderCursor: live,
      triggerProviderCursor: live,
    });
    expect(result.messages).toHaveLength(1);
    expect(attempts).toBe(2);

    const exhausted = {
      get: vi.fn(async () => {
        throw { status: 429, rawError: { retry_after: 1 } };
      }),
    };
    await expect(
      fetchDiscordProviderHistory(
        exhausted,
        { ...config, catch_up: { ...config.catch_up!, rate_limit_max_retries: 0 } },
        {
          threadId,
          afterProviderCursor: live,
          throughProviderCursor: live,
          triggerProviderCursor: live,
        }
      )
    ).rejects.toBeInstanceOf(DiscordHistoryError);
  });

  it('enforces the total request-time ceiling', async () => {
    const rest = {
      get: vi.fn(() => new Promise<unknown>(() => undefined)),
    };
    await expect(
      fetchDiscordProviderHistory(
        rest,
        { ...config, catch_up: { ...config.catch_up!, request_timeout_ms: 1 } },
        {
          threadId,
          afterProviderCursor: live,
          throughProviderCursor: live,
          triggerProviderCursor: live,
        }
      )
    ).rejects.toMatchObject({ kind: 'request_timeout' });
  });
});
