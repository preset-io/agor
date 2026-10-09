/**
 * Shared mechanics for provider final-delivery outboxes.
 *
 * Each provider keeps its own narrow table (`discord_message_deliveries`,
 * `teams_message_deliveries`). This module owns the rules both obey: Task-
 * addressed routing, the serial lane per mapping, leased and generation-fenced
 * claims, per-chunk effect markers, and terminal retention. Provider tables
 * never store message text.
 */

import type { ChannelType, Message, ThreadSessionMapID } from '@agor/core/types';
import { and, asc, eq, isNull, lte, or, type SQL, sql } from 'drizzle-orm';
import type { Database, SystemDatabase } from '../client';
import {
  databaseNowExpression,
  deleteFrom,
  getDatabaseNow,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  type discordMessageDeliveries,
  gatewayChannels,
  type teamsMessageDeliveries,
  threadSessionMap,
} from '../schema';
import { RepositoryError } from './base';
import { TaskRepository } from './tasks';

export const DELIVERY_COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DELIVERY_FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DELIVERY_CHUNK_RECEIPTS = 1_000;

export interface DeliveryOutbox {
  table: typeof discordMessageDeliveries | typeof teamsMessageDeliveries;
  /** Unquoted SQL table name, used by the lane predicate's correlated subquery. */
  sqlName: 'discord_message_deliveries' | 'teams_message_deliveries';
  /** Human label for repository errors, e.g. "Discord message delivery". */
  label: string;
  /** `database` reads PostgreSQL time; `caller` trusts the supplied/current wall clock. */
  clock: 'caller' | 'database';
  /** Terminal statuses kept for the failed-retention window instead of the completed one. */
  failedStatuses: readonly string[];
  /** Whether the table has `effect_recovery_grace_until`. */
  hasRecoveryGrace: boolean;
  /** Rank PostgreSQL discovery per tenant; off keeps a pure partial-index scan. */
  fairDiscovery: boolean;
  claimLost(deliveryId: string): Error;
}

/** Content-free per-chunk receipt; providers extend it with their own ids. */
export interface DeliveryChunkReceipt {
  chunk_index: number;
}

export interface DeliveryClaimRef {
  deliveryId: string;
  claimToken: string;
  claimGeneration: number;
  now?: Date;
}

export interface DeliveryDueRef {
  tenant_id: string;
  delivery_id: string;
  thread_session_map_id: ThreadSessionMapID;
}

/** A row as returned by Drizzle for either outbox table. */
export type DeliveryOutboxRow = Record<string, unknown> & {
  delivery_id: string;
  status: string;
  attempt_count: number;
  claim_token: string | null;
  claim_generation: number;
  claim_expires_at: Date | string | number | null;
  next_attempt_at: Date | string | number;
  ambiguous_chunk_index: number | null;
  chunk_receipts: unknown;
};

