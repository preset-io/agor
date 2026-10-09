/** Durable, provider-specific Teams delivery intents. Shared lane, lease, marker,
 * and retention rules live in `gateway-delivery-outbox`. Teams has no
 * idempotency key, so a chunk marker that loses its lease becomes terminal
 * `ambiguous`; it is never blindly resent. */

import type {
  GatewayChannelID,
  Message,
  MessageID,
  TeamsMessageDelivery,
  TeamsMessageDeliveryChunkReceipt,
  TeamsMessageDeliveryID,
  TeamsMessageDeliveryStatus,
  TenantID,
  ThreadSessionMapID,
} from '@agor/core/types';
import { and, eq } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database, SystemDatabase } from '../client';
import {
  getDatabaseNow,
  insert,
  isSQLiteDatabase,
  lockRowForUpdate,
  select,
  update,
} from '../database-wrapper';
import {
  type GatewayChannelRow,
  gatewayChannels,
  type TeamsMessageDeliveryInsert,
  type TeamsMessageDeliveryRow,
  teamsMessageDeliveries,
} from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import { RepositoryError } from './base';
import {
  boundedReceipts,
  chunkCheckpoint,
  chunkEffectMarker,
  claimWithLease,
  clearChunkEffect,
  type DeliveryClaimRef,
  type DeliveryLease,
  type DeliveryOutbox,
  type DeliveryOutboxRow,
  findDueRefs,
  purgeTerminal,
  renewClaim,
  resolveDeliveryMapping,
  transitionClaim,
} from './gateway-delivery-outbox';

export interface TeamsMessageDeliveryDiscoveryRef {
  tenant_id: TenantID | string;
  delivery_id: TeamsMessageDeliveryID;
  thread_session_map_id: ThreadSessionMapID;
}

export interface TeamsMessageDeliveryClaim {
  delivery_id: TeamsMessageDeliveryID;
  claim_token: string;
  claim_generation: number;
  lease_expires_at: string;
  delivery: TeamsMessageDelivery;
}

type TeamsClaimRef = Omit<DeliveryClaimRef, 'deliveryId'> & { deliveryId: TeamsMessageDeliveryID };

const MAX_TEAMS_RETRY_DELAY_MS = 10 * 60_000;

export class TeamsMessageDeliveryClaimLostError extends Error {
  constructor(deliveryId: string) {
    super(`Teams message delivery claim was lost: ${deliveryId}`);
    this.name = 'TeamsMessageDeliveryClaimLostError';
  }
}

/** A resumed delivery would send a different plan than the chunks already sent. */
export class TeamsChunkPlanChangedError extends RepositoryError {
  constructor() {
    super('Teams delivery chunk plan changed after a chunk was started');
    this.name = 'TeamsChunkPlanChangedError';
  }
}

const TEAMS_OUTBOX: DeliveryOutbox = {
  table: teamsMessageDeliveries,
  sqlName: 'teams_message_deliveries',
  label: 'Teams delivery',
  clock: 'database',
  failedStatuses: ['dead_letter', 'ambiguous'],
  hasRecoveryGrace: false,
  fairDiscovery: false,
  claimLost: (deliveryId) => new TeamsMessageDeliveryClaimLostError(deliveryId),
};

function asIso(value: Date | string | number): string {
  return new Date(value).toISOString();
}

