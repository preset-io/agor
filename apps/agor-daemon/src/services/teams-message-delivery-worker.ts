import { createHash } from 'node:crypto';
import { getBaseUrl } from '@agor/core/config';
import {
  bindRepositoryToTenantUnitOfWork,
  deliveryMessageText,
  GatewayChannelRepository,
  generateId,
  getCurrentTenantId,
  MessagesRepository,
  TeamsChunkPlanChangedError,
  TeamsConversationAddressRepository,
  type TeamsMessageDeliveryClaim,
  TeamsMessageDeliveryClaimLostError,
  type TeamsMessageDeliveryDiscoveryRef,
  TeamsMessageDeliveryRepository,
  type TenantScopeAwareDatabase,
  ThreadSessionMapRepository,
} from '@agor/core/db';
import {
  chunkMarkdown,
  classifyTeamsSendFailure,
  gatewayFailureCode,
  type PreparedTeamsSend,
  TEAMS_MESSAGE_TEXT_BUDGET,
  TeamsSendError,
  type TeamsSendOutcome,
  utf16Length,
} from '@agor/core/gateway';
import type {
  GatewayChannel,
  MessageID,
  SessionID,
  TeamsMessageDelivery,
  TenantID,
} from '@agor/core/types';
import { getSessionUrl } from '@agor/core/utils/url';
import { isBrowserReachableUrl } from '../utils/browser-reachable-url.js';
import { type TeamsSendConnector, teamsConnectorCache } from '../utils/teams-connector-cache.js';
import {
  boundedBackoff,
  boundedProviderCall,
  DeliveryControlError,
  discoverDueDeliveryRefs,
  GatewayDeliveryLoop,
} from './gateway-delivery-loop.js';

const DELIVERY_LEASE_MS = 30_000;
const DELIVERY_SCAN_BATCH = 25;
const DELIVERY_MAX_ATTEMPTS = 8;
const DELIVERY_MAX_CONCURRENCY = 4;
const DELIVERY_DRAIN_TIMEOUT_MS = 5_000;
const DELIVERY_RECOVERY_INTERVAL_MS = 5_000;
/** Teams allows about 7 messages per second per thread; stay well under it. */
const CHUNK_PACING_MS = 1_000;
const MAX_CHUNKS = 20;
const MIN_TEXT_BUDGET = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type TeamsMessageDeliveryWorkerRepositories = {
  delivery: Pick<
    TeamsMessageDeliveryRepository,
    | 'findDueRefs'
    | 'claim'
    | 'renewClaim'
    | 'recordChunkPlan'
    | 'markEffectStarted'
    | 'clearChunkEffectMarker'
    | 'checkpointChunk'
    | 'complete'
    | 'fail'
    | 'markAmbiguous'
    | 'purgeExpired'
  >;
  channel: Pick<GatewayChannelRepository, 'findById'>;
  mapping: Pick<ThreadSessionMapRepository, 'findById'>;
  message: Pick<MessagesRepository, 'findById'>;
  address: Pick<TeamsConversationAddressRepository, 'loadFenced' | 'revokeThread'>;
};

export interface TeamsMessageDeliveryWorkerOptions {
  tenantId?: TenantID | string;
  providerCallTimeoutMs?: number;
  chunkPacingMs?: number;
  maxChunks?: number;
  discover?: (limit: number) => Promise<TeamsMessageDeliveryDiscoveryRef[]>;
  /** Small deterministic seams for worker proof; production uses bound repositories. */
  repositories?: Partial<TeamsMessageDeliveryWorkerRepositories>;
  connectorFactory?: (channel: GatewayChannel) => TeamsSendConnector;
  sessionUrl?: (sessionId: SessionID) => Promise<string | null>;
  /** Called in the delivery's tenant once its first chunk is posted (ends this replica's typing). */
  onReplyPosted?: (sessionId: SessionID) => void;
}

/** The chunk may have been posted; record it terminally and never resend. */
class AmbiguousChunkError extends Error {
  constructor(
    readonly code: string,
    readonly chunkIndex: number
  ) {
    super(code);
    this.name = 'AmbiguousChunkError';
  }
}

