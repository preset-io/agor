/**
 * Durable final-delivery intents for mapped Discord assistant Messages.
 *
 * This repository deliberately contains no provider text or generalized
 * action vocabulary. It only elects a Discord delivery, fences a worker, and
 * stores bounded provider receipts needed to recover one delivery. Lane,
 * lease, marker, and retention mechanics live in `gateway-delivery-outbox`.
 */

import type {
  DiscordMessageDelivery,
  DiscordMessageDeliveryChunkReceipt,
  DiscordMessageDeliveryID,
  DiscordMessageDeliveryStatus,
  GatewayChannelID,
  Message,
  MessageID,
  ThreadSessionMapID,
} from '@agor/core/types';
import { isDiscordNoReply } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database, SystemDatabase } from '../client';
import { insert, isSQLiteDatabase, select } from '../database-wrapper';
import {
  type DiscordMessageDeliveryInsert,
  type DiscordMessageDeliveryRow,
  discordMessageDeliveries,
} from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import { RepositoryError } from './base';
import {
  boundedReceipts,
  chunkCheckpoint,
  chunkEffectMarker,
  claimWithLease,
  clearChunkEffect,
  type DeliveryOutbox,
  type DeliveryOutboxRow,
  deliveryMessageText,
  findDueRefs,
  purgeTerminal,
  reloadClaim,
  renewClaim,
  resolveDeliveryMapping,
  transitionClaim,
} from './gateway-delivery-outbox';

export interface DiscordMessageDeliveryDiscoveryRef {
  tenant_id: string;
  delivery_id: DiscordMessageDeliveryID;
  thread_session_map_id: ThreadSessionMapID;
}

export interface DiscordMessageDeliveryClaim {
  delivery_id: DiscordMessageDeliveryID;
  claim_token: string;
  claim_generation: number;
  lease_expires_at: string;
  delivery: DiscordMessageDelivery;
}

export class DiscordMessageDeliveryClaimLostError extends Error {
  constructor(deliveryId: string) {
    super(`Discord message delivery claim was lost: ${deliveryId}`);
    this.name = 'DiscordMessageDeliveryClaimLostError';
  }
}

const MAX_ALIASES = 2_000;
export const DEFAULT_DISCORD_DELIVERY_RECOVERY_GRACE_MS = 60_000;

const DISCORD_OUTBOX: DeliveryOutbox = {
  table: discordMessageDeliveries,
  sqlName: 'discord_message_deliveries',
  label: 'Discord delivery',
  clock: 'caller',
  failedStatuses: ['dead_letter'],
  hasRecoveryGrace: true,
  fairDiscovery: true,
  claimLost: (deliveryId) => new DiscordMessageDeliveryClaimLostError(deliveryId),
};

function asIso(value: Date | string | number): string {
  return new Date(value).toISOString();
}

/** Extract text only at the worker boundary; it is never stored in the intent. */
export function extractDiscordDeliveryText(message: Message): string {
  return deliveryMessageText(message);
}

function boundedAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))].slice(
    0,
    MAX_ALIASES
  );
}

function rowToDelivery(row: DiscordMessageDeliveryRow | DeliveryOutboxRow): DiscordMessageDelivery {
  const record = row as DiscordMessageDeliveryRow;
  return {
    delivery_id: record.delivery_id as DiscordMessageDeliveryID,
    message_id: record.message_id as MessageID,
    gateway_channel_id: record.gateway_channel_id as GatewayChannelID,
    thread_session_map_id: record.thread_session_map_id as ThreadSessionMapID,
    provider_installation_id: record.provider_installation_id,
    provider_config_generation: record.provider_config_generation,
    status: record.status as DiscordMessageDeliveryStatus,
    attempt_count: record.attempt_count,
    next_attempt_at: asIso(record.next_attempt_at),
    claim_token: record.claim_token,
    claim_expires_at: record.claim_expires_at ? asIso(record.claim_expires_at) : null,
    claim_generation: record.claim_generation,
    ambiguous_chunk_index: record.ambiguous_chunk_index ?? null,
    effect_started_at: record.effect_started_at ? asIso(record.effect_started_at) : null,
    effect_recovery_grace_until: record.effect_recovery_grace_until
      ? asIso(record.effect_recovery_grace_until)
      : null,
    chunk_receipts: boundedReceipts<DiscordMessageDeliveryChunkReceipt>(record.chunk_receipts),
    reply_aliases: boundedAliases(record.reply_aliases),
    last_error_code: record.last_error_code,
    created_at: asIso(record.created_at),
    updated_at: asIso(record.updated_at),
    completed_at: record.completed_at ? asIso(record.completed_at) : null,
    canceled_at: record.canceled_at ? asIso(record.canceled_at) : null,
    dead_lettered_at: record.dead_lettered_at ? asIso(record.dead_lettered_at) : null,
  };
}