function rowToDelivery(row: TeamsMessageDeliveryRow | DeliveryOutboxRow): TeamsMessageDelivery {
  const record = row as TeamsMessageDeliveryRow;
  return {
    delivery_id: record.delivery_id as TeamsMessageDeliveryID,
    message_id: record.message_id as MessageID,
    gateway_channel_id: record.gateway_channel_id as GatewayChannelID,
    thread_session_map_id: record.thread_session_map_id as ThreadSessionMapID,
    provider_installation_id: record.provider_installation_id,
    provider_config_generation: record.provider_config_generation,
    status: record.status as TeamsMessageDeliveryStatus,
    attempt_count: record.attempt_count,
    next_attempt_at: asIso(record.next_attempt_at),
    claim_token: record.claim_token,
    claim_expires_at: record.claim_expires_at ? asIso(record.claim_expires_at) : null,
    claim_generation: record.claim_generation,
    ambiguous_chunk_index: record.ambiguous_chunk_index ?? null,
    effect_started_at: record.effect_started_at ? asIso(record.effect_started_at) : null,
    chunk_receipts: boundedReceipts<TeamsMessageDeliveryChunkReceipt>(record.chunk_receipts),
    chunk_plan_digest: record.chunk_plan_digest ?? null,
    last_error_code: record.last_error_code ?? null,
    provider_message_id: record.provider_message_id ?? null,
    created_at: asIso(record.created_at),
    updated_at: asIso(record.updated_at),
    completed_at: record.completed_at ? asIso(record.completed_at) : null,
    canceled_at: record.canceled_at ? asIso(record.canceled_at) : null,
    dead_lettered_at: record.dead_lettered_at ? asIso(record.dead_lettered_at) : null,
  };
}

function toClaim(claimToken: string, lease: DeliveryLease): TeamsMessageDeliveryClaim {
  const delivery = rowToDelivery(lease.row);
  return {
    delivery_id: delivery.delivery_id,
    claim_token: claimToken,
    claim_generation: delivery.claim_generation,
    lease_expires_at: asIso(lease.leaseExpiresAt),
    delivery,
  };
}

function tenantFor(db: Database): TenantID | undefined {
  if (isSQLiteDatabase(db)) return undefined;
  const tenantId = getCurrentTenantId();
  if (!tenantId)
    throw new RepositoryError('Teams message delivery requires explicit tenant identity');
  return tenantId as TenantID;
}

export class TeamsMessageDeliveryRepository {
  constructor(private readonly db: Database) {}

  /** Called by the message transaction; insertion is the outbound HA source of truth. */
  async enqueueForMessageInTransaction(
    tx: Database,
    message: Message
  ): Promise<TeamsMessageDelivery | null> {
    const candidate = await resolveDeliveryMapping(tx, message, 'teams');
    if (!candidate) return null;
    const tenantId = tenantFor(tx);
    const now = await getDatabaseNow(
      tx,
      gatewayChannels,
      eq(gatewayChannels.id, candidate.channel_id)
    );
    if (!now) throw new RepositoryError('Unable to obtain database time for Teams delivery');
    const insertData: TeamsMessageDeliveryInsert = {
      delivery_id: generateId(),
      created_at: now,
      updated_at: now,
      message_id: message.message_id,
      gateway_channel_id: candidate.channel_id,
      thread_session_map_id: candidate.mapping_id,
      provider_installation_id: candidate.provider_installation_id,
      provider_config_generation: candidate.provider_config_generation,
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: now,
      claim_token: null,
      claim_expires_at: null,
      claim_generation: 0,
      ambiguous_chunk_index: null,
      effect_started_at: null,
      chunk_receipts: [],
      chunk_plan_digest: null,
      last_error_code: null,
      provider_message_id: null,
      completed_at: null,
      canceled_at: null,
      dead_lettered_at: null,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    };
    await insert(tx, teamsMessageDeliveries).values(insertData).onConflictDoNothing().run();
    const row = await select(tx)
      .from(teamsMessageDeliveries)
      .where(
        and(
          eq(teamsMessageDeliveries.message_id, message.message_id),
          eq(teamsMessageDeliveries.thread_session_map_id, candidate.mapping_id)
        )
      )
      .one();
    if (!row) throw new RepositoryError('Failed to retrieve Teams delivery intent');
    return rowToDelivery(row);
  }

