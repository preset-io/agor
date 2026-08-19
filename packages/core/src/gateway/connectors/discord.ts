/**
 * Discord gateway beta connector.
 *
 * The public connector owns Discord-specific validation, filtering, reply
 * identity, chunking, and target parsing. GatewayService remains responsible
 * for authentication, tenant-scoped authorization, audit rows, and session
 * seeds. The transport is deliberately injected through a non-exported seam so
 * connector tests never need a Discord account or network access.
 */

import { REST } from '@discordjs/rest';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import {
  GatewayDispatchEvents,
  type GatewayDispatchPayload,
  GatewayIntentBits,
  Routes,
} from 'discord-api-types/v10';
import type {
  ChannelType,
  DiscordGatewayConfig,
  GatewayConnectionTestResult,
} from '../../types/gateway';
import { validateDiscordConfig } from '../../types/gateway';
import type {
  GatewayConnector,
  GatewayInboundCallback,
  GatewayListenerOptions,
  GatewaySendReceipt,
  InboundMessage,
} from '../connector';
import { GatewayListenerError } from '../listener-error';
import { sanitizeGatewayProviderError } from '../provider-error';

const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_TEXT_CHANNEL_TYPE = 0;
const DISCORD_PUBLIC_THREAD_TYPES = new Set([10, 11]);
const DISCORD_TEXT_MESSAGE_TYPES = new Set([0, 19]);
const DISCORD_VIEW_CHANNEL_PERMISSION = 1n << 10n;
const DISCORD_SEND_MESSAGES_PERMISSION = 1n << 11n;
const DISCORD_READ_MESSAGE_HISTORY_PERMISSION = 1n << 16n;
const DISCORD_SEND_MESSAGES_IN_THREADS_PERMISSION = 1n << 38n;

interface DiscordRestTransport {
  get(route: string): Promise<unknown>;
  post(route: string, options?: { body?: unknown }): Promise<unknown>;
}

interface DiscordGatewayTransport {
  on(
    event: WebSocketShardEvents.Dispatch,
    listener: (payload: GatewayDispatchPayload, shardId: number) => void | Promise<void>
  ): unknown;
  connect(): Promise<void>;
  destroy(): Promise<void>;
}

interface DiscordTransport {
  rest: DiscordRestTransport;
  createGateway(options: {
    checkpoint: Record<string, unknown> | null | undefined;
    onSessionInfo: (sessionInfo: unknown) => Promise<void>;
  }): DiscordGatewayTransport;
}

