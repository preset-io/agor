import {
  bindRepositoryToTenantUnitOfWork,
  GatewayChannelRepository,
  GatewayInboundEventRepository,
  generateId,
  MessagesRepository,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  TeamsConversationAddressRepository,
  type TeamsMessageDeliveryClaim,
  TeamsMessageDeliveryClaimLostError,
  type TeamsMessageDeliveryDiscoveryRef,
  TeamsMessageDeliveryRepository,
  type TenantScopeAwareDatabase,
  ThreadSessionMapRepository,
} from '@agor/core/db';
import type {
  GatewayConnector,
  NormalizedTeamsActivity,
  TeamsCatchUpActivity,
} from '@agor/core/gateway';
import { boundTeamsCatchUp, getConnector } from '@agor/core/gateway';
import type {
  GatewayChannel,
  GatewayInboundEvent,
  GatewayInboundEventID,
  MessageID,
  TeamsMessageDelivery,
  TenantID,
} from '@agor/core/types';
import { withTeamsConfigDefaults } from '@agor/core/types';
import { gatewayInboundSessionId, gatewayInboundTaskId } from '../utils/durable-task-id.js';
import type { GatewayService } from './gateway.js';

const INBOUND_LEASE_MS = 30_000;
const DELIVERY_LEASE_MS = 30_000;
const SCAN_BATCH = 25;
const MAX_CONCURRENCY = 4;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5 * 60_000;
const LOOP_INTERVAL_MS = 1_000;

type InboundRepository = Pick<
  GatewayInboundEventRepository,
  'findDueTeamsRefs' | 'claimQueued' | 'decryptQueuedPayload' | 'complete' | 'failQueued'
>;
type DeliveryRepository = Pick<
  TeamsMessageDeliveryRepository,
  'findDueRefs' | 'claim' | 'markEffectStarted' | 'complete' | 'fail' | 'markAmbiguous'
>;

export interface TeamsGatewayWorkerRepositories {
  inbound: InboundRepository;
  delivery: DeliveryRepository;
  channel: Pick<GatewayChannelRepository, 'findById'>;
  mapping: Pick<
    ThreadSessionMapRepository,
    'findById' | 'findByChannelAndThread' | 'advanceTeamsLastAdmittedActivityId'
  >;
  address: Pick<
    TeamsConversationAddressRepository,
    'findByChannelAndThread' | 'addressForChannelAndThread'
  >;
  message: Pick<MessagesRepository, 'findById'>;
}

export interface TeamsGatewayWorkerOptions {
  tenantId?: TenantID | string;
  scanBatchSize?: number;
  maxConcurrency?: number;
  leaseDurationMs?: number;
  recoveryIntervalMs?: number;
  random?: () => number;
  now?: () => Date;
  repositories?: Partial<TeamsGatewayWorkerRepositories>;
  discoverInbound?: (
    limit: number
  ) => Promise<Array<{ tenant_id: string; gateway_channel_id: string; event_id: string }>>;
  discoverDelivery?: (limit: number) => Promise<TeamsMessageDeliveryDiscoveryRef[]>;
  gatewayService?: Pick<GatewayService, 'create'>;
  connectorFactory?: (config: Record<string, unknown>) => GatewayConnector;
  catchUp?: (input: {
    channel: GatewayChannel;
    activity: NormalizedTeamsActivity;
  }) => Promise<readonly TeamsCatchUpActivity[]>;
}

function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempt - 1, 8)));
}

function fairOrder<T extends { tenant_id: string }>(refs: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const ref of refs) groups.set(ref.tenant_id, [...(groups.get(ref.tenant_id) ?? []), ref]);
  const result: T[] = [];
  while (groups.size) {
    for (const [tenantId, group] of groups) {
      const next = group.shift();
      if (next) result.push(next);
      if (!group.length) groups.delete(tenantId);
    }
  }
  return result;
}

function isDefinitiveProviderFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const status =
    (error as Record<string, unknown>).status ?? (error as Record<string, unknown>).statusCode;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    ![408, 409, 425, 429].includes(status)
  );
}

function payloadActivity(payload: Record<string, unknown>): NormalizedTeamsActivity {
  return payload as unknown as NormalizedTeamsActivity;
}

export function teamsInboundMetadata(activity: NormalizedTeamsActivity): Record<string, unknown> {
  return { ...activity.metadata };
}

/**
 * HA worker for both queue-first Teams ingress and final outbound delivery.
 * Provider calls occur only after durable claims; inbound mentions are
 * admitted before optional history work begins.
 */
