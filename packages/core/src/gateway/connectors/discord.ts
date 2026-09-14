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
  ApplicationFlags,
  GatewayCloseCodes,
  GatewayDispatchEvents,
  type GatewayDispatchPayload,
  GatewayIntentBits,
  PermissionFlagsBits,
  Routes,
} from 'discord-api-types/v10';
import type {
  ChannelType,
  DiscordGatewayConfig,
  DiscordThreadCoordinates,
  GatewayConnectionTestResult,
} from '../../types/gateway';
import {
  isDiscordSnowflake,
  isDiscordThreadCoordinates,
  validateDiscordConfig,
} from '../../types/gateway';
import type {
  GatewayConnector,
  GatewayInboundCallback,
  GatewayListenerOptions,
  GatewayProviderHistoryRequest,
  GatewayProviderHistoryResult,
  GatewaySendReceipt,
  InboundMessage,
} from '../connector';
import type { DiscordDeliveryNonce } from '../discord-identifiers';
import {
  buildDiscordInboundMetadata,
  buildDiscordLegacyThreadKey,
  buildDiscordMessageThreadKey,
  buildDiscordVerifiedThreadMetadata,
  DISCORD_METADATA_KEY,
  parseDiscordAuthorityMetadata,
  parseDiscordThreadKey,
} from '../discord-identifiers';
import { GatewayListenerError } from '../listener-error';
import { gatewayFailureCode } from '../provider-error';
import { fetchDiscordProviderHistory } from './discord-history';

const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_TEXT_CHANNEL_TYPE = 0;
const DISCORD_PUBLIC_THREAD_TYPES = new Set([10, 11]);
const DISCORD_TEXT_MESSAGE_TYPES = new Set([0, 19]);
const DISCORD_NONCE_RECOVERY_WINDOW_MS = 5 * 60_000;
const DISCORD_VIEW_CHANNEL_PERMISSION = PermissionFlagsBits.ViewChannel;
const DISCORD_SEND_MESSAGES_PERMISSION = PermissionFlagsBits.SendMessages;
const DISCORD_READ_MESSAGE_HISTORY_PERMISSION = PermissionFlagsBits.ReadMessageHistory;
const DISCORD_CREATE_PUBLIC_THREADS_PERMISSION = PermissionFlagsBits.CreatePublicThreads;
const DISCORD_SEND_MESSAGES_IN_THREADS_PERMISSION = PermissionFlagsBits.SendMessagesInThreads;
const DISCORD_MESSAGE_CONTENT_FLAGS =
  BigInt(ApplicationFlags.GatewayMessageContent) |
  BigInt(ApplicationFlags.GatewayMessageContentLimited);

interface DiscordRestTransport {
  get(route: string): Promise<unknown>;
  post(route: string, options?: { body?: unknown }): Promise<unknown>;
}

