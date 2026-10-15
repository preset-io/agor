import {
  bindRepositoryToTenantUnitOfWork,
  DEFAULT_DISCORD_DELIVERY_RECOVERY_GRACE_MS,
  type DiscordMessageDeliveryClaim,
  DiscordMessageDeliveryClaimLostError,
  type DiscordMessageDeliveryDiscoveryRef,
  DiscordMessageDeliveryRepository,
  extractDiscordDeliveryText,
  GatewayChannelRepository,
  generateId,
  MessagesRepository,
  type TenantScopeAwareDatabase,
  ThreadSessionMapRepository,
} from '@agor/core/db';
import type { GatewayConnector } from '@agor/core/gateway';
import {
  buildDiscordDeliveryMetadata,
  buildDiscordDeliveryNonce,
  chunkDiscordMessage,
  DiscordDirectMessageError,
  getConnector,
  normalizeOutbound,
  normalizeSendReceipt,
  parseDiscordThreadKey,
} from '@agor/core/gateway';
import type {
  DiscordMessageDelivery,
  DiscordMessageDeliveryChunkReceipt,
  GatewayChannel,
  MessageID,
  TenantID,
} from '@agor/core/types';
import { isDiscordDirectMessagesEnabled } from '@agor/core/types';
import {
  boundedBackoff,
  boundedProviderCall,
  DeliveryControlError,
  discoverDueDeliveryRefs,
  fairOrderByTenant,
  GatewayDeliveryLoop,
  isDefinitiveProviderFailure,
  providerStatus,
  retryAfterMs,
} from './gateway-delivery-loop.js';

const DELIVERY_LEASE_MS = 30_000;
const DELIVERY_SCAN_BATCH = 25;
const DELIVERY_MAX_ATTEMPTS = 8;
const DELIVERY_MAX_CONCURRENCY = 4;
const DELIVERY_DRAIN_TIMEOUT_MS = 5_000;

export const deterministicDiscordDeliveryNonce = buildDiscordDeliveryNonce;

export { fairOrderByTenant };

function deliveryErrorCode(error: unknown): string {
  if (error instanceof DeliveryControlError) return error.code;
  if (isDefinitiveProviderFailure(error)) return `provider_http_${providerStatus(error)}`;
  if (providerStatus(error) === 429) return 'provider_rate_limited';
  return 'provider_ambiguous_or_transient';
}

/** Retry is safe only when the connector knows the provider rejected before acceptance. */
function isExplicitlyRetryableProviderFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const record = error as Record<string, unknown>;
  return record.retryable === true && record.providerAccepted !== true;
}

interface DeliveryContext {
  delivery: DiscordMessageDelivery;
  message: Awaited<ReturnType<MessagesRepository['findById']>>;
  mapping: Awaited<ReturnType<ThreadSessionMapRepository['findById']>>;
  channel: GatewayChannel | null;
}

type DiscordMessageDeliveryWorkerRepositories = {
  delivery: Pick<
    DiscordMessageDeliveryRepository,
    | 'findDueRefs'
    | 'claim'
    | 'renewClaim'
    | 'reloadClaim'
    | 'markChunkEffectStarted'
    | 'clearChunkEffectMarker'
    | 'checkpointChunk'
    | 'completeClaim'
    | 'failClaim'
    | 'purgeExpired'
  >;
  channel: Pick<GatewayChannelRepository, 'findById'>;
  mapping: Pick<ThreadSessionMapRepository, 'findById'>;
  message: Pick<MessagesRepository, 'findById'>;
};

export interface DiscordMessageDeliveryWorkerOptions {
  tenantId?: TenantID | string;
  scanBatchSize?: number;
  leaseDurationMs?: number;
  maxAttempts?: number;
  maxConcurrency?: number;
  providerCallTimeoutMs?: number;
  recoveryGraceMs?: number;
  shutdownTimeoutMs?: number;
  recoveryIntervalMs?: number;
  random?: () => number;
  discover?: (limit: number) => Promise<DiscordMessageDeliveryDiscoveryRef[]>;
  /** Small deterministic seams for worker proof; production uses bound repositories. */
  repositories?: Partial<DiscordMessageDeliveryWorkerRepositories>;
  connectorFactory?: (channelType: 'discord', config: Record<string, unknown>) => GatewayConnector;
  now?: () => Date;
}

