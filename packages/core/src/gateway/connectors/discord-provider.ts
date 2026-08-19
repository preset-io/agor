import { REST } from '@discordjs/rest';
import {
  type APIChannel,
  type APIMessage,
  type APIUser,
  ChannelType as DiscordChannelType,
  type RESTGetAPIChannelMessagesResult,
  type RESTGetAPIChannelResult,
  type RESTGetAPICurrentUserResult,
  type RESTGetAPIGatewayBotResult,
  type RESTGetAPIGuildResult,
  type RESTGetAPIOAuth2CurrentApplicationResult,
  type RESTGetCurrentApplicationResult,
  type RESTPatchCurrentApplicationResult,
  type RESTPostAPIChannelMessagesThreadsResult,
  Routes,
} from 'discord-api-types/v10';

import type {
  DiscordGatewayConfig,
  DiscordSnowflake,
  GatewayConnectionTestFailure,
  GatewayConnectionTestResult,
} from '../../types/gateway';
import type { GatewayHistoryCapability } from '../connector';
import {
  buildDiscordApplicationSettingsPatch,
  type DiscordApplicationSettingsSummary,
  discordGuildInstallDefaultsMatch,
  hasDiscordMessageContentAccess,
  summarizeDiscordApplicationSettings,
} from './discord-app-settings';
import { compareDiscordSnowflakes, isDiscordSnowflake } from './discord-config';
import {
  isDiscordAllowedParentType,
  isDiscordSupportedThreadType,
  parseDiscordThreadId,
} from './discord-helpers';
import type {
  DiscordDeliveryChunkRequest,
  DiscordRecoverableSendOptions,
} from './discord-provider-delivery';
import { sendDiscordDeliveryChunk, sendDiscordMessage } from './discord-provider-delivery';
import {
  DISCORD_THREAD_HISTORY_MAX_ACTOR_BYTES,
  DISCORD_THREAD_HISTORY_MAX_LIMIT,
  DISCORD_THREAD_HISTORY_MAX_PROVIDER_PAGES,
  DISCORD_THREAD_HISTORY_MAX_TEXT_BYTES,
  DiscordThreadHistoryIncompleteError,
  DiscordThreadHistoryMalformedError,
} from './discord-thread-history';

export type {
  DiscordDeliveryChunkRequest,
  DiscordRecoverableSendOptions,
} from './discord-provider-delivery';

const CHANNEL_CACHE_TTL_MS = 10 * 60_000;

export interface ResolvedDiscordSurface {
  channelId: DiscordSnowflake;
  guildId: DiscordSnowflake;
  parentId: DiscordSnowflake;
  channelType: DiscordChannelType;
  kind: 'parent_text' | 'public_thread';
}

interface CachedDiscordSurface {
  surface: ResolvedDiscordSurface;
  expiresAt: number;
}

export function safeDiscordErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const raw = record.rawError;
  const rawCode =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>).code : undefined;
  const code = rawCode ?? record.code ?? record.status;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
}

function failure(capability: string, reason: string): GatewayConnectionTestFailure {
  return { capability, reason };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Discord operation aborted');
}

function isGuildChannel(channel: APIChannel): channel is APIChannel & { guild_id: string } {
  return 'guild_id' in channel && typeof channel.guild_id === 'string';
}

function actorLabel(user: APIUser): string {
  return user.global_name?.trim() || user.username?.trim() || 'Discord user';
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeHistoryMessage(message: APIMessage) {
  if (
    !isDiscordSnowflake(message.id) ||
    !message.author ||
    !isDiscordSnowflake(message.author.id) ||
    (message.author.bot !== undefined && typeof message.author.bot !== 'boolean') ||
    typeof message.content !== 'string' ||
    utf8Bytes(message.content) > DISCORD_THREAD_HISTORY_MAX_TEXT_BYTES ||
    typeof message.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(message.timestamp)) ||
    !Array.isArray(message.attachments) ||
    message.attachments.length > 25
  ) {
    throw new DiscordThreadHistoryMalformedError();
  }
  const label = actorLabel(message.author);
  if (!label.trim() || utf8Bytes(label) > DISCORD_THREAD_HISTORY_MAX_ACTOR_BYTES) {
    throw new DiscordThreadHistoryMalformedError();
  }
  return {
    cursor: message.id,
    iso_time: message.timestamp,
    actor_label: label,
    text: message.content,
    is_trigger: false,
    ...(message.attachments.length > 0
      ? { attachment_summary: `${message.attachments.length} attached file(s)` }
      : {}),
  };
}

/** Discord REST transport and provider-specific normalization. */
export class DiscordProvider {
  readonly rest: REST;
  private readonly channelCache = new Map<string, CachedDiscordSurface>();