export interface TeamsChunkPlan {
  budget: number;
  chunks: string[];
  digest: string;
  /** The text needed more than `maxChunks`; the last chunk is the continuation note. */
  truncated: boolean;
}

/** Deterministic chunk plan; the digest pins budget and content across claims. */
export function planTeamsChunks(
  text: string,
  budget: number,
  options: { maxChunks?: number; continuation?: string } = {}
): TeamsChunkPlan {
  const maxChunks = options.maxChunks ?? MAX_CHUNKS;
  let chunks = chunkMarkdown(text, { limit: budget, measure: utf16Length, label: 'Teams' });
  const truncated = chunks.length > maxChunks;
  if (truncated) {
    chunks = [...chunks.slice(0, maxChunks - 1), options.continuation ?? continuationText(null)];
  }
  const hash = createHash('sha256').update(chunks.join('\u0000')).digest('hex').slice(0, 32);
  return { budget, chunks, digest: `${budget}:${hash}`, truncated };
}

function continuationText(url: string | null): string {
  return url
    ? `_This reply is too long for Teams. Continued in Agor: ${url}_`
    : '_This reply is too long for Teams. Open this session in Agor to read the rest._';
}

function plannedBudget(digest: string | null, fallback: number): number {
  const budget = digest ? Number(digest.split(':', 1)[0]) : Number.NaN;
  return Number.isSafeInteger(budget) && budget >= MIN_TEXT_BUDGET && budget <= fallback
    ? budget
    : fallback;
}

/**
 * All-daemon final-delivery worker for Teams. Claims are leased and
 * generation-fenced; a token and client are prepared before any effect marker;
 * each chunk is marked, posted once under a deadline, and checkpointed. A chunk
 * whose outcome is unknown ends the delivery as `ambiguous`.
 */
