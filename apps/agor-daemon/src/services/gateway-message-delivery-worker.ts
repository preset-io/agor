import { createHash } from 'node:crypto';
import {
  bindRepositoryToTenantUnitOfWork,
  extractGatewayDeliveryText,
  GatewayChannelRepository,
  type GatewayMessageDeliveryClaim,
  GatewayMessageDeliveryClaimLostError,
  type GatewayMessageDeliveryDiscoveryRef,
  GatewayMessageDeliveryRepository,
  generateId,
  MessagesRepository,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  ThreadSessionMapRepository,
} from '@agor/core/db';
import type { GatewayConnector } from '@agor/core/gateway';
import {
  chunkDiscordMessage,
  getConnector,
  normalizeOutbound,
  normalizeSendReceipt,
} from '@agor/core/gateway';
import type {
  GatewayChannel,
  GatewayMessageDelivery,
  GatewayMessageDeliveryChunkReceipt,
  GatewayMessageDeliveryID,
  MessageID,
  TenantID,
} from '@agor/core/types';

const DELIVERY_LEASE_MS = 30_000;
const DELIVERY_SCAN_BATCH = 25;
const DELIVERY_BASE_BACKOFF_MS = 1_000;
const DELIVERY_MAX_BACKOFF_MS = 5 * 60_000;
const DELIVERY_MAX_ATTEMPTS = 8;
const DELIVERY_MAX_RATE_LIMIT_DELAY_MS = 10 * 60_000;

export function deterministicDiscordDeliveryNonce(
  deliveryId: GatewayMessageDeliveryID,
  chunkIndex: number
): string {
  const digest = createHash('sha256').update(deliveryId).digest('hex').slice(0, 16);
  return `agor-${digest}-${chunkIndex.toString(36)}`;
}

function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const record = error as Record<string, unknown>;
  const status = record.status ?? record.statusCode ?? record.code;
  return typeof status === 'number' ? status : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const record = error as Record<string, unknown>;
  const direct = record.retry_after_ms ?? record.retryAfterMs;
  if (typeof direct === 'number' && Number.isFinite(direct)) return Math.max(0, direct);
  const seconds = record.retry_after ?? record.retryAfter;
  if (typeof seconds === 'number' && Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  return undefined;
}

function isDefinitiveProviderFailure(error: unknown): boolean {
  const status = providerStatus(error);
  return (
    status !== undefined && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)
  );
}

function boundedBackoff(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) {
    return Math.min(DELIVERY_MAX_RATE_LIMIT_DELAY_MS, Math.max(0, retryAfter));
  }
  return Math.min(
    DELIVERY_MAX_BACKOFF_MS,
    DELIVERY_BASE_BACKOFF_MS * 2 ** Math.max(0, Math.min(attempt - 1, 8))
  );
}

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

class DeliveryControlError extends Error {
  constructor(
    readonly code: string,
    readonly terminal: 'canceled' | 'dead_letter' | 'retry'
  ) {
    super(code);
    this.name = 'DeliveryControlError';
  }
}

interface DeliveryContext {
  delivery: GatewayMessageDelivery;
  message: Awaited<ReturnType<MessagesRepository['findById']>>;
  mapping: Awaited<ReturnType<ThreadSessionMapRepository['findById']>>;
  channel: GatewayChannel | null;
}