function defaultDiscordTransport(token: string): DiscordTransport {
  const rest = new REST({ version: '10' }).setToken(token);
  return {
    rest,
    createGateway: ({ checkpoint, onSessionInfo }) =>
      new WebSocketManager({
        token,
        rest,
        intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages,
        shardCount: 1,
        ...(typeof checkpoint?.session_id === 'string' &&
        typeof checkpoint.sequence === 'number' &&
        typeof checkpoint.resume_url === 'string' &&
        typeof checkpoint.shard_count === 'number' &&
        typeof checkpoint.shard_id === 'number'
          ? {
              retrieveSessionInfo: async () => ({
                sessionId: checkpoint.session_id as string,
                sequence: checkpoint.sequence as number,
                resumeURL: checkpoint.resume_url as string,
                shardCount: checkpoint.shard_count as number,
                shardId: checkpoint.shard_id as number,
              }),
            }
          : {}),
        updateSessionInfo: async (shardId, sessionInfo) => {
          if (sessionInfo) await onSessionInfo(sessionInfo);
          void shardId;
        },
      }) as unknown as DiscordGatewayTransport,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function snowflake(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{17,20}$/.test(value) ? value : undefined;
}

function configuredString(config: DiscordGatewayConfig, key: keyof DiscordGatewayConfig): string {
  const value = config[key];
  return typeof value === 'string' ? value : '';
}

function configuredChannelIds(config: DiscordGatewayConfig): string[] {
  return Array.isArray(config.allowed_channel_ids)
    ? config.allowed_channel_ids.filter((id): id is string => typeof id === 'string')
    : [];
}

function messageThreadId(channelId: string, messageId: string): string {
  return `discord:message:${channelId}:${messageId}`;
}

function existingThreadId(parentChannelId: string, threadChannelId: string): string {
  return `discord:thread:${parentChannelId}:${threadChannelId}`;
}

function parseThreadId(threadId: string): {
  channelId: string;
  messageId?: string;
  parentChannelId?: string;
  existingThread: boolean;
} {
  const threadMatch = /^discord:thread:(\d{17,20}):(\d{17,20})$/.exec(threadId);
  if (threadMatch) {
    return {
      channelId: threadMatch[2],
      parentChannelId: threadMatch[1],
      existingThread: true,
    };
  }
  const messageMatch = /^discord:message:(\d{17,20}):(\d{17,20})$/.exec(threadId);
  if (messageMatch) {
    return { channelId: messageMatch[1], messageId: messageMatch[2], existingThread: false };
  }
  throw new Error(`Invalid Discord thread ID: ${threadId}`);
}

interface DiscordFenceState {
  /** Exact info string from the opening fence, without the newline. */
  info: string;
}

interface DiscordChunkToken {
  text: string;
  stateAfter: DiscordFenceState | null;
  kind: 'text' | 'open' | 'close';
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function fencePrefix(state: DiscordFenceState): string {
  return `\`\`\`${state.info}\n`;
}

function tokenizeDiscordMessage(text: string): DiscordChunkToken[] {
  const codePoints = Array.from(text);
  const tokens: DiscordChunkToken[] = [];
  let state: DiscordFenceState | null = null;
  let offset = 0;
  while (offset < codePoints.length) {
    const isFence = codePoints.slice(offset, offset + 3).join('') === '```';
    if (!isFence) {
      tokens.push({ text: codePoints[offset], stateAfter: state, kind: 'text' });
      offset += 1;
      continue;
    }

    if (state) {
      state = null;
      tokens.push({ text: '```', stateAfter: state, kind: 'close' });
      offset += 3;
      continue;
    }

    const newlineOffset = codePoints.indexOf('\n', offset + 3);
    const infoEnd = newlineOffset === -1 ? codePoints.length : newlineOffset;
    const info = codePoints.slice(offset + 3, infoEnd).join('');
    const tokenEnd = newlineOffset === -1 ? codePoints.length : newlineOffset + 1;
    state = { info };
    tokens.push({
      text: codePoints.slice(offset, tokenEnd).join(''),
      stateAfter: state,
      kind: 'open',
    });
    offset = tokenEnd;
  }
  return tokens;
}

function renderedDiscordChunkLength(
  prefix: string,
  source: string,
  nextState: DiscordFenceState | null
): number {
  return codePointLength(prefix) + codePointLength(source) + (nextState ? 4 : 0);
}

/** Split text deterministically without ever exceeding Discord's 2000-code-point cap. */
export function chunkDiscordMessage(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit < 32) throw new Error('Discord chunk limit is too small');
  if (text.length === 0) return [''];

  const tokens = tokenizeDiscordMessage(text);
  const chunks: string[] = [];
  let state: DiscordFenceState | null = null;
  let tokenOffset = 0;

  while (tokenOffset < tokens.length) {
    const prefix = state ? fencePrefix(state) : '';
    if (codePointLength(prefix) >= limit) {
      throw new Error('Discord chunk limit cannot accommodate a Markdown fence');
    }

    const startOffset = tokenOffset;
    let source = '';
    let nextState: DiscordFenceState | null = state;
    let maxOffset = tokenOffset;
    let maxSource = '';
    let maxState: DiscordFenceState | null = state;
    while (tokenOffset < tokens.length) {
      const token = tokens[tokenOffset];
      const candidateSource = source + token.text;
      const candidateState = token.stateAfter;
      if (renderedDiscordChunkLength(prefix, candidateSource, candidateState) > limit) break;
      source = candidateSource;
      nextState = candidateState;
      tokenOffset += 1;
      maxOffset = tokenOffset;
      maxSource = source;
      maxState = nextState;
    }
    if (maxOffset === startOffset) {
      throw new Error('Discord chunk limit cannot accommodate a Markdown fence');
    }

    // Prefer a readable cut after whitespace, but only at token boundaries and
    // only when the following token still fits with its full fence prefix.
    let softOffset = startOffset;
    let sourceLength = 0;
    for (let index = startOffset; index < maxOffset; index += 1) {
      const token = tokens[index];
      sourceLength += codePointLength(token.text);
      if ((token.text === '\n' || token.text === ' ') && sourceLength >= Math.floor(limit * 0.6)) {
        softOffset = index + 1;
      }
    }
    if (softOffset > startOffset && softOffset < maxOffset) {
      const candidateNextState = tokens[softOffset - 1].stateAfter;
      const candidatePrefix = candidateNextState ? fencePrefix(candidateNextState) : '';
      const nextToken = tokens[softOffset];
      const nextFits =
        !nextToken ||
        renderedDiscordChunkLength(candidatePrefix, nextToken.text, nextToken.stateAfter) <= limit;
      if (nextFits) {
        tokenOffset = softOffset;
        source = tokens
          .slice(startOffset, softOffset)
          .map((token) => token.text)
          .join('');
        nextState = candidateNextState;
      } else {
        tokenOffset = maxOffset;
        source = maxSource;
        nextState = maxState;
      }
    } else {
      tokenOffset = maxOffset;
      source = maxSource;
      nextState = maxState;
    }

    if (renderedDiscordChunkLength(prefix, source, nextState) > limit) {
      throw new Error('Discord chunk limit cannot accommodate a Markdown fence');
    }
    chunks.push(prefix + source + (nextState ? '\n```' : ''));
    state = nextState;
  }
  return chunks;
}

/** Remove only the bot mention forms Discord emits for a message content. */
export function stripDiscordBotMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').replace(/^\s+|\s+$/g, '');
}

function providerError(error: unknown): string {
  return sanitizeGatewayProviderError(error);
}

function replyAliases(channelId: string, messageIds: string[]): string[] {
  return messageIds.map((messageId) => messageThreadId(channelId, messageId));
}

function toIsoTimestamp(value: unknown): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  return new Date().toISOString();
}

