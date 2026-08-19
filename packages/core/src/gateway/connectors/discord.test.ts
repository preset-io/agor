import { describe, expect, it, vi } from 'vitest';
import { validateDiscordConfig } from '../../types/gateway';
import type { GatewayListenerOptions } from '../connector';
import { chunkDiscordMessage, DiscordConnector, stripDiscordBotMention } from './discord';

const config = {
  bot_token: 'discord-secret',
  application_id: '666666666666666666',
  guild_id: '222222222222222222',
  allowed_channel_ids: ['333333333333333333'],
  allowed_user_ids: ['444444444444444444'],
  allowed_role_ids: ['555555555555555555'],
  outbound_enabled: true,
  default_outbound_target: 'channel:333333333333333333',
};

function makeTransport() {
  let dispatch: ((payload: unknown, shardId: number) => void) | undefined;
  let onSessionInfo: ((sessionInfo: unknown) => Promise<void>) | undefined;
  const rest = {
    get: vi.fn<(route: string) => Promise<unknown>>(async (route: string) => {
      if (route.startsWith('/users/')) return { id: config.application_id, username: 'Agor' };
      if (route.includes('/gateway/bot')) return { shards: 1 };
      if (route.includes('/members/'))
        return { user: { id: config.application_id }, roles: [], permissions: '274877975552' };
      if (route.startsWith('/guilds/'))
        return {
          id: config.guild_id,
          name: 'Guild',
          roles: [{ id: config.guild_id, permissions: '0' }],
        };
      if (route.startsWith('/channels/')) {
        return {
          id: config.allowed_channel_ids[0],
          guild_id: config.guild_id,
          name: 'general',
          type: 0,
        };
      }
      return {
        id: config.guild_id,
        name: 'Guild',
        roles: [{ id: config.guild_id, permissions: '0' }],
        type: 0,
      };
    }),
    post: vi.fn<(route: string, options?: { body?: unknown }) => Promise<unknown>>(async () => ({
      id: '777777777777777777',
    })),
  };
  const gateway = {
    on: vi.fn((_event: unknown, listener: (payload: unknown, shardId: number) => void) => {
      dispatch = listener;
    }),
    connect: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  };
  const transport = {
    rest,
    createGateway: vi.fn((options: { onSessionInfo: (sessionInfo: unknown) => Promise<void> }) => {
      onSessionInfo = options.onSessionInfo;
      return gateway;
    }),
  };
  return {
    transport,
    rest,
    gateway,
    dispatch: () => dispatch,
    updateSessionInfo: (sessionInfo: unknown) => onSessionInfo?.(sessionInfo),
  };
}

