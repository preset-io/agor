import {
  ApplicationFlags,
  ChannelType as DiscordChannelType,
  MessageType,
} from 'discord-api-types/v10';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayInboundCallback } from '../connector';
import { getConnector, hasConnector } from '../connector-registry';
import { DiscordConnector } from './discord';
import { discordMessageNonce } from './discord-format';

const BOT_ID = '123456789012345678';
const APP_ID = '223456789012345678';
const GUILD_ID = '323456789012345678';
const PARENT_ID = '423456789012345678';
const MESSAGE_ID = '523456789012345678';
const AUTHOR_ID = '623456789012345678';
const ATTACHMENT_ID = '723456789012345678';

function signedAttachmentUrl(attachmentId = ATTACHMENT_ID, filename = 'evidence.png'): string {
  return `https://cdn.discordapp.com/attachments/${PARENT_ID}/${attachmentId}/${filename}?ex=abcdef12&is=abcdef11&hm=${'a'.repeat(64)}`;
}

class TestDiscordConnector extends DiscordConnector {
  setBotUserId(): void {
    this.botUserId = BOT_ID;
  }

  async ingest(message: Record<string, unknown>, callback: GatewayInboundCallback): Promise<void> {
    await this.handleMessageCreate(message as never, callback);
  }

  fakeRest(rest: {
    get?: ReturnType<typeof vi.fn>;
    post?: ReturnType<typeof vi.fn>;
    patch?: ReturnType<typeof vi.fn>;
  }): void {
    Object.assign((this as unknown as { rest: object }).rest, rest);
  }
}

class FakeWebSocketManager {
  readonly options: Record<string, unknown>;
  private listeners = new Map<unknown, Array<(...args: never[]) => void>>();
  connect = vi.fn(async () => undefined);
  getShardIds = vi.fn(async () => [0]);
  send = vi.fn(async () => undefined);
  destroy = vi.fn(async () => {
    const update = this.options.updateSessionInfo as
      | ((shardId: number, session: null) => Promise<void> | void)
      | undefined;
    await update?.(0, null);
  });

  constructor(options: Record<string, unknown>) {
    this.options = options;
  }