interface DiscordGatewayTransport {
  on(
    event: WebSocketShardEvents.Dispatch,
    listener: (payload: GatewayDispatchPayload, shardId: number) => void | Promise<void>
  ): unknown;
  on(
    event: WebSocketShardEvents.Error | WebSocketShardEvents.SocketError,
    listener: (error: Error, shardId: number) => void | Promise<void>
  ): unknown;
  on(
    event: WebSocketShardEvents.Closed,
    listener: (code: number, shardId: number) => void | Promise<void>
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

interface VerifiedDiscordThread {
  coordinates: DiscordThreadCoordinates;
  type: number;
}

function defaultDiscordTransport(token: string): DiscordTransport {
  const rest = new REST({ version: '10' }).setToken(token);
  return {
    rest,
    createGateway: ({ onSessionInfo }) =>
      new WebSocketManager({
        token,
        rest,
        intents:
          GatewayIntentBits.Guilds |
          GatewayIntentBits.GuildMessages |
          GatewayIntentBits.MessageContent,
        shardCount: 1,
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

/** Keep only numeric retry metadata when sanitizing a provider error. */
function withDeliveryErrorMetadata(error: unknown, message: string): Error {
  const wrapped = new Error(message);
  const record = asRecord(error);
  if (!record) return wrapped;
  const status = record.status ?? record.statusCode ?? record.code;
  if (typeof status === 'number') {
    (wrapped as Error & { status: number }).status = status;
  }
  const retryAfter =
    record.retry_after_ms ??
    record.retryAfterMs ??
    record.retry_after ??
    record.retryAfter ??
    asRecord(record.rawError)?.retry_after;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    if (record.retry_after_ms !== undefined || record.retryAfterMs !== undefined) {
      (wrapped as Error & { retry_after_ms: number }).retry_after_ms = retryAfter;
    } else {
      (wrapped as Error & { retry_after: number }).retry_after = retryAfter;
    }
  }
  return wrapped;
}

function snowflake(value: unknown): string | undefined {
  return isDiscordSnowflake(value) ? value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function discordMentionRanges(text: string, botUserId: string): Array<[number, number]> {
  const mention = new RegExp(`<@!?${escapeRegExp(botUserId)}>`, 'g');
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(mention)) {
    if (match.index !== undefined) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/** True when a character offset is inside an inline or fenced Markdown code span. */
function isDiscordCodeOffset(text: string, offset: number): boolean {
  let fenced = false;
  let inline = false;
  for (let index = 0; index < text.length && index < offset; index += 1) {
    if (text.startsWith('```', index)) {
      if (!inline) fenced = !fenced;
      index += 2;
      continue;
    }
    if (text[index] === '`' && !fenced) inline = !inline;
  }
  return fenced || inline;
}

/**
 * Discord's structured `mentions` list is the authority for a bot mention;
 * content matching alone would admit look-alike text.  The content scan then
 * excludes mentions embedded in inline or fenced code.
 */
export function hasStructuredDiscordBotMention(
  message: Record<string, unknown>,
  botUserId: string
): boolean {
  const mentions = Array.isArray(message.mentions) ? message.mentions.map(asRecord) : [];
  if (!mentions.some((mention) => mention?.id === botUserId)) return false;
  const content = typeof message.content === 'string' ? message.content : '';
  return discordMentionRanges(content, botUserId).some(
    ([start]) => !isDiscordCodeOffset(content, start)
  );
}

/** Remove only structured bot mentions that are outside code spans. */
function stripStructuredDiscordBotMention(text: string, botUserId: string): string {
  const ranges = discordMentionRanges(text, botUserId).filter(
    ([start]) => !isDiscordCodeOffset(text, start)
  );
  if (ranges.length === 0) return text.trim();
  let output = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    output += text.slice(cursor, start);
    cursor = end;
  }
  return `${output}${text.slice(cursor)}`.replace(/^\s+|\s+$/g, '');
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
  return buildDiscordMessageThreadKey(channelId, messageId);
}

function existingThreadId(parentChannelId: string, threadChannelId: string): string {
  return buildDiscordLegacyThreadKey(parentChannelId, threadChannelId);
}

function parseThreadId(threadId: string): {
  channelId: string;
  messageId?: string;
  parentChannelId?: string;
  existingThread: boolean;
  providerThread: boolean;
} {
  const parsed = parseDiscordThreadKey(threadId);
  if (parsed?.kind === 'legacy_thread') {
    return {
      channelId: parsed.threadChannelId,
      parentChannelId: parsed.parentChannelId,
      existingThread: true,
      providerThread: false,
    };
  }
  if (parsed?.kind === 'message') {
    return {
      channelId: parsed.channelId,
      messageId: parsed.messageId,
      existingThread: false,
      providerThread: false,
    };
  }
  if (parsed?.kind === 'provider_thread') {
    return { channelId: parsed.channelId, existingThread: true, providerThread: true };
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
  return gatewayFailureCode(error);
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

function messageContentCapability(
  application: Record<string, unknown> | null
): boolean | undefined {
  const rawFlags = application?.flags;
  let flags: bigint;
  try {
    if (typeof rawFlags === 'bigint') flags = rawFlags;
    else if (typeof rawFlags === 'number' && Number.isSafeInteger(rawFlags))
      flags = BigInt(rawFlags);
    else if (typeof rawFlags === 'string' && /^\d+$/.test(rawFlags)) flags = BigInt(rawFlags);
    else return undefined;
  } catch {
    return undefined;
  }
  return (flags & DISCORD_MESSAGE_CONTENT_FLAGS) !== 0n;
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

  /**
   * Discord exposes the approved message-content capability on the
   * application resource when that REST surface includes flags.  Missing or
   * unparseable flags remain unknown; this probe does not claim to prove
   * Developer Portal state or gateway delivery.
   */
  private async readMessageContentCapability(): Promise<boolean | undefined> {
    try {
      return messageContentCapability(
        await this.getProviderRecord(Routes.oauth2CurrentApplication())
      );
    } catch {
      return undefined;
    }
  }

  private async requireMessageContentCapability(): Promise<void> {
    if ((await this.readMessageContentCapability()) === false) {
      throw new GatewayListenerError(
        'discord_message_content_unavailable',
        'permanent',
        'Discord application flags do not report the Message Content intent capability.'
      );
    }
  }

  private providerStatus(error: unknown): number | undefined {
    const record = asRecord(error);
    const status = record?.status ?? record?.statusCode;
    return typeof status === 'number' ? status : undefined;
  }

  private async getProviderRecord(route: string): Promise<Record<string, unknown> | null> {
    try {
      return asRecord(await this.transport.rest.get(route));
    } catch (error) {
      if (this.providerStatus(error) === 404) return null;
      throw error;
    }
  }

  private async verifyPublicThread(
    rawThread: unknown,
    parentChannelId: string,
    starterMessageId: string
  ): Promise<VerifiedDiscordThread> {
    const candidate = asRecord(rawThread);
    const threadId = snowflake(candidate?.id);
    if (!threadId) throw new Error('Discord thread response has an invalid thread id');

    const thread = await this.getProviderRecord(Routes.channel(threadId));
    const coordinates = {
      guild_id: thread?.guild_id,
      parent_channel_id: thread?.parent_id,
      thread_channel_id: thread?.id,
      starter_message_id: starterMessageId,
    };
    if (
      !isDiscordThreadCoordinates(coordinates) ||
      coordinates.guild_id !== configuredString(this.config, 'guild_id') ||
      coordinates.parent_channel_id !== parentChannelId ||
      !DISCORD_PUBLIC_THREAD_TYPES.has(thread?.type as number)
    ) {
      throw new Error(
        'Discord provider thread is not a verified public child of the configured parent'
      );
    }

    // A successful starter lookup is the accessibility proof used by the
    // listener. Discord keeps a message-started public thread's starter in
    // the parent channel, even though the thread channel id equals the starter
    // message id. Callers must therefore verify it through the parent route.
    return { coordinates, type: thread?.type as number };
  }

  private async lookupThreadForStarter(
    parentChannelId: string,
    starterMessageId: string
  ): Promise<VerifiedDiscordThread | null> {
    const starter = await this.getProviderRecord(
      Routes.channelMessage(parentChannelId, starterMessageId)
    );
    if (!starter || starter.id !== starterMessageId || starter.channel_id !== parentChannelId) {
      throw new Error('Discord summon starter message is inaccessible or malformed');
    }
    const existingThread = asRecord(starter.thread);
    if (!existingThread) return null;
    return this.verifyPublicThread(existingThread, parentChannelId, starterMessageId);
  }

  private async reconcilePublicSummonThread(
    parentChannelId: string,
    starterMessageId: string
  ): Promise<VerifiedDiscordThread> {
    // The starter lookup is intentionally before the one conditional create.
    // After a daemon crash, Discord's starter message is the durable provider
    // identity that lets a replacement owner recover without another thread.
    const existing = await this.lookupThreadForStarter(parentChannelId, starterMessageId);
    if (existing) return existing;

    const body = {
      name: `Agor request ${starterMessageId.slice(-8)}`,
      auto_archive_duration: this.config.thread_auto_archive_minutes ?? 1440,
    };
    let created: unknown;
    try {
      created = await this.transport.rest.post(Routes.threads(parentChannelId, starterMessageId), {
        body,
      });
    } catch (error) {
      // Discord may have committed the thread while the request was lost, or
      // may report a conflict after another owner won.  Always reconcile by
      // starter identity before surfacing the failure; never blindly retry a
      // provider create.
      const afterConflict = await this.lookupThreadForStarter(parentChannelId, starterMessageId);
      if (afterConflict) return afterConflict;
      throw new Error(`Discord public thread creation failed: ${gatewayFailureCode(error)}`);
    }

    const createdRecord = asRecord(created);
    if (!createdRecord?.id) {
      const afterAmbiguousResult = await this.lookupThreadForStarter(
        parentChannelId,
        starterMessageId
      );
      if (afterAmbiguousResult) return afterAmbiguousResult;
      throw new Error('Discord public thread creation returned malformed coordinates');
    }
    try {
      return await this.verifyPublicThread(createdRecord, parentChannelId, starterMessageId);
    } catch (error) {
      const afterAmbiguousResult = await this.lookupThreadForStarter(
        parentChannelId,
        starterMessageId
      );
      if (afterAmbiguousResult) return afterAmbiguousResult;
      throw error;
    }
  }

  private async verifyExistingPublicThread(
    threadChannelId: string,
    parentChannelId: string,
    starterMessageId: string
  ): Promise<VerifiedDiscordThread> {
    const thread = await this.getProviderRecord(Routes.channel(threadChannelId));
    if (!thread) throw new Error('Discord public thread is inaccessible');
    const verified = await this.verifyPublicThread(thread, parentChannelId, starterMessageId);
    const starter = await this.getProviderRecord(
      Routes.channelMessage(parentChannelId, starterMessageId)
    );
    if (!starter || starter.id !== starterMessageId || starter.channel_id !== parentChannelId) {
      throw new Error('Discord public thread starter message is inaccessible or malformed');
    }
    return verified;
  }

  private async prepareInboundDelivery(
    prepared: {
      channelId: string;
      messageId: string;
      isThread: boolean;
      parentChannelId?: string;
    },
    context?: { skipProviderThreadMaterialization?: boolean }
  ): Promise<Record<string, unknown>> {
    if (context?.skipProviderThreadMaterialization) return {};

    const verified = prepared.isThread
      ? await this.verifyExistingPublicThread(
          prepared.channelId,
          prepared.parentChannelId!,
          prepared.channelId
        )
      : await this.reconcilePublicSummonThread(prepared.channelId, prepared.messageId);
    return buildDiscordVerifiedThreadMetadata(verified.coordinates, verified.type);
  }

  private async sendChunk(
    channelId: string,
    content: string,
    replyToMessageId?: string,
    delivery?: { nonce: DiscordDeliveryNonce; enforceNonce: true }
  ): Promise<{ id: string }> {
    const body = {
      content,
      allowed_mentions: { parse: [] },
      ...(delivery ? { nonce: delivery.nonce, enforce_nonce: true } : {}),
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
      throw withDeliveryErrorMetadata(error, `Discord API failure: ${gatewayFailureCode(error)}`);
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
    const metadata = parseDiscordAuthorityMetadata(req.metadata);
    if (req.metadata !== undefined && !metadata) {
      throw new Error('Discord outbound metadata contains a malformed authority field');
    }
    let parentChannelId = parsed.parentChannelId ?? parsed.channelId;
    if (parsed.providerThread) {
      const thread = await this.getProviderRecord(Routes.channel(parsed.channelId));
      if (
        !thread ||
        thread.id !== parsed.channelId ||
        thread.guild_id !== configuredString(this.config, 'guild_id') ||
        !DISCORD_PUBLIC_THREAD_TYPES.has(thread.type as number)
      ) {
        throw new Error('Discord reply target is not an accessible public thread');
      }
      parentChannelId = snowflake(thread.parent_id) ?? '';
    }
    if (!configuredChannelIds(this.config).includes(parentChannelId)) {
      throw new Error('Discord replies must remain in an allowed channel');
    }
    const explicitReply = metadata?.[DISCORD_METADATA_KEY.replyToMessageId];
    const replyTo = explicitReply ?? parsed.messageId;
    const ids: string[] = [];
    const chunks = chunkDiscordMessage(req.text);
    const deliveryNonce = metadata?.[DISCORD_METADATA_KEY.deliveryNonce];
    const enforceNonce = metadata?.[DISCORD_METADATA_KEY.enforceNonce] === true;
    if (enforceNonce && (!deliveryNonce || chunks.length !== 1)) {
      throw new Error('Discord delivery nonce requires exactly one bounded message chunk');
    }
    const nonceOptions = enforceNonce
      ? { nonce: deliveryNonce as DiscordDeliveryNonce, enforceNonce: true as const }
      : undefined;
    for (const chunk of chunks) {
      ids.push(
        (
          await this.sendChunk(
            parsed.channelId,
            chunk,
            parsed.providerThread ? undefined : replyTo,
            nonceOptions
          )
        ).id
      );
    }
    return this.receipt(parsed.channelId, req.threadId, ids);
  }

  async recoverMessageByNonce(req: {
    threadId: string;
    nonce: string;
  }): Promise<GatewaySendReceipt | null> {
    this.validate();
    const parsed = parseThreadId(req.threadId);
    const channelId = parsed.channelId;
    const raw = await this.transport.rest.get(`${Routes.channelMessages(channelId)}?limit=100`);
    if (!Array.isArray(raw)) return null;
    const found = raw
      .map(asRecord)
      .find(
        (candidate) =>
          candidate?.channel_id === channelId &&
          String(candidate.nonce ?? '') === req.nonce &&
          typeof candidate.timestamp === 'string' &&
          !Number.isNaN(Date.parse(candidate.timestamp)) &&
          Date.now() - Date.parse(candidate.timestamp) >= -60_000 &&
          Date.now() - Date.parse(candidate.timestamp) <= DISCORD_NONCE_RECOVERY_WINDOW_MS
      );
    const messageId = snowflake(found?.id);
    return messageId ? this.receipt(channelId, req.threadId, [messageId]) : null;
  }

  /** Read one bounded, verified Discord history interval for daemon catch-up. */
  async fetchProviderHistory(
    req: GatewayProviderHistoryRequest
  ): Promise<GatewayProviderHistoryResult> {
    this.validate();
    return fetchDiscordProviderHistory(this.transport.rest, this.config, req);
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

  private async isAllowedMessage(message: Record<string, unknown>): Promise<{
    accepted: boolean;
    threadId?: string;
    metadata?: Record<string, unknown>;
    text?: string;
    prepareDelivery?: InboundMessage['prepareDelivery'];
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
    const mentioned = hasStructuredDiscordBotMention(message, botUserId);
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
    const text = stripStructuredDiscordBotMention(rawContent, botUserId);
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
      metadata: buildDiscordInboundMetadata({
        guildId,
        channelId,
        messageId,
        authorId,
        roleIds: roles,
        botUserId,
        isThread,
        ...(isThread && parentId ? { parentChannelId: parentId } : {}),
        ...(referencedMessageId ? { replyToMessageId: referencedMessageId } : {}),
      }),
      prepareDelivery: async (context) =>
        this.prepareInboundDelivery(
          {
            channelId,
            messageId,
            isThread,
            ...(parentId ? { parentChannelId: parentId } : {}),
          },
          context
        ),
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
      providerEventId: `discord:${configuredString(this.config, 'guild_id')}:${result.metadata?.[DISCORD_METADATA_KEY.channelId] ?? ''}:${messageId}`,
      threadId: result.threadId,
      text: result.text,
      userId: String(asRecord(message.author)?.id ?? ''),
      timestamp: toIsoTimestamp(message.timestamp),
      metadata: result.metadata,
      prepareDelivery: result.prepareDelivery,
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
    const bot = asRecord(await this.transport.rest.get(Routes.user('@me')));
    const botUserId = snowflake(bot?.id);
    if (!botUserId) {
      throw new GatewayListenerError(
        'discord_bot_identity_invalid',
        'permanent',
        'The Discord bot token did not return a bot user identity.'
      );
    }
    await this.requireMessageContentCapability();
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
    // Discord transport resume is deliberately process-local. Listener
    // ownership and event idempotency remain durable, but transport session
    // state is not written to gateway_channels.
    this.lastSequence = -1;

    this.gateway = this.transport.createGateway({
      checkpoint: undefined,
      onSessionInfo: async () => undefined,
    });
    const failListener = async (error: unknown): Promise<void> => {
      if (this.stopped) return;
      this.stopped = true;
      const gateway = this.gateway;
      this.gateway = null;
      try {
        if (gateway) await gateway.destroy();
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
    };
    this.gateway.on(WebSocketShardEvents.Dispatch, (payload) => {
      const processDispatch = this.dispatchChain.then(async () => {
        if (this.stopped) return;
        const sequence = typeof payload.s === 'number' ? payload.s : undefined;
        if (sequence !== undefined && sequence <= this.lastSequence) return;
        await this.dispatchMessage(payload, callback);
        if (sequence !== undefined) this.lastSequence = sequence;
      });
      this.dispatchChain = processDispatch.catch(async (error) => {
        if (this.stopped) return;
        console.warn('[discord] Dispatch processing failed:', providerError(error));
        await failListener(error);
      });
    });
    this.gateway.on(WebSocketShardEvents.Error, (error) => {
      void failListener(
        new GatewayListenerError(
          'discord_gateway_error',
          'transient',
          `Discord gateway error: ${providerError(error)}`
        )
      );
    });
    this.gateway.on(WebSocketShardEvents.SocketError, (error) => {
      void failListener(
        new GatewayListenerError(
          'discord_gateway_socket_error',
          'transient',
          `Discord gateway socket error: ${providerError(error)}`
        )
      );
    });
    this.gateway.on(WebSocketShardEvents.Closed, (code) => {
      const failure =
        code === GatewayCloseCodes.DisallowedIntents
          ? new GatewayListenerError(
              'discord_message_content_unavailable',
              'permanent',
              'Enable the privileged Message Content intent for this Discord application, then refresh the channel.'
            )
          : new GatewayListenerError(
              'discord_gateway_closed',
              'transient',
              `Discord gateway closed unexpectedly (code ${code}).`
            );
      void failListener(failure);
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
      const messageContent = await this.readMessageContentCapability();
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
          DISCORD_CREATE_PUBLIC_THREADS_PERMISSION |
          DISCORD_SEND_MESSAGES_IN_THREADS_PERMISSION;
        return {
          channelId,
          ok: publicText && (permissions & required) === required,
          permissions: {
            view: (permissions & DISCORD_VIEW_CHANNEL_PERMISSION) !== 0n,
            send: (permissions & DISCORD_SEND_MESSAGES_PERMISSION) !== 0n,
            readHistory: (permissions & DISCORD_READ_MESSAGE_HISTORY_PERMISSION) !== 0n,
            createPublicThreads: (permissions & DISCORD_CREATE_PUBLIC_THREADS_PERMISSION) !== 0n,
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
                  'One or more allowed channels is not public text or lacks view, send, history, public-thread creation, or thread-reply permission.',
              },
            ]),
        ...(messageContent === false
          ? [
              {
                capability: 'message_content',
                reason:
                  'Discord application flags do not report the Message Content intent capability.',
              },
            ]
          : []),
      ];
      return {
        ok: failures.length === 0,
        bot: {
          userId: String(bot?.id ?? ''),
          name: String(bot?.username ?? bot?.global_name ?? ''),
        },
        ...(botOk && botUserId ? { verifiedInstallationId: botUserId } : {}),
        team: { id: String(guild?.id ?? this.config.guild_id), name: String(guild?.name ?? '') },
        channelAccess,
        ...(messageContent === undefined
          ? {
              verification: {
                status: 'warning' as const,
                warnings: [
                  'Discord application flags did not expose a parseable Message Content capability; this result is not verified.',
                ],
              },
            }
          : { verification: { status: 'verified' as const, warnings: [] } }),
        failures,
        notVerifiable: [
          'End-to-end send/reply permission for every configured channel and thread cannot be proven by this REST-only probe; sampled view, send, history, public-thread creation, and thread-reply bits are reported in channelAccess.',
          'Whether the bot can receive MESSAGE_CREATE events end to end; the probe does not open a listener or use live credentials beyond these REST calls.',
          'Whether every configured allowlisted user or role can currently see the channel and is role-matchable at delivery time.',
          'Whether a Discord message creates or reuses the intended Agor session after gateway filtering, mapping ownership, and prompt admission.',
          ...(messageContent === undefined
            ? [
                'Whether Discord application flags include the approved Message Content capability; the REST application resource did not expose a parseable flags value, so portal approval and gateway delivery remain unproven.',
              ]
            : []),
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
