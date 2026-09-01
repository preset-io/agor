/**
 * Durable final-delivery intents for mapped Discord assistant Messages.
 *
 * This repository deliberately contains no provider text or generalized
 * action vocabulary. It only elects a Discord delivery, fences a worker, and
 * stores bounded provider receipts needed to recover one delivery.
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
import { and, asc, eq, isNull, lte, or, type SQL, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database, SystemDatabase } from '../client';
import {
  deleteFrom,
  insert,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  type DiscordMessageDeliveryInsert,
  type DiscordMessageDeliveryRow,
  discordMessageDeliveries,
  gatewayChannels,
  threadSessionMap,
} from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import { RepositoryError } from './base';

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

const MAX_RECEIPTS = 1_000;
const MAX_ALIASES = 2_000;
export const DEFAULT_DISCORD_DELIVERY_RECOVERY_GRACE_MS = 60_000;

function asIso(value: Date | string | number): string {
  return new Date(value).toISOString();
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    const text = message.content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          !Array.isArray(block) &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
      )
      .map((block) => block.text)
      .join('\n');
    return text || message.content_preview || '';
  }
  return message.content_preview ?? '';
}

function isRoutableAssistantMessage(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  const text = messageText(message);
  return text.trim().length > 0 && !/^thinking\s*\.{3}$/i.test(text.trim());
}

/** Extract text only at the worker boundary; it is never stored in the intent. */
export function extractDiscordDeliveryText(message: Message): string {
  return messageText(message);
}

function boundedReceipts(value: unknown): DiscordMessageDeliveryChunkReceipt[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_RECEIPTS) as DiscordMessageDeliveryChunkReceipt[];
}

function boundedAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))].slice(
    0,
    MAX_ALIASES
  );
}

function rowToDelivery(row: DiscordMessageDeliveryRow): DiscordMessageDelivery {
  return {
    delivery_id: row.delivery_id as DiscordMessageDeliveryID,
    message_id: row.message_id as MessageID,
    gateway_channel_id: row.gateway_channel_id as GatewayChannelID,
    thread_session_map_id: row.thread_session_map_id as ThreadSessionMapID,
    provider_installation_id: row.provider_installation_id,
    provider_config_generation: row.provider_config_generation,
    status: row.status as DiscordMessageDeliveryStatus,
    attempt_count: row.attempt_count,
    next_attempt_at: asIso(row.next_attempt_at),
    claim_token: row.claim_token,
    claim_expires_at: row.claim_expires_at ? asIso(row.claim_expires_at) : null,
    claim_generation: row.claim_generation,
    ambiguous_chunk_index: row.ambiguous_chunk_index ?? null,
    effect_started_at: row.effect_started_at ? asIso(row.effect_started_at) : null,
    effect_recovery_grace_until: row.effect_recovery_grace_until
      ? asIso(row.effect_recovery_grace_until)
      : null,
    chunk_receipts: boundedReceipts(row.chunk_receipts),
    reply_aliases: boundedAliases(row.reply_aliases),
    last_error_code: row.last_error_code,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
    completed_at: row.completed_at ? asIso(row.completed_at) : null,
    canceled_at: row.canceled_at ? asIso(row.canceled_at) : null,
    dead_lettered_at: row.dead_lettered_at ? asIso(row.dead_lettered_at) : null,
  };
}

function isSQLiteBusy(error: unknown): boolean {
  return /SQLITE_BUSY|database is locked|database is busy/i.test(String(error));
}

function mergeAliases(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])].slice(0, MAX_ALIASES);
}

const NONTERMINAL_DELIVERY_STATUS_SQL = sql`predecessor."status" NOT IN ('completed', 'canceled', 'dead_letter')`;

/**
 * A mapping is a durable serial lane. The row can be claimed only when no
 * older nonterminal row exists in that lane; in particular, a retry_wait
 * predecessor blocks a newer delivery even when the newer row is due.
 */
