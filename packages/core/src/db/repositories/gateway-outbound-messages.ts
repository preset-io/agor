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
  GatewayOutboundReplyAdmission,
  SessionID,
} from '@agor/core/types';
import { prefixToLikePattern } from '@agor/core/types';
import { and, eq, isNull, like, or, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import {
  insert,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  type GatewayOutboundMessageInsert,
  type GatewayOutboundMessageRow,
  gatewayOutboundMessages,
} from '../schema';
import { AmbiguousIdError, EntityNotFoundError, RepositoryError } from './base';

function isSqliteBusy(error: unknown): boolean {
  return (
    String(error).includes('SQLITE_BUSY') ||
    String(error).toLowerCase().includes('database is locked')
  );
}

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

  private async findReplySeedRow(
    db: Database,
    gatewayChannelId: string,
    platformThreadId: string
  ): Promise<GatewayOutboundMessageRow | null> {
    const aliasMatch = isSQLiteDatabase(db)
      ? sql`json_type(${gatewayOutboundMessages.metadata}, '$.provider_reply_aliases') = 'array'
          AND EXISTS (
            SELECT 1
            FROM json_each(${gatewayOutboundMessages.metadata}, '$.provider_reply_aliases') AS reply_alias
            WHERE reply_alias.value = ${platformThreadId}
          )`
      : sql`jsonb_typeof(${gatewayOutboundMessages.metadata}->'provider_reply_aliases') = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(${gatewayOutboundMessages.metadata}->'provider_reply_aliases') AS reply_alias(value)
            WHERE reply_alias.value = ${platformThreadId}
          )`;
    const rows = await select(db)
      .from(gatewayOutboundMessages)
      .where(
        and(
          eq(gatewayOutboundMessages.gateway_channel_id, gatewayChannelId),
          or(eq(gatewayOutboundMessages.platform_thread_id, platformThreadId), aliasMatch)
        )
      )
      .all();
    const matches = rows.filter((candidate: GatewayOutboundMessageRow) => {
      if (candidate.platform_thread_id === platformThreadId) return true;
      const metadata = (candidate.metadata as Record<string, unknown> | null) ?? {};
      const aliases = Array.isArray(metadata.provider_reply_aliases)
        ? metadata.provider_reply_aliases
        : [];
      return aliases.includes(platformThreadId);
    });
    if (matches.length > 1) {
      throw new RepositoryError(
        `Ambiguous gateway outbound reply seed for channel ${gatewayChannelId} and thread ${platformThreadId}`
      );
    }
    return matches[0] ?? null;
  }

  /** Reserve the stable session identity for a reply before any session exists. */
  async admitReplySession(
    gatewayChannelId: GatewayChannelID,
    platformThreadId: string
  ): Promise<GatewayOutboundReplyAdmission | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await runDatabaseTransaction(
          this.db,
          async (txDb) => {
            const candidate = await this.findReplySeedRow(txDb, gatewayChannelId, platformThreadId);
            if (!candidate) return null;
            await lockRowForUpdate(
              txDb,
              this.db,
              gatewayOutboundMessages,
              eq(gatewayOutboundMessages.id, candidate.id)
            );
            const row = await select(txDb)
              .from(gatewayOutboundMessages)
              .where(eq(gatewayOutboundMessages.id, candidate.id))
              .one();
            if (!row)
              throw new RepositoryError('Gateway outbound seed disappeared during admission');
            if (row.consumed_at) {
              if (!row.consumed_by_session_id) {
                throw new RepositoryError(
                  'Gateway outbound seed is consumed without a session identity'
                );
              }
              return {
                admitted: false,
                message: this.rowToMessage(row),
                sessionId: row.consumed_by_session_id as SessionID,
              };
            }
            const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
            if (Object.hasOwn(metadata, 'reply_session_admission_id')) {
              const reservedSessionId = metadata.reply_session_admission_id;
              if (typeof reservedSessionId !== 'string' || reservedSessionId.trim() === '') {
                throw new RepositoryError(
                  'Gateway outbound seed has an invalid session admission reservation'
                );
              }
              return {
                admitted: false,
                message: this.rowToMessage(row),
                sessionId: reservedSessionId as SessionID,
              };
            }
            const sessionId = generateId() as SessionID;
            const updated = await update(txDb, gatewayOutboundMessages)
              .set({
                metadata: { ...metadata, reply_session_admission_id: sessionId },
                updated_at: new Date(),
              })
              .where(eq(gatewayOutboundMessages.id, row.id))
              .returning()
              .one();
            return {
              admitted: true,
              message: this.rowToMessage(updated),
              sessionId,
            };
          },
          { sqliteImmediate: true }
        );
      } catch (error) {
        if (isSqliteBusy(error) && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
          continue;
        }
        if (error instanceof RepositoryError) throw error;
        throw new RepositoryError(
          `Failed to admit gateway outbound reply: ${error instanceof Error ? error.message : String(error)}`,
          error
        );
      }
    }
    throw new RepositoryError('Failed to admit gateway outbound reply after lock retries');
  }

  /** Complete a previously reserved admission after mapping persistence succeeds. */
  async completeReplyAdmission(
    id: GatewayOutboundMessageID,
    sessionId: SessionID
  ): Promise<GatewayOutboundMessage> {
    const fullId = await this.resolveId(id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await runDatabaseTransaction(
          this.db,
          async (txDb) => {
            await lockRowForUpdate(
              txDb,
              this.db,
              gatewayOutboundMessages,
              eq(gatewayOutboundMessages.id, fullId)
            );
            const row = await select(txDb)
              .from(gatewayOutboundMessages)
              .where(eq(gatewayOutboundMessages.id, fullId))
              .one();
            if (!row) throw new RepositoryError('Gateway outbound seed not found');
            if (row.consumed_at) {
              if (row.consumed_by_session_id !== sessionId) {
                throw new RepositoryError('Gateway outbound seed was consumed by another session');
              }
              return this.rowToMessage(row);
            }
            const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
            if (metadata.reply_session_admission_id !== sessionId) {
              throw new RepositoryError(
                'Gateway outbound reply admission does not match the session'
              );
            }
            const updated = await update(txDb, gatewayOutboundMessages)
              .set({
                consumed_by_session_id: sessionId,
                consumed_at: new Date(),
                updated_at: new Date(),
              })
              .where(
                and(
                  eq(gatewayOutboundMessages.id, fullId),
                  isNull(gatewayOutboundMessages.consumed_at)
                )
              )
              .returning()
              .one();
            return this.rowToMessage(updated);
          },
          { sqliteImmediate: true }
        );
      } catch (error) {
        if (isSqliteBusy(error) && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
          continue;
        }
        if (error instanceof RepositoryError) throw error;
        throw new RepositoryError(
          `Failed to complete gateway outbound reply: ${error instanceof Error ? error.message : String(error)}`,
          error
        );
      }
    }
    throw new RepositoryError('Failed to complete gateway outbound reply after lock retries');
  }
}
