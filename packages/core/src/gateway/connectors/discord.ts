import type { REST } from '@discordjs/rest';
import { type SessionInfo, WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import {
  GatewayDispatchEvents,
  type GatewayDispatchPayload,
  type GatewayMessageCreateDispatchData,
} from 'discord-api-types/v10';

import type {
  ChannelType,
  DiscordGatewayConfig,
  DiscordSnowflake,
  GatewayConnectionTestResult,
} from '../../types/gateway';
import type {
  GatewayConnector,
  GatewayHistoryCapability,
  GatewayInboundCallback,
  GatewayListenerOptions,
} from '../connector';
import { GatewayListenerError } from '../listener-error';
import {
  DISCORD_GATEWAY_INTENTS,
  type DiscordApplicationSettingsSummary,
  hasDiscordMessageContentAccess,
} from './discord-app-settings';
import { compareDiscordSnowflakes, parseDiscordGatewayConfig } from './discord-config';
import { admitDiscordMessage } from './discord-inbound';
import { DiscordAggregatePresenceController } from './discord-presence';
import {
  type DiscordDeliveryChunkRequest,
  DiscordProvider,
  type DiscordRecoverableSendOptions,
  safeDiscordErrorCode,
} from './discord-provider';

const DISCORD_DISPATCH_QUEUE_MAX_DEPTH = 1_000;

function discordListenerFailure(error: unknown): GatewayListenerError {
  const code = safeDiscordErrorCode(error);
  if (code === '401' || code === '4004') {
    return new GatewayListenerError(
      'discord_bot_token_invalid',
      'permanent',
      'Replace the Discord bot token and verify the application binding.'
    );
  }
  if (code === '4013' || code === '4014') {
    return new GatewayListenerError(
      'discord_gateway_intents_invalid',
      'permanent',
      'Enable Message Content access and use the audited Discord launch intents.'
    );
  }
  if (code === '4010' || code === '4011' || code === '4012') {
    return new GatewayListenerError(
      'discord_gateway_sharding_invalid',
      'permanent',
      'Verify Discord gateway version and recommended shard configuration.'
    );
  }
  return new GatewayListenerError(
    'discord_gateway_unavailable',
    'transient',
    'Discord Gateway is unavailable; Agor will retry automatically.'
  );
}

export class DiscordConnector implements GatewayConnector {
  readonly channelType: ChannelType = 'discord';
  readonly history: GatewayHistoryCapability = {
    fetchConversationHistory: (req) => this.provider.fetchConversationHistory(req),
    compareCursors: compareDiscordSnowflakes,
  };

  private readonly config: DiscordGatewayConfig;
  private readonly provider: DiscordProvider;
  private readonly rest: REST;
  private manager: WebSocketManager | null = null;
  private aggregatePresence: DiscordAggregatePresenceController | null = null;
  protected botUserId: DiscordSnowflake | null = null;
  /**
   * Gateway Resume is deliberately process-local. A live manager may Resume a
   * short disconnect, but daemon restart/takeover starts a fresh session.
   * Missed summons are best-effort and become bounded thread context when the
   * next live mention is admitted.
   */
  private transportSessions = new Map<number, SessionInfo>();
  private committedSessions = new Map<number, SessionInfo>();
  private dispatchQueues = new Map<number, Promise<void>>();
  private dispatchQueueDepths = new Map<number, number>();
  private stopping = false;

  constructor(config: Record<string, unknown>) {
    this.config = parseDiscordGatewayConfig(config, {
      enabled: true,
      requireRunAsUser: false,
    });
    this.provider = new DiscordProvider(this.config);
    this.rest = this.provider.rest;
  }

  protected createWebSocketManager(options: ConstructorParameters<typeof WebSocketManager>[0]) {
    return new WebSocketManager(options);
  }

  protected async handleMessageCreate(
    message: GatewayMessageCreateDispatchData,
    callback: GatewayInboundCallback
  ): Promise<'admitted' | 'ignored'> {
    return admitDiscordMessage({
      config: this.config,
      provider: this.provider,
      botUserId: this.botUserId,
      message,
      callback,
    });
  }

  private commitDispatch(shardId: number, sequence: number | null): void {
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) return;
    const transport = this.transportSessions.get(shardId);
    if (!transport) return;
    this.committedSessions.set(shardId, { ...transport, sequence: sequence as number });
  }

  private async abortTransport(): Promise<void> {
    const manager = this.manager;
    this.manager = null;
    this.stopping = true;
    if (manager) {
      await manager.destroy({ code: 1011, reason: 'Agor dispatch processing stopped' });
    }
  }

  private async handleDispatch(
    payload: GatewayDispatchPayload,
    shardId: number,
    callback: GatewayInboundCallback
  ): Promise<void> {
    if (payload.t === GatewayDispatchEvents.MessageCreate) {
      await this.handleMessageCreate(payload.d, callback);
    }
    // Resume is only an in-process optimization. Ignored traffic is safe to
    // advance because the next admitted mention reads its context from REST.
    this.commitDispatch(shardId, payload.s);
  }

  private enqueueDispatch(
    payload: GatewayDispatchPayload,
    shardId: number,
    callback: GatewayInboundCallback,
    options: GatewayListenerOptions
  ): void {
    const depth = this.dispatchQueueDepths.get(shardId) ?? 0;
    if (depth >= DISCORD_DISPATCH_QUEUE_MAX_DEPTH) {
      if (!this.stopping) void this.abortTransport().catch(() => undefined);
      return;
    }
    this.dispatchQueueDepths.set(shardId, depth + 1);
    const prior = this.dispatchQueues.get(shardId) ?? Promise.resolve();
    let current: Promise<void>;
    current = prior
      .then(() => {
        if (this.stopping) return;
        return this.handleDispatch(payload, shardId, callback);
      })
      .catch(async () => {
        if (this.stopping) return;
        // A failed summon is intentionally best-effort. A later live mention
        // re-reads the interval from the mapping's last admitted cursor. An
        // ownership failure is different: stop the stale socket immediately.
        if (
          options.listenerClaimIsCurrent &&
          !(await options.listenerClaimIsCurrent().catch(() => false))
        ) {
          await this.abortTransport();
        }
      })
      .finally(() => {
        const nextDepth = Math.max(0, (this.dispatchQueueDepths.get(shardId) ?? 1) - 1);
        if (nextDepth === 0) this.dispatchQueueDepths.delete(shardId);
        else this.dispatchQueueDepths.set(shardId, nextDepth);
        if (this.dispatchQueues.get(shardId) === current) this.dispatchQueues.delete(shardId);
      });
    this.dispatchQueues.set(shardId, current);
  }

  async startListening(
    callback: GatewayInboundCallback,
    options: GatewayListenerOptions = {}
  ): Promise<void> {
    if (this.manager) return;
    this.stopping = false;
    this.dispatchQueues.clear();
    this.dispatchQueueDepths.clear();
    this.transportSessions.clear();
    this.committedSessions.clear();
    try {
      const { bot, application } = await this.provider.identity();
      if (!bot.bot || bot.id.length === 0 || application.id !== this.config.application_id) {
        throw new GatewayListenerError(
          'discord_application_mismatch',
          'permanent',
          'The Discord bot token does not match the configured application.'
        );
      }
      if (!hasDiscordMessageContentAccess(application.flags)) {
        throw new GatewayListenerError(
          'discord_gateway_intents_invalid',
          'permanent',
          'Enable Message Content access for the Discord application.'
        );
      }
      this.botUserId = bot.id;

      const manager = this.createWebSocketManager({
        token: this.config.bot_token!,
        intents: DISCORD_GATEWAY_INTENTS,
        rest: this.rest,
        retrieveSessionInfo: (shardId) => this.committedSessions.get(shardId) ?? null,
        updateSessionInfo: async (shardId, session) => {
          if (session) {
            this.transportSessions.set(shardId, session);
            return;
          }
          // A non-resumable Invalid Session starts a fresh Identify. There is
          // no durable gap scan; a later mention performs thread catch-up.
          if (this.stopping) return;
          this.transportSessions.delete(shardId);
          this.committedSessions.delete(shardId);
        },
      });
      this.manager = manager;
      const aggregatePresence = new DiscordAggregatePresenceController(manager, {
        beforeSend: async () =>
          !this.stopping &&
          this.manager === manager &&
          !!options.listenerClaimIsCurrent &&
          (await options.listenerClaimIsCurrent()),
        onDiagnostic: options.reportAggregatePresenceState,
      });
      this.aggregatePresence = aggregatePresence;
      manager.on(WebSocketShardEvents.Dispatch, (payload, shardId) => {
        if (this.stopping || this.manager !== manager) return;
        this.enqueueDispatch(payload, shardId, callback, options);
      });
      manager.on(WebSocketShardEvents.Ready, () => {
        aggregatePresence.resend();
      });
      manager.on(WebSocketShardEvents.Resumed, () => {
        aggregatePresence.resend();
      });
      await manager.connect();
    } catch (error) {
      const manager = this.manager;
      this.manager = null;
      this.aggregatePresence?.stop();
      this.aggregatePresence = null;
      this.stopping = true;
      if (manager) {
        await Promise.resolve(
          manager.destroy({ code: 1011, reason: 'Agor listener startup stopped' })
        ).catch(() => undefined);
      }
      if (error instanceof GatewayListenerError) throw error;
      throw discordListenerFailure(error);
    }
  }

  async stopListening(): Promise<void> {
    const manager = this.manager;
    this.manager = null;
    this.aggregatePresence?.stop();
    this.aggregatePresence = null;
    this.stopping = true;
    this.provider.clearCache();
    if (manager) await manager.destroy({ code: 1000, reason: 'Agor listener stopped' });
    // The daemon releases its durable claim only after callbacks admitted
    // before socket destruction have drained.
    await Promise.all([...this.dispatchQueues.values()]);
    this.dispatchQueues.clear();
    this.dispatchQueueDepths.clear();
    this.transportSessions.clear();
    this.committedSessions.clear();
  }

  async sendMessage(req: Parameters<GatewayConnector['sendMessage']>[0]): Promise<string> {
    return this.provider.sendMessage(req, {
      ...(this.botUserId ? { botUserId: this.botUserId } : {}),
    });
  }

  async sendMessageRecoverable(
    req: Parameters<GatewayConnector['sendMessage']>[0],
    options: Omit<DiscordRecoverableSendOptions, 'botUserId'>
  ): Promise<string> {
    return this.provider.sendMessage(req, {
      ...options,
      ...(this.botUserId ? { botUserId: this.botUserId } : {}),
    });
  }

  async sendDeliveryChunk(
    req: DiscordDeliveryChunkRequest,
    options: Omit<DiscordRecoverableSendOptions, 'botUserId'>
  ): Promise<string> {
    return this.provider.sendDeliveryChunk(req, {
      ...options,
      ...(this.botUserId ? { botUserId: this.botUserId } : {}),
    });
  }

  async deleteMessage(req: { threadId: string; messageId: string }): Promise<void> {
    await this.provider.deleteMessage(req);
  }

  async triggerTyping(threadId: string): Promise<void> {
    await this.provider.triggerTyping(threadId);
  }

  updateAggregatePresence(activeCount: number): void {
    this.aggregatePresence?.request(activeCount);
  }

  getAggregatePresenceDiagnostic() {
    return (
      this.aggregatePresence?.getDiagnostic() ?? {
        desiredActiveCount: null,
        lastSentActiveCount: null,
        pending: false,
        retryCount: 0,
      }
    );
  }

  formatMessage(markdown: string): string {
    return markdown;
  }

  async testConnection(options?: { signal?: AbortSignal }): Promise<GatewayConnectionTestResult> {
    return this.provider.testConnection(options);
  }

  async applyRecommendedApplicationSettings(options: {
    signal?: AbortSignal;
    beforePatch: (applicationId: DiscordSnowflake) => Promise<void>;
  }): Promise<DiscordApplicationSettingsSummary> {
    return this.provider.applyRecommendedApplicationSettings(options);
  }
}