export class TeamsGatewayWorker {
  private readonly inboundRepo: InboundRepository;
  private readonly deliveryRepo: DeliveryRepository;
  private readonly channelRepo: TeamsGatewayWorkerRepositories['channel'];
  private readonly mappingRepo: TeamsGatewayWorkerRepositories['mapping'];
  private readonly addressRepo: TeamsGatewayWorkerRepositories['address'];
  private readonly messageRepo: TeamsGatewayWorkerRepositories['message'];
  private readonly scanBatchSize: number;
  private readonly maxConcurrency: number;
  private readonly leaseDurationMs: number;
  private readonly recoveryIntervalMs: number;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly gatewayService?: Pick<GatewayService, 'create'>;
  private readonly connectorFactory: (config: Record<string, unknown>) => GatewayConnector;
  private readonly catchUp?: TeamsGatewayWorkerOptions['catchUp'];
  private readonly threadTails = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private drainPromise: Promise<void> | null = null;
  private readonly activeWork = new Set<Promise<unknown>>();

  private readonly options: TeamsGatewayWorkerOptions;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    options: TeamsGatewayWorkerOptions = {}
  ) {
    this.options = options;
    this.inboundRepo =
      options.repositories?.inbound ??
      bindRepositoryToTenantUnitOfWork(db, new GatewayInboundEventRepository(db));
    this.deliveryRepo =
      options.repositories?.delivery ??
      bindRepositoryToTenantUnitOfWork(db, new TeamsMessageDeliveryRepository(db));
    this.channelRepo =
      options.repositories?.channel ??
      bindRepositoryToTenantUnitOfWork(db, new GatewayChannelRepository(db));
    this.mappingRepo =
      options.repositories?.mapping ??
      bindRepositoryToTenantUnitOfWork(db, new ThreadSessionMapRepository(db));
    this.addressRepo =
      options.repositories?.address ??
      bindRepositoryToTenantUnitOfWork(db, new TeamsConversationAddressRepository(db));
    this.messageRepo =
      options.repositories?.message ??
      bindRepositoryToTenantUnitOfWork(db, new MessagesRepository(db));
    this.scanBatchSize = options.scanBatchSize ?? SCAN_BATCH;
    this.maxConcurrency = options.maxConcurrency ?? MAX_CONCURRENCY;
    this.leaseDurationMs = options.leaseDurationMs ?? DELIVERY_LEASE_MS;
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? LOOP_INTERVAL_MS;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.gatewayService = options.gatewayService;
    this.connectorFactory = options.connectorFactory ?? ((config) => getConnector('teams', config));
    this.catchUp = options.catchUp;
    if (!Number.isSafeInteger(this.maxConcurrency) || this.maxConcurrency < 1)
      throw new Error('Teams worker concurrency must be positive');
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs < 1)
      throw new Error('Teams worker lease must be positive');
  }

  start(): void {
    if (this.timer || this.running) return;
    this.stopped = false;
    this.schedule(Math.floor(this.random() * 500));
    console.log('[distributed-work.teams-gateway] event="loop_started"');
  }

  getStatus(): {
    running: boolean;
    active_work: number;
    callback_mode: 'shared_queue_first';
    catch_up: 'bounded_best_effort';
    outbound_effect_recovery: 'ambiguous_terminal_no_blind_retry';
  } {
    return {
      running: this.timer !== null || this.activeWork.size > 0,
      active_work: this.activeWork.size,
      callback_mode: 'shared_queue_first',
      catch_up: 'bounded_best_effort',
      outbound_effect_recovery: 'ambiguous_terminal_no_blind_retry',
    };
  }

  async stop(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const active = Promise.allSettled([...this.activeWork]).then(() => undefined);
    this.drainPromise = this.activeWork.size
      ? Promise.race([active, new Promise<void>((resolve) => setTimeout(resolve, 5_000))])
      : Promise.resolve();
    await this.drainPromise;
    console.log('[distributed-work.teams-gateway] event="loop_stopped"');
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runLoop();
    }, delay);
    this.timer.unref?.();
  }

  private async runLoop(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const processed = await this.checkOnce();
      this.schedule(processed >= this.scanBatchSize ? 10 : this.recoveryIntervalMs);
    } catch (error) {
      console.warn(
        '[distributed-work.teams-gateway] event="scan_failed"',
        error instanceof Error ? error.message : String(error)
      );
      this.schedule(this.recoveryIntervalMs);
    } finally {
      this.running = false;
    }
  }

  private async discoverInbound() {
    if (this.options.discoverInbound) return this.options.discoverInbound(this.scanBatchSize);
    return runWithSystemDatabaseScope(
      this.db,
      'teams gateway ingress discovery',
      (systemDb) =>
        new GatewayInboundEventRepository(systemDb).findDueTeamsRefs(systemDb, {
          limit: this.scanBatchSize,
          now: this.now(),
        }),
      { capability: 'teams_gateway_ingress_discovery' }
    );
  }

  private async discoverDelivery() {
    if (this.options.discoverDelivery) return this.options.discoverDelivery(this.scanBatchSize);
    return runWithSystemDatabaseScope(
      this.db,
      'teams message delivery discovery',
      (systemDb) =>
        new TeamsMessageDeliveryRepository(systemDb).findDueRefs(systemDb, {
          limit: this.scanBatchSize,
          now: this.now(),
        }),
      { capability: 'teams_message_delivery_discovery' }
    );
  }

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
    const [inbound, deliveries] = await Promise.all([
      this.discoverInbound(),
      this.discoverDelivery(),
    ]);
    const refs = fairOrder([
      ...inbound.map((ref) => ({ ...ref, kind: 'inbound' as const })),
      ...deliveries.map((ref) => ({ ...ref, kind: 'delivery' as const })),
    ]);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(this.maxConcurrency, refs.length) }, async () => {
        while (next < refs.length) {
          const ref = refs[next++];
          const tenantId = this.options.tenantId ?? ref.tenant_id;
          await runWithTenantContext(tenantId, () => {
            const key = `${tenantId}:${ref.kind}:${ref.kind === 'inbound' ? ref.gateway_channel_id : ref.thread_session_map_id}`;
            return this.withThreadOrder(key, () =>
              ref.kind === 'inbound'
                ? this.processInbound(ref.event_id as GatewayInboundEventID)
                : this.processDelivery(ref.delivery_id)
            );
          });
        }
      })
    );
    return inbound.length + deliveries.length;
  }

  private async withThreadOrder<T>(key: string, work: () => Promise<T>): Promise<T> {
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

  private async processInbound(eventId: GatewayInboundEventID): Promise<void> {
    const event = await this.inboundRepo.claimQueued(
      eventId,
      generateId(),
      INBOUND_LEASE_MS,
      this.now()
    );
    if (!event) return;
    try {
      await this.admitInbound(event);
    } catch (error) {
      const retry = event.attempt_count < 8;
      await this.inboundRepo.failQueued({
        eventId,
        processingToken: event.processing_token,
        status: retry ? 'pending' : 'dead_letter',
        errorCode: error instanceof Error ? error.message.slice(0, 120) : 'teams_worker_failure',
        nextAttemptAt: retry
          ? new Date(this.now().getTime() + backoff(event.attempt_count))
          : undefined,
        now: this.now(),
      });
    }
  }

  private async admitInbound(event: GatewayInboundEvent): Promise<void> {
    const payload = this.inboundRepo.decryptQueuedPayload(event);
    const activity = payloadActivity(payload);
    const channel = await this.channelRepo.findById(event.gateway_channel_id);
    if (!channel?.enabled || channel.channel_type !== 'teams')
      throw new Error('teams_channel_disabled_or_missing');
    if (
      channel.provider_config_generation !== event.provider_config_generation ||
      channel.provider_installation_id !== event.verified_app_id ||
      channel.config.app_id !== event.verified_app_id ||
      channel.config.microsoft_tenant_id !== event.verified_tenant_id
    ) {
      throw new Error('teams_config_generation_or_identity_changed');
    }
    if (
      activity.providerEventId !== event.provider_event_id ||
      activity.threadId !== event.thread_id
    )
      throw new Error('teams_payload_identity_mismatch');
    if (activity.activityType !== 'message' || !activity.text.trim()) {
      await this.inboundRepo.complete({
        eventId: event.id,
        channelId: channel.id,
        processingToken: event.processing_token,
        requireListenerClaim: false,
      });
      return;
    }
    if (!this.gatewayService) throw new Error('teams_gateway_service_unavailable');
    const result = await this.gatewayService.create({
      channel_key: channel.channel_key,
      thread_id: activity.threadId,
      text: activity.text,
      user_name: activity.userId,
      metadata: teamsInboundMetadata(activity),
      gateway_inbound_event_id: event.id,
      idempotency_task_id: gatewayInboundTaskId(event.id),
      idempotency_session_id: gatewayInboundSessionId(event.id),
    });
    const completed = await this.inboundRepo.complete({
      eventId: event.id,
      channelId: channel.id,
      processingToken: event.processing_token,
      ...(result.sessionId ? { sessionId: result.sessionId as never } : {}),
      ...(result.taskId ? { taskId: result.taskId } : {}),
      requireListenerClaim: false,
    });
    if (!completed) throw new Error('teams_inbound_completion_fence_lost');
    if (result.success && result.taskId) {
      // The gateway is the admission authority; cursor advancement is best
      // effort after its stable Task. A missing mapping cannot create a Task.
      const actualMapping = await this.mappingRepo.findByChannelAndThread(
        channel.id,
        activity.threadId
      );
      if (actualMapping)
        await this.mappingRepo.advanceTeamsLastAdmittedActivityId(
          actualMapping.id,
          activity.activityId
        );
    }
    // Catch-up is deliberately after current mention admission. No Graph
    // implementation is claimed; injected history is bounded and optional.
    if (this.catchUp && activity.conversationType === 'channel') {
      void this.runCatchUp(channel, activity).catch((error) =>
        console.debug(
          '[teams] catch-up unavailable',
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  }

  private async runCatchUp(
    channel: GatewayChannel,
    activity: NormalizedTeamsActivity
  ): Promise<void> {
    const config = withTeamsConfigDefaults(channel.config);
    const catchUpConfig = config.catch_up as {
      mode?: 'off' | 'best_effort';
      max_messages?: number;
      max_prompt_bytes?: number;
      request_timeout_ms?: number;
    };
    if (catchUpConfig.mode === 'off') return;
    const rows = await Promise.race([
      this.catchUp!({ channel, activity }),
      new Promise<readonly TeamsCatchUpActivity[]>((resolve) =>
        setTimeout(() => resolve([]), catchUpConfig.request_timeout_ms ?? 2_000)
      ),
    ]);
    const bounded = boundTeamsCatchUp(rows, {
      maxMessages: catchUpConfig.max_messages ?? 50,
      maxPromptBytes: catchUpConfig.max_prompt_bytes ?? 16 * 1024,
    });
    if (!bounded.complete)
      console.debug(`[teams] catch-up best-effort incomplete: ${bounded.reason ?? 'unavailable'}`);
  }

  private async processDelivery(deliveryId: TeamsMessageDelivery['delivery_id']): Promise<void> {
    const claim = await this.deliveryRepo.claim(
      deliveryId,
      generateId(),
      this.leaseDurationMs,
      this.now()
    );
    if (!claim) return;
    try {
      await this.deliver(claim);
    } catch (error) {
      if (error instanceof TeamsMessageDeliveryClaimLostError) return;
      try {
        if (isDefinitiveProviderFailure(error)) {
          await this.deliveryRepo.fail({
            deliveryId,
            claimToken: claim.claim_token,
            claimGeneration: claim.claim_generation,
            status: 'canceled',
            errorCode: 'provider_rejected',
            now: this.now(),
          });
        } else {
          await this.deliveryRepo.markAmbiguous({
            deliveryId,
            claimToken: claim.claim_token,
            claimGeneration: claim.claim_generation,
            errorCode: 'provider_effect_unknown',
            now: this.now(),
          });
        }
      } catch (recordError) {
        console.warn(
          '[teams] unable to persist delivery terminal state',
          recordError instanceof Error ? recordError.message : String(recordError)
        );
      }
    }
  }

  private async deliver(claim: TeamsMessageDeliveryClaim): Promise<void> {
    const delivery = claim.delivery;
    const [message, mapping, channel] = await Promise.all([
      this.messageRepo.findById(delivery.message_id as MessageID),
      this.mappingRepo.findById(delivery.thread_session_map_id),
      this.channelRepo.findById(delivery.gateway_channel_id),
    ]);
    if (!message || !mapping || !channel?.enabled || channel.channel_type !== 'teams') {
      await this.deliveryRepo.fail({
        deliveryId: delivery.delivery_id,
        claimToken: claim.claim_token,
        claimGeneration: claim.claim_generation,
        status: 'canceled',
        errorCode: 'route_missing_or_disabled',
        now: this.now(),
      });
      return;
    }
    if (
      channel.provider_installation_id !== delivery.provider_installation_id ||
      channel.provider_config_generation !== delivery.provider_config_generation ||
      channel.config.outbound_enabled === false
    ) {
      await this.deliveryRepo.fail({
        deliveryId: delivery.delivery_id,
        claimToken: claim.claim_token,
        claimGeneration: claim.claim_generation,
        status: 'canceled',
        errorCode: 'config_generation_changed',
        now: this.now(),
      });
      return;
    }
    const address = await this.addressRepo.addressForChannelAndThread(
      channel.id,
      mapping.thread_id
    );
    if (!address) {
      await this.deliveryRepo.fail({
        deliveryId: delivery.delivery_id,
        claimToken: claim.claim_token,
        claimGeneration: claim.claim_generation,
        status: 'canceled',
        errorCode: 'conversation_address_missing',
        now: this.now(),
      });
      return;
    }
    const connector = this.connectorFactory(channel.config);
    await this.deliveryRepo.markEffectStarted({
      deliveryId: delivery.delivery_id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      now: this.now(),
    });
    const sent = await connector.sendMessage({
      threadId: mapping.thread_id,
      text: typeof message.content === 'string' ? message.content : (message.content_preview ?? ''),
      metadata: { teams_conversation_address: address },
    });
    const providerMessageId = typeof sent === 'string' ? sent : undefined;
    await this.deliveryRepo.complete({
      deliveryId: delivery.delivery_id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
      providerMessageId,
      now: this.now(),
    });
  }
}
