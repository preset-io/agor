/**
 * Durable idempotency and processing fences for provider-delivered gateway
 * events. The gateway domain owns the state machine; this repository only
 * performs its short atomic transitions.
 */

import type {
  GatewayChannelID,
  GatewayInboundEvent,
  GatewayInboundEventID,
  SessionID,
  TaskID,
} from '@agor/core/types';
import { and, eq, inArray, lte, type SQL, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
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
import { decryptApiKey, encryptApiKey } from '../encryption';
import { type GatewayInboundEventRow, gatewayChannels, gatewayInboundEvents } from '../schema';
import { RepositoryError } from './base';
import {
  type TeamsConversationAddressInput,
  TeamsConversationAddressRepository,
} from './teams-conversation-addresses';

export interface TeamsGatewayIngressDiscoveryRef {
  tenant_id: string;
  gateway_channel_id: GatewayChannelID;
  event_id: GatewayInboundEventID;
}

export interface TeamsVerifiedHttpAdmissionInput {
  channelId: GatewayChannelID;
  providerEventId: string;
  threadId: string;
  payload: Record<string, unknown>;
  deliveryMetadata?: Record<string, unknown> | null;
  address: TeamsConversationAddressInput;
  providerConfigGeneration: number;
  verifiedAppId: string;
  verifiedTenantId: string;
  payloadTtlMs?: number;
}

export type TeamsVerifiedHttpAdmissionResult =
  | { outcome: 'admitted'; event: GatewayInboundEvent }
  | { outcome: 'duplicate'; event: GatewayInboundEvent };

export interface GatewayInboundEventClaimInput {
  channelId: GatewayChannelID;
  providerEventId: string;
  threadId: string;
  processingToken: string;
  leaseDurationMs: number;
  /** Require the processing token to be the channel's live listener token. */
  requireListenerClaim: boolean;
}

const MAX_TEAMS_RETRY_DELAY_MS = 5 * 60_000;

export type GatewayInboundEventClaimResult =
  | { outcome: 'claimed'; event: GatewayInboundEvent }
  | { outcome: 'completed_duplicate'; event: GatewayInboundEvent }
  | { outcome: 'in_progress_elsewhere'; event: GatewayInboundEvent }
  | { outcome: 'listener_lost' };

/**
 * The process-local worker tail is only an optimization. This predicate is
 * the actual HA lane fence: a later occurrence cannot be claimed while an
 * earlier pending/processing occurrence for the same tenant/channel/thread
 * remains non-terminal.
 */
function teamsInboundLaneIsOldest(db: Database) {
  const tenantPredicate = isSQLiteDatabase(db)
    ? sql``
    : sql` AND predecessor."tenant_id" = "gateway_inbound_events"."tenant_id"`;
  return sql`NOT EXISTS (
    SELECT 1 FROM "gateway_inbound_events" AS predecessor
    WHERE predecessor."gateway_channel_id" = ${gatewayInboundEvents.gateway_channel_id}
      AND predecessor."thread_id" = ${gatewayInboundEvents.thread_id}
      ${tenantPredicate}
      AND predecessor."status" IN ('pending', 'processing')
      AND (predecessor."received_at" < ${gatewayInboundEvents.received_at}
        OR (predecessor."received_at" = ${gatewayInboundEvents.received_at}
          AND predecessor."id" < ${gatewayInboundEvents.id}))
  )`;
}

function safeTeamsDeliveryMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!metadata) return null;
  const safe: Record<string, unknown> = {};
  for (const key of [
    'teams_conversation_type',
    'teams_channel_type',
    'teams_channel_name',
    'teams_team_name',
    'teams_user_name',
    'teams_has_mention',
    'requires_mapping_verification',
  ]) {
    const value = metadata[key];
    if (typeof value === 'string' || typeof value === 'boolean') safe[key] = value;
  }
  return safe;
}

