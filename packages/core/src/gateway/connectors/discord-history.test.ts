import { RateLimitError } from '@discordjs/rest';
import { describe, expect, it, vi } from 'vitest';
import type { DiscordGatewayConfig } from '../../types/gateway';
import {
  DiscordHistoryError,
  fetchDiscordChannelHistory,
  fetchDiscordProviderHistory,
} from './discord-history';

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

  it('includes a forwarded message in catch-up with its snapshot text', async () => {
    const result = await fetchDiscordProviderHistory(
      pagedRest([
        [
          message(id(1n), {
            content: '',
            message_snapshots: [{ message: { content: 'forwarded body' } }],
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
    );
    expect(result.messages.map((item) => item.text)).toContain('forwarded body');
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

describe('Discord channel history for agents', () => {
  const channelId = '333333333333333333';
  const at = (offset: number) => id(BigInt(offset));

  function channelMessage(offset: number, patch: Record<string, unknown> = {}) {
    return { ...message(at(offset), patch), channel_id: channelId };
  }

  /** Fake Discord REST honoring before/after/limit semantics, newest-first pages. */
  function channelRest(messages: Array<Record<string, unknown>>) {
    const sorted = [...messages].sort((a, b) =>
      BigInt(a.id as string) < BigInt(b.id as string) ? -1 : 1
    );
    const get = vi.fn(async (route: string) => {
      const parsed = new URL(`https://discord.invalid${route}`);
      expect(parsed.pathname).toBe(`/channels/${channelId}/messages`);
      const limit = Number(parsed.searchParams.get('limit'));
      const before = parsed.searchParams.get('before');
      const after = parsed.searchParams.get('after');
      if (before && after) throw new Error('fake Discord REST rejected mixed pagination bounds');
      let page: Array<Record<string, unknown>>;
      if (after) {
        page = sorted.filter((item) => BigInt(item.id as string) > BigInt(after)).slice(0, limit);
      } else {
        const older = before
          ? sorted.filter((item) => BigInt(item.id as string) < BigInt(before))
          : sorted;
        page = older.slice(Math.max(0, older.length - limit));
      }
      return [...page].reverse();
    });
    return { get };
  }

  const range = (from: number, to: number, patch: Record<string, unknown> = {}) =>
    Array.from({ length: to - from + 1 }, (_, index) => channelMessage(from + index, patch));

  it('returns the newest messages in chronological order with a continuation cursor', async () => {
    const rest = channelRest(range(1, 120));
    const result = await fetchDiscordChannelHistory(rest, config, { channelId });

    expect(result.messages.map((item) => item.id)).toEqual(range(71, 120).map((item) => item.id));
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toEqual({ before: at(71) });

    const next = await fetchDiscordChannelHistory(rest, config, {
      channelId,
      before: at(71),
      limit: 200,
    });
    expect(next.messages.map((item) => item.id)).toEqual(range(1, 70).map((item) => item.id));
    expect(next.has_more).toBe(false);
    expect(next.next_cursor).toBeNull();
  });

  it('pages forward from an after cursor without gaps', async () => {
    const rest = channelRest(range(1, 150));
    const first = await fetchDiscordChannelHistory(rest, config, {
      channelId,
      after: at(10),
      limit: 100,
    });
    expect(first.messages[0]?.id).toBe(at(11));
    expect(first.messages.at(-1)?.id).toBe(at(110));
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual({ after: at(110) });

    const second = await fetchDiscordChannelHistory(rest, config, {
      channelId,
      after: at(110),
      limit: 100,
    });
    expect(second.messages.map((item) => item.id)).toEqual(range(111, 150).map((item) => item.id));
    expect(second.has_more).toBe(false);
  });

  it('needs one more request to prove an exactly full final page is the end', async () => {
    const rest = channelRest(range(1, 100));
    const result = await fetchDiscordChannelHistory(rest, config, { channelId, limit: 200 });

    expect(result.messages).toHaveLength(100);
    expect(result.has_more).toBe(false);
    expect(rest.get).toHaveBeenCalledTimes(2);
  });

  it('omits bots by default and returns a partial page when the page budget runs out', async () => {
    const messages = [
      channelMessage(1),
      ...range(2, 251, { author: { bot: true }, content: 'bot noise' }),
    ];
    const rest = channelRest(messages);
    const limited = { catch_up: { ...config.catch_up!, max_pages: 2 } };

    const result = await fetchDiscordChannelHistory(rest, limited, { channelId });
    expect(result.messages).toEqual([]);
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toEqual({ before: at(52) });
    expect(rest.get).toHaveBeenCalledTimes(2);

    const continued = await fetchDiscordChannelHistory(rest, limited, {
      channelId,
      before: at(52),
    });
    expect(continued.messages.map((item) => item.id)).toEqual([at(1)]);
    expect(continued.has_more).toBe(false);

    const withBots = await fetchDiscordChannelHistory(rest, config, {
      channelId,
      limit: 3,
      includeBotMessages: true,
    });
    expect(withBots.messages.map((item) => item.is_bot)).toEqual([true, true, true]);
  });

  it('does not report more when only filtered messages remain after the limit', async () => {
    const rest = channelRest([
      ...range(1, 2, { author: { bot: true }, content: 'bot noise' }),
      channelMessage(3),
      channelMessage(4),
    ]);
    const result = await fetchDiscordChannelHistory(rest, config, { channelId, limit: 2 });
    expect(result.messages.map((item) => item.id)).toEqual([at(3), at(4)]);
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
  });

  it('stops at the byte budget and truncates only a single oversized message', async () => {
    const rest = channelRest([
      channelMessage(1, { content: 'a'.repeat(40) }),
      channelMessage(2, { content: 'b'.repeat(40) }),
      channelMessage(3, { content: 'c'.repeat(40) }),
    ]);
    const small = { catch_up: { ...config.catch_up!, max_prompt_bytes: 100 } };

    const budgeted = await fetchDiscordChannelHistory(rest, small, { channelId });
    expect(budgeted.messages.map((item) => item.id)).toEqual([at(2), at(3)]);
    expect(budgeted.has_more).toBe(true);
    expect(budgeted.next_cursor).toEqual({ before: at(2) });

    const tiny = { catch_up: { ...config.catch_up!, max_prompt_bytes: 10 } };
    const truncated = await fetchDiscordChannelHistory(rest, tiny, { channelId });
    expect(truncated.messages).toHaveLength(1);
    expect(truncated.messages[0]).toMatchObject({ id: at(3), text: 'c'.repeat(10) });
    expect(truncated.messages[0]?.text_truncated).toBe(true);
    expect(truncated.has_more).toBe(true);
  });

  it('reports attachment metadata and started threads without provider URLs', async () => {
    const rest = channelRest([
      channelMessage(1, {
        attachments: [
          {
            id: '444444444444444444',
            filename: 'plan.png',
            content_type: 'image/png',
            size: 1234,
            url: 'https://cdn.discordapp.com/attachments/signed',
          },
        ],
        thread: { id: '555555555555555555' },
      }),
    ]);
    const result = await fetchDiscordChannelHistory(rest, config, { channelId });
    expect(result.messages[0]).toMatchObject({
      attachments: [{ filename: 'plan.png', content_type: 'image/png', size: 1234 }],
      thread_id: '555555555555555555',
    });
    expect(JSON.stringify(result)).not.toContain('cdn.discordapp.com');
  });

  it('fails closed when Message Content is missing or a page ignores its cursor', async () => {
    const redacted = channelRest([channelMessage(1, { content: '' })]);
    await expect(fetchDiscordChannelHistory(redacted, config, { channelId })).rejects.toMatchObject(
      { kind: 'incomplete_coverage' }
    );

    const ignoresCursor = { get: vi.fn(async () => [channelMessage(5)]) };
    await expect(
      fetchDiscordChannelHistory(ignoresCursor, config, { channelId, before: at(5) })
    ).rejects.toMatchObject({ kind: 'incomplete_coverage' });
  });

  it('reads a forward from its snapshot and flags it', async () => {
    const forward = channelMessage(1, {
      content: '',
      message_reference: { type: 1, channel_id: '444444444444444444', message_id: at(0) },
      message_snapshots: [
        {
          message: {
            content: 'original text',
            attachments: [{ filename: 'notes.txt', content_type: 'text/plain', size: 3 }],
          },
        },
      ],
    });
    const result = await fetchDiscordChannelHistory(channelRest([forward]), config, { channelId });
    expect(result.messages).toEqual([
      expect.objectContaining({
        text: 'original text',
        is_forwarded: true,
        attachments: [{ filename: 'notes.txt', content_type: 'text/plain', size: 3 }],
      }),
    ]);

    const emptyForward = channelMessage(2, {
      content: '',
      message_snapshots: [{ message: { content: '' } }],
    });
    await expect(
      fetchDiscordChannelHistory(channelRest([emptyForward]), config, { channelId })
    ).rejects.toMatchObject({ kind: 'incomplete_coverage' });
  });

  it('treats a rejected @discordjs/rest RateLimitError as budgeted rate limiting', async () => {
    const rateLimited = () =>
      new RateLimitError({
        timeToReset: 1,
        limit: 1,
        method: 'GET',
        hash: 'hash',
        url: 'https://discord.com/api/v10/channels/1/messages',
        route: '/channels/:id/messages',
        majorParameter: channelId,
        global: false,
        retryAfter: 1,
        sublimitTimeout: 0,
        scope: 'user',
      });
    const pages = [rateLimited(), [channelMessage(1)]];
    const retried = {
      get: vi.fn(async () => {
        const next = pages.shift();
        if (next instanceof Error) throw next;
        return next;
      }),
    };
    const result = await fetchDiscordChannelHistory(retried, config, { channelId });
    expect(result.messages.map((item) => item.id)).toEqual([at(1)]);
    expect(retried.get).toHaveBeenCalledTimes(2);

    const noRetries = { catch_up: { ...config.catch_up!, rate_limit_max_retries: 0 } };
    const limited = {
      get: vi.fn(async () => {
        throw rateLimited();
      }),
    };
    await expect(
      fetchDiscordChannelHistory(limited, noRetries, { channelId })
    ).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('rejects invalid requests before calling Discord', async () => {
    const rest = channelRest([]);
    for (const request of [
      { channelId, before: at(1), after: at(2) },
      { channelId, limit: 0 },
      { channelId, limit: 201 },
      { channelId: 'not-a-snowflake' },
    ]) {
      await expect(fetchDiscordChannelHistory(rest, config, request)).rejects.toBeInstanceOf(
        DiscordHistoryError
      );
    }
    expect(rest.get).not.toHaveBeenCalled();
  });
});