function mergeAliases(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])].slice(0, MAX_ALIASES);
}

function toClaim(
  claimToken: string,
  claimGeneration: number,
  lease: { row: DeliveryOutboxRow; leaseExpiresAt: Date }
): DiscordMessageDeliveryClaim {
  const delivery = rowToDelivery(lease.row);
  return {
    delivery_id: delivery.delivery_id,
    claim_token: claimToken,
    claim_generation: claimGeneration,
    lease_expires_at: asIso(lease.leaseExpiresAt),
    delivery,
  };
}

export class DiscordMessageDeliveryRepository {
  constructor(private readonly db: Database) {}

  /**
   * Insert the one intent inside the caller's Message transaction. The lookup
   * repeats the route boundary: only an enabled, mapped Discord channel with a
   * verified installation and a non-seed mapping is eligible.
   */
  async enqueueForMessageInTransaction(
    tx: Database,
    message: Message
  ): Promise<DiscordMessageDelivery | null> {
    // The agent's explicit no-reply marker is never delivered.
    if (isDiscordNoReply(deliveryMessageText(message))) return null;
    const candidate = await resolveDeliveryMapping(tx, message, 'discord');
    if (!candidate) return null;

    const now = new Date();
    const tenantId = isSQLiteDatabase(tx) ? undefined : getCurrentTenantId();
    if (!isSQLiteDatabase(tx) && !tenantId) {
      throw new RepositoryError(
        'Discord message delivery insertion requires explicit tenant identity'
      );
    }
    const insertData: DiscordMessageDeliveryInsert = {
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
      effect_recovery_grace_until: null,
      chunk_receipts: [],
      reply_aliases: [],
      last_error_code: null,
      completed_at: null,
      canceled_at: null,
      dead_lettered_at: null,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    };

    await insert(tx, discordMessageDeliveries)
      .values(insertData)
      .onConflictDoNothing({ target: discordMessageDeliveries.message_id })
      .run();
    const row = await select(tx)
      .from(discordMessageDeliveries)
      .where(eq(discordMessageDeliveries.message_id, message.message_id))
      .one();
    if (!row) throw new RepositoryError('Failed to retrieve Discord delivery intent');
    return rowToDelivery(row);
  }

  async findById(deliveryId: DiscordMessageDeliveryID): Promise<DiscordMessageDelivery | null> {
    const row = await select(this.db)
      .from(discordMessageDeliveries)
      .where(eq(discordMessageDeliveries.delivery_id, deliveryId))
      .one();
    return row ? rowToDelivery(row) : null;
  }

  async findByMessageId(messageId: string): Promise<DiscordMessageDelivery | null> {
    const row = await select(this.db)
      .from(discordMessageDeliveries)
      .where(eq(discordMessageDeliveries.message_id, messageId))
      .one();
    return row ? rowToDelivery(row) : null;
  }

  /** System discovery exposes only tenant routing identity and delivery ID. */
  async findDueRefs(
    db: SystemDatabase | Database,
    options: { limit?: number; now?: Date } = {}
  ): Promise<DiscordMessageDeliveryDiscoveryRef[]> {
    return (await findDueRefs(DISCORD_OUTBOX, db, options)).map((ref) => ({
      ...ref,
      delivery_id: ref.delivery_id as DiscordMessageDeliveryID,
    }));
  }

  async claim(
    deliveryId: DiscordMessageDeliveryID,
    claimToken: string,
    leaseDurationMs: number,
    now = new Date()
  ): Promise<DiscordMessageDeliveryClaim | null> {
    const lease = await claimWithLease(DISCORD_OUTBOX, this.db, {
      deliveryId,
      claimToken,
      leaseDurationMs,
      now,
    });
    return lease ? toClaim(claimToken, lease.row.claim_generation, lease) : null;
  }