function isPublicTextChannel(channel: Record<string, unknown> | null, guildId: string): boolean {
  if (channel?.type !== DISCORD_TEXT_CHANNEL_TYPE) return false;
  const overwrites = channel.permission_overwrites;
  if (!Array.isArray(overwrites)) return true;
  const everyone = overwrites
    .map(asRecord)
    .find(
      (overwrite) =>
        overwrite?.id === guildId && (overwrite.type === undefined || overwrite.type === 0)
    );
  if (!everyone) return true;
  const deny = everyone.deny;
  try {
    const denied =
      typeof deny === 'string' ? BigInt(deny) : typeof deny === 'number' ? BigInt(deny) : null;
    return denied !== null && (denied & DISCORD_VIEW_CHANNEL_PERMISSION) === 0n;
  } catch {
    return false;
  }
}

function permissionBits(value: unknown): bigint {
  try {
    return typeof value === 'string' || typeof value === 'number' ? BigInt(value) : 0n;
  } catch {
    return 0n;
  }
}

function effectiveChannelPermissions(
  guild: Record<string, unknown> | null,
  member: Record<string, unknown> | null,
  channel: Record<string, unknown> | null,
  guildId: string,
  botUserId: string
): bigint {
  const direct = permissionBits(member?.permissions);
  if (direct !== 0n) return direct;
  const roles = Array.isArray(guild?.roles) ? guild.roles.map(asRecord).filter(Boolean) : [];
  const memberRoles = Array.isArray(member?.roles)
    ? member.roles.filter((role): role is string => typeof role === 'string')
    : [];
  const everyoneRole = roles.find((role) => role?.id === guildId);
  let permissions = permissionBits(everyoneRole?.permissions);
  for (const role of roles) {
    if (typeof role?.id === 'string' && memberRoles.includes(role.id)) {
      permissions |= permissionBits(role.permissions);
    }
  }
  if ((permissions & (1n << 3n)) !== 0n) return permissions;
  const overwrites = Array.isArray(channel?.permission_overwrites)
    ? channel.permission_overwrites.map(asRecord).filter(Boolean)
    : [];
  const everyone = overwrites.find((overwrite) => overwrite?.id === guildId);
  if (everyone) {
    permissions &= ~permissionBits(everyone.deny);
    permissions |= permissionBits(everyone.allow);
  }
  const roleOverwrite = overwrites.filter(
    (overwrite) => typeof overwrite?.id === 'string' && memberRoles.includes(overwrite.id)
  );
  const roleDeny = roleOverwrite.reduce(
    (bits, overwrite) => bits | permissionBits(overwrite?.deny),
    0n
  );
  const roleAllow = roleOverwrite.reduce(
    (bits, overwrite) => bits | permissionBits(overwrite?.allow),
    0n
  );
  permissions &= ~roleDeny;
  permissions |= roleAllow;
  const memberOverwrite = overwrites.find((overwrite) => overwrite?.id === botUserId);
  if (memberOverwrite) {
    permissions &= ~permissionBits(memberOverwrite.deny);
    permissions |= permissionBits(memberOverwrite.allow);
  }
  return permissions;
}

