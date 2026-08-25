import { GatewayCloseCodes } from 'discord-api-types/v10';
import { describe, expect, it, vi } from 'vitest';
import { type DiscordMessageDeliveryID, validateDiscordConfig } from '../../types/gateway';
import type { GatewayListenerOptions } from '../connector';
import { buildDiscordDeliveryMetadata, buildDiscordDeliveryNonce } from '../discord-identifiers';
import {
  chunkDiscordMessage,
  DiscordConnector,
  hasStructuredDiscordBotMention,
  stripDiscordBotMention,
} from './discord';

const config = {
  bot_token: 'discord-secret',
  application_id: '666666666666666666',
  guild_id: '222222222222222222',
  allowed_channel_ids: ['333333333333333333'],
  allowed_user_ids: ['444444444444444444'],
  allowed_role_ids: ['555555555555555555'],
  message_content_enabled: true,
  thread_mode: 'public_thread_per_summon' as const,
  thread_auto_archive_minutes: 1440 as const,
  align_discord_users: false,
  catch_up: {
    max_pages: 5,
    max_messages: 200,
    max_prompt_bytes: 32768,
    request_timeout_ms: 30000,
    rate_limit_max_retries: 2,
    rate_limit_max_total_delay_ms: 10000,
  },
  files: false as const,
  agent_tools: [] as never[],
  outbound_enabled: true,
  default_outbound_target: 'channel:333333333333333333',
};