  async findById(deliveryId: TeamsMessageDeliveryID): Promise<TeamsMessageDelivery | null> {
    const row = await select(this.db)
      .from(teamsMessageDeliveries)
      .where(eq(teamsMessageDeliveries.delivery_id, deliveryId))
      .one();
    return row ? rowToDelivery(row) : null;
  }

  async findByMessageId(messageId: MessageID): Promise<TeamsMessageDelivery | null> {
    const row = await select(this.db)
      .from(teamsMessageDeliveries)
      .where(eq(teamsMessageDeliveries.message_id, messageId))
      .one();
    return row ? rowToDelivery(row) : null;
  }

  async findDueRefs(
    db: SystemDatabase | Database,
    options: { limit?: number; now?: Date } = {}
  ): Promise<TeamsMessageDeliveryDiscoveryRef[]> {
    return (await findDueRefs(TEAMS_OUTBOX, db, options)).map((ref) => ({
      ...ref,
      delivery_id: ref.delivery_id as TeamsMessageDeliveryID,
    }));
  }

  /** A lapsed claim whose chunk marker is still set becomes terminal `ambiguous`. */
  async claim(
    deliveryId: TeamsMessageDeliveryID,
    claimToken: string,
    leaseDurationMs: number,
    now?: Date
  ): Promise<TeamsMessageDeliveryClaim | null> {
    const lease = await claimWithLease(TEAMS_OUTBOX, this.db, {
      deliveryId,
      claimToken,
      leaseDurationMs,
      now,
      onExpiredEffect: async (tx, _row, dbNow) => {
        await update(tx, teamsMessageDeliveries)
          .set({
            status: 'ambiguous',
            claim_token: null,
            claim_expires_at: null,
            last_error_code: 'provider_effect_unknown',
            updated_at: dbNow,
          })
          .where(eq(teamsMessageDeliveries.delivery_id, deliveryId))
          .run();
        return true;
      },
    });
    return lease ? toClaim(claimToken, lease) : null;
  }

  async renewClaim(
    input: TeamsClaimRef & { leaseDurationMs: number }
  ): Promise<TeamsMessageDeliveryClaim | null> {
    const lease = await renewClaim(TEAMS_OUTBOX, this.db, input);
    return lease ? toClaim(input.claimToken, lease) : null;
  }

  /**
   * Pin the chunk plan before the first chunk. A different plan is accepted
   * only while nothing has been started (e.g. a 413 re-plan at a lower budget).
   */
  async recordChunkPlan(input: TeamsClaimRef & { digest: string }): Promise<TeamsMessageDelivery> {
    const row = await transitionClaim(TEAMS_OUTBOX, this.db, input, ({ row }) => {
      if (row.chunk_plan_digest === input.digest) return null;
      const started =
        boundedReceipts(row.chunk_receipts).length > 0 || row.ambiguous_chunk_index !== null;
      if (row.chunk_plan_digest && started) throw new TeamsChunkPlanChangedError();
      return { chunk_plan_digest: input.digest };
    });
    return rowToDelivery(row);
  }

  /**
   * Fence one chunk's provider effect. Configuration mutations lock the
   * channel first, so take the channel lock before the delivery row and
   * re-check installation and generation under both.
   */
  async markEffectStarted(
    input: TeamsClaimRef & { chunkIndex?: number }
  ): Promise<TeamsMessageDelivery> {
    const row = await transitionClaim<GatewayChannelRow | null>(
      TEAMS_OUTBOX,
      this.db,
      input,
      ({ row, now, before: channel }) => {
        if (
          !channel?.enabled ||
          channel.channel_type !== 'teams' ||
          channel.provider_installation_id !== row.provider_installation_id ||
          channel.provider_config_generation !== row.provider_config_generation
        ) {
          throw new TeamsMessageDeliveryClaimLostError(input.deliveryId);
        }
        return chunkEffectMarker(TEAMS_OUTBOX, row, input.chunkIndex ?? 0, now);
      },
      {
        before: async (tx, candidate): Promise<GatewayChannelRow | null> => {
          const where = eq(gatewayChannels.id, candidate.gateway_channel_id as string);
          await lockRowForUpdate(tx, this.db, gatewayChannels, where);
          return select(tx).from(gatewayChannels).where(where).one();
        },
        wallClock: true,
        sqliteImmediate: true,
      }
    );
    return rowToDelivery(row);
  }