export class DiscordConnector implements GatewayConnector {
  readonly channelType: ChannelType = 'discord';

  private readonly config: DiscordGatewayConfig;
  private readonly transport: DiscordTransport;
  private gateway: DiscordGatewayTransport | null = null;
  private botUserId: string | null = null;
  private readonly channelInfoCache = new Map<string, Record<string, unknown>>();
  private lastSequence = -1;
  private lastCheckpointSave: Promise<boolean> = Promise.resolve(true);
  private dispatchChain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(config: Record<string, unknown>, transport?: DiscordTransport) {
    this.config = config as DiscordGatewayConfig;
    this.transport =
      transport ?? defaultDiscordTransport(configuredString(this.config, 'bot_token'));
  }

  private validate(requireBotToken = true): void {
    const result = validateDiscordConfig(this.config as Record<string, unknown>, {
      requireBotToken,
    });
    if (!result.ok) throw new Error(`Invalid Discord configuration: ${result.errors.join('; ')}`);
  }

  private validateForListener(): void {
    const result = validateDiscordConfig(this.config as Record<string, unknown>, {
      requireBotToken: true,
    });
    if (!result.ok) {
      throw new GatewayListenerError(
        'discord_config_invalid',
        'permanent',
        `Fix the Discord gateway configuration: ${result.errors.join('; ')}`
      );
    }
  }

  private async sendChunk(
    channelId: string,
    content: string,
    replyToMessageId?: string
  ): Promise<{ id: string }> {
    const body = {
      content,
      allowed_mentions: { parse: [] },
      ...(replyToMessageId
        ? {
            message_reference: {
              message_id: replyToMessageId,
              channel_id: channelId,
              fail_if_not_exists: false,
            },
          }
        : {}),
    };
    let raw: Record<string, unknown> | null;
    try {
      raw = asRecord(await this.transport.rest.post(Routes.channelMessages(channelId), { body }));
    } catch (error) {
      throw new Error(`Discord API failure: ${sanitizeGatewayProviderError(error)}`);
    }
    const id = snowflake(raw?.id);
    if (!id) throw new Error('Discord API response did not include a message id');
    return { id };
  }

  private receipt(
    channelId: string,
    threadId: string,
    ids: string[],
    permalink = true
  ): GatewaySendReceipt {
    const firstId = ids[0];
    const lastId = ids[ids.length - 1];
    return {
      messageId: lastId,
      messageIds: ids,
      threadId,
      replyAliases: replyAliases(channelId, ids),
      platformChannelId: channelId,
      platformThreadId: threadId,
      ...(permalink
        ? {
            permalink: `https://discord.com/channels/${configuredString(this.config, 'guild_id')}/${channelId}/${firstId}`,
          }
        : {}),
    };
  }

  async sendMessage(req: {
    threadId: string;
    text: string;
    blocks?: unknown[];
    metadata?: Record<string, unknown>;
  }): Promise<GatewaySendReceipt> {
    this.validate();
    const parsed = parseThreadId(req.threadId);
    const parentChannelId = parsed.parentChannelId ?? parsed.channelId;
    if (!configuredChannelIds(this.config).includes(parentChannelId)) {
      throw new Error('Discord replies must remain in an allowed channel');
    }
    const explicitReply =
      typeof req.metadata?.discord_reply_to_message_id === 'string'
        ? req.metadata.discord_reply_to_message_id
        : undefined;
    const replyTo = explicitReply ?? parsed.messageId;
    const ids: string[] = [];
    for (const chunk of chunkDiscordMessage(req.text)) {
      ids.push((await this.sendChunk(parsed.channelId, chunk, replyTo)).id);
    }
    return this.receipt(parsed.channelId, req.threadId, ids);
  }