  on(event: unknown, listener: (...args: never[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  dispatch(payload: Record<string, unknown>, shardId = 0): void {
    for (const listener of this.listeners.get('dispatch') ?? []) {
      listener(payload as never, shardId as never);
    }
  }

  ready(shardId = 0): void {
    for (const listener of this.listeners.get('ready') ?? []) {
      listener({} as never, shardId as never);
    }
  }

  resumed(shardId = 0): void {
    for (const listener of this.listeners.get('resumed') ?? []) {
      listener(shardId as never);
    }
  }
}

class ListeningTestDiscordConnector extends TestDiscordConnector {
  fakeManager?: FakeWebSocketManager;

  protected override createWebSocketManager(options: never): never {
    this.fakeManager = new FakeWebSocketManager(options as Record<string, unknown>);
    return this.fakeManager as never;
  }
}

function createConnector(): TestDiscordConnector {
  return new TestDiscordConnector({
    bot_token: 'bot-secret',
    application_id: APP_ID,
    guild_id: GUILD_ID,
    allowed_channel_ids: [PARENT_ID],
    align_discord_users: false,
  });
}

function createListeningConnector(): ListeningTestDiscordConnector {
  return new ListeningTestDiscordConnector({
    bot_token: 'bot-secret',
    application_id: APP_ID,
    guild_id: GUILD_ID,
    allowed_channel_ids: [PARENT_ID],
    align_discord_users: false,
  });
}

function inboundMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MESSAGE_ID,
    channel_id: PARENT_ID,
    guild_id: GUILD_ID,
    type: MessageType.Default,
    author: { id: AUTHOR_ID, username: 'caller', bot: false },
    mentions: [{ id: BOT_ID, username: 'agor', bot: true }],
    content: `<@${BOT_ID}> investigate`,
    timestamp: '2026-08-18T12:00:00.000Z',
    attachments: [],
    ...overrides,
  };
}

describe('DiscordConnector registry', () => {
  it('is registered for the PostgreSQL-owned gateway runtime', () => {
    expect(hasConnector('discord')).toBe(true);
    expect(
      getConnector('discord', {
        bot_token: 'secret',
        application_id: APP_ID,
        guild_id: GUILD_ID,
        allowed_channel_ids: [PARENT_ID],
        align_discord_users: false,
      })
    ).toBeInstanceOf(DiscordConnector);
  });
});

describe('DiscordConnector inbound routing', () => {
  it('drops ordinary unmentioned traffic before any REST call or callback', async () => {
    const connector = createConnector();
    connector.setBotUserId();
    const get = vi.fn(() => {
      throw new Error('must not resolve a channel');
    });
    connector.fakeRest({ get });
    const callback = vi.fn();

    await connector.ingest(
      inboundMessage({ mentions: [], content: 'ambient conversation' }),
      callback
    );

    expect(get).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects structured lookalikes in code and malformed author Snowflakes before REST', async () => {
    const connector = createConnector();
    connector.setBotUserId();
    const get = vi.fn(() => {
      throw new Error('must not resolve a channel');
    });
    connector.fakeRest({ get });
    const callback = vi.fn();

    await connector.ingest(inboundMessage({ content: `\`<@${BOT_ID}>\`` }), callback);
    await connector.ingest(
      inboundMessage({ author: { id: 'not-a-snowflake', username: 'caller', bot: false } }),
      callback
    );

    expect(get).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('minimizes only valid current-summon attachments when ingestion is enabled', async () => {
    const connector = new TestDiscordConnector({
      bot_token: 'bot-secret',
      application_id: APP_ID,
      guild_id: GUILD_ID,
      allowed_channel_ids: [PARENT_ID],
      align_discord_users: false,
      ingest_files: true,
    });
    connector.setBotUserId();
    connector.fakeRest({
      get: vi.fn().mockResolvedValue({
        id: PARENT_ID,
        guild_id: GUILD_ID,
        type: DiscordChannelType.GuildText,
      }),
    });
    const callback = vi.fn();

    await connector.ingest(
      inboundMessage({
        attachments: [
          {
            id: ATTACHMENT_ID,
            filename: 'evidence.png',
            content_type: 'IMAGE/PNG',
            size: 4,
            url: signedAttachmentUrl(),
            proxy_url: 'https://attacker.invalid/proxy',
          },
        ],
      }),
      callback
    );

    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      files: [
        {
          id: ATTACHMENT_ID,
          name: 'evidence.png',
          mimetype: 'image/png',
          size: 4,
          url_private_download: signedAttachmentUrl(),
        },
      ],
    });
    expect(JSON.stringify(callback.mock.calls[0]?.[0])).not.toContain('proxy');
  });

  it('does not pass signed URLs when file ingestion is disabled', async () => {
    const connector = createConnector();
    connector.setBotUserId();
    connector.fakeRest({
      get: vi.fn().mockResolvedValue({
        id: PARENT_ID,
        guild_id: GUILD_ID,
        type: DiscordChannelType.GuildText,
      }),
    });
    const callback = vi.fn();
    await connector.ingest(
      inboundMessage({
        attachments: [
          {
            id: ATTACHMENT_ID,
            filename: 'evidence.png',
            content_type: 'image/png',
            size: 4,
            url: signedAttachmentUrl(),
          },
        ],
      }),
      callback
    );
    expect(callback.mock.calls[0]?.[0]).not.toHaveProperty('files');
    expect(JSON.stringify(callback.mock.calls[0]?.[0])).not.toContain('cdn.discordapp.com');
  });

  it('rejects malformed attachment coordinates without exposing their URLs', async () => {
    const connector = new TestDiscordConnector({
      bot_token: 'bot-secret',
      application_id: APP_ID,
      guild_id: GUILD_ID,
      allowed_channel_ids: [PARENT_ID],
      align_discord_users: false,
      ingest_files: true,
    });
    connector.setBotUserId();
    connector.fakeRest({
      get: vi.fn().mockResolvedValue({
        id: PARENT_ID,
        guild_id: GUILD_ID,
        type: DiscordChannelType.GuildText,
      }),
    });
    const callback = vi.fn();
    await connector.ingest(
      inboundMessage({
        attachments: [
          {
            id: ATTACHMENT_ID,
            filename: '../evidence.png',
            content_type: 'image/png',
            size: 4,
            url: 'https://cdn.discordapp.com.evil.invalid/attachments/1/2/a.png',
          },
        ],
      }),
      callback
    );
    expect(callback.mock.calls[0]?.[0]).not.toHaveProperty('files');
    expect(callback.mock.calls[0]?.[0].metadata).toMatchObject({
      discord_attachment_rejected_count: 1,
    });
    expect(JSON.stringify(callback.mock.calls[0]?.[0])).not.toContain('evil.invalid');
  });

  it('bounds the current-summon attachment descriptor count', async () => {
    const connector = new TestDiscordConnector({
      bot_token: 'bot-secret',
      application_id: APP_ID,
      guild_id: GUILD_ID,
      allowed_channel_ids: [PARENT_ID],
      align_discord_users: false,
      ingest_files: true,
    });
    connector.setBotUserId();
    connector.fakeRest({
      get: vi.fn().mockResolvedValue({
        id: PARENT_ID,
        guild_id: GUILD_ID,
        type: DiscordChannelType.GuildText,
      }),
    });
    const callback = vi.fn();
    const attachments = Array.from({ length: 12 }, (_, index) => {
      const id = String(BigInt(ATTACHMENT_ID) + BigInt(index));
      const filename = `evidence-${index}.png`;
      return {
        id,
        filename,
        content_type: 'image/png',
        size: 12,
        url: signedAttachmentUrl(id, filename),
      };
    });
    await connector.ingest(inboundMessage({ attachments }), callback);
    expect(callback.mock.calls[0]?.[0].files).toHaveLength(10);
    expect(callback.mock.calls[0]?.[0].metadata).toMatchObject({
      discord_attachment_rejected_count: 2,
    });
  });

  it('uses the source message Snowflake as the canonical top-level thread identity', async () => {
    const connector = createConnector();
    connector.setBotUserId();
    const get = vi.fn().mockResolvedValue({
      id: PARENT_ID,
      guild_id: GUILD_ID,
      type: DiscordChannelType.GuildText,
    });
    const post = vi.fn().mockResolvedValue({
      id: MESSAGE_ID,
      guild_id: GUILD_ID,
      parent_id: PARENT_ID,
      type: DiscordChannelType.PublicThread,
    });
    connector.fakeRest({ get, post });
    const callback = vi.fn(async (message) => message.prepareDelivery?.());

    await connector.ingest(inboundMessage(), callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      providerEventId: `discord:message:${APP_ID}:${MESSAGE_ID}`,
      threadId: `discord:${MESSAGE_ID}`,
      text: 'investigate',
      userId: AUTHOR_ID,
      metadata: {
        discord_message_id: MESSAGE_ID,
        discord_channel_id: MESSAGE_ID,
        discord_parent_channel_id: PARENT_ID,
        discord_has_mention: true,
      },
    });
    expect(post).toHaveBeenCalledWith(`/channels/${PARENT_ID}/messages/${MESSAGE_ID}/threads`, {
      body: { name: 'Agor session' },
    });
  });

  it('reuses an allowed public thread and requires a mention for every prompt', async () => {
    const connector = createConnector();
    connector.setBotUserId();
    connector.fakeRest({
      get: vi.fn().mockResolvedValue({
        id: MESSAGE_ID,
        guild_id: GUILD_ID,
        parent_id: PARENT_ID,
        type: DiscordChannelType.PublicThread,
      }),
    });
    const callback = vi.fn();

    await connector.ingest(
      inboundMessage({ channel_id: MESSAGE_ID, id: '723456789012345678' }),
      callback
    );

    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      threadId: `discord:${MESSAGE_ID}`,
      providerEventId: `discord:message:${APP_ID}:723456789012345678`,
    });
    expect(callback.mock.calls[0]?.[0].prepareDelivery).toBeUndefined();
  });

  it('recovers a concurrent thread-from-message creation via Discord error 160004', async () => {
    const connector = createConnector();
    connector.setBotUserId();
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        id: PARENT_ID,
        guild_id: GUILD_ID,
        type: DiscordChannelType.GuildText,
      })
      .mockResolvedValueOnce({
        id: MESSAGE_ID,
        guild_id: GUILD_ID,
        parent_id: PARENT_ID,
        type: DiscordChannelType.PublicThread,
      });
    const post = vi.fn().mockRejectedValue({ rawError: { code: 160004 } });
    connector.fakeRest({ get, post });
    let deliveryMetadata: Record<string, unknown> | undefined;

    await connector.ingest(inboundMessage(), async (message) => {
      deliveryMetadata = await message.prepareDelivery?.();
    });

    expect(get).toHaveBeenLastCalledWith(`/channels/${MESSAGE_ID}`);
    expect(deliveryMetadata).toEqual({
      discord_channel_id: MESSAGE_ID,
      discord_parent_channel_id: PARENT_ID,
      discord_root_message_id: MESSAGE_ID,
    });
  });
});