  /** Clear a marker only after the provider proved it did not accept the chunk. */
  async clearChunkEffectMarker(
    input: TeamsClaimRef & { chunkIndex: number }
  ): Promise<TeamsMessageDelivery> {
    const row = await transitionClaim(TEAMS_OUTBOX, this.db, input, ({ row }) =>
      clearChunkEffect(TEAMS_OUTBOX, row, input.chunkIndex)
    );
    return rowToDelivery(row);
  }

  async checkpointChunk(
    input: TeamsClaimRef & { receipt: TeamsMessageDeliveryChunkReceipt }
  ): Promise<TeamsMessageDelivery> {
    const row = await transitionClaim(TEAMS_OUTBOX, this.db, input, ({ row }) => {
      const { changes } = chunkCheckpoint(TEAMS_OUTBOX, row, input.receipt);
      if (!changes || input.receipt.chunk_index !== 0) return changes;
      return { ...changes, provider_message_id: input.receipt.provider_message_id };
    });
    return rowToDelivery(row);
  }

  async complete(
    input: TeamsClaimRef & { providerMessageId?: string | null }
  ): Promise<TeamsMessageDelivery> {
    const row = await transitionClaim(TEAMS_OUTBOX, this.db, input, ({ row, now }) => ({
      status: 'completed',
      claim_token: null,
      claim_expires_at: null,
      provider_message_id: input.providerMessageId ?? row.provider_message_id ?? null,
      completed_at: now,
    }));
    return rowToDelivery(row);
  }

  /** Release the claim. Chunk markers stay: only proven non-acceptance clears one. */
  async fail(
    input: TeamsClaimRef & {
      status: 'pending' | 'canceled' | 'dead_letter';
      errorCode: string;
      /** Bounded delay added to the transaction's database timestamp. */
      retryDelayMs?: number;
    }
  ): Promise<TeamsMessageDelivery> {
    if (
      input.retryDelayMs !== undefined &&
      (!Number.isSafeInteger(input.retryDelayMs) ||
        input.retryDelayMs < 0 ||
        input.retryDelayMs > MAX_TEAMS_RETRY_DELAY_MS)
    ) {
      throw new RepositoryError('Teams retry delay must be between 0 and 10 minutes');
    }
    const row = await transitionClaim(TEAMS_OUTBOX, this.db, input, ({ now }) => ({
      status: input.status,
      claim_token: null,
      claim_expires_at: null,
      last_error_code: input.errorCode,
      next_attempt_at:
        input.retryDelayMs === undefined ? now : new Date(now.getTime() + input.retryDelayMs),
      canceled_at: input.status === 'canceled' ? now : null,
      dead_lettered_at: input.status === 'dead_letter' ? now : null,
    }));
    return rowToDelivery(row);
  }

  /** Terminal: a chunk may or may not have been posted, so nothing is resent. */
  async markAmbiguous(
    input: TeamsClaimRef & { errorCode?: string; chunkIndex?: number }
  ): Promise<TeamsMessageDelivery> {
    const row = await transitionClaim(TEAMS_OUTBOX, this.db, input, ({ row }) => ({
      status: 'ambiguous',
      claim_token: null,
      claim_expires_at: null,
      ambiguous_chunk_index: input.chunkIndex ?? row.ambiguous_chunk_index,
      last_error_code: input.errorCode ?? 'provider_effect_unknown',
    }));
    return rowToDelivery(row);
  }

  async purgeExpired(now?: Date): Promise<number> {
    return purgeTerminal(TEAMS_OUTBOX, this.db, now);
  }
}
