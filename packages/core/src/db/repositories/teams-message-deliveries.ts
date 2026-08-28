/** Durable, provider-specific Teams delivery intents. An effect marker that
 * loses its lease becomes `ambiguous`; it is never blindly retried. */

import type {
  GatewayChannelID,
  Message,
  MessageID,
  TeamsMessageDelivery,
  TeamsMessageDeliveryID,
  TeamsMessageDeliveryStatus,
  TenantID,
  ThreadSessionMapID,
} from '@agor/core/types';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database, SystemDatabase } from '../client';
import {
  databaseNowExpression,
  getDatabaseNow,
  insert,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  gatewayChannels,
  type TeamsMessageDeliveryInsert,
  type TeamsMessageDeliveryRow,
  teamsMessageDeliveries,
  threadSessionMap,
} from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import { RepositoryError } from './base';

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
  /** Remaining lease measured by the database at claim time. */
  lease_remaining_ms: number;
  delivery: TeamsMessageDelivery;
}

const MAX_TEAMS_RETRY_DELAY_MS = 5 * 60_000;

export class TeamsMessageDeliveryClaimLostError extends Error {
  constructor(deliveryId: string) {
    super(`Teams message delivery claim was lost: ${deliveryId}`);
    this.name = 'TeamsMessageDeliveryClaimLostError';
  }
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
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
  }
  return message.content_preview ?? '';
}

function isRoutable(message: Message): boolean {
  return message.role === 'assistant' && messageText(message).trim().length > 0;
}

export function extractTeamsDeliveryText(message: Message): string {
  return messageText(message);
}

function asIso(value: Date | string | number): string {
  return new Date(value).toISOString();
}

function rowToDelivery(row: TeamsMessageDeliveryRow): TeamsMessageDelivery {
  return {
    delivery_id: row.delivery_id as TeamsMessageDeliveryID,
    message_id: row.message_id as MessageID,
    gateway_channel_id: row.gateway_channel_id as GatewayChannelID,
    thread_session_map_id: row.thread_session_map_id as ThreadSessionMapID,
    provider_installation_id: row.provider_installation_id,
    provider_config_generation: row.provider_config_generation,
    status: row.status as TeamsMessageDeliveryStatus,
    attempt_count: row.attempt_count,
    next_attempt_at: asIso(row.next_attempt_at),
    claim_token: row.claim_token,
    claim_expires_at: row.claim_expires_at ? asIso(row.claim_expires_at) : null,
    claim_generation: row.claim_generation,
    effect_started_at: row.effect_started_at ? asIso(row.effect_started_at) : null,
    last_error_code: row.last_error_code ?? null,
    provider_message_id: row.provider_message_id ?? null,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
    completed_at: row.completed_at ? asIso(row.completed_at) : null,
    canceled_at: row.canceled_at ? asIso(row.canceled_at) : null,
    dead_lettered_at: row.dead_lettered_at ? asIso(row.dead_lettered_at) : null,
  };
}

function tenantFor(db: Database): TenantID | undefined {
  if (isSQLiteDatabase(db)) return undefined;
  const tenantId = getCurrentTenantId();
  if (!tenantId)
    throw new RepositoryError('Teams message delivery requires explicit tenant identity');
  return tenantId as TenantID;
}

function laneIsOldest(db: Database) {
  const tenantPredicate = isSQLiteDatabase(db)
    ? sql``
    : sql` AND predecessor."tenant_id" = "teams_message_deliveries"."tenant_id"`;
  return sql`NOT EXISTS (
    SELECT 1 FROM "teams_message_deliveries" AS predecessor
    WHERE predecessor."thread_session_map_id" = ${teamsMessageDeliveries.thread_session_map_id}
      ${tenantPredicate}
      AND predecessor."status" IN ('pending', 'processing')
      AND (predecessor."created_at" < ${teamsMessageDeliveries.created_at}
        OR (predecessor."created_at" = ${teamsMessageDeliveries.created_at}
          AND predecessor."delivery_id" < ${teamsMessageDeliveries.delivery_id}))
  )`;
}

export class TeamsMessageDeliveryRepository {
  constructor(private readonly db: Database) {}

