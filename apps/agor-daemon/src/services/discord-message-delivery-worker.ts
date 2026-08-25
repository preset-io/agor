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
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  ThreadSessionMapRepository,
} from '@agor/core/db';
import type { GatewayConnector } from '@agor/core/gateway';
import {
  buildDiscordDeliveryMetadata,
  buildDiscordDeliveryNonce,
  chunkDiscordMessage,
  gatewayFailureCode,
  getConnector,
  normalizeOutbound,
  normalizeSendReceipt,
} from '@agor/core/gateway';
import type {
  DiscordMessageDelivery,
  DiscordMessageDeliveryChunkReceipt,
  GatewayChannel,
  MessageID,
  TenantID,
} from '@agor/core/types';

const DELIVERY_LEASE_MS = 30_000;
const DELIVERY_SCAN_BATCH = 25;
const DELIVERY_BASE_BACKOFF_MS = 1_000;
const DELIVERY_MAX_BACKOFF_MS = 5 * 60_000;
const DELIVERY_MAX_ATTEMPTS = 8;
const DELIVERY_MAX_RATE_LIMIT_DELAY_MS = 10 * 60_000;
const DELIVERY_MAX_CONCURRENCY = 4;
const DELIVERY_DRAIN_TIMEOUT_MS = 5_000;

export const deterministicDiscordDeliveryNonce = buildDiscordDeliveryNonce;

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

export function fairOrderByTenant(
  refs: DiscordMessageDeliveryDiscoveryRef[]
): DiscordMessageDeliveryDiscoveryRef[] {
  const groups = new Map<string, DiscordMessageDeliveryDiscoveryRef[]>();
  for (const ref of refs) {
    const group = groups.get(ref.tenant_id) ?? [];
    group.push(ref);
    groups.set(ref.tenant_id, group);
  }
  const ordered: DiscordMessageDeliveryDiscoveryRef[] = [];
  while (groups.size > 0) {
    for (const [tenantId, group] of groups) {
      const next = group.shift();
      if (next) ordered.push(next);
      if (group.length === 0) groups.delete(tenantId);
    }
  }
  return ordered;
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
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly deliveryRepo: DiscordMessageDeliveryWorkerRepositories['delivery'];
  private readonly channelRepo: DiscordMessageDeliveryWorkerRepositories['channel'];
  private readonly mappingRepo: DiscordMessageDeliveryWorkerRepositories['mapping'];
  private readonly messageRepo: DiscordMessageDeliveryWorkerRepositories['message'];
  private readonly scanBatchSize: number;
  private readonly leaseDurationMs: number;
  private readonly maxAttempts: number;
  private readonly maxConcurrency: number;
  private readonly providerCallTimeoutMs: number;
  private readonly recoveryGraceMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly recoveryIntervalMs: number;
  private readonly random: () => number;
  private readonly connectorFactory: NonNullable<
    DiscordMessageDeliveryWorkerOptions['connectorFactory']
  >;
  private readonly now: () => Date;
  private readonly activeWork = new Set<Promise<unknown>>();
  private readonly threadTails = new Map<string, Promise<void>>();
  private drainPromise: Promise<void> | null = null;

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
    this.scanBatchSize = options.scanBatchSize ?? DELIVERY_SCAN_BATCH;
    this.leaseDurationMs = options.leaseDurationMs ?? DELIVERY_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DELIVERY_MAX_ATTEMPTS;
    this.maxConcurrency = options.maxConcurrency ?? DELIVERY_MAX_CONCURRENCY;
    this.providerCallTimeoutMs =
      options.providerCallTimeoutMs ?? Math.max(1, Math.floor(this.leaseDurationMs * 0.75));
    this.recoveryGraceMs = options.recoveryGraceMs ?? DEFAULT_DISCORD_DELIVERY_RECOVERY_GRACE_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DELIVERY_DRAIN_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.maxConcurrency) || this.maxConcurrency < 1) {
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
    if (!Number.isSafeInteger(this.shutdownTimeoutMs) || this.shutdownTimeoutMs < 1) {
      throw new Error('Discord delivery shutdown timeout must be a positive integer');
    }
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
    console.log('[distributed-work.discord-message-delivery] event="loop_started"');
  }

  async stop(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    console.log('[distributed-work.discord-message-delivery] event="loop_stopped"');
    this.drainPromise = this.drainActiveWork();
    return this.drainPromise;
  }

  private async drainActiveWork(): Promise<void> {
    if (this.activeWork.size === 0) return;
    const active = Promise.allSettled([...this.activeWork]).then(() => undefined);
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      active,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.shutdownTimeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (this.activeWork.size > 0) {
      console.warn(
        `[distributed-work.discord-message-delivery] event="drain_timeout" active=${this.activeWork.size}`
      );
    }
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
        `[distributed-work.discord-message-delivery] event=scan_failed code=${gatewayFailureCode(error)}`
      );
      this.schedule(this.recoveryIntervalMs);
    } finally {
      this.running = false;
    }
  }

  private async discover(): Promise<DiscordMessageDeliveryDiscoveryRef[]> {
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
      'discord message delivery discovery',
      (systemDb) =>
        this.deliveryRepo.findDueRefs(systemDb, {
          limit: this.scanBatchSize,
          now: this.now(),
        }),
      { capability: 'discord_message_delivery_discovery' }
    );
  }

  /** One bounded discovery/claim pass, exposed for focused tests. */
  async checkOnce(): Promise<number> {
    const work = this.checkOnceInternal();
    this.activeWork.add(work);
    try {
      return await work;
    } finally {
      this.activeWork.delete(work);
    }
  }

  private async checkOnceInternal(): Promise<number> {
    const refs = await this.discover();
    const tenants = new Set<string>(this.options.tenantId ? [this.options.tenantId] : []);
    const orderedRefs = fairOrderByTenant(refs);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(this.maxConcurrency, orderedRefs.length) },
      async () => {
        while (nextIndex < orderedRefs.length) {
          const ref = orderedRefs[nextIndex++];
          const tenantId = this.options.tenantId ?? ref.tenant_id;
          if (!tenantId) continue;
          tenants.add(tenantId);
          await runWithTenantContext(tenantId, () =>
            this.withThreadOrder(tenantId, ref.thread_session_map_id, () => this.processRef(ref))
          );
        }
      }
    );
    await Promise.all(workers);
    for (const tenantId of tenants) {
      await runWithTenantContext(tenantId, () => this.deliveryRepo.purgeExpired(this.now()));
    }
    return refs.length;
  }

  private async withThreadOrder<T>(
    tenantId: string,
    threadSessionMapId: string,
    work: () => Promise<T>
  ): Promise<T> {
    const key = `${tenantId}:${threadSessionMapId}`;
    const previous = this.threadTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadTails.set(key, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.threadTails.get(key) === current) this.threadTails.delete(key);
    }
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
    let current = await this.renewClaim(claim);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        operation(),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Discord provider call exceeded its delivery lease bound')),
            this.providerCallTimeoutMs
          );
        }),
      ]);
      current = await this.renewClaim(current);
      return { claim: current, result };
    } finally {
      if (timer) clearTimeout(timer);
    }
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