/**
 * All-daemon, tenant-scoped final-delivery worker. Listener ownership and
 * inbound event Tasks are intentionally absent from this lifecycle.
 */
export class DiscordMessageDeliveryWorker {
  private readonly loop: GatewayDeliveryLoop<DiscordMessageDeliveryDiscoveryRef>;
  private readonly deliveryRepo: DiscordMessageDeliveryWorkerRepositories['delivery'];
  private readonly channelRepo: DiscordMessageDeliveryWorkerRepositories['channel'];
  private readonly mappingRepo: DiscordMessageDeliveryWorkerRepositories['mapping'];
  private readonly messageRepo: DiscordMessageDeliveryWorkerRepositories['message'];
  private readonly leaseDurationMs: number;
  private readonly maxAttempts: number;
  private readonly providerCallTimeoutMs: number;
  private readonly recoveryGraceMs: number;
  private readonly connectorFactory: NonNullable<
    DiscordMessageDeliveryWorkerOptions['connectorFactory']
  >;
  private readonly now: () => Date;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly options: DiscordMessageDeliveryWorkerOptions = {}
  ) {
    this.deliveryRepo =
      options.repositories?.delivery ??
      bindRepositoryToTenantUnitOfWork(db, new DiscordMessageDeliveryRepository(db));
    this.channelRepo =
      options.repositories?.channel ??
      bindRepositoryToTenantUnitOfWork(db, new GatewayChannelRepository(db));
    this.mappingRepo =
      options.repositories?.mapping ??
      bindRepositoryToTenantUnitOfWork(db, new ThreadSessionMapRepository(db));
    this.messageRepo =
      options.repositories?.message ??
      bindRepositoryToTenantUnitOfWork(db, new MessagesRepository(db));
    this.leaseDurationMs = options.leaseDurationMs ?? DELIVERY_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DELIVERY_MAX_ATTEMPTS;
    const maxConcurrency = options.maxConcurrency ?? DELIVERY_MAX_CONCURRENCY;
    this.providerCallTimeoutMs =
      options.providerCallTimeoutMs ?? Math.max(1, Math.floor(this.leaseDurationMs * 0.75));
    this.recoveryGraceMs = options.recoveryGraceMs ?? DEFAULT_DISCORD_DELIVERY_RECOVERY_GRACE_MS;
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DELIVERY_DRAIN_TIMEOUT_MS;
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error('Discord delivery concurrency must be a positive integer');
    }
    if (
      !Number.isSafeInteger(this.providerCallTimeoutMs) ||
      this.providerCallTimeoutMs < 1 ||
      this.providerCallTimeoutMs >= this.leaseDurationMs
    ) {
      throw new Error('Discord provider call timeout must be positive and below the lease');
    }
    if (!Number.isSafeInteger(this.recoveryGraceMs) || this.recoveryGraceMs < 1) {
      throw new Error('Discord delivery recovery grace must be a positive integer');
    }
    if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1) {
      throw new Error('Discord delivery shutdown timeout must be a positive integer');
    }
    this.connectorFactory =
      options.connectorFactory ?? ((channelType, config) => getConnector(channelType, config));
    this.now = options.now ?? (() => new Date());
    this.loop = new GatewayDeliveryLoop({
      area: 'distributed-work.discord-message-delivery',
      tenantId: options.tenantId,
      scanBatchSize: options.scanBatchSize ?? DELIVERY_SCAN_BATCH,
      maxConcurrency,
      shutdownTimeoutMs,
      recoveryIntervalMs: options.recoveryIntervalMs ?? 60_000,
      random: options.random ?? Math.random,
      discover: (limit) => this.discover(limit),
      lane: (ref) => ref.thread_session_map_id,
      process: (ref) => this.processRef(ref),
      purge: () => this.deliveryRepo.purgeExpired(this.now()),
    });
  }

  start(): void {
    this.loop.start();
  }

  async stop(): Promise<void> {
    return this.loop.stop();
  }

  /** One bounded discovery/claim pass, exposed for focused tests. */
  async checkOnce(): Promise<number> {
    return this.loop.checkOnce();
  }

  private async discover(limit: number): Promise<DiscordMessageDeliveryDiscoveryRef[]> {
    if (this.options.discover) return this.options.discover(limit);
    return discoverDueDeliveryRefs(this.db, {
      tenantId: this.options.tenantId,
      label: 'discord message delivery discovery',
      capability: 'discord_message_delivery_discovery',
      find: (scoped) => this.deliveryRepo.findDueRefs(scoped, { limit, now: this.now() }),
    });
  }

  private async processRef(ref: DiscordMessageDeliveryDiscoveryRef): Promise<void> {
    const claim = await this.deliveryRepo.claim(
      ref.delivery_id,
      generateId(),
      this.leaseDurationMs,
      this.now()
    );
    if (!claim) return;
    try {
      await this.deliverClaim(claim);
    } catch (error) {
      await this.recordFailure(claim, error);
    }
  }

  private async loadContext(delivery: DiscordMessageDelivery): Promise<DeliveryContext> {
    const [message, mapping, channel] = await Promise.all([
      this.messageRepo.findById(delivery.message_id as MessageID),
      this.mappingRepo.findById(delivery.thread_session_map_id),
      this.channelRepo.findById(delivery.gateway_channel_id),
    ]);
    return { delivery, message, mapping, channel };
  }

  private assertRouteContext(context: DeliveryContext): asserts context is DeliveryContext & {
    message: NonNullable<DeliveryContext['message']>;
    mapping: NonNullable<DeliveryContext['mapping']>;
    channel: GatewayChannel;
  } {
    if (!context.message) throw new DeliveryControlError('message_missing', 'canceled');
    if (!context.mapping || context.mapping.session_id !== context.message.session_id) {
      throw new DeliveryControlError('mapping_missing_or_mismatched', 'canceled');
    }
    if (
      context.mapping.channel_id !== context.delivery.gateway_channel_id ||
      !context.channel ||
      !context.channel.enabled ||
      context.channel.channel_type !== 'discord'
    ) {
      throw new DeliveryControlError('channel_disabled_or_changed', 'canceled');
    }
    if (
      context.channel.provider_installation_id !== context.delivery.provider_installation_id ||
      context.channel.provider_config_generation !== context.delivery.provider_config_generation
    ) {
      throw new DeliveryControlError('config_generation_changed', 'canceled');
    }
    if (
      parseDiscordThreadKey(context.mapping.thread_id)?.kind === 'direct_message' &&
      !isDiscordDirectMessagesEnabled(context.channel.config)
    ) {
      throw new DeliveryControlError('direct_messages_disabled', 'canceled');
    }
    const metadata = (context.mapping.metadata as Record<string, unknown> | null) ?? {};
    if (typeof metadata.outbound_seed_id === 'string') {
      throw new DeliveryControlError('proactive_seed_mapping', 'canceled');
    }
  }

  private async reloadClaim(claim: DiscordMessageDeliveryClaim): Promise<DiscordMessageDelivery> {
    const delivery = await this.deliveryRepo.reloadClaim({
      deliveryId: claim.delivery_id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      now: this.now(),
    });
    if (!delivery) throw new DiscordMessageDeliveryClaimLostError(claim.delivery_id);
    return delivery;
  }

  private async renewClaim(
    claim: DiscordMessageDeliveryClaim
  ): Promise<DiscordMessageDeliveryClaim> {
    const renewed = await this.deliveryRepo.renewClaim({
      deliveryId: claim.delivery_id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      leaseDurationMs: this.leaseDurationMs,
      now: this.now(),
    });
    if (!renewed) throw new DiscordMessageDeliveryClaimLostError(claim.delivery_id);
    return renewed;
  }

  /** Provider I/O never owns an unbounded live claim. */
  private async providerCall<T>(
    claim: DiscordMessageDeliveryClaim,
    operation: () => Promise<T>
  ): Promise<{ claim: DiscordMessageDeliveryClaim; result: T }> {
    return boundedProviderCall({
      claim,
      renew: (current) => this.renewClaim(current),
      timeoutMs: this.providerCallTimeoutMs,
      timeoutError: () => new Error('Discord provider call exceeded its delivery lease bound'),
      operation,
    });
  }

  private async deliverClaim(claim: DiscordMessageDeliveryClaim): Promise<void> {
    let currentClaim = claim;
    let delivery = await this.reloadClaim(claim);
    let context = await this.loadContext(delivery);
    this.assertRouteContext(context);
    const messageText = extractDiscordDeliveryText(context.message);
    if (!messageText.trim()) throw new DeliveryControlError('message_has_no_text', 'canceled');
    const connector = this.connectorFactory(
      'discord',
      context.channel.config as Record<string, unknown>
    );
    if (!connector.recoverMessageByNonce) {
      throw new DeliveryControlError('nonce_recovery_unavailable', 'dead_letter');
    }
    const payload = normalizeOutbound(
      connector.formatMessage ? connector.formatMessage(messageText) : messageText
    );
    const chunks = chunkDiscordMessage(payload.text);
    if (chunks.length > 1_000)
      throw new DeliveryControlError('chunk_bound_exceeded', 'dead_letter');

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      currentClaim = await this.renewClaim(currentClaim);
      delivery = currentClaim.delivery;
      const existing = delivery.chunk_receipts.find(
        (receipt) => receipt.chunk_index === chunkIndex
      );
      if (existing) continue;

      context = await this.loadContext(delivery);
      this.assertRouteContext(context);
      const nonce = deterministicDiscordDeliveryNonce(claim.delivery_id, chunkIndex);
      const hadEffectMarker = delivery.ambiguous_chunk_index === chunkIndex;
      let receipt: Awaited<ReturnType<NonNullable<typeof connector.recoverMessageByNonce>>>;
      try {
        const recovered = await this.providerCall(currentClaim, () =>
          connector.recoverMessageByNonce!({
            threadId: context.mapping!.thread_id,
            nonce,
          })
        );
        currentClaim = recovered.claim;
        delivery = recovered.claim.delivery;
        receipt = recovered.result;
      } catch (error) {
        if (error instanceof DiscordMessageDeliveryClaimLostError) throw error;
        if (hadEffectMarker) throw this.ambiguousRecoveryOutcome(delivery, 'nonce_recovery_failed');
        // No provider effect was permitted without the marker, so a failed
        // pre-send lookup is safe to retry before electing an effect.
        throw new DeliveryControlError('nonce_recovery_failed', 'retry');
      }
      if (!receipt) {
        if (hadEffectMarker) {
          throw this.ambiguousRecoveryOutcome(delivery, 'nonce_acceptance_unproven');
        }
        // Recovery is provider I/O and can overlap an installation disable or
        // generation rotation. Re-read the fenced intent and route immediately
        // before sending so a stale connector cannot create a new effect.
        currentClaim = await this.renewClaim(currentClaim);
        delivery = currentClaim.delivery;
        context = await this.loadContext(delivery);
        this.assertRouteContext(context);
        await this.deliveryRepo.markChunkEffectStarted({
          deliveryId: claim.delivery_id,
          claimToken: currentClaim.claim_token,
          claimGeneration: currentClaim.claim_generation,
          chunkIndex,
          recoveryGraceMs: this.recoveryGraceMs,
          now: this.now(),
        });
        currentClaim = await this.renewClaim(currentClaim);
        try {
          const sent = await this.providerCall(currentClaim, () =>
            connector.sendMessage({
              threadId: context.mapping!.thread_id,
              text: chunks[chunkIndex],
              metadata: buildDiscordDeliveryMetadata(nonce),
            })
          );
          currentClaim = sent.claim;
          delivery = sent.claim.delivery;
          receipt = normalizeSendReceipt(sent.result);
        } catch (error) {
          // Only an error explicitly proving non-acceptance may clear the
          // durable effect marker and permit another provider attempt.
          if (error instanceof DiscordDirectMessageError) {
            if (!error.retryable) throw new DeliveryControlError(error.code, 'dead_letter');
            await this.deliveryRepo.clearChunkEffectMarker({
              deliveryId: claim.delivery_id,
              claimToken: currentClaim.claim_token,
              claimGeneration: currentClaim.claim_generation,
              chunkIndex,
              now: this.now(),
            });
            throw new DeliveryControlError(error.code, 'retry');
          }
          if (providerStatus(error) === 429) {
            await this.deliveryRepo.clearChunkEffectMarker({
              deliveryId: claim.delivery_id,
              claimToken: currentClaim.claim_token,
              claimGeneration: currentClaim.claim_generation,
              chunkIndex,
              now: this.now(),
            });
            throw error;
          }
          if (isDefinitiveProviderFailure(error)) throw error;
          if (isExplicitlyRetryableProviderFailure(error)) {
            await this.deliveryRepo.clearChunkEffectMarker({
              deliveryId: claim.delivery_id,
              claimToken: currentClaim.claim_token,
              claimGeneration: currentClaim.claim_generation,
              chunkIndex,
              now: this.now(),
            });
            throw new DeliveryControlError('provider_transient', 'retry');
          }
          // A timeout or connection loss may have happened after Discord
          // accepted the nonce. Prove the exact nonce before allowing retry.
          let recovered: Awaited<ReturnType<NonNullable<typeof connector.recoverMessageByNonce>>>;
          try {
            const recovery = await this.providerCall(currentClaim, () =>
              connector.recoverMessageByNonce!({
                threadId: context.mapping!.thread_id,
                nonce,
              })
            );
            currentClaim = recovery.claim;
            delivery = recovery.claim.delivery;
            recovered = recovery.result;
          } catch (error) {
            if (error instanceof DiscordMessageDeliveryClaimLostError) throw error;
            throw this.ambiguousRecoveryOutcome(delivery, 'nonce_recovery_failed');
          }
          if (recovered) receipt = recovered;
          else throw this.ambiguousRecoveryOutcome(delivery, 'nonce_acceptance_unproven');
        }
      }
      if (!receipt?.messageId) {
        throw new DeliveryControlError('receipt_missing_id', 'dead_letter');
      }
      const checkpoint: DiscordMessageDeliveryChunkReceipt = {
        chunk_index: chunkIndex,
        nonce,
        provider_message_id: receipt.messageId,
        reply_aliases: (receipt.replyAliases ?? []).slice(0, 100),
      };
      delivery = await this.deliveryRepo.checkpointChunk({
        deliveryId: claim.delivery_id,
        claimToken: currentClaim.claim_token,
        claimGeneration: currentClaim.claim_generation,
        receipt: checkpoint,
        now: this.now(),
      });
      currentClaim = { ...currentClaim, delivery };
    }

    await this.deliveryRepo.completeClaim({
      deliveryId: claim.delivery_id,
      claimToken: currentClaim.claim_token,
      claimGeneration: currentClaim.claim_generation,
      now: this.now(),
    });
  }

  private ambiguousRecoveryOutcome(
    delivery: DiscordMessageDelivery,
    code: 'nonce_recovery_failed' | 'nonce_acceptance_unproven'
  ): DeliveryControlError {
    const graceUntil = delivery.effect_recovery_grace_until;
    const graceActive = graceUntil && new Date(graceUntil).getTime() > this.now().getTime();
    return new DeliveryControlError(code, graceActive ? 'retry' : 'dead_letter');
  }

  private async recordFailure(claim: DiscordMessageDeliveryClaim, error: unknown): Promise<void> {
    if (error instanceof DiscordMessageDeliveryClaimLostError) return;
    const code = deliveryErrorCode(error);
    const control = error instanceof DeliveryControlError ? error : undefined;
    const terminal =
      control?.terminal ?? (isDefinitiveProviderFailure(error) ? 'dead_letter' : 'retry');
    const current = await this.deliveryRepo.reloadClaim({
      deliveryId: claim.delivery_id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      now: this.now(),
    });
    if (!current) return;
    const attempts = current.attempt_count;
    const graceActive =
      current.effect_recovery_grace_until !== null &&
      new Date(current.effect_recovery_grace_until).getTime() > this.now().getTime();
    const status =
      terminal === 'canceled'
        ? 'canceled'
        : terminal === 'dead_letter' || (attempts >= this.maxAttempts && !graceActive)
          ? 'dead_letter'
          : 'pending';
    const nextAttemptAt = new Date(
      this.now().getTime() + boundedBackoff(attempts, retryAfterMs(error))
    );
    try {
      await this.deliveryRepo.failClaim({
        deliveryId: claim.delivery_id,
        claimToken: claim.claim_token,
        claimGeneration: claim.claim_generation,
        status,
        errorCode: code,
        nextAttemptAt,
        now: this.now(),
      });
    } catch (failure) {
      if (!(failure instanceof DiscordMessageDeliveryClaimLostError)) throw failure;
    }
  }
}