/** Extract text only at the worker boundary; it is never stored in an intent. */
export function deliveryMessageText(message: Message): string {
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

/** Only non-empty final assistant text is delivered; "Thinking..." placeholders are not. */
export function isRoutableAssistantMessage(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  const text = deliveryMessageText(message).trim();
  return text.length > 0 && !/^thinking\s*\.{3}$/i.test(text);
}

export interface DeliveryMapping {
  mapping_id: ThreadSessionMapID;
  channel_id: string;
  provider_installation_id: string;
  provider_config_generation: number;
}

/**
 * Choose the one mapping a Message replies to, inside the Message transaction.
 * The Task's `gateway_task_source` is the destination; a Task sourced from
 * another provider, another session's Task, or a deleted stamped mapping
 * resolves to nothing rather than to another mapping of the Session.
 */
export async function resolveDeliveryMapping(
  tx: Database,
  message: Message,
  channelType: Extract<ChannelType, 'discord' | 'teams'>
): Promise<DeliveryMapping | null> {
  if (!isRoutableAssistantMessage(message)) return null;
  const task = message.task_id ? await new TaskRepository(tx).findById(message.task_id) : null;
  if (message.task_id && (!task || task.session_id !== message.session_id)) return null;
  const source = task?.metadata?.gateway_task_source;
  if (source && source.channel_type !== channelType) return null;
  const destination = source
    ? and(
        eq(threadSessionMap.channel_id, source.gateway_channel_id),
        source.thread_session_map_id
          ? eq(threadSessionMap.id, source.thread_session_map_id)
          : eq(threadSessionMap.thread_id, source.thread_id)
      )
    : undefined;

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
        destination,
        eq(gatewayChannels.enabled, true),
        eq(gatewayChannels.channel_type, channelType),
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
  return {
    mapping_id: candidate.mapping_id as ThreadSessionMapID,
    channel_id: candidate.channel_id,
    provider_installation_id: candidate.provider_installation_id,
    provider_config_generation: candidate.provider_config_generation,
  };
}

/**
 * A mapping is a durable serial lane. A row is claimable only when no older
 * nonterminal row exists in that lane; a retrying predecessor blocks newer rows.
 */
export function laneOldestPredicate(outbox: DeliveryOutbox, db: Database): SQL {
  const name = sql.raw(`"${outbox.sqlName}"`);
  const tenantPredicate = isSQLiteDatabase(db)
    ? sql``
    : sql` AND predecessor."tenant_id" = ${name}."tenant_id"`;
  return sql`NOT EXISTS (
    SELECT 1
    FROM ${name} AS predecessor
    WHERE predecessor."thread_session_map_id" = ${outbox.table.thread_session_map_id}
      ${tenantPredicate}
      AND predecessor."status" IN ('pending', 'processing')
      AND (
        predecessor."created_at" < ${outbox.table.created_at}
        OR (
          predecessor."created_at" = ${outbox.table.created_at}
          AND predecessor."delivery_id" < ${outbox.table.delivery_id}
        )
      )
  )`;
}

function nowValue(outbox: DeliveryOutbox, db: Database, now: Date): SQL | Date {
  return outbox.clock === 'database' ? databaseNowExpression(db, now) : now;
}

function retentionCutoff(outbox: DeliveryOutbox, db: Database, now: Date, ms: number): SQL | Date {
  if (outbox.clock === 'database' && !isSQLiteDatabase(db)) {
    return sql`CURRENT_TIMESTAMP - interval '${sql.raw(String(Math.trunc(ms)))} milliseconds'`;
  }
  return new Date(now.getTime() - ms);
}

function retentionPredicate(outbox: DeliveryOutbox, db: Database, now: Date): SQL | undefined {
  const table = outbox.table;
  const failed = sql.join(
    outbox.failedStatuses.map((status) => sql`${status}`),
    sql`, `
  );
  return or(
    and(
      sql`${table.status} IN ('completed', 'canceled')`,
      lte(table.updated_at, retentionCutoff(outbox, db, now, DELIVERY_COMPLETED_RETENTION_MS))
    ),
    and(
      sql`${table.status} IN (${failed})`,
      lte(table.updated_at, retentionCutoff(outbox, db, now, DELIVERY_FAILED_RETENTION_MS))
    )
  );
}

/**
 * System discovery exposes only tenant routing identity and delivery id. Due
 * work is read first; expired terminal rows fill any remaining capacity so
 * each tenant's purge pass still runs without scanning terminal history.
 */
export async function findDueRefs(
  outbox: DeliveryOutbox,
  db: SystemDatabase | Database,
  options: { limit?: number; now?: Date } = {}
): Promise<DeliveryDueRef[]> {
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RepositoryError(`${outbox.label} discovery limit must be between 1 and 1000`);
  }
  const table = outbox.table;
  const now = options.now ?? new Date();
  const current = nowValue(outbox, db, now);
  const activeDue = and(
    lte(table.next_attempt_at, current),
    or(
      eq(table.status, 'pending'),
      and(
        eq(table.status, 'processing'),
        or(isNull(table.claim_expires_at), lte(table.claim_expires_at, current))
      )
    ),
    laneOldestPredicate(outbox, db)
  ) as SQL;
  const active = await selectDueRefs(outbox, db, activeDue, limit);
  if (active.length >= limit) return active;
  const expired = await selectDueRefs(
    outbox,
    db,
    retentionPredicate(outbox, db, now) as SQL,
    limit - active.length
  );
  return [...active, ...expired];
}