describe('DiscordConnector history and outbound', () => {
  it('normalizes bounded history chronologically through the trigger Snowflake', async () => {
    const connector = createConnector();
    connector.fakeRest({
      get: vi.fn().mockResolvedValue([
        {
          id: '723456789012345678',
          timestamp: '2026-08-18T12:03:00.000Z',
          author: { id: AUTHOR_ID, username: 'later', bot: false },
          content: 'after trigger',
          attachments: [],
        },
        {
          id: '623456789012345678',
          timestamp: '2026-08-18T12:02:00.000Z',
          author: { id: AUTHOR_ID, username: 'trigger', bot: false },
          content: 'summon',
          attachments: [],
        },
        {
          id: '523456789012345678',
          timestamp: '2026-08-18T12:01:00.000Z',
          author: { id: AUTHOR_ID, username: 'missed', bot: false },
          content: 'missed context',
          attachments: [{ id: '1' }],
        },
      ]),
    });

    const result = await connector.history!.fetchConversationHistory({
      threadId: `discord:${MESSAGE_ID}`,
      afterCursor: '423456789012345678',
      throughCursor: '623456789012345678',
      triggerCursor: '623456789012345678',
      limit: 200,
      includeBotMessages: false,
    });

    expect(result.messages).toEqual([
      expect.objectContaining({
        cursor: '523456789012345678',
        text: 'missed context',
        attachment_summary: '1 attached file(s)',
      }),
      expect.objectContaining({
        cursor: '623456789012345678',
        text: 'summon',
        is_trigger: true,
      }),
    ]);
  });

  it('fences every paginated history GET and stops before a later page when admission fails', async () => {
    const connector = createConnector();
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: String(523456789012345679n + BigInt(index)),
      timestamp: '2026-08-18T12:01:00.000Z',
      author: { id: AUTHOR_ID, username: 'caller', bot: true },
      content: 'bot row',
      attachments: [],
    }));
    const get = vi.fn().mockResolvedValue(firstPage);
    connector.fakeRest({ get });
    const beforeProviderCall = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('fenced'));

    await expect(
      connector.history!.fetchConversationHistory({
        threadId: `discord:${MESSAGE_ID}`,
        afterCursor: MESSAGE_ID,
        throughCursor: '923456789012345678',
        triggerCursor: '923456789012345678',
        limit: 50,
        includeBotMessages: false,
        beforeProviderCall,
      })
    ).rejects.toThrow('fenced');
    expect(beforeProviderCall).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('scans newest-to-oldest pages to return the earliest forward page after a cursor', async () => {
    const connector = createConnector();
    const after = BigInt(MESSAGE_ID);
    const historyMessage = (id: bigint) => ({
      id: String(id),
      timestamp: '2026-08-18T12:01:00.000Z',
      author: { id: AUTHOR_ID, username: 'caller', bot: false },
      content: `message-${id}`,
      attachments: [],
    });
    const newest = Array.from({ length: 100 }, (_, index) =>
      historyMessage(after + 200n - BigInt(index))
    );
    const oldest = Array.from({ length: 100 }, (_, index) =>
      historyMessage(after + 100n - BigInt(index))
    );
    const get = vi
      .fn()
      .mockResolvedValueOnce(newest)
      .mockResolvedValueOnce(oldest)
      .mockResolvedValueOnce([historyMessage(after)]);
    connector.fakeRest({ get });
    const beforeProviderCall = vi.fn(async () => undefined);

    const result = await connector.history!.fetchConversationHistory({
      threadId: `discord:${MESSAGE_ID}`,
      afterCursor: MESSAGE_ID,
      throughCursor: String(after + 200n),
      triggerCursor: String(after + 200n),
      limit: 2,
      includeBotMessages: false,
      beforeProviderCall,
    });

    expect(result).toMatchObject({
      messages: [{ cursor: String(after + 1n) }, { cursor: String(after + 2n) }],
      has_more: true,
      next_cursor: String(after + 2n),
    });
    expect(beforeProviderCall).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls[0]?.[1]?.query.get('before')).toBe(String(after + 201n));
  });

  it('accepts an after cursor equal to the fixed through bound without provider access', async () => {
    const connector = createConnector();
    const get = vi.fn();
    connector.fakeRest({ get });
    const result = await connector.history!.fetchConversationHistory({
      threadId: `discord:${MESSAGE_ID}`,
      afterCursor: MESSAGE_ID,
      throughCursor: MESSAGE_ID,
      triggerCursor: MESSAGE_ID,
      limit: 50,
      includeBotMessages: false,
    });
    expect(result).toEqual({ messages: [], has_more: false });
    expect(get).not.toHaveBeenCalled();
  });

  it('fails closed when the admitted lower bound is beyond the bounded provider scan', async () => {
    const connector = createConnector();
    const after = BigInt(MESSAGE_ID);
    const historyMessage = (id: bigint) => ({
      id: String(id),
      timestamp: '2026-08-18T12:01:00.000Z',
      author: { id: AUTHOR_ID, username: 'caller', bot: false },
      content: 'bounded row',
      attachments: [],
    });
    const get = vi.fn();
    for (let page = 0; page < 5; page += 1) {
      const pageTop = after + BigInt(600 - page * 100);
      get.mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, index) => historyMessage(pageTop - BigInt(index)))
      );
    }
    connector.fakeRest({ get });
    const beforeProviderCall = vi.fn(async () => undefined);

    await expect(
      connector.history!.fetchConversationHistory({
        threadId: `discord:${MESSAGE_ID}`,
        afterCursor: MESSAGE_ID,
        throughCursor: String(after + 600n),
        triggerCursor: String(after + 600n),
        limit: 50,
        includeBotMessages: false,
        beforeProviderCall,
      })
    ).rejects.toThrow('bounded provider scan');
    expect(beforeProviderCall).toHaveBeenCalledTimes(5);
    expect(get).toHaveBeenCalledTimes(5);
  });

  it('returns the latest bounded summon context when the lower cursor is beyond the scan bound', async () => {
    const connector = createConnector();
    const after = BigInt(MESSAGE_ID);
    const historyMessage = (id: bigint) => ({
      id: String(id),
      timestamp: '2026-08-18T12:01:00.000Z',
      author: { id: AUTHOR_ID, username: 'caller', bot: false },
      content: `bounded-${id}`,
      attachments: [],
    });
    const get = vi.fn();
    for (let page = 0; page < 5; page += 1) {
      const pageTop = after + BigInt(600 - page * 100);
      get.mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, index) => historyMessage(pageTop - BigInt(index)))
      );
    }
    connector.fakeRest({ get });

    await expect(
      connector.history!.fetchConversationHistory({
        threadId: `discord:${MESSAGE_ID}`,
        afterCursor: MESSAGE_ID,
        throughCursor: String(after + 600n),
        triggerCursor: String(after + 600n),
        limit: 2,
        includeBotMessages: false,
        allowTruncatedLowerBound: true,
        preferLatest: true,
      })
    ).resolves.toMatchObject({
      messages: [{ cursor: String(after + 599n) }, { cursor: String(after + 600n) }],
      has_more: true,
    });
    expect(get).toHaveBeenCalledTimes(5);
  });

  it('sends with suppressed mentions and a deterministic enforced nonce', async () => {
    const connector = createConnector();
    const nonce = discordMessageNonce('discord-progress:canonical-mapping:canonical-task', 0);
    const post = vi.fn().mockResolvedValue({ id: '723456789012345678', nonce });
    connector.fakeRest({ post });

    await connector.sendMessage({
      threadId: `discord:${MESSAGE_ID}`,
      text: '@everyone safe output',
      metadata: {
        agor_message_id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
        discord_nonce_seed: 'discord-progress:canonical-mapping:canonical-task',
      },
    });

    expect(post).toHaveBeenCalledWith(
      `/channels/${MESSAGE_ID}/messages`,
      expect.objectContaining({
        body: expect.objectContaining({
          content: '@everyone safe output',
          allowed_mentions: expect.objectContaining({ parse: [], replied_user: false }),
          enforce_nonce: true,
          nonce,
        }),
      })
    );
  });

  it('recovers an exact bot nonce before re-POSTing owner work', async () => {
    const connector = createConnector();
    connector.setBotUserId();
    const seed = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f';
    const nonce = discordMessageNonce(seed, 0);
    const get = vi.fn().mockResolvedValue([
      {
        id: '723456789012345678',
        nonce,
        author: { id: BOT_ID, bot: true, username: 'agor' },
      },
    ]);
    const post = vi.fn();
    connector.fakeRest({ get, post });
    const beforeProviderCall = vi.fn(async () => undefined);

    await expect(
      connector.sendMessageRecoverable(
        {
          threadId: `discord:${MESSAGE_ID}`,
          text: 'durable response',
          metadata: { agor_message_id: seed },
        },
        {
          recoveryWindow: { after: '100', before: '999999999999999999' },
          beforeProviderCall,
        }
      )
    ).resolves.toBe('723456789012345678');
    expect(get).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalled();
    expect(beforeProviderCall).toHaveBeenCalledOnce();
  });

  it('POSTs only after bounded nonce recovery proves absence', async () => {
    const connector = createConnector();
    connector.setBotUserId();
    const seed = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f';
    const nonce = discordMessageNonce(seed, 0);
    const get = vi.fn().mockResolvedValue([]);
    const post = vi.fn().mockResolvedValue({
      id: '723456789012345678',
      nonce,
      author: { id: BOT_ID, bot: true, username: 'agor' },
    });
    connector.fakeRest({ get, post });
    const beforeProviderCall = vi.fn(async () => undefined);

    await expect(
      connector.sendMessageRecoverable(
        {
          threadId: `discord:${MESSAGE_ID}`,
          text: 'new response',
          metadata: { agor_message_id: seed },
        },
        {
          recoveryWindow: { after: '100', before: '999999999999999999' },
          beforeProviderCall,
        }
      )
    ).resolves.toBe('723456789012345678');
    expect(get).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
    expect(beforeProviderCall).toHaveBeenCalledTimes(2);
  });

  it('validates overflow attachment coordinates for a frozen chunk create and recovery', async () => {
    const connector = createConnector();
    connector.setBotUserId();
    const nonce = discordMessageNonce('overflow-message', 7);
    const markdown = '# Full response';
    const get = vi.fn().mockResolvedValue([]);
    const post = vi.fn().mockResolvedValue({
      id: '723456789012345678',
      nonce,
      author: { id: BOT_ID, bot: true, username: 'agor' },
      attachments: [{ filename: 'agor-response.md', size: Buffer.byteLength(markdown) }],
    });
    connector.fakeRest({ get, post });

    await expect(
      connector.sendDeliveryChunk(
        {
          threadId: `discord:${MESSAGE_ID}`,
          content: 'Response continued in the attached Markdown file.',
          nonce,
          overflowAttachment: {
            filename: 'agor-response.md',
            markdown,
            byteLength: Buffer.byteLength(markdown),
          },
        },
        { recoveryWindow: { after: '100', before: '999999999999999999' } }
      )
    ).resolves.toBe('723456789012345678');
    expect(post).toHaveBeenCalledWith(
      `/channels/${MESSAGE_ID}/messages`,
      expect.objectContaining({
        files: [expect.objectContaining({ name: 'agor-response.md' })],
      })
    );

    get.mockResolvedValueOnce([
      {
        id: '723456789012345678',
        nonce,
        author: { id: BOT_ID, bot: true, username: 'agor' },
        attachments: [{ filename: 'wrong.md', size: Buffer.byteLength(markdown) }],
      },
    ]);
    await expect(
      connector.sendDeliveryChunk(
        {
          threadId: `discord:${MESSAGE_ID}`,
          content: 'Response continued in the attached Markdown file.',
          nonce,
          overflowAttachment: {
            filename: 'agor-response.md',
            markdown,
            byteLength: Buffer.byteLength(markdown),
          },
        },
        { recoveryWindow: { after: '100', before: '999999999999999999' } }
      )
    ).rejects.toThrow(/delivery coordinates/);
  });
});