  constructor(private readonly config: DiscordGatewayConfig) {
    this.rest = new REST({ version: '10', retries: 3, timeout: 15_000 }).setToken(
      config.bot_token!
    );
  }

  clearCache(): void {
    this.channelCache.clear();
  }

  cacheSurface(surface: ResolvedDiscordSurface): void {
    this.channelCache.set(surface.channelId, {
      surface,
      expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS,
    });
  }

  async identity(): Promise<{
    bot: RESTGetAPICurrentUserResult;
    application: RESTGetAPIOAuth2CurrentApplicationResult;
  }> {
    const [bot, application] = (await Promise.all([
      this.rest.get(Routes.user()),
      this.rest.get(Routes.oauth2CurrentApplication()),
    ])) as [RESTGetAPICurrentUserResult, RESTGetAPIOAuth2CurrentApplicationResult];
    return { bot, application };
  }

  async resolveSurface(
    channelId: DiscordSnowflake,
    signal?: AbortSignal
  ): Promise<ResolvedDiscordSurface | null> {
    const cached = this.channelCache.get(channelId);
    if (cached && cached.expiresAt > Date.now()) return cached.surface;
    const channel = (await this.rest.get(
      Routes.channel(channelId),
      signal ? { signal } : undefined
    )) as RESTGetAPIChannelResult;
    if (!isGuildChannel(channel) || channel.guild_id !== this.config.guild_id) return null;

    let surface: ResolvedDiscordSurface | null = null;
    if (
      channel.type === DiscordChannelType.GuildText &&
      this.config.allowed_channel_ids.includes(channel.id)
    ) {
      surface = {
        channelId: channel.id,
        guildId: channel.guild_id,
        parentId: channel.id,
        channelType: channel.type,
        kind: 'parent_text',
      };
    } else if (
      isDiscordSupportedThreadType(channel.type) &&
      'parent_id' in channel &&
      typeof channel.parent_id === 'string' &&
      this.config.allowed_channel_ids.includes(channel.parent_id)
    ) {
      surface = {
        channelId: channel.id,
        guildId: channel.guild_id,
        parentId: channel.parent_id,
        channelType: channel.type,
        kind: 'public_thread',
      };
    }
    if (surface) this.cacheSurface(surface);
    return surface;
  }

  async preparePublicThread(
    surface: ResolvedDiscordSurface,
    messageId: DiscordSnowflake
  ): Promise<Record<string, unknown>> {
    if (surface.kind !== 'parent_text') return {};
    let thread: RESTPostAPIChannelMessagesThreadsResult;
    try {
      thread = (await this.rest.post(Routes.threads(surface.channelId, messageId), {
        body: { name: 'Agor session' },
      })) as RESTPostAPIChannelMessagesThreadsResult;
    } catch (error) {
      if (safeDiscordErrorCode(error) !== '160004') throw error;
      thread = (await this.rest.get(Routes.channel(messageId))) as RESTGetAPIChannelResult;
    }
    if (
      thread.id !== messageId ||
      !isGuildChannel(thread) ||
      thread.guild_id !== this.config.guild_id ||
      !isDiscordSupportedThreadType(thread.type) ||
      !('parent_id' in thread) ||
      thread.parent_id !== surface.parentId
    ) {
      throw new Error('Discord returned an unexpected public thread identity');
    }
    return {
      discord_channel_id: thread.id,
      discord_parent_channel_id: surface.parentId,
      discord_root_message_id: messageId,
    };
  }