async function selectDueRefs(
  outbox: DeliveryOutbox,
  db: SystemDatabase | Database,
  where: SQL,
  limit: number
): Promise<DeliveryDueRef[]> {
  const table = outbox.table;
  const order = [asc(table.next_attempt_at), asc(table.delivery_id)];
  if (isSQLiteDatabase(db)) {
    const rows = (await select(db, {
      delivery_id: table.delivery_id,
      thread_session_map_id: table.thread_session_map_id,
    })
      .from(table)
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .all()) as Array<{ delivery_id: string; thread_session_map_id: string }>;
    return rows.map((row) => ({
      tenant_id: 'default',
      delivery_id: row.delivery_id,
      thread_session_map_id: row.thread_session_map_id as ThreadSessionMapID,
    }));
  }
  const name = sql.raw(`"${outbox.sqlName}"`);
  const fairRank = outbox.fairDiscovery
    ? sql<number>`row_number() OVER (
        PARTITION BY ${name}."tenant_id"
        ORDER BY ${name}."next_attempt_at", ${name}."delivery_id"
      )`
    : null;
  const rows = (await select(db, {
    // Qualified: system-scope RLS policies may expose more than one tenant_id.
    tenant_id: sql<string>`${name}."tenant_id"`,
    delivery_id: table.delivery_id,
    thread_session_map_id: table.thread_session_map_id,
    ...(fairRank ? { fair_rank: fairRank } : {}),
  })
    .from(table)
    .where(where)
    .orderBy(...(fairRank ? [asc(fairRank), asc(sql`${name}."tenant_id"`), ...order] : order))
    .limit(limit)
    .all()) as Array<{ tenant_id: string; delivery_id: string; thread_session_map_id: string }>;
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    delivery_id: row.delivery_id,
    thread_session_map_id: row.thread_session_map_id as ThreadSessionMapID,
  }));
}

function byId(outbox: DeliveryOutbox, deliveryId: string): SQL {
  return eq(outbox.table.delivery_id, deliveryId) as SQL;
}

async function loadRow(
  outbox: DeliveryOutbox,
  db: Database,
  deliveryId: string
): Promise<DeliveryOutboxRow | null> {
  return ((await select(db).from(outbox.table).where(byId(outbox, deliveryId)).one()) ??
    null) as DeliveryOutboxRow | null;
}

async function lockAndLoad(
  outbox: DeliveryOutbox,
  rootDb: Database,
  tx: Database,
  deliveryId: string
): Promise<DeliveryOutboxRow | null> {
  await lockRowForUpdate(tx, rootDb, outbox.table, byId(outbox, deliveryId));
  return loadRow(outbox, tx, deliveryId);
}

/** Current time for a locked row: caller wall clock or (PostgreSQL) database time. */
async function rowClock(
  outbox: DeliveryOutbox,
  tx: Database,
  deliveryId: string,
  fallback: Date | undefined,
  wall = false
): Promise<Date> {
  if (outbox.clock === 'caller') return fallback ?? new Date();
  if (wall && !isSQLiteDatabase(tx)) {
    // A lock wait may outlive the lease, so use wall time rather than transaction start.
    const clock = (await select(tx, { now: sql<Date>`clock_timestamp()` })
      .from(outbox.table)
      .where(byId(outbox, deliveryId))
      .one()) as { now?: Date | string } | null;
    if (clock?.now) return new Date(clock.now);
  }
  const now = await getDatabaseNow(tx, outbox.table, byId(outbox, deliveryId), fallback);
  if (!now) throw new RepositoryError(`Unable to obtain database time for ${outbox.label}`);
  return now;
}

export function isClaimCurrent(
  row: DeliveryOutboxRow,
  token: string,
  generation: number,
  now: Date
): boolean {
  return (
    row.status === 'processing' &&
    row.claim_token === token &&
    row.claim_generation === generation &&
    !!row.claim_expires_at &&
    new Date(row.claim_expires_at) > now
  );
}

function claimWhere(outbox: DeliveryOutbox, db: Database, ref: DeliveryClaimRef, now: Date): SQL {
  const claimNow =
    outbox.clock === 'database'
      ? databaseNowExpression(db, now)
      : isSQLiteDatabase(db)
        ? now
        : now.toISOString();
  return and(
    byId(outbox, ref.deliveryId),
    eq(outbox.table.status, 'processing'),
    eq(outbox.table.claim_token, ref.claimToken),
    eq(outbox.table.claim_generation, ref.claimGeneration),
    sql`${outbox.table.claim_expires_at} > ${claimNow}`
  ) as SQL;
}

function isSQLiteBusy(error: unknown): boolean {
  return /SQLITE_BUSY|database is locked|database is busy/i.test(String(error));
}

export interface DeliveryLease {
  row: DeliveryOutboxRow;
  leaseExpiresAt: Date;
}

/**
 * Claim a due row at the head of its lane. `onExpiredEffect` may terminalize
 * a lapsed claim whose chunk effect marker is still set (returning true skips
 * the claim); otherwise such a row is reclaimed for recovery.
 */
