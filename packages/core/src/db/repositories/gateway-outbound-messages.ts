/**
 * Gateway Outbound Message Repository
 *
 * Durable audit/seed rows for proactive gateway outbound messages.
 */

import type {
  ChannelType,
  GatewayChannelID,
  GatewayOutboundMessage,
  GatewayOutboundMessageID,
  SessionID,
} from '@agor/core/types';
import { prefixToLikePattern } from '@agor/core/types';
import { and, eq, isNull, like } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { insert, select, update } from '../database-wrapper';
import {
  type GatewayOutboundMessageInsert,
  type GatewayOutboundMessageRow,
  gatewayOutboundMessages,
} from '../schema';
import { AmbiguousIdError, EntityNotFoundError, RepositoryError } from './base';

export class GatewayOutboundMessageRepository {
  constructor(private db: Database) {}

  private rowToMessage(row: GatewayOutboundMessageRow): GatewayOutboundMessage {
    return {
      id: row.id as GatewayOutboundMessageID,
      gateway_channel_id: row.gateway_channel_id as GatewayChannelID,
      channel_type: row.channel_type as ChannelType,
      platform_channel_id: row.platform_channel_id,
      platform_message_id: row.platform_message_id,
      platform_thread_id: row.platform_thread_id,
      platform_permalink: row.platform_permalink ?? null,
      target_branch_id: row.target_branch_id as GatewayOutboundMessage['target_branch_id'],
      emitted_by_user_id: row.emitted_by_user_id as GatewayOutboundMessage['emitted_by_user_id'],
      emitted_by_session_id: (row.emitted_by_session_id as SessionID | null) ?? null,
      emitted_by_task_id:
        (row.emitted_by_task_id as GatewayOutboundMessage['emitted_by_task_id']) ?? null,
      emitted_by_schedule_id:
        (row.emitted_by_schedule_id as GatewayOutboundMessage['emitted_by_schedule_id']) ?? null,
      message_text: row.message_text,
      message_preview: row.message_preview,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      consumed_by_session_id: (row.consumed_by_session_id as SessionID | null) ?? null,
      consumed_at: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }

  private toInsert(data: Partial<GatewayOutboundMessage>): GatewayOutboundMessageInsert {
    const now = Date.now();
    return {
      id: data.id ?? generateId(),
      created_at: new Date(data.created_at ?? now),
      updated_at: new Date(data.updated_at ?? now),
      gateway_channel_id: data.gateway_channel_id ?? '',
      channel_type: data.channel_type ?? 'slack',
      platform_channel_id: data.platform_channel_id ?? '',
      platform_message_id: data.platform_message_id ?? '',
      platform_thread_id: data.platform_thread_id ?? '',
      platform_permalink: data.platform_permalink ?? null,
      target_branch_id: data.target_branch_id ?? '',
      emitted_by_user_id: data.emitted_by_user_id ?? '',
      emitted_by_session_id: data.emitted_by_session_id ?? null,
      emitted_by_task_id: data.emitted_by_task_id ?? null,
      emitted_by_schedule_id: data.emitted_by_schedule_id ?? null,
      message_text: data.message_text ?? '',
      message_preview: data.message_preview ?? '',
      metadata: data.metadata ?? null,
      consumed_by_session_id: data.consumed_by_session_id ?? null,
      consumed_at: data.consumed_at ? new Date(data.consumed_at) : null,
    };
  }

  private async resolveId(id: string): Promise<string> {
    if (id.length === 36 && id.includes('-')) return id;
    const rows = await select(this.db)
      .from(gatewayOutboundMessages)
      .where(like(gatewayOutboundMessages.id, prefixToLikePattern(id)))
      .all();
    if (rows.length === 0) throw new EntityNotFoundError('GatewayOutboundMessage', id);
    if (rows.length > 1) {
      throw new AmbiguousIdError(
        'GatewayOutboundMessage',
        id,
        rows.map((row: { id: string }) => row.id)
      );
    }
    return rows[0].id;
  }

  async create(data: Partial<GatewayOutboundMessage>): Promise<GatewayOutboundMessage> {
    try {
      const insertData = this.toInsert({ ...data, id: data.id ?? generateId() });
      await insert(this.db, gatewayOutboundMessages).values(insertData).run();
      const row = await select(this.db)
        .from(gatewayOutboundMessages)
        .where(eq(gatewayOutboundMessages.id, insertData.id))
        .one();
      if (!row) throw new RepositoryError('Failed to retrieve created gateway outbound message');
      return this.rowToMessage(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create gateway outbound message: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findById(id: string): Promise<GatewayOutboundMessage | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(gatewayOutboundMessages)
        .where(eq(gatewayOutboundMessages.id, fullId))
        .one();
      return row ? this.rowToMessage(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find gateway outbound message: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findUnconsumedByChannelAndThread(
    gatewayChannelId: string,
    platformThreadId: string
  ): Promise<GatewayOutboundMessage | null> {
    try {
      const row = await select(this.db)
        .from(gatewayOutboundMessages)
        .where(
          and(
            eq(gatewayOutboundMessages.gateway_channel_id, gatewayChannelId),
            eq(gatewayOutboundMessages.platform_thread_id, platformThreadId),
            isNull(gatewayOutboundMessages.consumed_at)
          )
        )
        .one();
      return row ? this.rowToMessage(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find gateway outbound seed: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async markConsumed(
    id: GatewayOutboundMessageID,
    sessionId: SessionID
  ): Promise<GatewayOutboundMessage> {
    try {
      const fullId = await this.resolveId(id);
      await update(this.db, gatewayOutboundMessages)
        .set({
          consumed_by_session_id: sessionId,
          consumed_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(gatewayOutboundMessages.id, fullId))
        .run();
      const updated = await this.findById(fullId);
      if (!updated) throw new RepositoryError('Failed to retrieve consumed gateway outbound seed');
      return updated;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to mark gateway outbound seed consumed: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