function oldestNonterminalDelivery(db: Database): SQL {
  const tenantPredicate = isSQLiteDatabase(db)
    ? sql``
    : sql` AND predecessor."tenant_id" = "discord_message_deliveries"."tenant_id"`;
  return sql`NOT EXISTS (
    SELECT 1
    FROM "discord_message_deliveries" AS predecessor
    WHERE predecessor."thread_session_map_id" = ${discordMessageDeliveries.thread_session_map_id}
      ${tenantPredicate}
      AND ${NONTERMINAL_DELIVERY_STATUS_SQL}
      AND (
        predecessor."created_at" < ${discordMessageDeliveries.created_at}
        OR (
          predecessor."created_at" = ${discordMessageDeliveries.created_at}
          AND predecessor."delivery_id" < ${discordMessageDeliveries.delivery_id}
        )
      )
  )`;
}

function fairDiscoveryRank(db: Database): SQL<number> | null {
  if (isSQLiteDatabase(db)) return null;
  return sql<number>`row_number() OVER (
    PARTITION BY "discord_message_deliveries"."tenant_id"
    ORDER BY "discord_message_deliveries"."next_attempt_at", "discord_message_deliveries"."delivery_id"
  )`;
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
    if (!isRoutableAssistantMessage(message)) return null;

    const candidates = (await select(tx, {
      mapping_id: threadSessionMap.id,
      mapping_metadata: threadSessionMap.metadata,
      channel_id: gatewayChannels.id,
      provider_installation_id: gatewayChannels.provider_installation_id,
      provider_config_generation: gatewayChannels.provider_config_generation,
    })
      .from(threadSessionMap)
      .innerJoin(gatewayChannels, eq(gatewayChannels.id, threadSessionMap.channel_id))
      .where(
        and(
          eq(threadSessionMap.session_id, message.session_id),
          eq(gatewayChannels.enabled, true),
          eq(gatewayChannels.channel_type, 'discord'),
          sql`${gatewayChannels.provider_installation_id} IS NOT NULL`
        )
      )
      .orderBy(asc(threadSessionMap.created_at), asc(threadSessionMap.id))
      .limit(2)
      .all()) as Array<{
      mapping_id: string;
      mapping_metadata: unknown;
      channel_id: string;
      provider_installation_id: string | null;
      provider_config_generation: number;
    }>;

    const candidate = candidates.find((row) => {
      const metadata = (row.mapping_metadata as Record<string, unknown> | null) ?? {};
      return typeof metadata.outbound_seed_id !== 'string';
    });
    if (!candidate || typeof candidate.provider_installation_id !== 'string') return null;

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
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RepositoryError(
        'Discord message delivery discovery limit must be between 1 and 1000'
      );
    }
    const now = options.now ?? new Date();
    const completedBefore = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const deadLetterBefore = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const activeDue = and(
      lte(discordMessageDeliveries.next_attempt_at, now),
      or(
        eq(discordMessageDeliveries.status, 'pending'),
        and(
          eq(discordMessageDeliveries.status, 'processing'),
          or(
            isNull(discordMessageDeliveries.claim_expires_at),
            lte(discordMessageDeliveries.claim_expires_at, now)
          )
        )
      ),
      oldestNonterminalDelivery(db)
    );
    const due = and(
      or(
        activeDue,
        and(
          sql`${discordMessageDeliveries.status} IN ('completed', 'canceled')`,
          lte(discordMessageDeliveries.updated_at, completedBefore)
        ),
        and(
          eq(discordMessageDeliveries.status, 'dead_letter'),
          lte(discordMessageDeliveries.updated_at, deadLetterBefore)
        )
      )
    );
    const order = [
      asc(discordMessageDeliveries.next_attempt_at),
      asc(discordMessageDeliveries.delivery_id),
    ];
    if (isSQLiteDatabase(db)) {
      const rows = await select(db, {
        delivery_id: discordMessageDeliveries.delivery_id,
        thread_session_map_id: discordMessageDeliveries.thread_session_map_id,
      })
        .from(discordMessageDeliveries)
        .where(due)
        .orderBy(...order)
        .limit(limit)
        .all();
      return rows.map((row: { delivery_id: string; thread_session_map_id: string }) => ({
        tenant_id: 'default',
        delivery_id: row.delivery_id as DiscordMessageDeliveryID,
        thread_session_map_id: row.thread_session_map_id as ThreadSessionMapID,
      }));
    }
    const fairRank = fairDiscoveryRank(db);
    const rows = await select(db, {
      tenant_id: sql<string>`tenant_id`,
      delivery_id: discordMessageDeliveries.delivery_id,
      thread_session_map_id: discordMessageDeliveries.thread_session_map_id,
      ...(fairRank ? { fair_rank: fairRank } : {}),
    })
      .from(discordMessageDeliveries)
      .where(due)
      .orderBy(
        ...(fairRank
          ? [asc(fairRank), asc(sql`"discord_message_deliveries"."tenant_id"`), ...order]
          : order)
      )
      .limit(limit)
      .all();
    return rows.map(
      (row: { tenant_id: string; delivery_id: string; thread_session_map_id: string }) => ({
        tenant_id: row.tenant_id,
        delivery_id: row.delivery_id as DiscordMessageDeliveryID,
        thread_session_map_id: row.thread_session_map_id as ThreadSessionMapID,
      })
    );
  }

  async claim(
    deliveryId: DiscordMessageDeliveryID,
    claimToken: string,
    leaseDurationMs: number,
    now = new Date()
  ): Promise<DiscordMessageDeliveryClaim | null> {
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new RepositoryError('Discord message delivery lease must be a positive integer');
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await runDatabaseTransaction(
          this.db,
          async (tx) => {
            await lockRowForUpdate(
              tx,
              this.db,
              discordMessageDeliveries,
              eq(discordMessageDeliveries.delivery_id, deliveryId)
            );
            const row = await select(tx)
              .from(discordMessageDeliveries)
              .where(eq(discordMessageDeliveries.delivery_id, deliveryId))
              .one();
            if (!row) return null;
            const claimable =
              row.next_attempt_at <= now &&
              (row.status === 'pending' ||
                (row.status === 'processing' &&
                  (!row.claim_expires_at || new Date(row.claim_expires_at) <= now)));
            if (!claimable) return null;
            const oldest = await select(tx, { delivery_id: discordMessageDeliveries.delivery_id })
              .from(discordMessageDeliveries)
              .where(
                and(
                  eq(discordMessageDeliveries.delivery_id, deliveryId),
                  oldestNonterminalDelivery(this.db)
                )
              )
              .one();
            if (!oldest) return null;
            const leaseExpires = new Date(now.getTime() + leaseDurationMs);
            const updated = await update(tx, discordMessageDeliveries)
              .set({
                status: 'processing',
                claim_token: claimToken,
                claim_expires_at: leaseExpires,
                claim_generation: row.claim_generation + 1,
                attempt_count: row.attempt_count + 1,
                updated_at: now,
              })
              .where(eq(discordMessageDeliveries.delivery_id, deliveryId))
              .returning()
              .one();
            const delivery = rowToDelivery(updated);
            return {
              delivery_id: delivery.delivery_id,
              claim_token: claimToken,
              claim_generation: delivery.claim_generation,
              lease_expires_at: asIso(leaseExpires),
              delivery,
            };
          },
          { sqliteImmediate: true }
        );
      } catch (error) {
        if (isSQLiteBusy(error) && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  /** Reload a claim in a short tenant transaction before provider work. */
  async reloadClaim(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    now?: Date;
  }): Promise<DiscordMessageDelivery | null> {
    const now = input.now ?? new Date();
    const row = await select(this.db)
      .from(discordMessageDeliveries)
      .where(eq(discordMessageDeliveries.delivery_id, input.deliveryId))
      .one();
    return row && this.isClaimCurrent(row, input.claimToken, input.claimGeneration, now)
      ? rowToDelivery(row)
      : null;
  }

  /** Extend a live claim immediately before/after a bounded provider call. */
  async renewClaim(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    leaseDurationMs: number;
    now?: Date;
  }): Promise<DiscordMessageDeliveryClaim | null> {
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
      throw new RepositoryError('Discord message delivery lease must be a positive integer');
    }
    const now = input.now ?? new Date();
    return runDatabaseTransaction(this.db, async (tx) => {
      await lockRowForUpdate(
        tx,
        this.db,
        discordMessageDeliveries,
        eq(discordMessageDeliveries.delivery_id, input.deliveryId)
      );
      const row = await select(tx)
        .from(discordMessageDeliveries)
        .where(eq(discordMessageDeliveries.delivery_id, input.deliveryId))
        .one();
      if (!row || !this.isClaimCurrent(row, input.claimToken, input.claimGeneration, now)) {
        return null;
      }
      const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
      const updated = await update(tx, discordMessageDeliveries)
        .set({ claim_expires_at: leaseExpiresAt, updated_at: now })
        .where(this.claimWhere(input.deliveryId, input.claimToken, input.claimGeneration, now))
        .returning()
        .one();
      const delivery = rowToDelivery(updated);
      return {
        delivery_id: delivery.delivery_id,
        claim_token: input.claimToken,
        claim_generation: input.claimGeneration,
        lease_expires_at: asIso(leaseExpiresAt),
        delivery,
      };
    });
  }

  private claimWhere(deliveryId: string, token: string, generation: number, now: Date) {
    const claimNow = isSQLiteDatabase(this.db) ? now : now.toISOString();
    return and(
      eq(discordMessageDeliveries.delivery_id, deliveryId),
      eq(discordMessageDeliveries.status, 'processing'),
      eq(discordMessageDeliveries.claim_token, token),
      eq(discordMessageDeliveries.claim_generation, generation),
      sql`${discordMessageDeliveries.claim_expires_at} > ${claimNow}`
    );
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
    const now = input.now ?? new Date();
    if (input.chunkIndex < 0 || input.chunkIndex >= MAX_RECEIPTS) {
      throw new RepositoryError('Discord delivery chunk marker bound exceeded');
    }
    return runDatabaseTransaction(this.db, async (tx) => {
      await lockRowForUpdate(
        tx,
        this.db,
        discordMessageDeliveries,
        eq(discordMessageDeliveries.delivery_id, input.deliveryId)
      );
      const row = await select(tx)
        .from(discordMessageDeliveries)
        .where(eq(discordMessageDeliveries.delivery_id, input.deliveryId))
        .one();
      if (!row || !this.isClaimCurrent(row, input.claimToken, input.claimGeneration, now)) {
        throw new DiscordMessageDeliveryClaimLostError(input.deliveryId);
      }
      if (
        boundedReceipts(row.chunk_receipts).some((item) => item.chunk_index === input.chunkIndex)
      ) {
        return rowToDelivery(row);
      }
      if (row.ambiguous_chunk_index !== null && row.ambiguous_chunk_index !== input.chunkIndex) {
        throw new RepositoryError('Discord delivery has another ambiguous chunk in flight');
      }
      if (row.ambiguous_chunk_index === input.chunkIndex) return rowToDelivery(row);
      const recoveryGraceMs = input.recoveryGraceMs ?? DEFAULT_DISCORD_DELIVERY_RECOVERY_GRACE_MS;
      if (!Number.isSafeInteger(recoveryGraceMs) || recoveryGraceMs < 1) {
        throw new RepositoryError('Discord delivery recovery grace must be a positive integer');
      }
      const updated = await update(tx, discordMessageDeliveries)
        .set({
          ambiguous_chunk_index: input.chunkIndex,
          effect_started_at: now,
          effect_recovery_grace_until: new Date(now.getTime() + recoveryGraceMs),
          updated_at: now,
        })
        .where(this.claimWhere(input.deliveryId, input.claimToken, input.claimGeneration, now))
        .returning()
        .one();
      return rowToDelivery(updated);
    });
  }

  /** Clear an ambiguous marker only after the provider proved non-acceptance. */
  async clearChunkEffectMarker(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    chunkIndex: number;
    now?: Date;
  }): Promise<DiscordMessageDelivery> {
    const now = input.now ?? new Date();
    return runDatabaseTransaction(this.db, async (tx) => {
      await lockRowForUpdate(
        tx,
        this.db,
        discordMessageDeliveries,
        eq(discordMessageDeliveries.delivery_id, input.deliveryId)
      );
      const row = await select(tx)
        .from(discordMessageDeliveries)
        .where(eq(discordMessageDeliveries.delivery_id, input.deliveryId))
        .one();
      if (!row || !this.isClaimCurrent(row, input.claimToken, input.claimGeneration, now)) {
        throw new DiscordMessageDeliveryClaimLostError(input.deliveryId);
      }
      if (row.ambiguous_chunk_index !== input.chunkIndex) return rowToDelivery(row);
      const updated = await update(tx, discordMessageDeliveries)
        .set({
          ambiguous_chunk_index: null,
          effect_started_at: null,
          effect_recovery_grace_until: null,
          updated_at: now,
        })
        .where(this.claimWhere(input.deliveryId, input.claimToken, input.claimGeneration, now))
        .returning()
        .one();
      return rowToDelivery(updated);
    });
  }

  async checkpointChunk(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    receipt: DiscordMessageDeliveryChunkReceipt;
    now?: Date;
  }): Promise<DiscordMessageDelivery> {
    const now = input.now ?? new Date();
    if (input.receipt.chunk_index < 0 || input.receipt.chunk_index >= MAX_RECEIPTS) {
      throw new RepositoryError('Discord delivery chunk receipt bound exceeded');
    }
    return runDatabaseTransaction(this.db, async (tx) => {
      await lockRowForUpdate(
        tx,
        this.db,
        discordMessageDeliveries,
        eq(discordMessageDeliveries.delivery_id, input.deliveryId)
      );
      const row = await select(tx)
        .from(discordMessageDeliveries)
        .where(eq(discordMessageDeliveries.delivery_id, input.deliveryId))
        .one();
      if (!row || !this.isClaimCurrent(row, input.claimToken, input.claimGeneration, now)) {
        throw new DiscordMessageDeliveryClaimLostError(input.deliveryId);
      }
      const receipts = boundedReceipts(row.chunk_receipts);
      const existing = receipts.find((item) => item.chunk_index === input.receipt.chunk_index);
      if (existing) {
        if (row.ambiguous_chunk_index !== input.receipt.chunk_index) return rowToDelivery(row);
        const updated = await update(tx, discordMessageDeliveries)
          .set({
            ambiguous_chunk_index: null,
            effect_started_at: null,
            effect_recovery_grace_until: null,
            updated_at: now,
          })
          .where(this.claimWhere(input.deliveryId, input.claimToken, input.claimGeneration, now))
          .returning()
          .one();
        return rowToDelivery(updated);
      }
      if (row.ambiguous_chunk_index !== input.receipt.chunk_index) {
        throw new RepositoryError('Discord delivery checkpoint lacked an effect marker');
      }
      if (receipts.some((item) => item.chunk_index > input.receipt.chunk_index)) {
        throw new RepositoryError('Discord delivery chunk checkpoint is out of order');
      }
      const nextReceipts = [...receipts, input.receipt];
      if (nextReceipts.length > MAX_RECEIPTS) {
        throw new RepositoryError('Discord delivery chunk receipt bound exceeded');
      }
      const updated = await update(tx, discordMessageDeliveries)
        .set({
          chunk_receipts: nextReceipts,
          ambiguous_chunk_index: null,
          effect_started_at: null,
          effect_recovery_grace_until: null,
          reply_aliases: mergeAliases(
            boundedAliases(row.reply_aliases),
            input.receipt.reply_aliases
          ),
          updated_at: now,
        })
        .where(this.claimWhere(input.deliveryId, input.claimToken, input.claimGeneration, now))
        .returning()
        .one();
      return rowToDelivery(updated);
    });
  }

  private isClaimCurrent(
    row: DiscordMessageDeliveryRow,
    token: string,
    generation: number,
    now: Date
  ) {
    return (
      row.status === 'processing' &&
      row.claim_token === token &&
      row.claim_generation === generation &&
      !!row.claim_expires_at &&
      new Date(row.claim_expires_at) > now
    );
  }

  async completeClaim(input: {
    deliveryId: DiscordMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    now?: Date;
  }): Promise<DiscordMessageDelivery> {
    const now = input.now ?? new Date();
    return runDatabaseTransaction(this.db, async (tx) => {
      await lockRowForUpdate(
        tx,
        this.db,
        discordMessageDeliveries,
        eq(discordMessageDeliveries.delivery_id, input.deliveryId)
      );
      const row = await select(tx)
        .from(discordMessageDeliveries)
        .where(eq(discordMessageDeliveries.delivery_id, input.deliveryId))
        .one();
      if (!row || !this.isClaimCurrent(row, input.claimToken, input.claimGeneration, now)) {
        throw new DiscordMessageDeliveryClaimLostError(input.deliveryId);
      }
      const updated = await update(tx, discordMessageDeliveries)
        .set({
          status: 'completed',
          claim_token: null,
          claim_expires_at: null,
          completed_at: now,
          updated_at: now,
        })
        .where(this.claimWhere(input.deliveryId, input.claimToken, input.claimGeneration, now))
        .returning()
        .one();
      return rowToDelivery(updated);
    });
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
    const now = input.now ?? new Date();
    return runDatabaseTransaction(this.db, async (tx) => {
      await lockRowForUpdate(
        tx,
        this.db,
        discordMessageDeliveries,
        eq(discordMessageDeliveries.delivery_id, input.deliveryId)
      );
      const row = await select(tx)
        .from(discordMessageDeliveries)
        .where(eq(discordMessageDeliveries.delivery_id, input.deliveryId))
        .one();
      if (!row || !this.isClaimCurrent(row, input.claimToken, input.claimGeneration, now)) {
        throw new DiscordMessageDeliveryClaimLostError(input.deliveryId);
      }
      const updated = await update(tx, discordMessageDeliveries)
        .set({
          status: input.status,
          claim_token: null,
          claim_expires_at: null,
          last_error_code: input.errorCode,
          next_attempt_at: input.nextAttemptAt ?? now,
          canceled_at: input.status === 'canceled' ? now : null,
          dead_lettered_at: input.status === 'dead_letter' ? now : null,
          updated_at: now,
        })
        .where(this.claimWhere(input.deliveryId, input.claimToken, input.claimGeneration, now))
        .returning()
        .one();
      return rowToDelivery(updated);
    });
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const completedBefore = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const deadLetterBefore = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const result = await deleteFrom(this.db, discordMessageDeliveries)
      .where(
        or(
          and(
            sql`${discordMessageDeliveries.status} IN ('completed', 'canceled')`,
            lte(discordMessageDeliveries.updated_at, completedBefore)
          ),
          and(
            eq(discordMessageDeliveries.status, 'dead_letter'),
            lte(discordMessageDeliveries.updated_at, deadLetterBefore)
          )
        )
      )
      .run();
    return result.rowsAffected;
  }
}