  async fetchConversationHistory(
    req: Parameters<GatewayHistoryCapability['fetchConversationHistory']>[0]
  ): ReturnType<GatewayHistoryCapability['fetchConversationHistory']> {
    const channelId = parseDiscordThreadId(req.threadId);
    if (
      !isDiscordSnowflake(req.throughCursor) ||
      !isDiscordSnowflake(req.triggerCursor) ||
      (req.afterCursor !== undefined && !isDiscordSnowflake(req.afterCursor)) ||
      !Number.isSafeInteger(req.limit) ||
      req.limit < 1 ||
      req.limit > DISCORD_THREAD_HISTORY_MAX_LIMIT ||
      (req.afterCursor && compareDiscordSnowflakes(req.afterCursor, req.throughCursor) > 0) ||
      compareDiscordSnowflakes(req.triggerCursor, req.throughCursor) > 0 ||
      (req.afterCursor && compareDiscordSnowflakes(req.triggerCursor, req.afterCursor) < 0)
    ) {
      throw new Error('Discord thread history bounds are invalid');
    }
    if (req.afterCursor === req.throughCursor) {
      return { messages: [], has_more: false };
    }
    const messages = new Map<string, APIMessage>();
    const throughSuccessor = BigInt(req.throughCursor) + 1n;
    if (!isDiscordSnowflake(throughSuccessor.toString())) {
      throw new Error('Discord thread history bounds are invalid');
    }
    let before = throughSuccessor.toString() as DiscordSnowflake;
    let reachedLowerBound = false;
    let pages = 0;
    while (!reachedLowerBound && pages < DISCORD_THREAD_HISTORY_MAX_PROVIDER_PAGES) {
      const pageLimit = 100;
      const query = new URLSearchParams({ limit: String(pageLimit), before });
      await req.beforeProviderCall?.();
      const page = (await this.rest.get(Routes.channelMessages(channelId), {
        query,
      })) as RESTGetAPIChannelMessagesResult;
      pages++;
      if (!Array.isArray(page) || page.length > pageLimit) {
        throw new DiscordThreadHistoryMalformedError();
      }
      if (page.length === 0) {
        reachedLowerBound = true;
        break;
      }

      let smallest: DiscordSnowflake | undefined;
      for (const message of page) {
        if (!isDiscordSnowflake(message.id)) {
          throw new DiscordThreadHistoryMalformedError();
        }
        smallest =
          !smallest || compareDiscordSnowflakes(message.id, smallest) < 0 ? message.id : smallest;
        // Validate even skipped bot rows so a malformed provider page never
        // influences the safe continuation cursor.
        normalizeHistoryMessage(message);
        if (
          compareDiscordSnowflakes(message.id, req.throughCursor) <= 0 &&
          (!req.afterCursor || compareDiscordSnowflakes(message.id, req.afterCursor) > 0) &&
          !message.author.bot &&
          !message.webhook_id
        ) {
          messages.set(message.id, message);
        }
      }
      if (!smallest || compareDiscordSnowflakes(smallest, before) >= 0) {
        throw new DiscordThreadHistoryMalformedError();
      }
      if (
        page.length < pageLimit ||
        (req.afterCursor && compareDiscordSnowflakes(smallest, req.afterCursor) <= 0)
      ) {
        reachedLowerBound = true;
        break;
      }
      before = smallest;
    }

    if (!reachedLowerBound && !req.allowTruncatedLowerBound) {
      throw new DiscordThreadHistoryIncompleteError();
    }
    const allHuman = [...messages.values()]
      .sort((left, right) => compareDiscordSnowflakes(left.id, right.id))
      .map((message) => ({
        ...normalizeHistoryMessage(message),
        is_trigger: message.id === req.triggerCursor,
      }));
    const normalized = req.preferLatest
      ? allHuman.slice(Math.max(0, allHuman.length - req.limit))
      : allHuman.slice(0, req.limit);
    const hasMore = !reachedLowerBound || allHuman.length > req.limit;
    const nextCursor = normalized.at(-1)?.cursor;
    if (hasMore && !nextCursor) {
      throw new Error('Discord history pagination could not produce a safe continuation');
    }
    return {
      messages: normalized,
      has_more: hasMore,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    };
  }

  async sendMessage(
    req: {
      threadId: string;
      text: string;
      metadata?: Record<string, unknown>;
    },
    options: DiscordRecoverableSendOptions = {}
  ): Promise<string> {
    return sendDiscordMessage(this.rest, req, options);
  }

  async sendDeliveryChunk(
    req: DiscordDeliveryChunkRequest,
    options: DiscordRecoverableSendOptions = {}
  ): Promise<string> {
    return sendDiscordDeliveryChunk(this.rest, req, options);
  }

  async deleteMessage(req: { threadId: string; messageId: string }): Promise<void> {
    await this.rest.delete(
      Routes.channelMessage(parseDiscordThreadId(req.threadId), req.messageId)
    );
  }

  async triggerTyping(threadId: string): Promise<void> {
    await this.rest.post(Routes.channelTyping(parseDiscordThreadId(threadId)));
  }

  /**
   * Apply only the reviewed editable subset of the token's current application.
   * The caller's callback is the fresh database side-effect admission fence and
   * runs after the identity-bearing GET, immediately before PATCH.
   */
  async applyRecommendedApplicationSettings(options: {
    signal?: AbortSignal;
    beforePatch: (applicationId: DiscordSnowflake) => Promise<void>;
  }): Promise<DiscordApplicationSettingsSummary> {
    const { signal } = options;
    throwIfAborted(signal);
    const application = (await this.rest.get(
      Routes.currentApplication(),
      signal ? { signal } : undefined
    )) as RESTGetCurrentApplicationResult;
    throwIfAborted(signal);
    if (!isDiscordSnowflake(application.id) || application.id !== this.config.application_id) {
      throw new Error('Discord bot token does not match the configured application');
    }
    const body = buildDiscordApplicationSettingsPatch(application);
    await options.beforePatch(application.id);
    throwIfAborted(signal);
    const updated = (await this.rest.patch(Routes.currentApplication(), {
      body,
      ...(signal ? { signal } : {}),
    })) as RESTPatchCurrentApplicationResult;
    throwIfAborted(signal);
    return summarizeDiscordApplicationSettings(
      updated,
      this.config.application_id,
      this.config.guild_id
    );
  }