export async function claimWithLease(
  outbox: DeliveryOutbox,
  db: Database,
  input: {
    deliveryId: string;
    claimToken: string;
    leaseDurationMs: number;
    now?: Date;
    onExpiredEffect?: (tx: Database, row: DeliveryOutboxRow, now: Date) => Promise<boolean>;
  }
): Promise<DeliveryLease | null> {
  if (
    !input.claimToken.trim() ||
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1
  ) {
    throw new RepositoryError(`${outbox.label} lease must be a positive integer`);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await runDatabaseTransaction(
        db,
        async (tx) => {
          const row = await lockAndLoad(outbox, db, tx, input.deliveryId);
          if (!row) return null;
          const now = await rowClock(outbox, tx, input.deliveryId, input.now);
          const lapsed =
            row.status === 'processing' &&
            (!row.claim_expires_at || new Date(row.claim_expires_at) <= now);
          if (
            lapsed &&
            row.ambiguous_chunk_index !== null &&
            input.onExpiredEffect &&
            (await input.onExpiredEffect(tx, row, now))
          ) {
            return null;
          }
          const claimable =
            new Date(row.next_attempt_at) <= now && (row.status === 'pending' || lapsed);
          if (!claimable) return null;
          const oldest = await select(tx, { delivery_id: outbox.table.delivery_id })
            .from(outbox.table)
            .where(and(byId(outbox, input.deliveryId), laneOldestPredicate(outbox, db)))
            .one();
          if (!oldest) return null;
          const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs);
          const updated = (await update(tx, outbox.table)
            .set({
              status: 'processing',
              claim_token: input.claimToken,
              claim_expires_at: leaseExpiresAt,
              claim_generation: row.claim_generation + 1,
              attempt_count: row.attempt_count + 1,
              updated_at: now,
            })
            .where(byId(outbox, input.deliveryId))
            .returning()
            .one()) as DeliveryOutboxRow;
          return { row: updated, leaseExpiresAt };
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
export async function reloadClaim(
  outbox: DeliveryOutbox,
  db: Database,
  ref: DeliveryClaimRef
): Promise<DeliveryOutboxRow | null> {
  const row = await loadRow(outbox, db, ref.deliveryId);
  if (!row) return null;
  const now =
    outbox.clock === 'caller'
      ? (ref.now ?? new Date())
      : await rowClock(outbox, db, ref.deliveryId, ref.now);
  return isClaimCurrent(row, ref.claimToken, ref.claimGeneration, now) ? row : null;
}

/** Extend a live claim immediately before/after a bounded provider call. */
export async function renewClaim(
  outbox: DeliveryOutbox,
  db: Database,
  ref: DeliveryClaimRef & { leaseDurationMs: number }
): Promise<DeliveryLease | null> {
  if (!Number.isSafeInteger(ref.leaseDurationMs) || ref.leaseDurationMs < 1) {
    throw new RepositoryError(`${outbox.label} lease must be a positive integer`);
  }
  return runDatabaseTransaction(db, async (tx) => {
    const row = await lockAndLoad(outbox, db, tx, ref.deliveryId);
    if (!row) return null;
    const now = await rowClock(outbox, tx, ref.deliveryId, ref.now);
    if (!isClaimCurrent(row, ref.claimToken, ref.claimGeneration, now)) return null;
    const leaseExpiresAt = new Date(now.getTime() + ref.leaseDurationMs);
    const updated = (await update(tx, outbox.table)
      .set({ claim_expires_at: leaseExpiresAt, updated_at: now })
      .where(claimWhere(outbox, db, ref, now))
      .returning()
      .one()) as DeliveryOutboxRow;
    return { row: updated, leaseExpiresAt };
  });
}

/**
 * Apply one claim-fenced state change. `before` runs first in the same
 * transaction (e.g. to lock the channel ahead of the row, matching config
 * writers' lock order); `apply` returns the columns to set, or null to keep
 * the row as is. A lost or stale claim throws the outbox's claim-lost error.
 */
export async function transitionClaim<T = undefined>(
  outbox: DeliveryOutbox,
  db: Database,
  ref: DeliveryClaimRef,
  apply: (context: {
    tx: Database;
    row: DeliveryOutboxRow;
    now: Date;
    before: T;
  }) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null,
  options: {
    before?: (tx: Database, candidate: DeliveryOutboxRow) => Promise<T>;
    wallClock?: boolean;
    sqliteImmediate?: boolean;
  } = {}
): Promise<DeliveryOutboxRow> {
  return runDatabaseTransaction(
    db,
    async (tx) => {
      let before = undefined as T;
      if (options.before) {
        const candidate = await loadRow(outbox, tx, ref.deliveryId);
        if (!candidate) throw outbox.claimLost(ref.deliveryId);
        before = await options.before(tx, candidate);
      }
      const row = await lockAndLoad(outbox, db, tx, ref.deliveryId);
      if (!row) throw outbox.claimLost(ref.deliveryId);
      const now = await rowClock(outbox, tx, ref.deliveryId, ref.now, options.wallClock);
      if (!isClaimCurrent(row, ref.claimToken, ref.claimGeneration, now)) {
        throw outbox.claimLost(ref.deliveryId);
      }
      const changes = await apply({ tx, row, now, before });
      if (!changes) return row;
      return (await update(tx, outbox.table)
        .set({ ...changes, updated_at: now })
        .where(claimWhere(outbox, db, ref, now))
        .returning()
        .one()) as DeliveryOutboxRow;
    },
    options.sqliteImmediate ? { sqliteImmediate: true } : {}
  );
}

export function boundedReceipts<R extends DeliveryChunkReceipt>(value: unknown): R[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_DELIVERY_CHUNK_RECEIPTS) as R[];
}

function clearedEffect(outbox: DeliveryOutbox): Record<string, unknown> {
  return {
    ambiguous_chunk_index: null,
    effect_started_at: null,
    ...(outbox.hasRecoveryGrace ? { effect_recovery_grace_until: null } : {}),
  };
}

/**
 * Columns that fence the next chunk's provider effect. The marker survives
 * lease expiry and worker failure; only a receipt or a provider response
 * proving non-acceptance removes it.
 */
export function chunkEffectMarker(
  outbox: DeliveryOutbox,
  row: DeliveryOutboxRow,
  chunkIndex: number,
  now: Date,
  recoveryGraceMs?: number
): Record<string, unknown> | null {
  if (chunkIndex < 0 || chunkIndex >= MAX_DELIVERY_CHUNK_RECEIPTS) {
    throw new RepositoryError(`${outbox.label} chunk marker bound exceeded`);
  }
  if (boundedReceipts(row.chunk_receipts).some((item) => item.chunk_index === chunkIndex)) {
    return null;
  }
  if (row.ambiguous_chunk_index !== null && row.ambiguous_chunk_index !== chunkIndex) {
    throw new RepositoryError(`${outbox.label} has another ambiguous chunk in flight`);
  }
  if (row.ambiguous_chunk_index === chunkIndex) return null;
  return {
    ambiguous_chunk_index: chunkIndex,
    effect_started_at: now,
    ...(outbox.hasRecoveryGrace && recoveryGraceMs !== undefined
      ? { effect_recovery_grace_until: new Date(now.getTime() + recoveryGraceMs) }
      : {}),
  };
}

/** Columns that clear a chunk marker after the provider proved non-acceptance. */
export function clearChunkEffect(
  outbox: DeliveryOutbox,
  row: DeliveryOutboxRow,
  chunkIndex: number
): Record<string, unknown> | null {
  return row.ambiguous_chunk_index === chunkIndex ? clearedEffect(outbox) : null;
}

/** Columns that checkpoint one chunk receipt (in order, only under its marker). */
export function chunkCheckpoint<R extends DeliveryChunkReceipt>(
  outbox: DeliveryOutbox,
  row: DeliveryOutboxRow,
  receipt: R
): { changes: Record<string, unknown> | null; receipts: R[] } {
  if (receipt.chunk_index < 0 || receipt.chunk_index >= MAX_DELIVERY_CHUNK_RECEIPTS) {
    throw new RepositoryError(`${outbox.label} chunk receipt bound exceeded`);
  }
  const receipts = boundedReceipts<R>(row.chunk_receipts);
  if (receipts.some((item) => item.chunk_index === receipt.chunk_index)) {
    return {
      changes: row.ambiguous_chunk_index === receipt.chunk_index ? clearedEffect(outbox) : null,
      receipts,
    };
  }
  if (row.ambiguous_chunk_index !== receipt.chunk_index) {
    throw new RepositoryError(`${outbox.label} checkpoint lacked an effect marker`);
  }
  if (receipts.some((item) => item.chunk_index > receipt.chunk_index)) {
    throw new RepositoryError(`${outbox.label} chunk checkpoint is out of order`);
  }
  const next = [...receipts, receipt];
  if (next.length > MAX_DELIVERY_CHUNK_RECEIPTS) {
    throw new RepositoryError(`${outbox.label} chunk receipt bound exceeded`);
  }
  return { changes: { chunk_receipts: next, ...clearedEffect(outbox) }, receipts: next };
}

/** Delete terminal rows past retention: completed/canceled 7 days, failed 30 days. */
export async function purgeTerminal(
  outbox: DeliveryOutbox,
  db: Database,
  now = new Date()
): Promise<number> {
  const predicate = retentionPredicate(outbox, db, now);
  const result = await deleteFrom(db, outbox.table).where(predicate).run();
  return result.rowsAffected;
}