type GatewayMessageDeliveryWorkerRepositories = {
  delivery: Pick<
    GatewayMessageDeliveryRepository,
    | 'findDueRefs'
    | 'claim'
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

export interface GatewayMessageDeliveryWorkerOptions {
  tenantId?: TenantID | string;
  scanBatchSize?: number;
  leaseDurationMs?: number;
  maxAttempts?: number;
  recoveryIntervalMs?: number;
  random?: () => number;
  discover?: (limit: number) => Promise<GatewayMessageDeliveryDiscoveryRef[]>;
  /** Small deterministic seams for worker proof; production uses bound repositories. */
  repositories?: Partial<GatewayMessageDeliveryWorkerRepositories>;
  connectorFactory?: (channelType: 'discord', config: Record<string, unknown>) => GatewayConnector;
  now?: () => Date;
}

/**
 * All-daemon, tenant-scoped final-delivery worker. Listener ownership and
 * inbound event Tasks are intentionally absent from this lifecycle.
 */
export class GatewayMessageDeliveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly deliveryRepo: GatewayMessageDeliveryWorkerRepositories['delivery'];
  private readonly channelRepo: GatewayMessageDeliveryWorkerRepositories['channel'];
  private readonly mappingRepo: GatewayMessageDeliveryWorkerRepositories['mapping'];
  private readonly messageRepo: GatewayMessageDeliveryWorkerRepositories['message'];
  private readonly scanBatchSize: number;
  private readonly leaseDurationMs: number;
  private readonly maxAttempts: number;
  private readonly recoveryIntervalMs: number;
  private readonly random: () => number;
  private readonly connectorFactory: NonNullable<
    GatewayMessageDeliveryWorkerOptions['connectorFactory']
  >;
  private readonly now: () => Date;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly options: GatewayMessageDeliveryWorkerOptions = {}
  ) {
    this.deliveryRepo =
      options.repositories?.delivery ??
      bindRepositoryToTenantUnitOfWork(db, new GatewayMessageDeliveryRepository(db));
    this.channelRepo =
      options.repositories?.channel ??
      bindRepositoryToTenantUnitOfWork(db, new GatewayChannelRepository(db));
    this.mappingRepo =
      options.repositories?.mapping ??
      bindRepositoryToTenantUnitOfWork(db, new ThreadSessionMapRepository(db));
    this.messageRepo =
      options.repositories?.message ??
      bindRepositoryToTenantUnitOfWork(db, new MessagesRepository(db));
    this.scanBatchSize = options.scanBatchSize ?? DELIVERY_SCAN_BATCH;
    this.leaseDurationMs = options.leaseDurationMs ?? DELIVERY_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DELIVERY_MAX_ATTEMPTS;
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? 60_000;
    this.random = options.random ?? Math.random;
    this.connectorFactory =
      options.connectorFactory ?? ((channelType, config) => getConnector(channelType, config));
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer || this.running) return;
    this.stopped = false;
    this.schedule(Math.floor(this.random() * 1_000));
    console.log('[distributed-work.gateway-message-delivery] event="loop_started"');
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    console.log('[distributed-work.gateway-message-delivery] event="loop_stopped"');
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runLoopIteration();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runLoopIteration(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const count = await this.checkOnce();
      this.schedule(count >= this.scanBatchSize ? 100 : this.recoveryIntervalMs);
    } catch (error) {
      console.warn(
        `[distributed-work.gateway-message-delivery] event=scan_failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`
      );
      this.schedule(this.recoveryIntervalMs);
    } finally {
      this.running = false;
    }
  }

  private async discover(): Promise<GatewayMessageDeliveryDiscoveryRef[]> {
    if (this.options.discover) return this.options.discover(this.scanBatchSize);
    const find = (scoped: import('@agor/core/db').TenantScopedDatabase) =>
      this.deliveryRepo.findDueRefs(scoped, {
        limit: this.scanBatchSize,
        now: this.now(),
      });
    if (this.options.tenantId) {
      return runWithTenantDatabaseScope(this.db, this.options.tenantId, find);
    }
    return runWithSystemDatabaseScope(
      this.db,
      'gateway message delivery discovery',
      (systemDb) =>
        this.deliveryRepo.findDueRefs(systemDb, {
          limit: this.scanBatchSize,
          now: this.now(),
        }),
      { capability: 'gateway_message_delivery_discovery' }
    );
  }

  /** One bounded discovery/claim pass, exposed for focused tests. */
  async checkOnce(): Promise<number> {
    const refs = await this.discover();
    const tenants = new Set<string>(this.options.tenantId ? [this.options.tenantId] : []);
    for (const ref of refs) {
      const tenantId = this.options.tenantId ?? ref.tenant_id;
      if (!tenantId) continue;
      tenants.add(tenantId);
      await runWithTenantContext(tenantId, () => this.processRef(ref));
    }
    for (const tenantId of tenants) {
      await runWithTenantContext(tenantId, () => this.deliveryRepo.purgeExpired(this.now()));
    }
    return refs.length;
  }

  private async processRef(ref: GatewayMessageDeliveryDiscoveryRef): Promise<void> {
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

  private async loadContext(delivery: GatewayMessageDelivery): Promise<DeliveryContext> {
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
    const metadata = (context.mapping.metadata as Record<string, unknown> | null) ?? {};
    if (typeof metadata.outbound_seed_id === 'string') {
      throw new DeliveryControlError('proactive_seed_mapping', 'canceled');
    }
  }

  private async reloadClaim(claim: GatewayMessageDeliveryClaim): Promise<GatewayMessageDelivery> {
    const delivery = await this.deliveryRepo.reloadClaim({
      deliveryId: claim.delivery_id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      now: this.now(),
    });
    if (!delivery) throw new GatewayMessageDeliveryClaimLostError(claim.delivery_id);
    return delivery;
  }

  private async deliverClaim(claim: GatewayMessageDeliveryClaim): Promise<void> {
    let delivery = await this.reloadClaim(claim);
    let context = await this.loadContext(delivery);
    this.assertRouteContext(context);
    const messageText = extractGatewayDeliveryText(context.message);
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
      delivery = await this.reloadClaim(claim);
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
        receipt = await connector.recoverMessageByNonce({
          threadId: context.mapping.thread_id,
          nonce,
        });
      } catch {
        if (hadEffectMarker) {
          throw new DeliveryControlError('nonce_recovery_failed', 'dead_letter');
        }
        // No provider effect was permitted without the marker, so a failed
        // pre-send lookup is safe to retry before electing an effect.
        throw new DeliveryControlError('nonce_recovery_failed', 'retry');
      }
      if (!receipt) {
        if (hadEffectMarker) {
          // A takeover/crash path may never send again without a provider
          // receipt proving what happened to the marked effect.
          throw new DeliveryControlError('nonce_acceptance_unproven', 'dead_letter');
        }
        // Recovery is provider I/O and can overlap an installation disable or
        // generation rotation. Re-read the fenced intent and route immediately
        // before sending so a stale connector cannot create a new effect.
        delivery = await this.reloadClaim(claim);
        context = await this.loadContext(delivery);
        this.assertRouteContext(context);
        await this.deliveryRepo.markChunkEffectStarted({
          deliveryId: claim.delivery_id,
          claimToken: claim.claim_token,
          claimGeneration: claim.claim_generation,
          chunkIndex,
          now: this.now(),
        });
        try {
          const sent = await connector.sendMessage({
            threadId: context.mapping.thread_id,
            text: chunks[chunkIndex],
            metadata: {
              discord_delivery_nonce: nonce,
              discord_enforce_nonce: true,
            },
          });
          receipt = normalizeSendReceipt(sent);
        } catch (error) {
          // Only an error explicitly proving non-acceptance may clear the
          // durable effect marker and permit another provider attempt.
          if (providerStatus(error) === 429) {
            await this.deliveryRepo.clearChunkEffectMarker({
              deliveryId: claim.delivery_id,
              claimToken: claim.claim_token,
              claimGeneration: claim.claim_generation,
              chunkIndex,
              now: this.now(),
            });
            throw error;
          }
          if (isDefinitiveProviderFailure(error)) throw error;
          if (isExplicitlyRetryableProviderFailure(error)) {
            await this.deliveryRepo.clearChunkEffectMarker({
              deliveryId: claim.delivery_id,
              claimToken: claim.claim_token,
              claimGeneration: claim.claim_generation,
              chunkIndex,
              now: this.now(),
            });
            throw new DeliveryControlError('provider_transient', 'retry');
          }
          // A timeout or connection loss may have happened after Discord
          // accepted the nonce. Prove the exact nonce before allowing retry.
          let recovered: Awaited<ReturnType<NonNullable<typeof connector.recoverMessageByNonce>>>;
          try {
            recovered = await connector.recoverMessageByNonce({
              threadId: context.mapping.thread_id,
              nonce,
            });
          } catch {
            throw new DeliveryControlError('nonce_recovery_failed', 'dead_letter');
          }
          if (recovered) receipt = recovered;
          else throw new DeliveryControlError('nonce_acceptance_unproven', 'dead_letter');
        }
      }
      if (!receipt?.messageId) {
        throw new DeliveryControlError('receipt_missing_id', 'dead_letter');
      }
      const checkpoint: GatewayMessageDeliveryChunkReceipt = {
        chunk_index: chunkIndex,
        nonce,
        provider_message_id: receipt.messageId,
        reply_aliases: (receipt.replyAliases ?? []).slice(0, 100),
      };
      delivery = await this.deliveryRepo.checkpointChunk({
        deliveryId: claim.delivery_id,
        claimToken: claim.claim_token,
        claimGeneration: claim.claim_generation,
        receipt: checkpoint,
        now: this.now(),
      });
    }

    await this.deliveryRepo.completeClaim({
      deliveryId: claim.delivery_id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      now: this.now(),
    });
  }

  private async recordFailure(claim: GatewayMessageDeliveryClaim, error: unknown): Promise<void> {
    if (error instanceof GatewayMessageDeliveryClaimLostError) return;
    const code = deliveryErrorCode(error);
    const control = error instanceof DeliveryControlError ? error : undefined;
    const terminal =
      control?.terminal ?? (isDefinitiveProviderFailure(error) ? 'dead_letter' : 'retry');
    const attempts = claim.delivery.attempt_count;
    const status =
      terminal === 'canceled'
        ? 'canceled'
        : terminal === 'dead_letter' || attempts >= this.maxAttempts
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
      if (!(failure instanceof GatewayMessageDeliveryClaimLostError)) throw failure;
    }
  }
}