async function terminalizeExpiredTeamsPayloads(db: Database, now: Date | SQL): Promise<void> {
  await update(db, gatewayInboundEvents)
    .set({
      status: 'dead_letter',
      processing_expires_at: now,
      next_attempt_at: now,
      last_error_code: 'payload_expired',
      payload_encrypted: null,
      payload_expires_at: null,
    })
    .where(
      and(
        inArray(gatewayInboundEvents.status, ['pending', 'processing']),
        lte(gatewayInboundEvents.payload_expires_at, now)
      )
    )
    .run();
}

function rowToEvent(row: GatewayInboundEventRow): GatewayInboundEvent {
  return {
    id: row.id as GatewayInboundEventID,
    gateway_channel_id: row.gateway_channel_id as GatewayChannelID,
    provider_event_id: row.provider_event_id,
    thread_id: row.thread_id,
    delivery_metadata:
      row.delivery_metadata && typeof row.delivery_metadata === 'object'
        ? (row.delivery_metadata as Record<string, unknown>)
        : null,
    status: row.status,
    processing_token: row.processing_token,
    processing_expires_at: new Date(row.processing_expires_at).toISOString(),
    payload_encrypted: row.payload_encrypted ?? null,
    payload_expires_at: row.payload_expires_at
      ? new Date(row.payload_expires_at).toISOString()
      : null,
    provider_config_generation: row.provider_config_generation,
    verified_app_id: row.verified_app_id ?? null,
    verified_tenant_id: row.verified_tenant_id ?? null,
    attempt_count: row.attempt_count,
    next_attempt_at: new Date(row.next_attempt_at).toISOString(),
    last_error_code: row.last_error_code ?? null,
    session_id: row.session_id as SessionID | null,
    task_id: row.task_id as TaskID | null,
    received_at: new Date(row.received_at).toISOString(),
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

export class GatewayInboundEventRepository {
  constructor(private db: Database) {}

  private validateClaim(input: GatewayInboundEventClaimInput): void {
    if (!input.providerEventId.trim()) throw new RepositoryError('Provider event ID required');
    if (!input.threadId.trim()) throw new RepositoryError('Gateway event thread ID required');
    if (!input.processingToken.trim()) {
      throw new RepositoryError('Gateway event processing token required');
    }
    if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new RepositoryError('Gateway event processing lease must be positive');
    }
  }

  private async transactionNow(txDb: Database, channelId: GatewayChannelID) {
    return getDatabaseNow(txDb, gatewayChannels, eq(gatewayChannels.id, channelId));
  }

  /**
   * Admit or reclaim one provider occurrence. A completed occurrence is always
   * a duplicate; a processing occurrence can be reclaimed only after its
   * processing lease expires. When required, listener validity is checked
   * under the same channel row lock as admission.
   */
  async claim(input: GatewayInboundEventClaimInput): Promise<GatewayInboundEventClaimResult> {
    this.validateClaim(input);
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(
          txDb,
          this.db,
          gatewayChannels,
          eq(gatewayChannels.id, input.channelId)
        );
        const channel = await select(txDb)
          .from(gatewayChannels)
          .where(eq(gatewayChannels.id, input.channelId))
          .one();
        const now = await this.transactionNow(txDb, input.channelId);
        if (!channel || !now || !channel.enabled) return { outcome: 'listener_lost' };
        if (
          input.requireListenerClaim &&
          (channel.listener_claim_token !== input.processingToken ||
            !channel.listener_lease_expires_at ||
            new Date(channel.listener_lease_expires_at).getTime() <= now.getTime())
        ) {
          return { outcome: 'listener_lost' };
        }

        const expiresAt = new Date(now.getTime() + input.leaseDurationMs);
        const eventId = generateId() as GatewayInboundEventID;
        await insert(txDb, gatewayInboundEvents)
          .values({
            id: eventId,
            gateway_channel_id: input.channelId,
            provider_event_id: input.providerEventId,
            thread_id: input.threadId,
            status: 'processing',
            processing_token: input.processingToken,
            processing_expires_at: expiresAt,
            next_attempt_at: expiresAt,
            received_at: now,
          })
          .onConflictDoNothing()
          .run();

        await lockRowForUpdate(
          txDb,
          this.db,
          gatewayInboundEvents,
          and(
            eq(gatewayInboundEvents.gateway_channel_id, input.channelId),
            eq(gatewayInboundEvents.provider_event_id, input.providerEventId)
          )!
        );
        const row = await select(txDb)
          .from(gatewayInboundEvents)
          .where(
            and(
              eq(gatewayInboundEvents.gateway_channel_id, input.channelId),
              eq(gatewayInboundEvents.provider_event_id, input.providerEventId)
            )
          )
          .one();
        if (!row) throw new RepositoryError('Failed to retrieve gateway inbound event');
        if (row.id === eventId) return { outcome: 'claimed', event: rowToEvent(row) };
        if (row.thread_id !== input.threadId) {
          throw new RepositoryError(
            'Provider event identity was reused for a different gateway thread'
          );
        }
        if (row.status === 'completed') {
          return { outcome: 'completed_duplicate', event: rowToEvent(row) };
        }

        // A provider retry delivered back to the same live owner is recovery
        // of its own interrupted callback, not a competing claim. Refresh the
        // short processing lease and reconcile the stable Session/Task IDs.
        if (row.processing_token === input.processingToken) {
          const retried = await update(txDb, gatewayInboundEvents)
            .set({ processing_expires_at: expiresAt })
            .where(eq(gatewayInboundEvents.id, row.id))
            .returning()
            .one();
          return { outcome: 'claimed', event: rowToEvent(retried) };
        }
        if (new Date(row.processing_expires_at).getTime() > now.getTime()) {
          return { outcome: 'in_progress_elsewhere', event: rowToEvent(row) };
        }

        const reclaimed = await update(txDb, gatewayInboundEvents)
          .set({
            status: 'processing',
            processing_token: input.processingToken,
            processing_expires_at: expiresAt,
          })
          .where(eq(gatewayInboundEvents.id, row.id))
          .returning()
          .one();
        return { outcome: 'claimed', event: rowToEvent(reclaimed) };
      },
      { sqliteImmediate: true }
    );
  }

  /**
   * The Teams HTTP boundary uses this transaction as its acknowledgement
   * fence: normalized, already-authenticated data and its refreshed address
   * are committed before the route may return 200.
   */
  async admitVerifiedHttp(
    input: TeamsVerifiedHttpAdmissionInput
  ): Promise<TeamsVerifiedHttpAdmissionResult> {
    if (!input.providerEventId.trim() || !input.threadId.trim()) {
      throw new RepositoryError('Teams provider event and thread IDs are required');
    }
    if (
      !Number.isSafeInteger(input.providerConfigGeneration) ||
      input.providerConfigGeneration < 1
    ) {
      throw new RepositoryError('Teams provider configuration generation is invalid');
    }
    if (
      input.address.gatewayChannelId !== input.channelId ||
      input.address.threadId !== input.threadId ||
      input.address.verifiedAppId !== input.verifiedAppId ||
      input.address.verifiedTenantId !== input.verifiedTenantId ||
      input.address.providerConfigGeneration !== input.providerConfigGeneration
    ) {
      throw new RepositoryError('Teams admission address identity does not match the activity');
    }
    const payloadTtlMs = input.payloadTtlMs ?? 24 * 60 * 60 * 1000;
    if (
      !Number.isSafeInteger(payloadTtlMs) ||
      payloadTtlMs < 1 ||
      payloadTtlMs > 7 * 24 * 60 * 60 * 1000
    ) {
      throw new RepositoryError('Teams queued payload retention is invalid');
    }
    const addressRepository = new TeamsConversationAddressRepository(this.db);
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(
          txDb,
          this.db,
          gatewayChannels,
          eq(gatewayChannels.id, input.channelId)
        );
        const channel = await select(txDb)
          .from(gatewayChannels)
          .where(eq(gatewayChannels.id, input.channelId))
          .one();
        if (!channel?.enabled || channel.channel_type !== 'teams') {
          throw new RepositoryError('Teams gateway channel is disabled or unavailable');
        }
        if (
          channel.provider_config_generation !== input.providerConfigGeneration ||
          channel.provider_installation_id !== input.verifiedAppId
        ) {
          throw new RepositoryError('Teams gateway provider authority changed during admission');
        }
        const now = await this.transactionNow(txDb, input.channelId);
        if (!now) throw new RepositoryError('Unable to obtain database time for Teams admission');
        const expiresAt = new Date(now.getTime() + payloadTtlMs);
        const eventId = generateId() as GatewayInboundEventID;
        await insert(txDb, gatewayInboundEvents)
          .values({
            id: eventId,
            gateway_channel_id: input.channelId,
            provider_event_id: input.providerEventId,
            thread_id: input.threadId,
            delivery_metadata: safeTeamsDeliveryMetadata(input.deliveryMetadata),
            status: 'pending',
            processing_token: generateId(),
            processing_expires_at: now,
            payload_encrypted: encryptApiKey(JSON.stringify(input.payload)),
            payload_expires_at: expiresAt,
            provider_config_generation: input.providerConfigGeneration,
            verified_app_id: input.verifiedAppId,
            verified_tenant_id: input.verifiedTenantId,
            attempt_count: 0,
            next_attempt_at: now,
            last_error_code: null,
            received_at: now,
          })
          .onConflictDoNothing()
          .run();
        const row = await select(txDb)
          .from(gatewayInboundEvents)
          .where(
            and(
              eq(gatewayInboundEvents.gateway_channel_id, input.channelId),
              eq(gatewayInboundEvents.provider_event_id, input.providerEventId)
            )
          )
          .one();
        if (!row) throw new RepositoryError('Failed to retrieve Teams inbound event');
        if (row.thread_id !== input.threadId) {
          throw new RepositoryError('Teams activity identity was reused for a different thread');
        }
        if (
          row.provider_config_generation !== input.providerConfigGeneration ||
          row.verified_app_id !== input.verifiedAppId ||
          row.verified_tenant_id !== input.verifiedTenantId
        ) {
          throw new RepositoryError(
            'Teams activity identity was reused across provider generations'
          );
        }
        // Do not refresh the durable address until the provider occurrence has
        // passed every duplicate/thread/generation identity check. A rejected
        // retry must not leave any persisted Teams address behind.
        await addressRepository.upsertInTransaction(txDb, input.address);
        return {
          outcome: row.id === eventId ? 'admitted' : 'duplicate',
          event: rowToEvent(row),
        };
      },
      { sqliteImmediate: true }
    );
  }

  /** System-scope discovery returns routing IDs only; payload is decrypted in tenant scope. */
  async findDueTeamsRefs(
    db: Database,
    options: { limit?: number; now?: Date } = {}
  ): Promise<TeamsGatewayIngressDiscoveryRef[]> {
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RepositoryError('Teams ingress discovery limit must be between 1 and 1000');
    }
    const now = databaseNowExpression(db, options.now);
    const due = sql`${gatewayInboundEvents.status} IN ('pending', 'processing')
      AND ${gatewayInboundEvents.next_attempt_at} <= ${now}
      AND (${gatewayInboundEvents.status} = 'pending'
        OR ${gatewayInboundEvents.processing_expires_at} <= ${now})
      AND ${gatewayInboundEvents.payload_expires_at} IS NOT NULL`;
    const projection = {
      ...(isSQLiteDatabase(db)
        ? {}
        : {
            tenant_id: sql<string>`${
              (gatewayInboundEvents as unknown as { tenant_id: unknown }).tenant_id
            }`,
          }),
      gateway_channel_id: gatewayInboundEvents.gateway_channel_id,
      event_id: gatewayInboundEvents.id,
      next_attempt_at: gatewayInboundEvents.next_attempt_at,
    };
    const enabledRows = await select(db, projection)
      .from(gatewayInboundEvents)
      .innerJoin(gatewayChannels, eq(gatewayChannels.id, gatewayInboundEvents.gateway_channel_id))
      .where(
        and(
          due,
          teamsInboundLaneIsOldest(db),
          eq(gatewayChannels.channel_type, 'teams'),
          eq(gatewayChannels.enabled, true)
        )
      )
      .orderBy(gatewayInboundEvents.next_attempt_at, gatewayInboundEvents.id)
      .limit(limit)
      .all();

    // Expired encrypted payloads are the durable Teams envelope. Discover
    // them independently of gateway_channels because its system policy is
    // deliberately limited to enabled Teams rows; the owning tenant scope
    // performs the terminalizing update after this routing-only projection.
    const expiredRows = await select(db, projection)
      .from(gatewayInboundEvents)
      .where(
        and(
          due,
          lte(gatewayInboundEvents.payload_expires_at, now),
          sql`${gatewayInboundEvents.payload_encrypted} IS NOT NULL`,
          teamsInboundLaneIsOldest(db)
        )
      )
      .orderBy(gatewayInboundEvents.next_attempt_at, gatewayInboundEvents.id)
      .limit(limit)
      .all();

    type DiscoveryRow = {
      tenant_id?: unknown;
      gateway_channel_id: string;
      event_id: string;
      next_attempt_at: Date | string | number;
    };
    const uniqueRows = new Map<string, DiscoveryRow>();
    for (const row of [...enabledRows, ...expiredRows] as DiscoveryRow[]) {
      if (!uniqueRows.has(row.event_id)) uniqueRows.set(row.event_id, row);
    }
    return [...uniqueRows.values()]
      .sort((left, right) => {
        const byNextAttempt =
          new Date(left.next_attempt_at).getTime() - new Date(right.next_attempt_at).getTime();
        return byNextAttempt || left.event_id.localeCompare(right.event_id);
      })
      .slice(0, limit)
      .map((row) => ({
        tenant_id: isSQLiteDatabase(db)
          ? 'default'
          : String((row as { tenant_id: unknown }).tenant_id),
        gateway_channel_id: row.gateway_channel_id as GatewayChannelID,
        event_id: row.event_id as GatewayInboundEventID,
      }));
  }

  /** Claim a queued Teams occurrence, reclaiming only an expired worker lease. */
  async claimQueued(
    eventId: GatewayInboundEventID,
    processingToken: string,
    leaseDurationMs: number,
    now?: Date
  ): Promise<GatewayInboundEvent | null> {
    if (!processingToken.trim() || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new RepositoryError('Valid Teams queue claim and lease are required');
    }
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(
          txDb,
          this.db,
          gatewayInboundEvents,
          eq(gatewayInboundEvents.id, eventId)
        );
        const row = await select(txDb)
          .from(gatewayInboundEvents)
          .where(eq(gatewayInboundEvents.id, eventId))
          .one();
        if (!row) return null;
        const dbNow = await getDatabaseNow(
          txDb,
          gatewayInboundEvents,
          eq(gatewayInboundEvents.id, eventId),
          now
        );
        if (!dbNow) throw new RepositoryError('Unable to obtain database time for Teams claim');
        // Direct claim callers must not be able to leave an expired
        // predecessor in the lane forever just because discovery was skipped.
        await terminalizeExpiredTeamsPayloads(txDb, dbNow);
        if (
          row.payload_expires_at &&
          new Date(row.payload_expires_at).getTime() <= dbNow.getTime() &&
          (row.status === 'pending' || row.status === 'processing')
        ) {
          await update(txDb, gatewayInboundEvents)
            .set({
              status: 'dead_letter',
              processing_expires_at: dbNow,
              next_attempt_at: dbNow,
              last_error_code: 'payload_expired',
              payload_encrypted: null,
              payload_expires_at: null,
            })
            .where(eq(gatewayInboundEvents.id, eventId))
            .run();
          return null;
        }
        if (!row.payload_encrypted) return null;
        if (row.status === 'completed' || row.status === 'dead_letter') return null;
        if (row.status === 'processing' && row.processing_expires_at > dbNow) return null;
        if (row.status === 'pending' && row.next_attempt_at > dbNow) return null;
        const oldest = await select(txDb, { id: gatewayInboundEvents.id })
          .from(gatewayInboundEvents)
          .where(and(eq(gatewayInboundEvents.id, eventId), teamsInboundLaneIsOldest(this.db)))
          .one();
        if (!oldest) return null;
        const expiresAt = new Date(dbNow.getTime() + leaseDurationMs);
        const updated = await update(txDb, gatewayInboundEvents)
          .set({
            status: 'processing',
            processing_token: processingToken,
            processing_expires_at: expiresAt,
            attempt_count: row.attempt_count + 1,
          })
          .where(eq(gatewayInboundEvents.id, eventId))
          .returning()
          .one();
        return rowToEvent(updated);
      },
      { sqliteImmediate: true }
    );
  }

  decryptQueuedPayload(event: GatewayInboundEvent): Record<string, unknown> {
    if (!event.payload_encrypted) throw new RepositoryError('Teams queued payload is unavailable');
    try {
      const payload = JSON.parse(decryptApiKey(event.payload_encrypted)) as unknown;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('payload is not an object');
      return payload as Record<string, unknown>;
    } catch (error) {
      throw new RepositoryError('Failed to decrypt Teams queued payload', error);
    }
  }

  async failQueued(input: {
    eventId: GatewayInboundEventID;
    processingToken: string;
    status: 'pending' | 'dead_letter';
    errorCode: string;
    /** Bounded delay added to the transaction's database timestamp. */
    retryDelayMs?: number;
    /** Deterministic SQLite test clock; PostgreSQL always uses database time. */
    now?: Date;
  }): Promise<boolean> {
    if (
      input.retryDelayMs !== undefined &&
      (!Number.isSafeInteger(input.retryDelayMs) ||
        input.retryDelayMs < 0 ||
        input.retryDelayMs > MAX_TEAMS_RETRY_DELAY_MS)
    ) {
      throw new RepositoryError('Teams retry delay must be between 0 and 5 minutes');
    }
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(
          txDb,
          this.db,
          gatewayInboundEvents,
          eq(gatewayInboundEvents.id, input.eventId)
        );
        const row = await select(txDb)
          .from(gatewayInboundEvents)
          .where(eq(gatewayInboundEvents.id, input.eventId))
          .one();
        if (!row) return false;
        const dbNow = await getDatabaseNow(
          txDb,
          gatewayInboundEvents,
          eq(gatewayInboundEvents.id, input.eventId),
          input.now
        );
        if (!dbNow) throw new RepositoryError('Unable to obtain database time for Teams failure');
        const result = await update(txDb, gatewayInboundEvents)
          .set({
            status: input.status,
            processing_expires_at: dbNow,
            next_attempt_at:
              input.retryDelayMs === undefined
                ? dbNow
                : new Date(dbNow.getTime() + input.retryDelayMs),
            last_error_code: input.errorCode,
            ...(input.status === 'dead_letter'
              ? { payload_encrypted: null, payload_expires_at: null }
              : {}),
          })
          .where(
            and(
              eq(gatewayInboundEvents.id, input.eventId),
              eq(gatewayInboundEvents.status, 'processing'),
              eq(gatewayInboundEvents.processing_token, input.processingToken)
            )
          )
          .run();
        return result.rowsAffected > 0;
      },
      { sqliteImmediate: true }
    );
  }

  /**
   * Complete only while both the event token and (when required) the channel
   * listener token remain current. This is the stale-owner completion fence.
   */
  async complete(input: {
    eventId: GatewayInboundEventID;
    channelId: GatewayChannelID;
    processingToken: string;
    sessionId?: SessionID;
    taskId?: TaskID;
    requireListenerClaim: boolean;
  }): Promise<boolean> {
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(
          txDb,
          this.db,
          gatewayChannels,
          eq(gatewayChannels.id, input.channelId)
        );
        const channel = await select(txDb)
          .from(gatewayChannels)
          .where(eq(gatewayChannels.id, input.channelId))
          .one();
        const now = await this.transactionNow(txDb, input.channelId);
        if (!channel || !now || !channel.enabled) return false;
        if (
          input.requireListenerClaim &&
          (channel.listener_claim_token !== input.processingToken ||
            !channel.listener_lease_expires_at ||
            new Date(channel.listener_lease_expires_at).getTime() <= now.getTime())
        ) {
          return false;
        }
        const result = await update(txDb, gatewayInboundEvents)
          .set({
            status: 'completed',
            session_id: input.sessionId ?? null,
            task_id: input.taskId ?? null,
            completed_at: now,
            payload_encrypted: null,
            payload_expires_at: null,
          })
          .where(
            and(
              eq(gatewayInboundEvents.id, input.eventId),
              eq(gatewayInboundEvents.gateway_channel_id, input.channelId),
              eq(gatewayInboundEvents.status, 'processing'),
              eq(gatewayInboundEvents.processing_token, input.processingToken)
            )
          )
          .run();
        return result.rowsAffected > 0;
      },
      { sqliteImmediate: true }
    );
  }

  /**
   * Persist provider acknowledgement/reply coordinates while the occurrence
   * and listener token are still current. A replacement owner can then reuse
   * the same editable provider object instead of creating another one.
   */
  async recordDeliveryMetadata(input: {
    eventId: GatewayInboundEventID;
    channelId: GatewayChannelID;
    processingToken: string;
    metadata: Record<string, unknown>;
    requireListenerClaim: boolean;
  }): Promise<boolean> {
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(
          txDb,
          this.db,
          gatewayChannels,
          eq(gatewayChannels.id, input.channelId)
        );
        const channel = await select(txDb)
          .from(gatewayChannels)
          .where(eq(gatewayChannels.id, input.channelId))
          .one();
        const now = await this.transactionNow(txDb, input.channelId);
        if (!channel || !now || !channel.enabled) return false;
        if (
          input.requireListenerClaim &&
          (channel.listener_claim_token !== input.processingToken ||
            !channel.listener_lease_expires_at ||
            new Date(channel.listener_lease_expires_at).getTime() <= now.getTime())
        ) {
          return false;
        }
        const result = await update(txDb, gatewayInboundEvents)
          .set({ delivery_metadata: input.metadata })
          .where(
            and(
              eq(gatewayInboundEvents.id, input.eventId),
              eq(gatewayInboundEvents.gateway_channel_id, input.channelId),
              eq(gatewayInboundEvents.status, 'processing'),
              eq(gatewayInboundEvents.processing_token, input.processingToken)
            )
          )
          .run();
        return result.rowsAffected > 0;
      },
      { sqliteImmediate: true }
    );
  }

  async findByProviderEvent(
    channelId: GatewayChannelID,
    providerEventId: string
  ): Promise<GatewayInboundEvent | null> {
    const row = await select(this.db)
      .from(gatewayInboundEvents)
      .where(
        and(
          eq(gatewayInboundEvents.gateway_channel_id, channelId),
          eq(gatewayInboundEvents.provider_event_id, providerEventId)
        )
      )
      .one();
    return row ? rowToEvent(row) : null;
  }
}
