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
import { and, eq, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import {
  insert,
  isPostgresDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { type GatewayInboundEventRow, gatewayChannels, gatewayInboundEvents } from '../schema';
import { RepositoryError } from './base';

export interface GatewayInboundEventClaimInput {
  channelId: GatewayChannelID;
  providerEventId: string;
  threadId: string;
  processingToken: string;
  leaseDurationMs: number;
  /** Require the processing token to be the channel's live listener token. */
  requireListenerClaim: boolean;
}

export type GatewayInboundEventClaimResult =
  | { outcome: 'claimed'; event: GatewayInboundEvent }
  | { outcome: 'completed_duplicate'; event: GatewayInboundEvent }
  | { outcome: 'in_progress_elsewhere'; event: GatewayInboundEvent }
  | { outcome: 'listener_lost' };

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
    if (!isPostgresDatabase(this.db)) return new Date();
    const row = await select(txDb, { value: sql<Date>`CURRENT_TIMESTAMP` })
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, channelId))
      .one();
    return row?.value instanceof Date ? row.value : row?.value ? new Date(row.value) : null;
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

  async findById(eventId: GatewayInboundEventID): Promise<GatewayInboundEvent | null> {
    const row = await select(this.db)
      .from(gatewayInboundEvents)
      .where(eq(gatewayInboundEvents.id, eventId))
      .one();
    return row ? rowToEvent(row) : null;
  }
}