export class TeamsMessageDeliveryWorker {
  private readonly loop: GatewayDeliveryLoop<TeamsMessageDeliveryDiscoveryRef>;
  private readonly deliveryRepo: TeamsMessageDeliveryWorkerRepositories['delivery'];
  private readonly channelRepo: TeamsMessageDeliveryWorkerRepositories['channel'];
  private readonly mappingRepo: TeamsMessageDeliveryWorkerRepositories['mapping'];
  private readonly messageRepo: TeamsMessageDeliveryWorkerRepositories['message'];
  private readonly addressRepo: TeamsMessageDeliveryWorkerRepositories['address'];
  private readonly providerCallTimeoutMs: number;
  private readonly chunkPacingMs: number;
  private readonly maxChunks: number;

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly options: TeamsMessageDeliveryWorkerOptions = {}
  ) {
    const repositories = options.repositories ?? {};
    this.deliveryRepo =
      repositories.delivery ??
      bindRepositoryToTenantUnitOfWork(db, new TeamsMessageDeliveryRepository(db));
    this.channelRepo =
      repositories.channel ??
      bindRepositoryToTenantUnitOfWork(db, new GatewayChannelRepository(db));
    this.mappingRepo =
      repositories.mapping ??
      bindRepositoryToTenantUnitOfWork(db, new ThreadSessionMapRepository(db));
    this.messageRepo =
      repositories.message ?? bindRepositoryToTenantUnitOfWork(db, new MessagesRepository(db));
    this.addressRepo =
      repositories.address ??
      bindRepositoryToTenantUnitOfWork(db, new TeamsConversationAddressRepository(db));
    this.providerCallTimeoutMs =
      options.providerCallTimeoutMs ?? Math.floor(DELIVERY_LEASE_MS * 0.75);
    this.chunkPacingMs = options.chunkPacingMs ?? CHUNK_PACING_MS;
    this.maxChunks = options.maxChunks ?? MAX_CHUNKS;
    this.loop = new GatewayDeliveryLoop({
      area: 'distributed-work.teams-message-delivery',
      tenantId: options.tenantId,
      scanBatchSize: DELIVERY_SCAN_BATCH,
      maxConcurrency: DELIVERY_MAX_CONCURRENCY,
      shutdownTimeoutMs: DELIVERY_DRAIN_TIMEOUT_MS,
      recoveryIntervalMs: DELIVERY_RECOVERY_INTERVAL_MS,
      random: Math.random,
      discover: (limit) => this.discover(limit),
      lane: (ref) => ref.thread_session_map_id,
      process: (ref) => this.processRef(ref),
      purge: () => this.deliveryRepo.purgeExpired(),
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** Scan soon on this replica after a local Message commit enqueued a delivery. */
  wake(): void {
    this.loop.wake();
  }

  /** One bounded discovery/claim pass, exposed for focused tests. */
  checkOnce(): Promise<number> {
    return this.loop.checkOnce();
  }

  private discover(limit: number): Promise<TeamsMessageDeliveryDiscoveryRef[]> {
    if (this.options.discover) return this.options.discover(limit);
    return discoverDueDeliveryRefs(this.db, {
      tenantId: this.options.tenantId,
      label: 'teams message delivery discovery',
      capability: 'teams_message_delivery_discovery',
      find: (scoped) => this.deliveryRepo.findDueRefs(scoped, { limit }),
    });
  }

  private async processRef(ref: TeamsMessageDeliveryDiscoveryRef): Promise<void> {
    const claim = await this.deliveryRepo.claim(ref.delivery_id, generateId(), DELIVERY_LEASE_MS);
    if (!claim) return;
    try {
      await this.deliverClaim(claim);
    } catch (error) {
      await this.recordFailure(claim, error);
    }
  }

  private claimRef(claim: TeamsMessageDeliveryClaim) {
    return {
      deliveryId: claim.delivery_id,
      claimToken: claim.claim_token,
      claimGeneration: claim.claim_generation,
    };
  }

  private async renew(claim: TeamsMessageDeliveryClaim): Promise<TeamsMessageDeliveryClaim> {
    const renewed = await this.deliveryRepo.renewClaim({
      ...this.claimRef(claim),
      leaseDurationMs: DELIVERY_LEASE_MS,
    });
    if (!renewed) throw new TeamsMessageDeliveryClaimLostError(claim.delivery_id);
    return renewed;
  }

  private providerCall<T>(
    claim: TeamsMessageDeliveryClaim,
    phase: 'prepare' | 'send',
    operation: (signal: AbortSignal) => Promise<T>
  ) {
    return boundedProviderCall({
      claim,
      renew: (current) => this.renew(current),
      timeoutMs: this.providerCallTimeoutMs,
      timeoutError: () =>
        phase === 'prepare'
          ? new TeamsSendError({ phase, reason: 'prepare_timeout' })
          : new TeamsSendError({ phase, networkCode: 'ETIMEDOUT' }),
      operation,
    });
  }

  private async loadRoute(delivery: TeamsMessageDelivery) {
    const [message, mapping, channel] = await Promise.all([
      this.messageRepo.findById(delivery.message_id as MessageID),
      this.mappingRepo.findById(delivery.thread_session_map_id),
      this.channelRepo.findById(delivery.gateway_channel_id),
    ]);
    if (!message) throw new DeliveryControlError('message_missing', 'canceled');
    if (!mapping || mapping.session_id !== message.session_id) {
      throw new DeliveryControlError('mapping_missing_or_mismatched', 'canceled');
    }
    if (
      mapping.channel_id !== delivery.gateway_channel_id ||
      !channel?.enabled ||
      channel.channel_type !== 'teams'
    ) {
      throw new DeliveryControlError('channel_disabled_or_changed', 'canceled');
    }
    if (
      channel.provider_installation_id !== delivery.provider_installation_id ||
      channel.provider_config_generation !== delivery.provider_config_generation
    ) {
      throw new DeliveryControlError('config_generation_changed', 'canceled');
    }
    return { message, mapping, channel };
  }

  /** Plan chunks; only an overflowing plan resolves the Agor link for its last chunk. */
  private async planChunks(
    text: string,
    budget: number,
    sessionId: SessionID
  ): Promise<TeamsChunkPlan> {
    const plan = planTeamsChunks(text, budget, { maxChunks: this.maxChunks });
    if (!plan.truncated) return plan;
    return planTeamsChunks(text, budget, {
      maxChunks: this.maxChunks,
      continuation: await this.continuationFor(sessionId),
    });
  }

  private async continuationFor(sessionId: SessionID): Promise<string> {
    try {
      if (this.options.sessionUrl)
        return continuationText(await this.options.sessionUrl(sessionId));
      const baseUrl = await getBaseUrl(this.db);
      const url = baseUrl ? getSessionUrl(sessionId, baseUrl) : null;
      return continuationText(isBrowserReachableUrl(url) ? url : null);
    } catch {
      return continuationText(null);
    }
  }

  private async deliverClaim(claim: TeamsMessageDeliveryClaim): Promise<void> {
    let current = claim;
    const { message, mapping, channel } = await this.loadRoute(current.delivery);
    const fenced = await this.addressRepo.loadFenced({
      channel,
      threadId: mapping.thread_id,
      expected: current.delivery,
    });
    if (!fenced.ok) throw new DeliveryControlError(fenced.code, 'canceled');
    const text = deliveryMessageText(message);
    if (!text.trim()) throw new DeliveryControlError('message_has_no_text', 'canceled');

    const connector =
      this.options.connectorFactory?.(channel) ??
      teamsConnectorCache.get(getCurrentTenantId(), channel);
    const formatted = connector.formatMessage(text);
    const budget = plannedBudget(current.delivery.chunk_plan_digest, TEAMS_MESSAGE_TEXT_BUDGET);
    const plan = await this.planChunks(formatted, budget, message.session_id);
    if (current.delivery.chunk_plan_digest !== plan.digest) {
      const delivery = await this.deliveryRepo.recordChunkPlan({
        ...this.claimRef(current),
        digest: plan.digest,
      });
      current = { ...current, delivery };
    }

    const prepared = await this.providerCall(current, 'prepare', () =>
      connector.prepareSend(fenced.address, plan.budget)
    );
    current = prepared.claim;
    const sender: PreparedTeamsSend = prepared.result;
    let sentInThisClaim = false;
    for (let chunkIndex = 0; chunkIndex < plan.chunks.length; chunkIndex += 1) {
      current = await this.renew(current);
      const delivery = current.delivery;
      if (delivery.chunk_receipts.some((receipt) => receipt.chunk_index === chunkIndex)) continue;
      if (delivery.ambiguous_chunk_index === chunkIndex) {
        throw new AmbiguousChunkError('provider_effect_unknown', chunkIndex);
      }
      if (sentInThisClaim && this.chunkPacingMs > 0) await sleep(this.chunkPacingMs);
      await this.deliveryRepo.markEffectStarted({ ...this.claimRef(current), chunkIndex });
      let activityId: string;
      try {
        const sent = await this.providerCall(current, 'send', (signal) =>
          sender.send(plan.chunks[chunkIndex], signal)
        );
        current = sent.claim;
        activityId = sent.result;
      } catch (error) {
        if (error instanceof TeamsMessageDeliveryClaimLostError) throw error;
        throw await this.sendFailure(current, chunkIndex, classifyTeamsSendFailure(error), {
          connector,
          plan,
          formatted,
          sessionId: message.session_id,
          channelId: channel.id,
          threadId: mapping.thread_id,
        });
      }
      if (!sentInThisClaim) {
        try {
          this.options.onReplyPosted?.(message.session_id);
        } catch {
          // Typing is cosmetic; it never affects delivery.
        }
      }
      sentInThisClaim = true;
      const checkpointed = await this.deliveryRepo.checkpointChunk({
        ...this.claimRef(current),
        receipt: { chunk_index: chunkIndex, provider_message_id: activityId },
      });
      current = { ...current, delivery: checkpointed };
    }
    await this.deliveryRepo.complete(this.claimRef(current));
  }

  /** Turn a classified send failure into the next durable state. */
  private async sendFailure(
    claim: TeamsMessageDeliveryClaim,
    chunkIndex: number,
    outcome: TeamsSendOutcome,
    context: {
      connector: TeamsSendConnector;
      plan: TeamsChunkPlan;
      formatted: string;
      sessionId: SessionID;
      channelId: string;
      threadId: string;
    }
  ): Promise<Error> {
    if (outcome.kind === 'ambiguous') return new AmbiguousChunkError(outcome.code, chunkIndex);
    // Every other class proves the chunk was not accepted.
    const cleared = await this.deliveryRepo.clearChunkEffectMarker({
      ...this.claimRef(claim),
      chunkIndex,
    });
    if (outcome.kind === 'retry') {
      if (outcome.refreshToken) context.connector.invalidateTokens();
      return new DeliveryControlError(outcome.code, 'retry', outcome.retryAfterMs);
    }
    if (outcome.kind === 'too_large') {
      const nextBudget = Math.floor(context.plan.budget / 2);
      if (cleared.chunk_receipts.length > 0 || nextBudget < MIN_TEXT_BUDGET) {
        return new DeliveryControlError(outcome.code, 'dead_letter');
      }
      const replanned = await this.planChunks(context.formatted, nextBudget, context.sessionId);
      await this.deliveryRepo.recordChunkPlan({
        ...this.claimRef(claim),
        digest: replanned.digest,
      });
      return new DeliveryControlError('chunk_replanned', 'retry', 0);
    }
    if (outcome.kind === 'revoked') {
      await this.addressRepo
        .revokeThread(context.channelId, context.threadId, outcome.reason)
        .catch((error: unknown) =>
          console.warn(
            `[distributed-work.teams-message-delivery] event=address_revoke_failed delivery_id=${claim.delivery_id} code=${gatewayFailureCode(error)}`
          )
        );
      const code =
        outcome.reason === 'bot_disabled'
          ? 'conversation_address_suspended'
          : 'conversation_address_revoked';
      return new DeliveryControlError(code, 'canceled');
    }
    return new DeliveryControlError(outcome.code, 'dead_letter');
  }

  private async recordFailure(claim: TeamsMessageDeliveryClaim, error: unknown): Promise<void> {
    if (error instanceof TeamsMessageDeliveryClaimLostError) return;
    const ref = this.claimRef(claim);
    try {
      if (error instanceof AmbiguousChunkError) {
        await this.deliveryRepo.markAmbiguous({
          ...ref,
          errorCode: error.code,
          chunkIndex: error.chunkIndex,
        });
        return;
      }
      let control: DeliveryControlError;
      if (error instanceof DeliveryControlError) control = error;
      else if (error instanceof TeamsChunkPlanChangedError) {
        control = new DeliveryControlError('chunk_plan_changed', 'dead_letter');
      } else if (error instanceof TeamsSendError) {
        const outcome = classifyTeamsSendFailure(error);
        control =
          outcome.kind === 'retry'
            ? new DeliveryControlError(outcome.code, 'retry', outcome.retryAfterMs)
            : new DeliveryControlError(outcome.code, 'dead_letter');
      } else {
        // Unknown failure; a chunk marker left in place stays ambiguous on the next claim.
        control = new DeliveryControlError('delivery_interrupted', 'retry');
      }
      const exhausted =
        control.terminal === 'retry' && claim.delivery.attempt_count >= DELIVERY_MAX_ATTEMPTS;
      await this.deliveryRepo.fail({
        ...ref,
        status:
          control.terminal === 'canceled'
            ? 'canceled'
            : control.terminal === 'dead_letter' || exhausted
              ? 'dead_letter'
              : 'pending',
        errorCode: control.code,
        ...(control.terminal === 'retry' && !exhausted
          ? {
              retryDelayMs: Math.round(
                boundedBackoff(claim.delivery.attempt_count, control.retryAfterMs)
              ),
            }
          : {}),
      });
    } catch (failure) {
      if (failure instanceof TeamsMessageDeliveryClaimLostError) return;
      console.warn(
        `[distributed-work.teams-message-delivery] event=terminal_state_failed delivery_id=${claim.delivery_id} code=${gatewayFailureCode(failure)}`
      );
    }
  }
}