  /** Called by the message transaction; insertion is the outbound HA source of truth. */
  async enqueueForMessageInTransaction(
    tx: Database,
    message: Message
  ): Promise<TeamsMessageDelivery | null> {
    if (!isRoutable(message)) return null;
    const candidates = await select(tx, {
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
          eq(gatewayChannels.channel_type, 'teams'),
          sql`${gatewayChannels.provider_installation_id} IS NOT NULL`
        )
      )
      .orderBy(asc(threadSessionMap.created_at), asc(threadSessionMap.id))
      .limit(2)
      .all();
    const candidate = (
      candidates as Array<{
        mapping_id: string;
        mapping_metadata: unknown;
        channel_id: string;
        provider_installation_id: string | null;
        provider_config_generation: number;
      }>
    ).find((row) => {
      const metadata = (row.mapping_metadata as Record<string, unknown> | null) ?? {};
      return typeof metadata.outbound_seed_id !== 'string';
    });
    if (!candidate || typeof candidate.provider_installation_id !== 'string') return null;
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
      effect_started_at: null,
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
      .where(eq(teamsMessageDeliveries.delivery_id, insertData.delivery_id))
      .one();
    if (!row) {
      const existing = await select(tx)
        .from(teamsMessageDeliveries)
        .where(
          and(
            eq(teamsMessageDeliveries.message_id, message.message_id),
            eq(teamsMessageDeliveries.thread_session_map_id, candidate.mapping_id)
          )
        )
        .one();
      if (!existing) throw new RepositoryError('Failed to retrieve Teams delivery intent');
      return rowToDelivery(existing);
    }
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
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RepositoryError('Teams delivery discovery limit must be between 1 and 1000');
    }
    const now = databaseNowExpression(db, options.now);
    const due = and(
      lte(teamsMessageDeliveries.next_attempt_at, now),
      or(
        eq(teamsMessageDeliveries.status, 'pending'),
        and(
          eq(teamsMessageDeliveries.status, 'processing'),
          or(
            isNull(teamsMessageDeliveries.claim_expires_at),
            lte(teamsMessageDeliveries.claim_expires_at, now)
          )
        )
      ),
      laneIsOldest(db)
    );
    if (isSQLiteDatabase(db)) {
      const rows = await select(db, {
        delivery_id: teamsMessageDeliveries.delivery_id,
        thread_session_map_id: teamsMessageDeliveries.thread_session_map_id,
      })
        .from(teamsMessageDeliveries)
        .where(due)
        .orderBy(
          asc(teamsMessageDeliveries.next_attempt_at),
          asc(teamsMessageDeliveries.delivery_id)
        )
        .limit(limit)
        .all();
      return (rows as Array<{ delivery_id: string; thread_session_map_id: string }>).map((row) => ({
        tenant_id: 'default',
        delivery_id: row.delivery_id as TeamsMessageDeliveryID,
        thread_session_map_id: row.thread_session_map_id as ThreadSessionMapID,
      }));
    }
    const rows = await select(db, {
      // Keep this projection qualified as well: system-scope joins and RLS
      // policies may expose more than one tenant_id column to PostgreSQL.
      tenant_id: sql<string>`${
        (teamsMessageDeliveries as unknown as { tenant_id: unknown }).tenant_id
      }`,
      delivery_id: teamsMessageDeliveries.delivery_id,
      thread_session_map_id: teamsMessageDeliveries.thread_session_map_id,
    })
      .from(teamsMessageDeliveries)
      .where(due)
      .orderBy(asc(teamsMessageDeliveries.next_attempt_at), asc(teamsMessageDeliveries.delivery_id))
      .limit(limit)
      .all();
    return (
      rows as Array<{ tenant_id: string; delivery_id: string; thread_session_map_id: string }>
    ).map((row) => ({
      tenant_id: row.tenant_id,
      delivery_id: row.delivery_id as TeamsMessageDeliveryID,
      thread_session_map_id: row.thread_session_map_id as ThreadSessionMapID,
    }));
  }

  async claim(
    deliveryId: TeamsMessageDeliveryID,
    claimToken: string,
    leaseDurationMs: number,
    now?: Date
  ): Promise<TeamsMessageDeliveryClaim | null> {
    if (!claimToken.trim() || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new RepositoryError('Valid Teams delivery claim and lease are required');
    }
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockRowForUpdate(
          tx,
          this.db,
          teamsMessageDeliveries,
          eq(teamsMessageDeliveries.delivery_id, deliveryId)
        );
        const row = await select(tx)
          .from(teamsMessageDeliveries)
          .where(eq(teamsMessageDeliveries.delivery_id, deliveryId))
          .one();
        if (!row) return null;
        const dbNow = await getDatabaseNow(
          tx,
          teamsMessageDeliveries,
          eq(teamsMessageDeliveries.delivery_id, deliveryId),
          now
        );
        if (!dbNow) throw new RepositoryError('Unable to obtain database time for Teams claim');
        if (
          row.status === 'processing' &&
          row.effect_started_at &&
          row.claim_expires_at &&
          new Date(row.claim_expires_at) <= dbNow
        ) {
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
          return null;
        }
        const claimable =
          row.next_attempt_at <= dbNow &&
          (row.status === 'pending' ||
            (row.status === 'processing' &&
              (!row.claim_expires_at || new Date(row.claim_expires_at) <= dbNow)));
        if (!claimable) return null;
        const oldest = await select(tx, { delivery_id: teamsMessageDeliveries.delivery_id })
          .from(teamsMessageDeliveries)
          .where(and(eq(teamsMessageDeliveries.delivery_id, deliveryId), laneIsOldest(this.db)))
          .one();
        if (!oldest) return null;
        const lease = new Date(dbNow.getTime() + leaseDurationMs);
        const updated = await update(tx, teamsMessageDeliveries)
          .set({
            status: 'processing',
            claim_token: claimToken,
            claim_expires_at: lease,
            claim_generation: row.claim_generation + 1,
            attempt_count: row.attempt_count + 1,
            updated_at: dbNow,
          })
          .where(eq(teamsMessageDeliveries.delivery_id, deliveryId))
          .returning()
          .one();
        const delivery = rowToDelivery(updated);
        return {
          delivery_id: delivery.delivery_id,
          claim_token: claimToken,
          claim_generation: delivery.claim_generation,
          lease_expires_at: asIso(lease),
          lease_remaining_ms: leaseDurationMs,
          delivery,
        };
      },
      { sqliteImmediate: true }
    );
  }

  private claimWhere(
    input: { deliveryId: string; claimToken: string; claimGeneration: number },
    now: Date
  ) {
    return and(
      eq(teamsMessageDeliveries.delivery_id, input.deliveryId),
      eq(teamsMessageDeliveries.status, 'processing'),
      eq(teamsMessageDeliveries.claim_token, input.claimToken),
      eq(teamsMessageDeliveries.claim_generation, input.claimGeneration),
      sql`${teamsMessageDeliveries.claim_expires_at} > ${databaseNowExpression(this.db, now)}`
    );
  }

  async markEffectStarted(input: {
    deliveryId: TeamsMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    now?: Date;
  }): Promise<TeamsMessageDelivery> {
    return runDatabaseTransaction(this.db, async (tx) => {
      await lockRowForUpdate(
        tx,
        this.db,
        teamsMessageDeliveries,
        eq(teamsMessageDeliveries.delivery_id, input.deliveryId)
      );
      const row = await select(tx)
        .from(teamsMessageDeliveries)
        .where(eq(teamsMessageDeliveries.delivery_id, input.deliveryId))
        .one();
      const now = row
        ? await getDatabaseNow(
            tx,
            teamsMessageDeliveries,
            eq(teamsMessageDeliveries.delivery_id, input.deliveryId),
            input.now
          )
        : null;
      if (!row || !now || !this.isCurrent(row, input, now))
        throw new TeamsMessageDeliveryClaimLostError(input.deliveryId);
      const updated = await update(tx, teamsMessageDeliveries)
        .set({ effect_started_at: row.effect_started_at ?? now, updated_at: now })
        .where(this.claimWhere(input, now))
        .returning()
        .one();
      return rowToDelivery(updated);
    });
  }

  async complete(input: {
    deliveryId: TeamsMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    providerMessageId?: string | null;
    now?: Date;
  }): Promise<TeamsMessageDelivery> {
    return runDatabaseTransaction(this.db, async (tx) => {
      await lockRowForUpdate(
        tx,
        this.db,
        teamsMessageDeliveries,
        eq(teamsMessageDeliveries.delivery_id, input.deliveryId)
      );
      const row = await select(tx)
        .from(teamsMessageDeliveries)
        .where(eq(teamsMessageDeliveries.delivery_id, input.deliveryId))
        .one();
      const now = row
        ? await getDatabaseNow(
            tx,
            teamsMessageDeliveries,
            eq(teamsMessageDeliveries.delivery_id, input.deliveryId),
            input.now
          )
        : null;
      if (!row || !now || !this.isCurrent(row, input, now))
        throw new TeamsMessageDeliveryClaimLostError(input.deliveryId);
      const updated = await update(tx, teamsMessageDeliveries)
        .set({
          status: 'completed',
          claim_token: null,
          claim_expires_at: null,
          effect_started_at: null,
          provider_message_id: input.providerMessageId ?? null,
          completed_at: now,
          updated_at: now,
        })
        .where(this.claimWhere(input, now))
        .returning()
        .one();
      return rowToDelivery(updated);
    });
  }

  async fail(input: {
    deliveryId: TeamsMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    status: 'pending' | 'canceled' | 'dead_letter';
    errorCode: string;
    /** Bounded delay added to the transaction's database timestamp. */
    retryDelayMs?: number;
    /** Deterministic SQLite test clock; PostgreSQL always uses database time. */
    now?: Date;
  }): Promise<TeamsMessageDelivery> {
    if (
      input.retryDelayMs !== undefined &&
      (!Number.isSafeInteger(input.retryDelayMs) ||
        input.retryDelayMs < 0 ||
        input.retryDelayMs > MAX_TEAMS_RETRY_DELAY_MS)
    ) {
      throw new RepositoryError('Teams retry delay must be between 0 and 5 minutes');
    }
    return runDatabaseTransaction(this.db, async (tx) => {
      await lockRowForUpdate(
        tx,
        this.db,
        teamsMessageDeliveries,
        eq(teamsMessageDeliveries.delivery_id, input.deliveryId)
      );
      const row = await select(tx)
        .from(teamsMessageDeliveries)
        .where(eq(teamsMessageDeliveries.delivery_id, input.deliveryId))
        .one();
      const now = row
        ? await getDatabaseNow(
            tx,
            teamsMessageDeliveries,
            eq(teamsMessageDeliveries.delivery_id, input.deliveryId),
            input.now
          )
        : null;
      if (!row || !now || !this.isCurrent(row, input, now))
        throw new TeamsMessageDeliveryClaimLostError(input.deliveryId);
      const updated = await update(tx, teamsMessageDeliveries)
        .set({
          status: input.status,
          claim_token: null,
          claim_expires_at: null,
          effect_started_at: null,
          last_error_code: input.errorCode,
          next_attempt_at:
            input.retryDelayMs === undefined ? now : new Date(now.getTime() + input.retryDelayMs),
          canceled_at: input.status === 'canceled' ? now : null,
          dead_lettered_at: input.status === 'dead_letter' ? now : null,
          updated_at: now,
        })
        .where(this.claimWhere(input, now))
        .returning()
        .one();
      return rowToDelivery(updated);
    });
  }

  async markAmbiguous(input: {
    deliveryId: TeamsMessageDeliveryID;
    claimToken: string;
    claimGeneration: number;
    errorCode?: string;
    now?: Date;
  }): Promise<TeamsMessageDelivery> {
    return runDatabaseTransaction(this.db, async (tx) => {
      await lockRowForUpdate(
        tx,
        this.db,
        teamsMessageDeliveries,
        eq(teamsMessageDeliveries.delivery_id, input.deliveryId)
      );
      const row = await select(tx)
        .from(teamsMessageDeliveries)
        .where(eq(teamsMessageDeliveries.delivery_id, input.deliveryId))
        .one();
      const now = row
        ? await getDatabaseNow(
            tx,
            teamsMessageDeliveries,
            eq(teamsMessageDeliveries.delivery_id, input.deliveryId),
            input.now
          )
        : null;
      if (!row || !now || !this.isCurrent(row, input, now))
        throw new TeamsMessageDeliveryClaimLostError(input.deliveryId);
      const updated = await update(tx, teamsMessageDeliveries)
        .set({
          status: 'ambiguous',
          claim_token: null,
          claim_expires_at: null,
          last_error_code: input.errorCode ?? 'provider_effect_unknown',
          updated_at: now,
        })
        .where(this.claimWhere(input, now))
        .returning()
        .one();
      return rowToDelivery(updated);
    });
  }

  private isCurrent(
    row: TeamsMessageDeliveryRow,
    input: { claimToken: string; claimGeneration: number },
    now: Date
  ): boolean {
    return (
      row.status === 'processing' &&
      row.claim_token === input.claimToken &&
      row.claim_generation === input.claimGeneration &&
      !!row.claim_expires_at &&
      new Date(row.claim_expires_at) > now
    );
  }
}
