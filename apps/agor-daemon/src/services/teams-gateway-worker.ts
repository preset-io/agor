import {
  bindRepositoryToTenantUnitOfWork,
  GatewayChannelRepository,
  GatewayInboundEventRepository,
  generateId,
  runWithSystemDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { NormalizedTeamsActivity } from '@agor/core/gateway';
import { gatewayFailureCode, safeTeamsMetadata } from '@agor/core/gateway';
import {
  type GatewayInboundEvent,
  type GatewayInboundEventID,
  type TaskID,
  TEAMS_INBOUND_LEASE_MS,
  type TenantID,
} from '@agor/core/types';
import { gatewayInboundSessionId, gatewayInboundTaskId } from '../utils/durable-task-id.js';
import type { GatewayService } from './gateway.js';
import { withVerifiedHttpGatewayAuthority } from './gateway-authority.js';
import { boundedBackoff, GatewayDeliveryLoop } from './gateway-delivery-loop.js';

const SCAN_BATCH = 25;
const MAX_CONCURRENCY = 4;
const LOOP_INTERVAL_MS = 1_000;
const MAX_IDLE_DELAY_MS = 60_000;
const DRAIN_TIMEOUT_MS = 5_000;

type InboundRepository = Pick<
  GatewayInboundEventRepository,
  'findDueTeamsRefs' | 'claimQueued' | 'decryptQueuedPayload' | 'complete' | 'failQueued'
>;

type InboundRef = {
  tenant_id: string;
  gateway_channel_id: string;
  thread_id: string;
  event_id: string;
};

export interface TeamsGatewayWorkerRepositories {
  inbound: InboundRepository;
  channel: Pick<GatewayChannelRepository, 'findById'>;
}

export interface TeamsGatewayWorkerOptions {
  tenantId?: TenantID | string;
  random?: () => number;
  repositories?: Partial<TeamsGatewayWorkerRepositories>;
  discoverInbound?: (limit: number) => Promise<InboundRef[]>;
  gatewayService?: Pick<GatewayService, 'create'>;
}

type TeamsInboundFailureCode =
  | 'teams_payload_invalid'
  | 'teams_channel_disabled_or_missing'
  | 'teams_config_generation_or_identity_changed'
  | 'teams_payload_identity_mismatch'
  | 'teams_inbound_completion_fence_lost'
  | 'teams_gateway_service_unavailable'
  | 'teams_worker_failure';

/** A classified admission failure; only a retryable one is re-queued. */
class TeamsInboundError extends Error {
  constructor(
    readonly code: TeamsInboundFailureCode,
    readonly retryable: boolean,
    cause?: unknown
  ) {
    super(`Teams inbound failure: ${code}`, { cause });
    this.name = 'TeamsInboundError';
  }
}

function stringMetadata(activity: NormalizedTeamsActivity, key: string): string | null {
  const value = activity.metadata[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * HA worker for queue-first Teams ingress. Optional history catch-up runs
 * inside GatewayService admission on the shared provider-history path; final
 * replies are delivered by `TeamsMessageDeliveryWorker`.
 */
export class TeamsGatewayWorker {
  private readonly loop: GatewayDeliveryLoop<InboundRef>;
  private readonly inboundRepo: InboundRepository;
  private readonly channelRepo: TeamsGatewayWorkerRepositories['channel'];
  private readonly gatewayService?: Pick<GatewayService, 'create'>;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly options: TeamsGatewayWorkerOptions = {}
  ) {
    this.inboundRepo =
      options.repositories?.inbound ??
      bindRepositoryToTenantUnitOfWork(db, new GatewayInboundEventRepository(db));
    this.channelRepo =
      options.repositories?.channel ??
      bindRepositoryToTenantUnitOfWork(db, new GatewayChannelRepository(db));
    this.gatewayService = options.gatewayService;
    this.loop = new GatewayDeliveryLoop<InboundRef>({
      area: 'distributed-work.teams-gateway',
      tenantId: options.tenantId,
      scanBatchSize: SCAN_BATCH,
      maxConcurrency: MAX_CONCURRENCY,
      shutdownTimeoutMs: DRAIN_TIMEOUT_MS,
      recoveryIntervalMs: LOOP_INTERVAL_MS,
      maxIdleDelayMs: MAX_IDLE_DELAY_MS,
      random: options.random ?? Math.random,
      discover: (limit) => this.discoverInbound(limit),
      lane: (ref) => `inbound:${JSON.stringify([ref.gateway_channel_id, ref.thread_id])}`,
      process: (ref) => this.processInbound(ref.event_id as GatewayInboundEventID),
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** Claim newly committed local ingress now instead of waiting out the idle back-off. */
  wake(): void {
    this.loop.wake();
  }

  /** One bounded discovery/claim pass, exposed for focused tests. */
  checkOnce(): Promise<number> {
    return this.loop.checkOnce();
  }

  private discoverInbound(limit: number): Promise<InboundRef[]> {
    if (this.options.discoverInbound) return this.options.discoverInbound(limit);
    return runWithSystemDatabaseScope(
      this.db,
      'teams gateway ingress discovery',
      (systemDb) =>
        new GatewayInboundEventRepository(systemDb).findDueTeamsRefs(systemDb, { limit }),
      { capability: 'teams_gateway_ingress_discovery' }
    );
  }

  private async processInbound(eventId: GatewayInboundEventID): Promise<void> {
    const event = await this.inboundRepo.claimQueued(eventId, generateId(), TEAMS_INBOUND_LEASE_MS);
    if (!event) return;
    try {
      await this.admitInbound(event);
    } catch (error) {
      const retry =
        error instanceof TeamsInboundError && error.retryable && event.attempt_count < 8;
      await this.inboundRepo.failQueued({
        eventId,
        processingToken: event.processing_token,
        status: retry ? 'pending' : 'dead_letter',
        errorCode: error instanceof TeamsInboundError ? error.code : gatewayFailureCode(error),
        ...(retry ? { retryDelayMs: boundedBackoff(event.attempt_count) } : {}),
      });
    }
  }

  private async withTransientRepositoryFailure<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new TeamsInboundError('teams_worker_failure', true, error);
    }
  }

  private async admitInbound(event: GatewayInboundEvent): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      payload = this.inboundRepo.decryptQueuedPayload(event);
    } catch (error) {
      throw new TeamsInboundError('teams_payload_invalid', false, error);
    }
    const activity = payload as unknown as NormalizedTeamsActivity;
    const channel = await this.withTransientRepositoryFailure(() =>
      this.channelRepo.findById(event.gateway_channel_id)
    );
    if (!channel?.enabled || channel.channel_type !== 'teams')
      throw new TeamsInboundError('teams_channel_disabled_or_missing', false);
    if (
      channel.provider_config_generation !== event.provider_config_generation ||
      channel.provider_installation_id !== event.verified_app_id ||
      channel.config.app_id !== event.verified_app_id ||
      channel.config.microsoft_tenant_id !== event.verified_tenant_id
    ) {
      throw new TeamsInboundError('teams_config_generation_or_identity_changed', false);
    }
    if (
      activity.providerEventId !== event.provider_event_id ||
      activity.threadId !== event.thread_id
    )
      throw new TeamsInboundError('teams_payload_identity_mismatch', false);
    // Rows queued before ingress filtering (non-message, empty, unmentioned) drain without a Task.
    const admissible =
      activity.activityType === 'message' &&
      (!!activity.text.trim() || !!activity.files?.length || !!activity.skippedFiles?.length) &&
      (activity.conversationType.toLowerCase() === 'personal' || activity.hasMention);
    let result: { sessionId?: string; taskId?: TaskID } = {};
    if (admissible) {
      if (!this.gatewayService) {
        throw new TeamsInboundError('teams_gateway_service_unavailable', true);
      }
      try {
        result = await this.gatewayService.create(
          withVerifiedHttpGatewayAuthority(
            {
              channel_key: channel.channel_key,
              thread_id: activity.threadId,
              text: activity.text,
              user_name: activity.userName ?? activity.userId,
              ...(activity.files?.length ? { files: activity.files } : {}),
              ...(activity.skippedFiles?.length ? { skipped_files: activity.skippedFiles } : {}),
              metadata: safeTeamsMetadata(activity.metadata),
              teams_user_aad_object_id: activity.userAadObjectId ?? undefined,
              teams_catch_up: {
                activity_id: activity.activityId,
                timestamp: activity.timestamp,
                service_url: activity.serviceUrl,
                team_id: stringMetadata(activity, 'teams_team_id'),
                team_group_id: stringMetadata(activity, 'teams_team_aad_group_id'),
              },
              teams_member: {
                service_url: activity.serviceUrl,
                conversation_id: activity.conversationId,
                team_id: stringMetadata(activity, 'teams_team_id'),
                user_id: activity.userId,
              },
              gateway_inbound_event_id: event.id,
              idempotency_task_id: gatewayInboundTaskId(event.id),
              idempotency_session_id: gatewayInboundSessionId(event.id),
            },
            event
          )
        );
      } catch (error) {
        throw new TeamsInboundError('teams_gateway_service_unavailable', true, error);
      }
    }
    const completed = await this.withTransientRepositoryFailure(() =>
      this.inboundRepo.complete({
        eventId: event.id,
        channelId: channel.id,
        processingToken: event.processing_token,
        ...(result.sessionId ? { sessionId: result.sessionId as never } : {}),
        ...(result.taskId ? { taskId: result.taskId } : {}),
        requireListenerClaim: false,
      })
    );
    if (!completed) throw new TeamsInboundError('teams_inbound_completion_fence_lost', false);
  }
}