  async sendDirectMessage(req: {
    target: string;
    text: string;
    blocks?: unknown[];
    threadId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<GatewaySendReceipt> {
    this.validate();
    const match = /^channel:(\d{17,20})$/.exec(req.target.trim());
    if (!match) throw new Error('Invalid Discord outbound target. Expected channel:<snowflake>');
    const channelId = match[1];
    if (!configuredChannelIds(this.config).includes(channelId)) {
      throw new Error('Discord outbound target must be one of the allowed channels');
    }
    if (req.threadId) throw new Error('Discord proactive outbound does not accept thread targets');
    const ids: string[] = [];
    for (const chunk of chunkDiscordMessage(req.text)) {
      ids.push((await this.sendChunk(channelId, chunk)).id);
    }
    const threadId = messageThreadId(channelId, ids[0]);
    return this.receipt(channelId, threadId, ids);
  }

  formatMessage(markdown: string): string {
    return markdown;
  }

  private async saveCheckpoint(
    options: GatewayListenerOptions,
    checkpoint: Record<string, unknown>
  ): Promise<boolean> {
    if (!options.saveCheckpoint) return true;
    this.lastCheckpointSave = this.lastCheckpointSave.then(() =>
      options.saveCheckpoint!(checkpoint)
    );
    return this.lastCheckpointSave;
  }

  private async isAllowedMessage(message: Record<string, unknown>): Promise<{
    accepted: boolean;
    threadId?: string;
    metadata?: Record<string, unknown>;
    text?: string;
  }> {
    const author = asRecord(message.author);
    const member = asRecord(message.member);
    const channelId = snowflake(message.channel_id);
    const guildId = snowflake(message.guild_id);
    const messageId = snowflake(message.id);
    const authorId = snowflake(author?.id);
    const botUserId = this.botUserId;
    if (!author || !channelId || !guildId || !messageId || !authorId || !botUserId) {
      return { accepted: false };
    }
    if (guildId !== configuredString(this.config, 'guild_id')) return { accepted: false };
    if (
      author.bot === true ||
      author.system === true ||
      (message.webhook_id !== undefined && message.webhook_id !== null)
    ) {
      return { accepted: false };
    }
    if (authorId === botUserId) return { accepted: false };
    if (typeof message.type !== 'number' || !DISCORD_TEXT_MESSAGE_TYPES.has(message.type)) {
      return { accepted: false };
    }

    const allowedUsers = Array.isArray(this.config.allowed_user_ids)
      ? this.config.allowed_user_ids.filter((id): id is string => typeof id === 'string')
      : [];
    const allowedRoles = Array.isArray(this.config.allowed_role_ids)
      ? this.config.allowed_role_ids.filter((id): id is string => typeof id === 'string')
      : [];
    const roles = Array.isArray(member?.roles)
      ? member.roles.filter((id): id is string => typeof id === 'string')
      : [];
    if (
      !allowedUsers.includes(String(author.id)) &&
      !roles.some((role) => allowedRoles.includes(role))
    ) {
      return { accepted: false };
    }

    const rawContent = typeof message.content === 'string' ? message.content : '';
    const mentioned = new RegExp(`<@!?${botUserId}>`).test(rawContent);
    if (!mentioned) return { accepted: false };
    if (
      (Array.isArray(message.attachments) && message.attachments.length > 0) ||
      (Array.isArray(message.embeds) && message.embeds.length > 0) ||
      (Array.isArray(message.components) && message.components.length > 0) ||
      (Array.isArray(message.sticker_items) && message.sticker_items.length > 0) ||
      message.poll !== undefined
    ) {
      return { accepted: false };
    }
    const text = stripDiscordBotMention(rawContent, botUserId);
    if (!text) return { accepted: false };

    const configuredChannelIdsList = configuredChannelIds(this.config);
    let isThread = false;
    let parentId: string | undefined;
    if (!configuredChannelIdsList.includes(channelId)) {
      let channel = this.channelInfoCache.get(channelId);
      if (!channel) {
        try {
          channel = asRecord(await this.transport.rest.get(Routes.channel(channelId))) ?? undefined;
          if (channel) this.channelInfoCache.set(channelId, channel);
        } catch {
          return { accepted: false };
        }
      }
      parentId = snowflake(channel?.parent_id);
      isThread =
        channel?.guild_id === guildId &&
        DISCORD_PUBLIC_THREAD_TYPES.has(channel?.type as number) &&
        configuredChannelIdsList.includes(parentId ?? '');
    }
    if (!configuredChannelIdsList.includes(channelId) && !isThread) return { accepted: false };

    const reference = asRecord(message.message_reference);
    const referencedMessageId = snowflake(reference?.message_id);
    const threadId = isThread
      ? existingThreadId(parentId!, channelId)
      : messageThreadId(channelId, referencedMessageId ?? messageId);
    return {
      accepted: true,
      threadId,
      text,
      metadata: {
        discord_guild_id: guildId,
        discord_channel_id: channelId,
        discord_message_id: messageId,
        discord_author_id: authorId,
        discord_role_ids: roles,
        discord_bot_user_id: botUserId,
        discord_is_thread: isThread,
        ...(isThread ? { discord_parent_channel_id: parentId } : {}),
        ...(referencedMessageId ? { discord_reply_to_message_id: referencedMessageId } : {}),
        discord_has_mention: true,
      },
    };
  }

  private async dispatchMessage(
    payload: GatewayDispatchPayload,
    callback: GatewayInboundCallback
  ): Promise<{ messageId?: string }> {
    if (payload.t !== GatewayDispatchEvents.MessageCreate) return {};
    const message = asRecord(payload.d);
    if (!message) return {};
    const result = await this.isAllowedMessage(message);
    const messageId = snowflake(message.id);
    if (!result.accepted || !result.threadId || !result.text || !messageId) return { messageId };
    const inbound: InboundMessage = {
      providerEventId: `discord:${configuredString(this.config, 'guild_id')}:${result.metadata?.discord_channel_id ?? ''}:${messageId}`,
      threadId: result.threadId,
      text: result.text,
      userId: String(asRecord(message.author)?.id ?? ''),
      timestamp: toIsoTimestamp(message.timestamp),
      metadata: result.metadata,
    };
    await callback(inbound);
    return { messageId };
  }

  async startListening(
    callback: GatewayInboundCallback,
    options: GatewayListenerOptions = {}
  ): Promise<void> {
    this.validateForListener();
    this.stopped = false;
    this.dispatchChain = Promise.resolve();
    this.lastCheckpointSave = Promise.resolve(true);
    const bot = asRecord(await this.transport.rest.get(Routes.user('@me')));
    const botUserId = snowflake(bot?.id);
    if (!botUserId) {
      throw new GatewayListenerError(
        'discord_bot_identity_invalid',
        'permanent',
        'The Discord bot token did not return a bot user identity.'
      );
    }
    this.botUserId = botUserId;
    if (botUserId !== configuredString(this.config, 'application_id')) {
      throw new GatewayListenerError(
        'discord_application_identity_invalid',
        'permanent',
        'The Discord bot user did not match the configured application.'
      );
    }
    const gatewayBot = asRecord(await this.transport.rest.get(Routes.gatewayBot()));
    const recommendedShards =
      typeof gatewayBot?.shards === 'number' ? gatewayBot.shards : undefined;
    if (recommendedShards !== 1) {
      throw new GatewayListenerError(
        'discord_sharding_unsupported',
        'permanent',
        recommendedShards && recommendedShards > 1
          ? `Discord recommends ${recommendedShards} shards; this beta supports one shard only.`
          : 'Discord did not return a valid bot shard recommendation.'
      );
    }
    const allowedChannelIds = configuredChannelIds(this.config);
    const configuredChannels = await Promise.all(
      allowedChannelIds.map(async (channelId) =>
        asRecord(await this.transport.rest.get(Routes.channel(channelId)))
      )
    );
    if (
      configuredChannels.some(
        (configuredChannel, index) =>
          configuredChannel?.id !== allowedChannelIds[index] ||
          configuredChannel?.guild_id !== configuredString(this.config, 'guild_id') ||
          !isPublicTextChannel(configuredChannel, configuredString(this.config, 'guild_id'))
      )
    ) {
      throw new GatewayListenerError(
        'discord_channel_invalid',
        'permanent',
        'Every allowed Discord channel must be a public text channel.'
      );
    }
    configuredChannels.forEach((channel, index) => {
      if (channel) this.channelInfoCache.set(allowedChannelIds[index], channel);
    });
    this.lastSequence =
      typeof options.checkpoint?.sequence === 'number' ? options.checkpoint.sequence : -1;
    let sessionInfo = options.checkpoint ?? undefined;

    this.gateway = this.transport.createGateway({
      checkpoint: options.checkpoint,
      onSessionInfo: async (nextSessionInfo) => {
        const record = asRecord(nextSessionInfo);
        if (!record) return;
        sessionInfo = record;
      },
    });
    this.gateway.on(WebSocketShardEvents.Dispatch, (payload) => {
      const processDispatch = this.dispatchChain.then(async () => {
        if (this.stopped) return;
        const sequence = typeof payload.s === 'number' ? payload.s : undefined;
        if (sequence !== undefined && sequence <= this.lastSequence) return;
        const delivered = await this.dispatchMessage(payload, callback);
        if (sequence !== undefined) this.lastSequence = sequence;
        const checkpoint: Record<string, unknown> = {
          ...(typeof sessionInfo?.sessionId === 'string'
            ? { session_id: sessionInfo.sessionId }
            : typeof sessionInfo?.session_id === 'string'
              ? { session_id: sessionInfo.session_id }
              : {}),
          ...(typeof sessionInfo?.resumeURL === 'string'
            ? { resume_url: sessionInfo.resumeURL }
            : typeof sessionInfo?.resume_url === 'string'
              ? { resume_url: sessionInfo.resume_url }
              : {}),
          ...(typeof sessionInfo?.shardCount === 'number'
            ? { shard_count: sessionInfo.shardCount }
            : typeof sessionInfo?.shard_count === 'number'
              ? { shard_count: sessionInfo.shard_count }
              : {}),
          ...(typeof sessionInfo?.shardId === 'number'
            ? { shard_id: sessionInfo.shardId }
            : typeof sessionInfo?.shard_id === 'number'
              ? { shard_id: sessionInfo.shard_id }
              : {}),
          ...(sequence !== undefined ? { sequence } : {}),
          ...(delivered.messageId ? { last_message_id: delivered.messageId } : {}),
        };
        const saved = await this.saveCheckpoint(options, checkpoint);
        if (!saved) {
          throw new GatewayListenerError(
            'gateway_listener_lease_lost',
            'transient',
            'The Discord listener lost its durable owner lease; Agor will retry automatically.'
          );
        }
      });
      this.dispatchChain = processDispatch.catch(async (error) => {
        if (this.stopped) return;
        console.warn('[discord] Dispatch processing failed:', providerError(error));
        this.stopped = true;
        try {
          await this.stopListening();
        } finally {
          try {
            await options.onError?.(error);
          } catch (notifyError) {
            console.warn(
              '[discord] Listener failure notification failed:',
              providerError(notifyError)
            );
          }
        }
      });
    });
    await this.gateway.connect();
  }

  async stopListening(): Promise<void> {
    this.stopped = true;
    const gateway = this.gateway;
    this.gateway = null;
    if (gateway) await gateway.destroy();
  }

  async testConnection(): Promise<GatewayConnectionTestResult> {
    const validation = validateDiscordConfig(this.config as Record<string, unknown>, {
      requireBotToken: true,
    });
    if (!validation.ok) {
      return {
        ok: false,
        failures: validation.errors.map((reason) => ({ capability: 'config', reason })),
        notVerifiable: [],
      };
    }
    try {
      const [bot, guild, gatewayBot] = await Promise.all([
        asRecord(await this.transport.rest.get(Routes.user('@me'))),
        asRecord(await this.transport.rest.get(Routes.guild(this.config.guild_id!))),
        asRecord(await this.transport.rest.get(Routes.gatewayBot())),
      ]);
      const botOk = bot?.id === configuredString(this.config, 'application_id');
      const guildOk = guild?.id === configuredString(this.config, 'guild_id');
      const shardCount = typeof gatewayBot?.shards === 'number' ? gatewayBot.shards : 0;
      const botUserId = snowflake(bot?.id);
      const member = botUserId
        ? asRecord(
            await this.transport.rest.get(
              Routes.guildMember(configuredString(this.config, 'guild_id'), botUserId)
            )
          )
        : null;
      const channels = await Promise.all(
        configuredChannelIds(this.config).map(async (channelId) => ({
          channelId,
          channel: asRecord(await this.transport.rest.get(Routes.channel(channelId))),
        }))
      );
      const channelAccess = channels.map(({ channelId, channel }) => {
        const permissions = effectiveChannelPermissions(
          guild,
          member,
          channel,
          configuredString(this.config, 'guild_id'),
          botUserId ?? ''
        );
        const publicText =
          channel?.id === channelId &&
          channel?.guild_id === configuredString(this.config, 'guild_id') &&
          isPublicTextChannel(channel, configuredString(this.config, 'guild_id'));
        const required =
          DISCORD_VIEW_CHANNEL_PERMISSION |
          DISCORD_SEND_MESSAGES_PERMISSION |
          DISCORD_READ_MESSAGE_HISTORY_PERMISSION |
          DISCORD_SEND_MESSAGES_IN_THREADS_PERMISSION;
        return {
          channelId,
          ok: publicText && (permissions & required) === required,
          permissions: {
            view: (permissions & DISCORD_VIEW_CHANNEL_PERMISSION) !== 0n,
            send: (permissions & DISCORD_SEND_MESSAGES_PERMISSION) !== 0n,
            readHistory: (permissions & DISCORD_READ_MESSAGE_HISTORY_PERMISSION) !== 0n,
            sendInThreads: (permissions & DISCORD_SEND_MESSAGES_IN_THREADS_PERMISSION) !== 0n,
          },
        };
      });
      const failures = [
        ...(botOk
          ? []
          : [{ capability: 'bot_identity', reason: 'Bot user does not match application_id' }]),
        ...(guildOk
          ? []
          : [{ capability: 'guild_access', reason: 'Bot cannot access the configured guild' }]),
        ...(shardCount === 1
          ? []
          : [
              {
                capability: 'gateway_shards',
                reason:
                  shardCount > 1
                    ? `Discord recommends ${shardCount} shards; this beta supports one shard only.`
                    : 'Discord did not return a valid bot shard recommendation.',
              },
            ]),
        ...(channelAccess.every((channel) => channel.ok)
          ? []
          : [
              {
                capability: 'channel_access',
                reason:
                  'One or more allowed channels is not public text or lacks view, send, history, or thread-reply permission.',
              },
            ]),
      ];
      return {
        ok: failures.length === 0,
        bot: {
          userId: String(bot?.id ?? ''),
          name: String(bot?.username ?? bot?.global_name ?? ''),
        },
        team: { id: String(guild?.id ?? this.config.guild_id), name: String(guild?.name ?? '') },
        channelAccess,
        failures,
        notVerifiable: [
          'End-to-end send/reply permission for every configured channel and thread cannot be proven by this REST-only probe; sampled view, send, history, and thread-reply bits are reported in channelAccess.',
          'Whether the bot can receive MESSAGE_CREATE events end to end; the probe does not open a listener or use live credentials beyond these REST calls.',
          'Whether every configured allowlisted user or role can currently see the channel and is role-matchable at delivery time.',
          'Whether a Discord message creates or reuses the intended Agor session after gateway filtering, mapping ownership, and prompt admission.',
          'Whether the Developer Portal preserves the GUILDS and GUILD_MESSAGES intents; privileged Message Content is not requested by this beta.',
        ],
      };
    } catch (error) {
      return {
        ok: false,
        failures: [{ capability: 'bot_token', reason: providerError(error) }],
        notVerifiable: [],
      };
    }
  }
}