describe('Discord connector beta', () => {
  it('chunks at Discord’s hard limit and avoids empty trailing chunks', () => {
    const chunks = chunkDiscordMessage(`${'a'.repeat(1999)}\n${'b'.repeat(1999)}`);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join('')).toBe(`${'a'.repeat(1999)}\n${'b'.repeat(1999)}`);
  });

  it('does not split Unicode surrogate pairs at the chunk boundary', () => {
    const text = `${'a'.repeat(1999)}😀tail`;
    const chunks = chunkDiscordMessage(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 2000)).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('😀'))).toBe(true);
  });

  it('keeps fence delimiters and complete language tags atomic at every boundary', () => {
    for (const ordinaryLength of [1997, 1998, 1999]) {
      const chunks = chunkDiscordMessage(`${'a'.repeat(ordinaryLength)}\`\`\`ts\ncode`);
      expect(chunks[0]).toBe('a'.repeat(ordinaryLength));
      expect(chunks[1]).toMatch(/^```ts\n/);
      expect(chunks.every((chunk) => Array.from(chunk).length <= 2_000)).toBe(true);
    }
  });

  it('reserves fence suffix and reopening prefix around astral text and closing delimiters', () => {
    const text = `\`\`\`typescript\n${'😀'.repeat(2_500)}\n\`\`\``;
    const chunks = chunkDiscordMessage(text);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 2_000)).toBe(true);
    expect(chunks.slice(1, -1).every((chunk) => chunk.startsWith('```typescript\n'))).toBe(true);
    expect(chunks.slice(0, -1).every((chunk) => chunk.endsWith('\n```'))).toBe(true);
    expect(chunks.at(-1)).toMatch(/\n```$/);
  });

  it('fails instead of truncating an indivisible fence opener', () => {
    expect(() => chunkDiscordMessage(`\`\`\`${'x'.repeat(40)}\n`, 32)).toThrow(
      'Discord chunk limit cannot accommodate a Markdown fence'
    );
  });

  it('reopens language-tagged Markdown fences deterministically across chunks', () => {
    const text = `\`\`\`typescript\n${'😀'.repeat(2_100)}\n\`\`\``;
    const first = chunkDiscordMessage(text);
    const second = chunkDiscordMessage(text);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);
    expect(first.every((chunk) => Array.from(chunk).length <= 2_000)).toBe(true);
    expect(first[0]).toMatch(/^```typescript\n/);
    expect(first.slice(0, -1).every((chunk) => chunk.endsWith('\n```'))).toBe(true);
    expect(first.slice(1).every((chunk) => chunk.startsWith('```typescript\n'))).toBe(true);
    expect(first.at(-1)).toMatch(/\n```$/);
    expect(first.join('')).toContain('😀');
  });

  it('strips both Discord mention spellings', () => {
    expect(stripDiscordBotMention('<@666666666666666666> hello', '666666666666666666')).toBe(
      'hello'
    );
    expect(stripDiscordBotMention('<@!666666666666666666> hello', '666666666666666666')).toBe(
      'hello'
    );
  });

  it('rejects malformed allowlist fields instead of silently ignoring them', () => {
    expect(
      validateDiscordConfig({
        ...config,
        allowed_user_ids: 'not-an-array',
        allowed_role_ids: ['555555555555555555'],
      }).errors
    ).toContain('allowed_user_ids must contain only Discord snowflakes');
  });

  it('sends text-only replies, suppresses generated mentions, and returns aliases for every chunk', async () => {
    const { transport, rest } = makeTransport();
    const connector = new DiscordConnector(config, transport as never);
    const receipt = await connector.sendMessage({
      threadId: 'discord:message:333333333333333333:888888888888888888',
      text: 'hello',
    });
    expect(rest.post).toHaveBeenCalledWith(
      '/channels/333333333333333333/messages',
      expect.objectContaining({
        body: expect.objectContaining({
          content: 'hello',
          allowed_mentions: { parse: [] },
          message_reference: expect.objectContaining({ message_id: '888888888888888888' }),
        }),
      })
    );
    expect(receipt.messageId).toBe('777777777777777777');
    expect(receipt.replyAliases).toEqual(['discord:message:333333333333333333:777777777777777777']);
  });

  it('accepts only mentioned text from the configured guild/channel and persists ordered checkpoints', async () => {
    const { transport, gateway, dispatch, updateSessionInfo } = makeTransport();
    const connector = new DiscordConnector(config, transport as never);
    const received: unknown[] = [];
    const saveCheckpoint = vi.fn(async (_checkpoint: Record<string, unknown>) => true);
    await connector.startListening(
      async (message) => {
        received.push(message);
      },
      { saveCheckpoint } satisfies GatewayListenerOptions
    );
    const emit = dispatch();
    expect(emit).toBeDefined();
    await updateSessionInfo?.({
      sessionId: 'session-1',
      sequence: 4,
      resumeURL: 'wss://gateway.example',
      shardCount: 1,
      shardId: 0,
    });
    emit?.(
      {
        t: 'MESSAGE_CREATE',
        s: 4,
        d: {
          id: '888888888888888888',
          guild_id: '222222222222222222',
          channel_id: '333333333333333333',
          type: 0,
          content: '<@666666666666666666> do the thing',
          author: { id: '444444444444444444', bot: false },
          member: { roles: [] },
          mentions: [{ id: '666666666666666666' }],
          attachments: [],
          embeds: [],
          components: [],
        },
      },
      0
    );
    emit?.(
      {
        t: 'MESSAGE_CREATE',
        s: 5,
        d: {
          id: '999999999999999999',
          guild_id: '222222222222222222',
          channel_id: '333333333333333333',
          type: 0,
          content: 'not mentioned',
          author: { id: '444444444444444444', bot: false },
          member: { roles: [] },
        },
      },
      0
    );
    await (connector as unknown as { dispatchChain: Promise<void> }).dispatchChain;
    expect(received).toHaveLength(1);
    expect((received[0] as { text: string }).text).toBe('do the thing');
    expect((received[0] as { threadId: string }).threadId).toBe(
      'discord:message:333333333333333333:888888888888888888'
    );
    expect((received[0] as { providerEventId: string }).providerEventId).toContain(
      '888888888888888888'
    );
    expect(saveCheckpoint.mock.calls.map(([checkpoint]) => checkpoint.sequence)).toEqual([4, 5]);
    expect(gateway.connect).toHaveBeenCalledOnce();
    await connector.stopListening();
    expect(gateway.destroy).toHaveBeenCalledOnce();
  });

  it('accepts ordinary text messages in existing public threads and routes replies to that thread', async () => {
    const { transport, rest, gateway, dispatch } = makeTransport();
    rest.get.mockImplementation(async (route: string) => {
      if (route.startsWith('/users/')) return { id: config.application_id, username: 'Agor' };
      if (route.includes('/gateway/bot')) return { shards: 1 };
      if (route.includes('/members/'))
        return { user: { id: config.application_id }, roles: [], permissions: '274877975552' };
      if (route === '/channels/888888888888888888') {
        return {
          id: '888888888888888888',
          guild_id: config.guild_id,
          parent_id: config.allowed_channel_ids[0],
          type: 11,
        };
      }
      if (route.startsWith('/channels/')) {
        return { id: config.allowed_channel_ids[0], guild_id: config.guild_id, type: 0 };
      }
      return { id: config.guild_id, name: 'Guild' };
    });
    const connector = new DiscordConnector(config, transport as never);
    const received: unknown[] = [];
    await connector.startListening(async (message) => {
      received.push(message);
    });
    dispatch()?.(
      {
        t: 'MESSAGE_CREATE',
        s: 6,
        d: {
          id: '999999999999999999',
          guild_id: config.guild_id,
          channel_id: '888888888888888888',
          type: 0,
          content: '<@666666666666666666> continue here',
          author: { id: '444444444444444444', bot: false },
          member: { roles: [] },
          attachments: [],
          embeds: [],
          components: [],
        },
      },
      0
    );
    await (connector as unknown as { dispatchChain: Promise<void> }).dispatchChain;

    expect(received[0]).toMatchObject({
      text: 'continue here',
      threadId: 'discord:thread:333333333333333333:888888888888888888',
    });
    await connector.sendMessage({
      threadId: 'discord:thread:333333333333333333:888888888888888888',
      text: 'thread reply',
    });
    expect(rest.post).toHaveBeenCalledWith(
      '/channels/888888888888888888/messages',
      expect.objectContaining({ body: expect.objectContaining({ content: 'thread reply' }) })
    );
    await connector.stopListening();
    expect(gateway.destroy).toHaveBeenCalledOnce();
  });

  it('stops and reports processing failures without checkpointing later sequences', async () => {
    const { transport, gateway, dispatch } = makeTransport();
    const connector = new DiscordConnector(config, transport as never);
    const onError = vi.fn(async () => undefined);
    const saveCheckpoint = vi.fn(async (_checkpoint: Record<string, unknown>) => true);
    await connector.startListening(
      async () => {
        throw new Error('routing failed');
      },
      { onError, saveCheckpoint } satisfies GatewayListenerOptions
    );
    const emit = dispatch();
    emit?.(
      {
        t: 'MESSAGE_CREATE',
        s: 7,
        d: {
          id: '777777777777777777',
          guild_id: config.guild_id,
          channel_id: config.allowed_channel_ids[0],
          type: 0,
          content: '<@666666666666666666> fail this',
          author: { id: '444444444444444444', bot: false },
          member: { roles: [] },
          attachments: [],
          embeds: [],
          components: [],
        },
      },
      0
    );
    emit?.(
      {
        t: 'MESSAGE_CREATE',
        s: 8,
        d: {
          id: '888888888888888888',
          guild_id: config.guild_id,
          channel_id: config.allowed_channel_ids[0],
          type: 0,
          content: '<@666666666666666666> must not overtake',
          author: { id: '444444444444444444', bot: false },
          member: { roles: [] },
          attachments: [],
          embeds: [],
          components: [],
        },
      },
      0
    );
    await (connector as unknown as { dispatchChain: Promise<void> }).dispatchChain;
    expect(onError).toHaveBeenCalledOnce();
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(gateway.destroy).toHaveBeenCalledOnce();
  });

  it('only permits the configured proactive channel target', async () => {
    const { transport } = makeTransport();
    const connector = new DiscordConnector(config, transport as never);
    await expect(
      connector.sendMessage({
        threadId: 'discord:thread:999999999999999999:999999999999999999',
        text: 'nope',
      })
    ).rejects.toThrow('allowed channel');
    await expect(
      connector.sendDirectMessage({ target: 'channel:999999999999999999', text: 'nope' })
    ).rejects.toThrow('allowed channel');
    await expect(
      connector.sendDirectMessage({ target: 'channel:333333333333333333', text: 'yes' })
    ).resolves.toMatchObject({ platformChannelId: '333333333333333333' });
  });

  it('sanitizes token-shaped Discord provider failures at the connector boundary', async () => {
    const { transport, rest } = makeTransport();
    rest.post.mockRejectedValueOnce(
      new Error(
        'Bot abcdefghijklmnopqrst https://discord.example.test/api /srv/agor/private-key\nunsafe'
      )
    );
    const connector = new DiscordConnector(config, transport as never);

    const result = connector.sendDirectMessage({
      target: 'channel:333333333333333333',
      text: 'hello',
    });
    await expect(result).rejects.toThrow(/redacted|provider-url|path/);
    await expect(result).rejects.not.toThrow('Bot abcdefghijklmnopqrst');
    await expect(result).rejects.not.toThrow('https://discord.example.test');
  });

  it('connection probes reject a private text channel', async () => {
    const { transport, rest } = makeTransport();
    rest.get.mockImplementation(async (route: string) => {
      if (route.startsWith('/users/')) return { id: config.application_id, username: 'Agor' };
      if (route.includes('/gateway/bot')) return { shards: 1 };
      if (route.includes('/members/'))
        return { user: { id: config.application_id }, roles: [], permissions: '274877975552' };
      if (route.startsWith('/guilds/'))
        return {
          id: config.guild_id,
          name: 'Guild',
          roles: [{ id: config.guild_id, permissions: '0' }],
        };
      return {
        id: config.allowed_channel_ids[0],
        guild_id: config.guild_id,
        type: 0,
        permission_overwrites: [{ id: config.guild_id, type: 0, deny: '1024' }],
      };
    });
    const connector = new DiscordConnector(config, transport as never);
    await expect(connector.testConnection()).resolves.toMatchObject({
      ok: false,
      failures: [{ capability: 'channel_access' }],
    });
  });

  it('rejects a multi-shard recommendation before opening the gateway', async () => {
    const { transport, rest, gateway } = makeTransport();
    rest.get.mockImplementation(async (route: string) => {
      if (route.includes('/gateway/bot')) return { shards: 2 };
      if (route.startsWith('/users/')) return { id: config.application_id };
      return { id: config.guild_id, guild_id: config.guild_id, type: 0 };
    });
    const connector = new DiscordConnector(config, transport as never);
    await expect(connector.startListening(async () => undefined)).rejects.toMatchObject({
      code: 'discord_sharding_unsupported',
    });
    expect(gateway.connect).not.toHaveBeenCalled();
  });

  it('reports sampled permission bits and explicit probe limitations', async () => {
    const { transport } = makeTransport();
    const connector = new DiscordConnector(config, transport as never);
    const result = await connector.testConnection();
    expect(result.ok).toBe(true);
    expect(result.channelAccess).toEqual([
      expect.objectContaining({
        channelId: '333333333333333333',
        ok: true,
        permissions: expect.objectContaining({
          view: true,
          send: true,
          readHistory: true,
        }),
      }),
    ]);
    expect(result.notVerifiable.join(' ')).toMatch(
      /event|reply|role matchability|end-to-end session/i
    );
  });
});