describe('DiscordConnector setup probe', () => {
  it('returns the verified application binding and gates success on Message Content access', async () => {
    const connector = createConnector();
    connector.fakeRest({
      get: vi.fn(async (route: string) => {
        if (route === '/users/@me') return { id: BOT_ID, username: 'agor', bot: true };
        if (route === '/oauth2/applications/@me') {
          return {
            id: APP_ID,
            name: 'Agor',
            flags: 0,
            integration_types_config: {
              '0': {
                oauth2_install_params: {
                  scopes: ['bot'],
                  permissions: '309237746688',
                },
              },
            },
          };
        }
        if (route === `/guilds/${GUILD_ID}`) return { id: GUILD_ID, name: 'Guild' };
        if (route === `/channels/${PARENT_ID}`) {
          return { id: PARENT_ID, guild_id: GUILD_ID, type: DiscordChannelType.GuildText };
        }
        if (route === '/gateway/bot') {
          return { session_start_limit: { remaining: 10 } };
        }
        throw new Error(`unexpected REST route ${route}`);
      }),
    });

    const result = await connector.testConnection();

    expect(result.providerInstallationId).toBe(APP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ capability: 'message_content' })
    );
  });

  it('passes an abort signal through REST and stops sequential probe work', async () => {
    const connector = createConnector();
    const get = vi.fn(async (route: string, options?: { signal?: AbortSignal }) => {
      if (route === '/users/@me') return { id: BOT_ID, username: 'agor', bot: true };
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    connector.fakeRest({ get });
    const controller = new AbortController();
    const pending = connector.testConnection({ signal: controller.signal });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    const reason = new Error('probe fence lost');
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('applies only the reviewed current-application fields after fresh admission', async () => {
    const connector = createConnector();
    const application = {
      id: APP_ID,
      flags: ApplicationFlags.Embedded,
      integration_types_config: {
        '0': {
          retained: true,
          oauth2_install_params: { scopes: ['applications.commands'], permissions: '8' },
        },
        '1': { oauth2_install_params: { scopes: ['applications.commands'], permissions: '0' } },
      },
      owner: { id: AUTHOR_ID },
      description: 'not mutable through Agor',
    };
    const get = vi.fn(async () => application);
    const patch = vi.fn(async (_route: string, options: { body: Record<string, unknown> }) => ({
      ...application,
      ...options.body,
    }));
    connector.fakeRest({ get, patch });
    const beforePatch = vi.fn(async (applicationId: string) => {
      expect(applicationId).toBe(APP_ID);
      expect(patch).not.toHaveBeenCalled();
    });

    const result = await connector.applyRecommendedApplicationSettings({ beforePatch });

    expect(get).toHaveBeenCalledWith('/applications/@me', undefined);
    expect(beforePatch).toHaveBeenCalledOnce();
    expect(patch).toHaveBeenCalledWith('/applications/@me', {
      body: {
        flags: ApplicationFlags.Embedded | ApplicationFlags.GatewayMessageContentLimited,
        integration_types_config: {
          '0': {
            retained: true,
            oauth2_install_params: { scopes: ['bot'], permissions: '309237746688' },
          },
          '1': {
            oauth2_install_params: { scopes: ['applications.commands'], permissions: '0' },
          },
        },
      },
    });
    expect(result).toMatchObject({
      applicationId: APP_ID,
      messageContentAccess: true,
      guildInstallDefaults: true,
    });
    expect(JSON.stringify(patch.mock.calls[0][1])).not.toContain('owner');
    expect(JSON.stringify(patch.mock.calls[0][1])).not.toContain('description');
  });

  it('aborts after admission without PATCH and rejects an unexpected PATCH response', async () => {
    const application = { id: APP_ID, flags: 0, integration_types_config: {} };
    const connector = createConnector();
    const patch = vi.fn();
    connector.fakeRest({ get: vi.fn(async () => application), patch });
    const controller = new AbortController();
    await expect(
      connector.applyRecommendedApplicationSettings({
        signal: controller.signal,
        beforePatch: async () => controller.abort(new Error('setup fence lost')),
      })
    ).rejects.toThrow(/setup fence lost/);
    expect(patch).not.toHaveBeenCalled();

    const unexpected = createConnector();
    unexpected.fakeRest({
      get: vi.fn(async () => application),
      patch: vi.fn(async (_route: string, options: { body: Record<string, unknown> }) => ({
        id: '999456789012345678',
        ...options.body,
      })),
    });
    await expect(
      unexpected.applyRecommendedApplicationSettings({ beforePatch: async () => undefined })
    ).rejects.toThrow(/identity/);
  });
});

describe('DiscordConnector Gateway lifecycle', () => {
  function applicationIdentity() {
    return {
      id: APP_ID,
      name: 'Agor',
      flags: ApplicationFlags.GatewayMessageContentLimited,
      integration_types_config: {
        '0': {
          oauth2_install_params: {
            scopes: ['bot'],
            permissions: '309237746688',
          },
        },
      },
    };
  }

  function installIdentityRest(connector: ListeningTestDiscordConnector): ReturnType<typeof vi.fn> {
    const get = vi.fn(async (route: string) => {
      if (route === '/users/@me') return { id: BOT_ID, username: 'agor', bot: true };
      if (route === '/oauth2/applications/@me') return applicationIdentity();
      if (route === `/channels/${PARENT_ID}`) {
        return { id: PARENT_ID, guild_id: GUILD_ID, type: DiscordChannelType.GuildText };
      }
      throw new Error(`unexpected REST route ${route}`);
    });
    connector.fakeRest({ get });
    return get;
  }

  function checkpoint(sequence = 10) {
    return {
      provider: 'discord',
      version: 1,
      sessions: {
        '0': {
          session_id: 'session-1',
          resume_gateway_url: 'wss://gateway.discord.gg',
          sequence,
          shard_id: 0,
          shard_count: 1,
        },
      },
    };
  }

  function legacyDurableCheckpoint() {
    return {
      ...checkpoint(),
      parent_high_waters: { [PARENT_ID]: '423456789012345677' },
      thread_reconciliation_high_water: '423456789012345677',
      baseline_established: true,
      reconciliation_required: true,
    };
  }

  it('keeps Resume state process-local and ignores a durable checkpoint from an old owner', async () => {
    const connector = createListeningConnector();
    installIdentityRest(connector);
    const saveCheckpoint = vi.fn(async () => true);
    await connector.startListening(vi.fn(), { checkpoint: checkpoint(), saveCheckpoint });
    const manager = connector.fakeManager!;
    const updateSessionInfo = manager.options.updateSessionInfo as (
      shardId: number,
      session: {
        sessionId: string;
        resumeURL: string;
        sequence: number;
        shardId: number;
        shardCount: number;
      }
    ) => Promise<void>;
    const retrieveSessionInfo = manager.options.retrieveSessionInfo as (shardId: number) => unknown;

    expect(retrieveSessionInfo(0)).toBeNull();
    await updateSessionInfo(0, {
      sessionId: 'process-local-session',
      resumeURL: 'wss://gateway.discord.gg',
      sequence: 10,
      shardId: 0,
      shardCount: 1,
    });
    manager.dispatch({ op: 0, t: 'GUILD_CREATE', s: 11, d: {} });

    await vi.waitFor(() =>
      expect(retrieveSessionInfo(0)).toMatchObject({
        sessionId: 'process-local-session',
        sequence: 11,
      })
    );
    expect(saveCheckpoint).not.toHaveBeenCalled();
    await connector.stopListening();
  });

  it('drains an admitted callback before graceful stop resolves', async () => {
    const connector = createListeningConnector();
    installIdentityRest(connector);
    let releaseCallback!: () => void;
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const callback = vi.fn(async () => callbackGate);
    await connector.startListening(callback, { listenerClaimIsCurrent: async () => true });
    connector.fakeManager!.dispatch({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 11,
      d: inboundMessage(),
    });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = connector.stopListening().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseCallback();
    await stopping;
  });

  it('treats a failed summon as best-effort and admits a later live mention', async () => {
    const connector = createListeningConnector();
    installIdentityRest(connector);
    const callback = vi
      .fn()
      .mockRejectedValueOnce(new Error('Task admission failed'))
      .mockResolvedValueOnce(undefined);
    const listenerClaimIsCurrent = vi.fn(async () => true);
    await connector.startListening(callback, { listenerClaimIsCurrent });
    const manager = connector.fakeManager!;

    manager.dispatch({ op: 0, t: 'MESSAGE_CREATE', s: 11, d: inboundMessage() });
    manager.dispatch({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 12,
      d: inboundMessage({ id: '523456789012345679', content: `<@${BOT_ID}> try again` }),
    });

    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
    expect(manager.destroy).not.toHaveBeenCalled();
    expect(listenerClaimIsCurrent).toHaveBeenCalled();
    await connector.stopListening();
  });

  it('stops a failed dispatch when the listener owner fence is gone', async () => {
    const connector = createListeningConnector();
    installIdentityRest(connector);
    const callback = vi.fn(async () => {
      throw new Error('listener fence lost');
    });
    await connector.startListening(callback, { listenerClaimIsCurrent: async () => false });
    const manager = connector.fakeManager!;

    manager.dispatch({ op: 0, t: 'MESSAGE_CREATE', s: 11, d: inboundMessage() });

    await vi.waitFor(() => expect(manager.destroy).toHaveBeenCalledOnce());
    expect(callback).toHaveBeenCalledOnce();
    await connector.stopListening();
  });

  it('starts a fresh Identify after invalid Resume without provider reconciliation', async () => {
    const connector = createListeningConnector();
    const get = installIdentityRest(connector);
    const saveCheckpoint = vi.fn(async () => true);
    await connector.startListening(vi.fn(), {
      checkpoint: legacyDurableCheckpoint(),
      saveCheckpoint,
    });
    const manager = connector.fakeManager!;
    const updateSessionInfo = manager.options.updateSessionInfo as (
      shardId: number,
      session: null
    ) => Promise<void>;
    const retrieveSessionInfo = manager.options.retrieveSessionInfo as (shardId: number) => unknown;

    await updateSessionInfo(0, null);

    expect(retrieveSessionInfo(0)).toBeNull();
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
    await connector.stopListening();
  });

  it('destroys the transport rather than letting a shard dispatch queue grow without bound', async () => {
    const connector = createListeningConnector();
    installIdentityRest(connector);
    const callback = vi.fn();
    const saveCheckpoint = vi.fn(async () => true);
    await connector.startListening(callback, { checkpoint: checkpoint(), saveCheckpoint });
    const manager = connector.fakeManager!;

    for (let index = 0; index <= 1_000; index += 1) {
      manager.dispatch({ op: 0, t: 'GUILD_CREATE', s: 11 + index, d: {} });
    }

    await vi.waitFor(() => expect(manager.destroy).toHaveBeenCalledOnce());
    expect(callback).not.toHaveBeenCalled();
    await connector.stopListening();
  });

  it('uses the owned WebSocket manager for aggregate presence and cancels it on stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00.000Z'));
    try {
      const connector = createListeningConnector();
      installIdentityRest(connector);
      const ownerCurrent = vi.fn(async () => true);
      await connector.startListening(vi.fn(), {
        checkpoint: checkpoint(),
        listenerClaimIsCurrent: ownerCurrent,
      });
      const manager = connector.fakeManager!;

      connector.updateAggregatePresence(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.send).toHaveBeenCalledWith(
        0,
        expect.objectContaining({
          op: 3,
          d: expect.objectContaining({
            status: 'online',
            activities: [expect.objectContaining({ name: '2 active Agor sessions' })],
          }),
        })
      );

      manager.resumed();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(manager.send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.send).toHaveBeenCalledTimes(2);

      connector.updateAggregatePresence(3);
      await connector.stopListening();
      await vi.advanceTimersByTimeAsync(5_001);
      expect(manager.send).toHaveBeenCalledTimes(2);
      expect(ownerCurrent).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