  async testConnection(
    options: { signal?: AbortSignal } = {}
  ): Promise<GatewayConnectionTestResult> {
    const { signal } = options;
    const failures: GatewayConnectionTestFailure[] = [];
    const channelAccess: Array<{ channelId: string; ok: boolean }> = [];
    let bot: RESTGetAPICurrentUserResult | undefined;
    let application: RESTGetAPIOAuth2CurrentApplicationResult | undefined;
    let guild: RESTGetAPIGuildResult | undefined;
    try {
      throwIfAborted(signal);
      bot = (await this.rest.get(
        Routes.user(),
        signal ? { signal } : undefined
      )) as RESTGetAPICurrentUserResult;
      throwIfAborted(signal);
      if (!bot.bot) failures.push(failure('bot_token', 'Token does not belong to a bot'));
    } catch (error) {
      throwIfAborted(signal);
      failures.push(
        failure(
          'bot_token',
          safeDiscordErrorCode(error) === '401'
            ? 'Bot token is invalid'
            : 'Bot identity unavailable'
        )
      );
    }
    try {
      throwIfAborted(signal);
      application = (await this.rest.get(
        Routes.oauth2CurrentApplication(),
        signal ? { signal } : undefined
      )) as RESTGetAPIOAuth2CurrentApplicationResult;
      throwIfAborted(signal);
      if (application.id !== this.config.application_id) {
        failures.push(failure('application_id', 'Bot token does not match application'));
      }
      if (!hasDiscordMessageContentAccess(application.flags)) {
        failures.push(
          failure('message_content', 'Privileged Message Content access is not enabled')
        );
      }
      if (!discordGuildInstallDefaultsMatch(application)) {
        failures.push(
          failure(
            'guild_install_defaults',
            'Discord Guild Install defaults differ from the reviewed launch permissions'
          )
        );
      }
    } catch {
      throwIfAborted(signal);
      failures.push(failure('application_id', 'Application identity unavailable'));
    }
    try {
      throwIfAborted(signal);
      guild = (await this.rest.get(
        Routes.guild(this.config.guild_id),
        signal ? { signal } : undefined
      )) as RESTGetAPIGuildResult;
      throwIfAborted(signal);
      if (guild.id !== this.config.guild_id) {
        failures.push(failure('guild_id', 'Configured guild does not match response'));
      }
    } catch {
      throwIfAborted(signal);
      failures.push(failure('guild_id', 'Configured guild is unavailable to the bot'));
    }
    for (const channelId of this.config.allowed_channel_ids) {
      try {
        throwIfAborted(signal);
        const channel = (await this.rest.get(
          Routes.channel(channelId),
          signal ? { signal } : undefined
        )) as RESTGetAPIChannelResult;
        throwIfAborted(signal);
        const ok =
          isGuildChannel(channel) &&
          channel.guild_id === this.config.guild_id &&
          isDiscordAllowedParentType(channel.type);
        channelAccess.push({ channelId, ok });
        if (!ok)
          failures.push(
            failure('channel_access', 'Allowed channel is not a supported guild parent')
          );
      } catch {
        throwIfAborted(signal);
        channelAccess.push({ channelId, ok: false });
        failures.push(failure('channel_access', 'Allowed channel is unavailable to the bot'));
      }
    }
    try {
      throwIfAborted(signal);
      const gateway = (await this.rest.get(
        Routes.gatewayBot(),
        signal ? { signal } : undefined
      )) as RESTGetAPIGatewayBotResult;
      throwIfAborted(signal);
      if (gateway.session_start_limit.remaining <= 0) {
        failures.push(failure('gateway_session_start', 'Gateway session starts are exhausted'));
      }
    } catch {
      throwIfAborted(signal);
      failures.push(failure('gateway', 'Gateway bot information is unavailable'));
    }

    return {
      ok: failures.length === 0,
      ...(application?.id === this.config.application_id
        ? { providerInstallationId: application.id }
        : {}),
      ...(guild ? { team: { id: guild.id, name: guild.name } } : {}),
      ...(bot ? { bot: { userId: bot.id, name: bot.username } } : {}),
      channelAccess,
      failures,
      notVerifiable: [
        'Effective send/thread/file permissions after guild role and channel overwrites',
        'Receipt of MESSAGE_CREATE events and structured mentions',
        'Gateway reconnect/takeover and best-effort downtime behavior',
        'Locked or archived mapped-thread behavior',
        'Discord AutoMod acceptance of model output',
        'End-to-end Agor session and Task execution',
      ],
    };
  }
}