function makeTransport() {
  const listeners = new Map<string, (...args: unknown[]) => void | Promise<void>>();
  let onSessionInfo: ((sessionInfo: unknown) => Promise<void>) | undefined;
  const rest = {
    get: vi.fn<(route: string) => Promise<unknown>>(async (route: string) => {
      if (route.startsWith('/users/')) return { id: config.application_id, username: 'Agor' };
      if (route.includes('/gateway/bot')) return { shards: 1 };
      if (route.includes('/oauth2/applications/@me')) return { flags: '524288' };
      if (route.includes('/members/'))
        return { user: { id: config.application_id }, roles: [], permissions: '309237713920' };
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
    on: vi.fn((_event: unknown, listener: (...args: unknown[]) => void | Promise<void>) => {
      listeners.set(String(_event), listener);
    }),
    connect: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  };
  const transport = {
    rest,
    createGateway: vi.fn(
      (options: {
        checkpoint?: Record<string, unknown> | null;
        onSessionInfo: (sessionInfo: unknown) => Promise<void>;
      }) => {
        onSessionInfo = options.onSessionInfo;
        return gateway;
      }
    ),
  };
  return {
    transport,
    rest,
    gateway,
    dispatch: () =>
      listeners.get('dispatch') as ((payload: unknown, shardId: number) => void) | undefined,
    emitGatewayError: (error: Error) => listeners.get('error')?.(error, 0),
    emitSocketError: (error: Error) => listeners.get('socketError')?.(error, 0),
    emitClosed: (code: number) => listeners.get('closed')?.(code, 0),
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

  it('accepts only structured mentions outside inline and fenced code', () => {
    const mention = (content: string) =>
      hasStructuredDiscordBotMention(
        { content, mentions: [{ id: '666666666666666666' }] },
        '666666666666666666'
      );

    expect(mention('<@666666666666666666> do it')).toBe(true);
    expect(mention('`<@666666666666666666>`')).toBe(false);
    expect(mention('```md\n<@666666666666666666>\n```')).toBe(false);
    expect(
      hasStructuredDiscordBotMention(
        { content: '<@666666666666666666> do it', mentions: [] },
        '666666666666666666'
      )
    ).toBe(false);
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

  it('sends one nonce-enforced delivery chunk and recovers that nonce', async () => {
    const { transport, rest } = makeTransport();
    const nonce = buildDiscordDeliveryNonce(
      '018f5f63-0fd1-7c2e-9e7d-8fb27d4a6e1a' as DiscordMessageDeliveryID,
      0
    );
    rest.get.mockImplementation(async (route: string) => {
      if (route.includes('/messages?limit=100')) {
        return [
          {
            id: '777777777777777777',
            channel_id: '333333333333333333',
            nonce,
            timestamp: new Date().toISOString(),
          },
        ];
      }
      return {
        id: config.allowed_channel_ids[0],
        guild_id: config.guild_id,
        name: 'general',
        type: 0,
      };
    });
    const connector = new DiscordConnector(config, transport as never);
    await connector.sendMessage({
      threadId: 'discord:message:333333333333333333:888888888888888888',
      text: 'recoverable reply',
      metadata: buildDiscordDeliveryMetadata(nonce),
    });
    expect(rest.post).toHaveBeenCalledWith(
      '/channels/333333333333333333/messages',
      expect.objectContaining({
        body: expect.objectContaining({ nonce, enforce_nonce: true }),
      })
    );
    await expect(
      connector.recoverMessageByNonce?.({
        threadId: 'discord:message:333333333333333333:888888888888888888',
        nonce,
      })
    ).resolves.toMatchObject({ messageId: '777777777777777777' });
  });

  it('accepts only mentioned text and does not persist Discord transport checkpoints', async () => {
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
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(transport.createGateway).toHaveBeenCalledWith(
      expect.objectContaining({ checkpoint: undefined })
    );
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
        return { user: { id: config.application_id }, roles: [], permissions: '309237713920' };
      if (route === '/channels/888888888888888888') {
        return {
          id: '888888888888888888',
          guild_id: config.guild_id,
          parent_id: config.allowed_channel_ids[0],
          type: 11,
        };
      }
      if (route === '/channels/333333333333333333/messages/888888888888888888') {
        return { id: '888888888888888888', channel_id: '333333333333333333' };
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
          mentions: [{ id: '666666666666666666' }],
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
    const prepared = await (
      received[0] as { prepareDelivery: () => Promise<Record<string, unknown>> }
    ).prepareDelivery();
    expect(prepared).toMatchObject({
      discord_thread_id: '888888888888888888',
      discord_thread: {
        guild_id: config.guild_id,
        parent_channel_id: config.allowed_channel_ids[0],
        thread_channel_id: '888888888888888888',
        starter_message_id: '888888888888888888',
      },
      discord_thread_accessible: true,
    });
    expect(rest.get).toHaveBeenCalledWith(
      '/channels/333333333333333333/messages/888888888888888888'
    );
    expect(rest.get).not.toHaveBeenCalledWith(
      '/channels/888888888888888888/messages/888888888888888888'
    );
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

  it('looks up a starter-owned thread before one conditional create and reuses it after a crash', async () => {
    const { transport, rest, dispatch } = makeTransport();
    let thread: Record<string, unknown> | undefined;
    rest.get.mockImplementation(async (route: string) => {
      if (route.startsWith('/users/')) return { id: config.application_id, username: 'Agor' };
      if (route.includes('/gateway/bot')) return { shards: 1 };
      if (route.includes('/members/'))
        return { user: { id: config.application_id }, roles: [], permissions: '309237713920' };
      if (route === `/channels/${config.allowed_channel_ids[0]}`)
        return { id: config.allowed_channel_ids[0], guild_id: config.guild_id, type: 0 };
      if (route === `/channels/${config.allowed_channel_ids[0]}/messages/888888888888888888`)
        return {
          id: '888888888888888888',
          channel_id: config.allowed_channel_ids[0],
          ...(thread ? { thread } : {}),
        };
      if (route === '/channels/777777777777777777')
        return {
          id: '777777777777777777',
          guild_id: config.guild_id,
          parent_id: config.allowed_channel_ids[0],
          type: 11,
        };
      return { id: config.guild_id, name: 'Guild' };
    });
    rest.post.mockImplementationOnce(async () => {
      thread = { id: '777777777777777777' };
      return thread;
    });
    const connector = new DiscordConnector(config, transport as never);
    const received: unknown[] = [];
    await connector.startListening(async (message) => {
      received.push(message);
    });
    dispatch()?.(
      {
        t: 'MESSAGE_CREATE',
        s: 9,
        d: {
          id: '888888888888888888',
          guild_id: config.guild_id,
          channel_id: config.allowed_channel_ids[0],
          type: 0,
          content: '<@666666666666666666> create once',
          author: { id: '444444444444444444', bot: false },
          member: { roles: [] },
          mentions: [{ id: config.application_id }],
        },
      },
      0
    );
    await (connector as unknown as { dispatchChain: Promise<void> }).dispatchChain;

    const first = await (
      received[0] as { prepareDelivery: () => Promise<Record<string, unknown>> }
    ).prepareDelivery();
    const second = await (
      received[0] as { prepareDelivery: () => Promise<Record<string, unknown>> }
    ).prepareDelivery();
    expect(first).toMatchObject({ discord_thread_id: '777777777777777777' });
    expect(second).toEqual(first);
    expect(rest.post).toHaveBeenCalledOnce();
  });

  it('reconciles a conflict after the provider create without a second create', async () => {
    const { transport, rest, dispatch } = makeTransport();
    let lookupCount = 0;
    rest.get.mockImplementation(async (route: string) => {
      if (route.startsWith('/users/')) return { id: config.application_id };
      if (route.includes('/gateway/bot')) return { shards: 1 };
      if (route.includes('/members/')) return { user: { id: config.application_id }, roles: [] };
      if (route === `/channels/${config.allowed_channel_ids[0]}`)
        return { id: config.allowed_channel_ids[0], guild_id: config.guild_id, type: 0 };
      if (route === `/channels/${config.allowed_channel_ids[0]}/messages/888888888888888888`)
        return {
          id: '888888888888888888',
          channel_id: config.allowed_channel_ids[0],
          ...(lookupCount++ > 0 ? { thread: { id: '777777777777777777' } } : {}),
        };
      if (route === '/channels/777777777777777777')
        return {
          id: '777777777777777777',
          guild_id: config.guild_id,
          parent_id: config.allowed_channel_ids[0],
          type: 11,
        };
      return { id: config.guild_id };
    });
    rest.post.mockRejectedValueOnce(Object.assign(new Error('already exists'), { status: 409 }));
    const connector = new DiscordConnector(config, transport as never);
    const received: unknown[] = [];
    await connector.startListening(async (message) => {
      received.push(message);
    });
    dispatch()?.(
      {
        t: 'MESSAGE_CREATE',
        s: 10,
        d: {
          id: '888888888888888888',
          guild_id: config.guild_id,
          channel_id: config.allowed_channel_ids[0],
          type: 0,
          content: '<@666666666666666666> conflict-safe',
          author: { id: '444444444444444444', bot: false },
          member: { roles: [] },
          mentions: [{ id: config.application_id }],
        },
      },
      0
    );
    await (connector as unknown as { dispatchChain: Promise<void> }).dispatchChain;
    const prepared = await (
      received[0] as { prepareDelivery: () => Promise<Record<string, unknown>> }
    ).prepareDelivery();
    expect(prepared).toMatchObject({ discord_thread_id: '777777777777777777' });
    expect(rest.post).toHaveBeenCalledOnce();
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
        s: 8,
        d: {
          id: '888888888888888888',
          guild_id: config.guild_id,
          channel_id: config.allowed_channel_ids[0],
          type: 0,
          content: '<@666666666666666666> must not overtake',
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
    await (connector as unknown as { dispatchChain: Promise<void> }).dispatchChain;
    expect(onError).toHaveBeenCalledOnce();
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(gateway.destroy).toHaveBeenCalledOnce();
  });

  it('reports Discord transport lifecycle failures and stops the listener', async () => {
    const { transport, gateway, emitSocketError } = makeTransport();
    const connector = new DiscordConnector(config, transport as never);
    const onError = vi.fn(async () => undefined);
    await connector.startListening(async () => undefined, { onError });

    emitSocketError(new Error('socket failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      code: 'discord_gateway_socket_error',
    });
    expect(gateway.destroy).toHaveBeenCalledOnce();
  });

  it('classifies a DisallowedIntents close as permanent Message Content unavailability', async () => {
    const { transport, gateway, emitClosed } = makeTransport();
    const connector = new DiscordConnector(config, transport as never);
    const onError = vi.fn(async () => undefined);
    await connector.startListening(async () => undefined, { onError });

    emitClosed(GatewayCloseCodes.DisallowedIntents);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      code: 'discord_message_content_unavailable',
      kind: 'permanent',
    });
    expect(gateway.destroy).toHaveBeenCalledOnce();
  });

  it('keeps other Gateway close codes transient', async () => {
    const { transport, gateway, emitClosed } = makeTransport();
    const connector = new DiscordConnector(config, transport as never);
    const onError = vi.fn(async () => undefined);
    await connector.startListening(async () => undefined, { onError });

    emitClosed(GatewayCloseCodes.UnknownError);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      code: 'discord_gateway_closed',
      kind: 'transient',
    });
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
    await expect(result).rejects.toThrow('Discord API failure: provider_request_failed');
    await expect(result).rejects.not.toThrow('Bot abcdefghijklmnopqrst');
    await expect(result).rejects.not.toThrow('https://discord.example.test');
  });

  it('connection probes reject a private text channel', async () => {
    const { transport, rest } = makeTransport();
    rest.get.mockImplementation(async (route: string) => {
      if (route.startsWith('/users/')) return { id: config.application_id, username: 'Agor' };
      if (route.includes('/gateway/bot')) return { shards: 1 };
      if (route.includes('/members/'))
        return { user: { id: config.application_id }, roles: [], permissions: '309237713920' };
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

  it('fails closed when application flags report Message Content unavailable', async () => {
    const { transport, rest, gateway } = makeTransport();
    rest.get.mockImplementation(async (route: string) => {
      if (route.includes('/oauth2/applications/@me')) return { flags: 0 };
      if (route.startsWith('/users/')) return { id: config.application_id };
      if (route.includes('/gateway/bot')) return { shards: 1 };
      if (route.includes('/members/')) {
        return { user: { id: config.application_id }, roles: [], permissions: '309237713920' };
      }
      if (route.startsWith('/guilds/')) return { id: config.guild_id, roles: [] };
      return { id: config.allowed_channel_ids[0], guild_id: config.guild_id, type: 0 };
    });
    const connector = new DiscordConnector(config, transport as never);

    await expect(connector.testConnection()).resolves.toMatchObject({
      ok: false,
      failures: [expect.objectContaining({ capability: 'message_content' })],
    });
    await expect(connector.startListening(async () => undefined)).rejects.toMatchObject({
      code: 'discord_message_content_unavailable',
    });
    expect(gateway.connect).not.toHaveBeenCalled();
  });

  it('does not call an unknown Message Content capability verified', async () => {
    const { transport, rest } = makeTransport();
    rest.get.mockImplementation(async (route: string) => {
      if (route.includes('/oauth2/applications/@me')) return { name: 'opaque flags' };
      if (route.startsWith('/users/')) return { id: config.application_id };
      if (route.includes('/gateway/bot')) return { shards: 1 };
      if (route.includes('/members/')) {
        return { user: { id: config.application_id }, roles: [], permissions: '309237713920' };
      }
      if (route.startsWith('/guilds/')) return { id: config.guild_id, roles: [] };
      return { id: config.allowed_channel_ids[0], guild_id: config.guild_id, type: 0 };
    });
    const result = await new DiscordConnector(config, transport as never).testConnection();
    expect(result.ok).toBe(true);
    expect(result.verification).toEqual({
      status: 'warning',
      warnings: [expect.stringMatching(/not expose.*Message Content/i)],
    });
    expect(result.verifiedInstallationId).toBe(config.application_id);
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
    expect(result.verifiedInstallationId).toBe(config.application_id);
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

  it('requires Create Public Threads in the sampled channel capability', async () => {
    const { transport, rest } = makeTransport();
    rest.get.mockImplementation(async (route: string) => {
      if (route.includes('/oauth2/applications/@me')) return { flags: '524288' };
      if (route.startsWith('/users/')) return { id: config.application_id };
      if (route.includes('/gateway/bot')) return { shards: 1 };
      if (route.includes('/members/')) {
        return { user: { id: config.application_id }, roles: [], permissions: '274877975552' };
      }
      if (route.startsWith('/guilds/')) return { id: config.guild_id, roles: [] };
      return { id: config.allowed_channel_ids[0], guild_id: config.guild_id, type: 0 };
    });
    const result = await new DiscordConnector(config, transport as never).testConnection();
    expect(result).toMatchObject({
      ok: false,
      failures: [expect.objectContaining({ capability: 'channel_access' })],
      channelAccess: [
        expect.objectContaining({
          ok: false,
          permissions: expect.objectContaining({ createPublicThreads: false }),
        }),
      ],
    });
  });

  it('does not materialize an installation identity when the token belongs to another application', async () => {
    const { transport, rest } = makeTransport();
    rest.get.mockImplementation(async (route: string) => {
      if (route.startsWith('/users/')) return { id: '777777777777777777', username: 'Other' };
      return { id: config.guild_id, guild_id: config.guild_id, type: 0 };
    });
    const connector = new DiscordConnector(config, transport as never);
    const result = await connector.testConnection();
    expect(result.verifiedInstallationId).toBeUndefined();
    expect(result.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: 'bot_identity' })])
    );
  });
});