  /** Reload a claim in a short tenant transaction before provider work. */
  async reloadClaim(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    now?: Date;
  }): Promise<DiscordMessageDelivery | null> {
    const row = await reloadClaim(DISCORD_OUTBOX, this.db, {
      ...input,
      now: input.now ?? new Date(),
    });
    return row ? rowToDelivery(row) : null;
  }

  /** Extend a live claim immediately before/after a bounded provider call. */
  async renewClaim(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    leaseDurationMs: number;
    now?: Date;
  }): Promise<DiscordMessageDeliveryClaim | null> {
    const lease = await renewClaim(DISCORD_OUTBOX, this.db, {
      ...input,
      now: input.now ?? new Date(),
    });
    return lease ? toClaim(input.claimToken, input.claimGeneration, lease) : null;
  }

  /**
   * Fence the next provider effect before making the provider call.  The
   * marker intentionally survives lease expiry and worker failure; only a
   * receipt checkpoint or an explicitly non-accepting provider response may
   * remove it.
   */
  async markChunkEffectStarted(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    chunkIndex: number;
    recoveryGraceMs?: number;
    now?: Date;
  }): Promise<DiscordMessageDelivery> {
    const recoveryGraceMs = input.recoveryGraceMs ?? DEFAULT_DISCORD_DELIVERY_RECOVERY_GRACE_MS;
    const row = await transitionClaim(
      DISCORD_OUTBOX,
      this.db,
      { ...input, now: input.now ?? new Date() },
      ({ row, now }) => {
        const changes = chunkEffectMarker(DISCORD_OUTBOX, row, input.chunkIndex, now);
        if (!changes) return null;
        if (!Number.isSafeInteger(recoveryGraceMs) || recoveryGraceMs < 1) {
          throw new RepositoryError('Discord delivery recovery grace must be a positive integer');
        }
        return {
          ...changes,
          effect_recovery_grace_until: new Date(now.getTime() + recoveryGraceMs),
        };
      }
    );
    return rowToDelivery(row);
  }

  /** Clear an ambiguous marker only after the provider proved non-acceptance. */
  async clearChunkEffectMarker(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    chunkIndex: number;
    now?: Date;
  }): Promise<DiscordMessageDelivery> {
    const row = await transitionClaim(
      DISCORD_OUTBOX,
      this.db,
      { ...input, now: input.now ?? new Date() },
      ({ row }) => clearChunkEffect(DISCORD_OUTBOX, row, input.chunkIndex)
    );
    return rowToDelivery(row);
  }

  async checkpointChunk(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    receipt: DiscordMessageDeliveryChunkReceipt;
    now?: Date;
  }): Promise<DiscordMessageDelivery> {
    const row = await transitionClaim(
      DISCORD_OUTBOX,
      this.db,
      { ...input, now: input.now ?? new Date() },
      ({ row }) => {
        const { changes } = chunkCheckpoint(DISCORD_OUTBOX, row, input.receipt);
        if (!changes || !('chunk_receipts' in changes)) return changes;
        return {
          ...changes,
          reply_aliases: mergeAliases(
            boundedAliases(row.reply_aliases),
            input.receipt.reply_aliases
          ),
        };
      }
    );
    return rowToDelivery(row);
  }

  async completeClaim(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    now?: Date;
  }): Promise<DiscordMessageDelivery> {
    const row = await transitionClaim(
      DISCORD_OUTBOX,
      this.db,
      { ...input, now: input.now ?? new Date() },
      ({ now }) => ({
        status: 'completed',
        claim_token: null,
        claim_expires_at: null,
        completed_at: now,
      })
    );
    return rowToDelivery(row);
  }

  async failClaim(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    status: 'pending' | 'canceled' | 'dead_letter';
    errorCode: string;
    nextAttemptAt?: Date;
    now?: Date;
  }): Promise<DiscordMessageDelivery> {
    const row = await transitionClaim(
      DISCORD_OUTBOX,
      this.db,
      { ...input, now: input.now ?? new Date() },
      ({ now }) => ({
        status: input.status,
        claim_token: null,
        claim_expires_at: null,
        last_error_code: input.errorCode,
        next_attempt_at: input.nextAttemptAt ?? now,
        canceled_at: input.status === 'canceled' ? now : null,
        dead_lettered_at: input.status === 'dead_letter' ? now : null,
      })
    );
    return rowToDelivery(row);
  }

  async purgeExpired(now = new Date()): Promise<number> {
    return purgeTerminal(DISCORD_OUTBOX, this.db, now);
  }
}
