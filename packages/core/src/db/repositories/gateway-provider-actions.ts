/**
 * Tenant-scoped durable outbox for provider REST actions.
 *
 * This repository owns only bounded state transitions. Provider rendering and
 * network calls remain with the current process-local listener connector.
 */

import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  isDiscordSnowflake,
  parseDiscordGatewayConfig,
} from '../../gateway/connectors/discord-config';
import { parseDiscordThreadId } from '../../gateway/connectors/discord-helpers';
import {
  advanceDiscordProgressMetadata,
  parseDiscordProgressMetadata,
} from '../../gateway/connectors/discord-progress';
import {
  DISCORD_THREAD_HISTORY_ACTION_TTL_MS,
  type DiscordThreadHistoryBounds,
  resolveDiscordThreadHistoryBounds,
} from '../../gateway/connectors/discord-thread-history';
import { generateId } from '../../lib/ids';
import type {
  DiscordGatewayConfig,
  GatewayChannelID,
  GatewayDiscordDeliveryExecutionMetadata,
  GatewayDiscordProgressActionParams,
  GatewayDiscordProgressState,
  GatewayDiscordThreadHistoryActionParams,
  GatewayProviderAction,
  GatewayProviderActionID,
  GatewayProviderActionParams,
  GatewayProviderActionResultMetadata,
  SessionID,
  TaskID,
  ThreadSessionMapID,
  UserID,
} from '../../types';
import { isTerminalTaskStatus } from '../../types';
import type { Database } from '../client';
import {
  executeRaw,
  insert,
  isPostgresDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  gatewayChannels,
  gatewayInboundEvents,
  gatewayProviderActions,
  messages,
  sessions,
  tasks,
  threadSessionMap,
} from '../schema';
import { RepositoryError } from './base';
import {
  assertGatewayProviderActionClaimInput,
  assertProviderActionBoundedNonEmpty,
  assertProviderActionCanonicalId,
  assertProviderActionPositiveInteger,
  GATEWAY_PROVIDER_ACTION_ACTIVE_STATUSES,
  GATEWAY_PROVIDER_ACTION_DISCORD_NOTICE_TTL_MS,
  GATEWAY_PROVIDER_ACTION_IDEMPOTENCY_KEY_MAX_BYTES,
  GATEWAY_PROVIDER_ACTION_MAX_ACTIVITY_TTL_MS,
  GATEWAY_PROVIDER_ACTION_MAX_BACKLOG,
  type GatewayProviderActionClaimInput,
  type GatewayProviderActionEnqueueInput,
  type GatewayProviderActionEnqueueResult,
  gatewayProviderActionFromRawRow,
  gatewayProviderActionFromRow,
  parseGatewayProviderActionParams,
  providerActionRows,
} from './gateway-provider-action-codec';
import {
  abandonGatewayProviderActionDiscordDelivery,
  admitGatewayProviderCall,
  armGatewayProviderActionProgressCreate,
  completeGatewayProviderAction,
  deadLetterGatewayProviderAction,
  initializeGatewayProviderActionDiscordDelivery,
  prepareGatewayProviderActionProgressCleanup,
  recordGatewayProviderActionDiscordDeliveryChunk,
  recordGatewayProviderActionProgressCleanupDebt,
  repairGatewayProviderActionDiscordDeliveryCoordinates,
  retryGatewayProviderAction,
  settleGatewayProviderActionProgressCleanupDebt,
  updateGatewayProviderActionProgressHandle,
} from './gateway-provider-action-transitions';

export * from './gateway-provider-action-codec';

export class GatewayProviderActionBacklogError extends RepositoryError {
  constructor() {
    super('Gateway provider action backlog is full');
    this.name = 'GatewayProviderActionBacklogError';
  }
}

export type GatewayDiscordProgressEnqueueResult =
  | {
      outcome: 'enqueued' | 'coalesced';
      action: GatewayProviderAction;
    }
  | {
      outcome: 'ignored';
      reason: 'missing_task' | 'stale_task' | 'terminal_regression' | 'unchanged';
    };

export interface GatewayProviderActionBacklogMetrics {
  activeCount: number;
  oldestDueAt: string | null;
  oldestDueAgeMs: number;
  deadLetterCount: number;
  partialDeliveryCount: number;
  nonceRecoveryIncompleteCount: number;
  historyIncompleteCount: number;
  formatterMismatchCount: number;
  observedAt: string;
}

export class GatewayProviderActionRepository {
  private readonly maxBacklogPerChannel: number;

  constructor(
    private readonly db: Database,
    options: { maxBacklogPerChannel?: number } = {}
  ) {
    this.maxBacklogPerChannel = options.maxBacklogPerChannel ?? GATEWAY_PROVIDER_ACTION_MAX_BACKLOG;
    assertProviderActionPositiveInteger(
      this.maxBacklogPerChannel,
      GATEWAY_PROVIDER_ACTION_MAX_BACKLOG,
      'Gateway provider action backlog limit'
    );
  }

  private async transactionNow(txDb: Database, channelId: GatewayChannelID): Promise<Date> {
    if (!isPostgresDatabase(this.db)) return new Date();
    const row = await select(txDb, { value: sql<Date>`CURRENT_TIMESTAMP` })
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, channelId))
      .one();
    return row?.value instanceof Date ? row.value : new Date(String(row?.value));
  }

  private validateEnqueue(input: GatewayProviderActionEnqueueInput): GatewayProviderActionParams {
    assertProviderActionCanonicalId(input.channelId, 'Gateway channel ID');
    if (input.kind !== 'discord_notice') {
      assertProviderActionCanonicalId(input.mappingId, 'Thread mapping ID');
      assertProviderActionCanonicalId(input.sessionId, 'Session ID');
      if (input.kind !== 'discord_thread_history') {
        assertProviderActionCanonicalId(input.taskId, 'Task ID');
      }
    }
    if (input.kind === 'deliver_message') {
      assertProviderActionCanonicalId(input.messageId, 'Message ID');
    } else if (input.kind === 'discord_progress') {
      if (input.params.state === 'done') {
        if (input.dropAfterMs !== undefined) {
          throw new RepositoryError('Discord terminal cleanup must not expire');
        }
      } else {
        if (input.dropAfterMs === undefined) {
          throw new RepositoryError('Discord display activity requires an expiry');
        }
        assertProviderActionPositiveInteger(
          input.dropAfterMs,
          GATEWAY_PROVIDER_ACTION_MAX_ACTIVITY_TTL_MS,
          'Gateway provider activity lifetime'
        );
      }
    }
    assertProviderActionCanonicalId(input.inboundEventId, 'Gateway inbound event ID');
    assertProviderActionBoundedNonEmpty(
      input.idempotencyKey,
      GATEWAY_PROVIDER_ACTION_IDEMPOTENCY_KEY_MAX_BYTES,
      'Gateway provider action idempotency key'
    );
    return parseGatewayProviderActionParams(input.params, input.kind);
  }

  private async validateCanonicalReferences(
    txDb: Database,
    input: GatewayProviderActionEnqueueInput,
    channel?: typeof gatewayChannels.$inferSelect
  ): Promise<void> {
    const [mapping, session, message, task, inboundEvent] = await Promise.all([
      input.kind !== 'discord_notice'
        ? select(txDb).from(threadSessionMap).where(eq(threadSessionMap.id, input.mappingId)).one()
        : Promise.resolve(null),
      input.kind !== 'discord_notice'
        ? select(txDb).from(sessions).where(eq(sessions.session_id, input.sessionId)).one()
        : Promise.resolve(null),
      input.kind === 'deliver_message'
        ? select(txDb).from(messages).where(eq(messages.message_id, input.messageId)).one()
        : Promise.resolve(null),
      input.kind !== 'discord_notice' && input.kind !== 'discord_thread_history'
        ? select(txDb).from(tasks).where(eq(tasks.task_id, input.taskId)).one()
        : Promise.resolve(null),
      input.inboundEventId
        ? select(txDb)
            .from(gatewayInboundEvents)
            .where(eq(gatewayInboundEvents.id, input.inboundEventId))
            .one()
        : Promise.resolve(null),
    ]);
    if (input.kind === 'discord_notice') {
      const eventIdentity = inboundEvent?.provider_event_id.match(
        /^discord:message:([1-9]\d{0,19}):([1-9]\d{0,19})$/
      );
      let validThread = false;
      try {
        validThread =
          !!inboundEvent && isDiscordSnowflake(parseDiscordThreadId(inboundEvent.thread_id));
      } catch {
        validThread = false;
      }
      if (
        channel?.channel_type !== 'discord' ||
        !channel.provider_installation_id ||
        !inboundEvent ||
        inboundEvent.gateway_channel_id !== input.channelId ||
        eventIdentity?.[1] !== channel.provider_installation_id ||
        !isDiscordSnowflake(eventIdentity?.[2]) ||
        !validThread
      ) {
        throw new RepositoryError('Gateway provider action canonical references do not match');
      }
      return;
    }
    if (input.kind === 'discord_thread_history') {
      const params = input.params as GatewayDiscordThreadHistoryActionParams;
      let config: DiscordGatewayConfig;
      let bounds: DiscordThreadHistoryBounds;
      let validThread = false;
      try {
        config = parseDiscordGatewayConfig(channel?.config, {
          enabled: true,
          agorUserId: channel?.agor_user_id,
        });
        bounds = resolveDiscordThreadHistoryBounds(
          (mapping?.metadata as Record<string, unknown> | null) ?? null
        );
        validThread = !!mapping && isDiscordSnowflake(parseDiscordThreadId(mapping.thread_id));
      } catch {
        throw new RepositoryError('Gateway provider action canonical references do not match');
      }
      const metadata = (mapping?.metadata as Record<string, unknown> | null) ?? {};
      if (
        channel?.channel_type !== 'discord' ||
        channel.provider_installation_id !== config.application_id ||
        config.agent_tools?.thread_history === false ||
        !mapping ||
        mapping.status !== 'active' ||
        mapping.channel_id !== input.channelId ||
        mapping.session_id !== input.sessionId ||
        mapping.branch_id !== session?.branch_id ||
        channel.target_branch_id !== session?.branch_id ||
        metadata.discord_application_id !== config.application_id ||
        metadata.discord_guild_id !== config.guild_id ||
        typeof metadata.discord_parent_channel_id !== 'string' ||
        !config.allowed_channel_ids.includes(metadata.discord_parent_channel_id as never) ||
        !validThread ||
        params.initial_message_id !== bounds.initialMessageId ||
        params.through_message_id !== bounds.throughMessageId
      ) {
        throw new RepositoryError('Gateway provider action canonical references do not match');
      }
      return;
    }
    if (
      !mapping ||
      mapping.channel_id !== input.channelId ||
      mapping.session_id !== input.sessionId ||
      !session ||
      !task ||
      task.session_id !== input.sessionId ||
      (input.kind === 'deliver_message' &&
        (!message || message.session_id !== input.sessionId || message.task_id !== input.taskId)) ||
      (input.inboundEventId !== undefined &&
        (!inboundEvent ||
          inboundEvent.gateway_channel_id !== input.channelId ||
          (inboundEvent.session_id !== null && inboundEvent.session_id !== input.sessionId) ||
          (inboundEvent.task_id !== null && inboundEvent.task_id !== input.taskId)))
    ) {
      throw new RepositoryError('Gateway provider action canonical references do not match');
    }
  }

  async enqueue(
    input: GatewayProviderActionEnqueueInput
  ): Promise<GatewayProviderActionEnqueueResult> {
    const params = this.validateEnqueue(input);
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        if (input.kind === 'discord_thread_history' && !isPostgresDatabase(txDb)) {
          throw new RepositoryError('Discord thread history actions require PostgreSQL');
        }
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
        if (!channel?.enabled || !channel.provider_installation_id) {
          throw new RepositoryError('Gateway provider action channel is not outbound-authorized');
        }
        if (input.kind === 'discord_thread_history') {
          await lockRowForUpdate(
            txDb,
            this.db,
            threadSessionMap,
            eq(threadSessionMap.id, input.mappingId)
          );
        }
        await this.validateCanonicalReferences(txDb, input, channel);

        const existing = await select(txDb)
          .from(gatewayProviderActions)
          .where(
            and(
              eq(gatewayProviderActions.gateway_channel_id, input.channelId),
              eq(
                gatewayProviderActions.provider_config_generation,
                channel.provider_config_generation
              ),
              eq(gatewayProviderActions.idempotency_key, input.idempotencyKey)
            )
          )
          .one();
        if (existing) {
          const action = gatewayProviderActionFromRow(existing);
          if (
            action.kind !== input.kind ||
            action.thread_session_map_id !==
              (input.kind === 'discord_notice' ? null : input.mappingId) ||
            action.session_id !== (input.kind === 'discord_notice' ? null : input.sessionId) ||
            action.task_id !==
              (input.kind === 'discord_notice' || input.kind === 'discord_thread_history'
                ? null
                : input.taskId) ||
            action.message_id !== (input.kind === 'deliver_message' ? input.messageId : null) ||
            action.gateway_inbound_event_id !== (input.inboundEventId ?? null) ||
            JSON.stringify(action.params) !== JSON.stringify(params)
          ) {
            throw new RepositoryError(
              'Gateway provider action idempotency key was reused for different work'
            );
          }
          return { outcome: 'duplicate', action };
        }

        const countRow = await select(txDb, { value: sql<number>`count(*)` })
          .from(gatewayProviderActions)
          .where(
            and(
              eq(gatewayProviderActions.gateway_channel_id, input.channelId),
              inArray(gatewayProviderActions.status, [...GATEWAY_PROVIDER_ACTION_ACTIVE_STATUSES])
            )
          )
          .one();
        if (Number(countRow?.value ?? 0) >= this.maxBacklogPerChannel) {
          throw new GatewayProviderActionBacklogError();
        }

        const now = await this.transactionNow(txDb, input.channelId);
        const id = generateId() as GatewayProviderActionID;
        await insert(txDb, gatewayProviderActions)
          .values({
            id,
            created_at: now,
            updated_at: now,
            gateway_channel_id: input.channelId,
            channel_type: channel.channel_type,
            provider_installation_id: channel.provider_installation_id,
            provider_config_generation: channel.provider_config_generation,
            kind: input.kind,
            idempotency_key: input.idempotencyKey,
            thread_session_map_id: input.kind === 'discord_notice' ? null : input.mappingId,
            session_id: input.kind === 'discord_notice' ? null : input.sessionId,
            task_id:
              input.kind === 'discord_notice' || input.kind === 'discord_thread_history'
                ? null
                : input.taskId,
            message_id: input.kind === 'deliver_message' ? input.messageId : null,
            gateway_inbound_event_id: input.inboundEventId ?? null,
            params,
            status: 'pending',
            attempts: 0,
            not_before: now,
            drop_after:
              input.kind === 'discord_progress' && input.params.state !== 'done'
                ? new Date(now.getTime() + input.dropAfterMs!)
                : input.kind === 'discord_notice'
                  ? new Date(now.getTime() + GATEWAY_PROVIDER_ACTION_DISCORD_NOTICE_TTL_MS)
                  : input.kind === 'discord_thread_history'
                    ? new Date(now.getTime() + DISCORD_THREAD_HISTORY_ACTION_TTL_MS)
                    : null,
            claim_generation: 0,
          })
          .run();
        const row = await select(txDb)
          .from(gatewayProviderActions)
          .where(eq(gatewayProviderActions.id, id))
          .one();
        if (!row) throw new RepositoryError('Failed to retrieve enqueued provider action');
        return { outcome: 'enqueued', action: gatewayProviderActionFromRow(row) };
      },
      { sqliteImmediate: true }
    );
  }

  /**
   * Advance sanitized mapping activity and coalesce its single task action in
   * one row-locked transaction. Re-queuing an in-flight row clears its exact
   * action claim, so a stale completion cannot overwrite the newer revision.
   */
  async enqueueDiscordProgress(input: {
    channelId: GatewayChannelID;
    mappingId: ThreadSessionMapID;
    sessionId: SessionID;
    taskId?: TaskID;
    state: GatewayDiscordProgressState;
    toolName?: unknown;
    dropAfterMs: number;
  }): Promise<GatewayDiscordProgressEnqueueResult> {
    assertProviderActionCanonicalId(input.channelId, 'Gateway channel ID');
    assertProviderActionCanonicalId(input.mappingId, 'Thread mapping ID');
    assertProviderActionCanonicalId(input.sessionId, 'Session ID');
    assertProviderActionCanonicalId(input.taskId, 'Task ID');
    assertProviderActionPositiveInteger(
      input.dropAfterMs,
      GATEWAY_PROVIDER_ACTION_MAX_ACTIVITY_TTL_MS,
      'Gateway provider activity lifetime'
    );
    return runDatabaseTransaction(
      this.db,
      async (txDb) => {
        await lockRowForUpdate(
          txDb,
          this.db,
          gatewayChannels,
          eq(gatewayChannels.id, input.channelId)
        );
        await lockRowForUpdate(
          txDb,
          this.db,
          threadSessionMap,
          eq(threadSessionMap.id, input.mappingId)
        );
        const [channel, mapping] = await Promise.all([
          select(txDb).from(gatewayChannels).where(eq(gatewayChannels.id, input.channelId)).one(),
          select(txDb).from(threadSessionMap).where(eq(threadSessionMap.id, input.mappingId)).one(),
        ]);
        if (
          !channel?.enabled ||
          channel.channel_type !== 'discord' ||
          !channel.provider_installation_id ||
          !mapping ||
          mapping.status !== 'active' ||
          mapping.channel_id !== channel.id ||
          mapping.session_id !== input.sessionId
        ) {
          throw new RepositoryError('Discord progress channel is not outbound-authorized');
        }

        const metadata = {
          ...((mapping.metadata as Record<string, unknown> | null) ?? {}),
        };
        const current = parseDiscordProgressMetadata(metadata);
        if ((input.state === 'done' || input.state === 'failed') && !input.taskId) {
          return { outcome: 'ignored', reason: 'missing_task' };
        }
        const taskId = input.taskId ?? current?.taskId;
        if (!taskId) return { outcome: 'ignored', reason: 'missing_task' };
        const desiredTask = await select(txDb).from(tasks).where(eq(tasks.task_id, taskId)).one();
        if (!desiredTask || desiredTask.session_id !== input.sessionId) {
          throw new RepositoryError('Discord progress canonical task does not match');
        }
        if (
          (input.state === 'queued' || input.state === 'working') &&
          isTerminalTaskStatus(desiredTask.status)
        ) {
          return { outcome: 'ignored', reason: 'stale_task' };
        }
        if (current && current.taskId !== taskId) {
          const currentTask = await select(txDb)
            .from(tasks)
            .where(eq(tasks.task_id, current.taskId))
            .one();
          if (
            currentTask?.session_id === input.sessionId &&
            (new Date(desiredTask.created_at).getTime() <
              new Date(currentTask.created_at).getTime() ||
              (new Date(desiredTask.created_at).getTime() ===
                new Date(currentTask.created_at).getTime() &&
                desiredTask.task_id < currentTask.task_id))
          ) {
            return { outcome: 'ignored', reason: 'stale_task' };
          }
        }

        const advanced = advanceDiscordProgressMetadata(metadata, {
          taskId,
          state: input.state,
          toolName: input.toolName,
        });
        if (!advanced.changed || !advanced.progress) {
          return {
            outcome: 'ignored',
            reason:
              advanced.reason === 'terminal_regression'
                ? 'terminal_regression'
                : advanced.reason === 'missing_task'
                  ? 'missing_task'
                  : 'unchanged',
          };
        }
        const now = await this.transactionNow(txDb, input.channelId);
        const params = parseGatewayProviderActionParams(
          {
            state: advanced.progress.state,
            revision: advanced.progress.revision,
            ...(advanced.progress.toolName ? { tool_name: advanced.progress.toolName } : {}),
          },
          'discord_progress'
        );
        const idempotencyKey = `discord_progress:${mapping.id}:${taskId}`;
        const existing = await select(txDb)
          .from(gatewayProviderActions)
          .where(
            and(
              eq(gatewayProviderActions.gateway_channel_id, channel.id),
              eq(
                gatewayProviderActions.provider_config_generation,
                channel.provider_config_generation
              ),
              eq(gatewayProviderActions.idempotency_key, idempotencyKey)
            )
          )
          .one();
        if (
          existing &&
          (existing.kind !== 'discord_progress' ||
            existing.thread_session_map_id !== mapping.id ||
            existing.session_id !== input.sessionId ||
            existing.task_id !== taskId ||
            existing.message_id !== null)
        ) {
          throw new RepositoryError(
            'Gateway provider action idempotency key was reused for different work'
          );
        }
        if (
          !existing ||
          !GATEWAY_PROVIDER_ACTION_ACTIVE_STATUSES.includes(existing.status as never)
        ) {
          const countRow = await select(txDb, { value: sql<number>`count(*)` })
            .from(gatewayProviderActions)
            .where(
              and(
                eq(gatewayProviderActions.gateway_channel_id, channel.id),
                inArray(gatewayProviderActions.status, [...GATEWAY_PROVIDER_ACTION_ACTIVE_STATUSES])
              )
            )
            .one();
          if (Number(countRow?.value ?? 0) >= this.maxBacklogPerChannel) {
            throw new GatewayProviderActionBacklogError();
          }
        }
        await update(txDb, threadSessionMap)
          .set({ metadata: advanced.metadata })
          .where(eq(threadSessionMap.id, mapping.id))
          .run();
        const values = {
          updated_at: now,
          gateway_channel_id: channel.id,
          channel_type: channel.channel_type,
          provider_installation_id: channel.provider_installation_id,
          provider_config_generation: channel.provider_config_generation,
          kind: 'discord_progress' as const,
          idempotency_key: idempotencyKey,
          thread_session_map_id: mapping.id,
          session_id: input.sessionId,
          task_id: taskId,
          message_id: null,
          gateway_inbound_event_id: null,
          params,
          status: 'pending' as const,
          attempts: 0,
          not_before: now,
          drop_after: input.state === 'done' ? null : new Date(now.getTime() + input.dropAfterMs),
          claim_token: null,
          claim_expires_at: null,
          claim_listener_token: null,
          claim_listener_generation: null,
          claim_instance_id: null,
          claim_boot_id: null,
          last_error_code: null,
          result_metadata: null,
          completed_at: null,
          dead_lettered_at: null,
          canceled_at: null,
        };
        let row: typeof gatewayProviderActions.$inferSelect | undefined;
        if (existing) {
          row = await update(txDb, gatewayProviderActions)
            .set(values)
            .where(eq(gatewayProviderActions.id, existing.id))
            .returning()
            .one();
        } else {
          const id = generateId() as GatewayProviderActionID;
          await insert(txDb, gatewayProviderActions)
            .values({
              ...values,
              id,
              created_at: now,
              claim_generation: 0,
            })
            .run();
          row = await select(txDb)
            .from(gatewayProviderActions)
            .where(eq(gatewayProviderActions.id, id))
            .one();
        }
        if (!row) throw new RepositoryError('Failed to retrieve Discord progress action');
        return {
          outcome: existing ? 'coalesced' : 'enqueued',
          action: gatewayProviderActionFromRow(row),
        };
      },
      { sqliteImmediate: true }
    );
  }

  private async cancelStaleTx(txDb: Database, channel: typeof gatewayChannels.$inferSelect) {
    await update(txDb, gatewayProviderActions)
      .set({
        status: 'canceled',
        canceled_at: isPostgresDatabase(this.db) ? sql`CURRENT_TIMESTAMP` : new Date(),
        updated_at: isPostgresDatabase(this.db) ? sql`CURRENT_TIMESTAMP` : new Date(),
        last_error_code: 'provider_configuration_changed',
        claim_token: null,
        claim_expires_at: null,
        claim_listener_token: null,
        claim_listener_generation: null,
        claim_instance_id: null,
        claim_boot_id: null,
      })
      .where(
        and(
          eq(gatewayProviderActions.gateway_channel_id, channel.id),
          inArray(gatewayProviderActions.status, [...GATEWAY_PROVIDER_ACTION_ACTIVE_STATUSES]),
          or(
            ne(gatewayProviderActions.channel_type, channel.channel_type),
            ne(
              gatewayProviderActions.provider_installation_id,
              channel.provider_installation_id ?? ''
            ),
            ne(
              gatewayProviderActions.provider_config_generation,
              channel.provider_config_generation
            )
          )
        )
      )
      .run();
  }

  private async convertExpiredEphemeralTx(
    txDb: Database,
    channelId: GatewayChannelID,
    now: Date
  ): Promise<void> {
    const expired = await select(txDb)
      .from(gatewayProviderActions)
      .where(
        and(
          eq(gatewayProviderActions.gateway_channel_id, channelId),
          inArray(gatewayProviderActions.kind, [
            'discord_progress',
            'discord_notice',
            'discord_thread_history',
          ]),
          inArray(gatewayProviderActions.status, [...GATEWAY_PROVIDER_ACTION_ACTIVE_STATUSES]),
          lte(gatewayProviderActions.drop_after, now)
        )
      )
      .orderBy(asc(gatewayProviderActions.drop_after), asc(gatewayProviderActions.id))
      .limit(100)
      .all();
    for (const candidate of expired) {
      await lockRowForUpdate(
        txDb,
        this.db,
        gatewayProviderActions,
        eq(gatewayProviderActions.id, candidate.id)
      );
      // The bounded discovery query intentionally does not hold locks. Re-read
      // after acquiring the row lock so a concurrent completion/coalesce cannot
      // be overwritten by a stale expiry snapshot.
      const action = await select(txDb)
        .from(gatewayProviderActions)
        .where(eq(gatewayProviderActions.id, candidate.id))
        .one();
      if (
        !action ||
        action.gateway_channel_id !== channelId ||
        (action.kind !== 'discord_progress' &&
          action.kind !== 'discord_notice' &&
          action.kind !== 'discord_thread_history') ||
        !GATEWAY_PROVIDER_ACTION_ACTIVE_STATUSES.includes(action.status as never) ||
        !action.drop_after ||
        new Date(action.drop_after).getTime() > now.getTime()
      ) {
        continue;
      }
      if (action.kind === 'discord_thread_history') {
        await update(txDb, gatewayProviderActions)
          .set({
            status: 'canceled',
            canceled_at: now,
            updated_at: now,
            last_error_code: 'discord_history_expired',
            claim_token: null,
            claim_expires_at: null,
            claim_listener_token: null,
            claim_listener_generation: null,
            claim_instance_id: null,
            claim_boot_id: null,
          })
          .where(eq(gatewayProviderActions.id, action.id))
          .run();
        continue;
      }
      if (action.kind === 'discord_notice') {
        await update(txDb, gatewayProviderActions)
          .set({
            status: 'canceled',
            canceled_at: now,
            updated_at: now,
            last_error_code: 'notice_expired',
            claim_token: null,
            claim_expires_at: null,
            claim_listener_token: null,
            claim_listener_generation: null,
            claim_instance_id: null,
            claim_boot_id: null,
          })
          .where(eq(gatewayProviderActions.id, action.id))
          .run();
        continue;
      }
      if (!action.thread_session_map_id || !action.task_id || !action.session_id) {
        await update(txDb, gatewayProviderActions)
          .set({
            status: 'canceled',
            canceled_at: now,
            updated_at: now,
            last_error_code: 'activity_expired_superseded',
            claim_token: null,
            claim_expires_at: null,
            claim_listener_token: null,
            claim_listener_generation: null,
            claim_instance_id: null,
            claim_boot_id: null,
          })
          .where(eq(gatewayProviderActions.id, action.id))
          .run();
        continue;
      }
      await lockRowForUpdate(
        txDb,
        this.db,
        threadSessionMap,
        eq(threadSessionMap.id, action.thread_session_map_id)
      );
      const mapping = await select(txDb)
        .from(threadSessionMap)
        .where(eq(threadSessionMap.id, action.thread_session_map_id))
        .one();
      const metadata = { ...((mapping?.metadata as Record<string, unknown> | null) ?? {}) };
      const progress = parseDiscordProgressMetadata(metadata);
      const params = parseGatewayProviderActionParams(
        action.params,
        'discord_progress'
      ) as GatewayDiscordProgressActionParams;
      if (
        mapping?.status === 'active' &&
        mapping.channel_id === channelId &&
        mapping.session_id === action.session_id &&
        progress &&
        progress.taskId === action.task_id &&
        progress.revision === params.revision
      ) {
        const advanced = advanceDiscordProgressMetadata(metadata, {
          taskId: action.task_id as TaskID,
          state: 'done',
        });
        const cleanup = advanced.progress ?? progress;
        await update(txDb, threadSessionMap)
          .set({ metadata: advanced.metadata })
          .where(eq(threadSessionMap.id, mapping.id))
          .run();
        await update(txDb, gatewayProviderActions)
          .set({
            status: 'pending',
            params: parseGatewayProviderActionParams(
              {
                state: 'done',
                revision: cleanup.revision,
                cleanup_reason: 'activity_expired',
              },
              'discord_progress'
            ),
            not_before: now,
            drop_after: null,
            attempts: 0,
            updated_at: now,
            last_error_code: 'activity_expired',
            claim_token: null,
            claim_expires_at: null,
            claim_listener_token: null,
            claim_listener_generation: null,
            claim_instance_id: null,
            claim_boot_id: null,
          })
          .where(eq(gatewayProviderActions.id, action.id))
          .run();
      } else {
        await update(txDb, gatewayProviderActions)
          .set({
            status: 'canceled',
            canceled_at: now,
            updated_at: now,
            last_error_code: 'activity_expired_superseded',
            claim_token: null,
            claim_expires_at: null,
            claim_listener_token: null,
            claim_listener_generation: null,
            claim_instance_id: null,
            claim_boot_id: null,
          })
          .where(eq(gatewayProviderActions.id, action.id))
          .run();
      }
    }
  }

  /** Claim due work only under the exact current unexpired listener fence. */
  async claimForListener(input: GatewayProviderActionClaimInput): Promise<GatewayProviderAction[]> {
    assertGatewayProviderActionClaimInput(input);
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
        if (!channel) return [];
        await this.cancelStaleTx(txDb, channel);
        const now = await this.transactionNow(txDb, input.channelId);
        await this.convertExpiredEphemeralTx(txDb, input.channelId, now);
        if (
          !channel.enabled ||
          !channel.provider_installation_id ||
          channel.listener_claim_token !== input.listenerClaimToken ||
          channel.listener_generation !== input.listenerGeneration ||
          !channel.listener_lease_expires_at ||
          new Date(channel.listener_lease_expires_at).getTime() <= now.getTime()
        ) {
          return [];
        }

        if (isPostgresDatabase(this.db)) {
          const result = await executeRaw(
            txDb,
            sql`WITH claimable AS (
                  SELECT a.id
                  FROM gateway_provider_actions AS a
                  WHERE a.gateway_channel_id = ${input.channelId}
                    AND a.channel_type = ${channel.channel_type}
                    AND a.provider_installation_id = ${channel.provider_installation_id}
                    AND a.provider_config_generation = ${channel.provider_config_generation}
                    AND a.not_before <= clock_timestamp()
                    AND (a.drop_after IS NULL OR a.drop_after > clock_timestamp())
                    AND (
                      a.status IN ('pending', 'retry')
                      OR (
                        a.status = 'processing'
                        AND (a.claim_expires_at IS NULL OR a.claim_expires_at <= clock_timestamp())
                      )
                    )
                  ORDER BY a.not_before, a.created_at, a.id
                  FOR UPDATE OF a SKIP LOCKED
                  LIMIT ${input.limit}
                )
                UPDATE gateway_provider_actions AS a
                SET status = 'processing',
                    attempts = a.attempts + 1,
                    claim_token = ${input.actionClaimToken},
                    claim_generation = a.claim_generation + 1,
                    claim_expires_at = clock_timestamp() + (${input.leaseMs} * interval '1 millisecond'),
                    claim_listener_token = ${input.listenerClaimToken},
                    claim_listener_generation = ${input.listenerGeneration},
                    claim_instance_id = ${input.identity.instanceId},
                    claim_boot_id = ${input.identity.bootId},
                    updated_at = CURRENT_TIMESTAMP
                FROM claimable
                WHERE a.id = claimable.id
                RETURNING a.*`
          );
          return providerActionRows(result).map(gatewayProviderActionFromRawRow);
        }

        const candidates = await select(txDb)
          .from(gatewayProviderActions)
          .where(
            and(
              eq(gatewayProviderActions.gateway_channel_id, input.channelId),
              eq(gatewayProviderActions.channel_type, channel.channel_type),
              eq(gatewayProviderActions.provider_installation_id, channel.provider_installation_id),
              eq(
                gatewayProviderActions.provider_config_generation,
                channel.provider_config_generation
              ),
              ne(gatewayProviderActions.kind, 'discord_thread_history'),
              lte(gatewayProviderActions.not_before, now),
              or(
                isNull(gatewayProviderActions.drop_after),
                gt(gatewayProviderActions.drop_after, now)
              ),
              or(
                inArray(gatewayProviderActions.status, ['pending', 'retry']),
                and(
                  eq(gatewayProviderActions.status, 'processing'),
                  or(
                    isNull(gatewayProviderActions.claim_expires_at),
                    lte(gatewayProviderActions.claim_expires_at, now)
                  )
                )
              )
            )
          )
          .orderBy(
            asc(gatewayProviderActions.not_before),
            asc(gatewayProviderActions.created_at),
            asc(gatewayProviderActions.id)
          )
          .limit(input.limit)
          .all();
        const expiresAt = new Date(now.getTime() + input.leaseMs);
        const claimed: GatewayProviderAction[] = [];
        for (const candidate of candidates) {
          const row = await update(txDb, gatewayProviderActions)
            .set({
              status: 'processing',
              attempts: candidate.attempts + 1,
              claim_token: input.actionClaimToken,
              claim_generation: candidate.claim_generation + 1,
              claim_expires_at: expiresAt,
              claim_listener_token: input.listenerClaimToken,
              claim_listener_generation: input.listenerGeneration,
              claim_instance_id: input.identity.instanceId,
              claim_boot_id: input.identity.bootId,
              updated_at: now,
            })
            .where(eq(gatewayProviderActions.id, candidate.id))
            .returning()
            .one();
          claimed.push(gatewayProviderActionFromRow(row));
        }
        return claimed;
      },
      { sqliteImmediate: true }
    );
  }

  async admitProviderCall(input: {
    actionId: GatewayProviderActionID;
    channelId: GatewayChannelID;
    actionClaimToken: string;
    actionClaimGeneration: number;
    listenerClaimToken: string;
    listenerGeneration: number;
    leaseMs: number;
  }): Promise<GatewayProviderAction | null> {
    return admitGatewayProviderCall(this.db, input);
  }

  async complete(input: {
    actionId: GatewayProviderActionID;
    channelId: GatewayChannelID;
    actionClaimToken: string;
    actionClaimGeneration: number;
    listenerClaimToken: string;
    listenerGeneration: number;
    result: GatewayProviderActionResultMetadata;
  }): Promise<boolean> {
    return completeGatewayProviderAction(this.db, input);
  }

  async initializeDiscordDelivery(input: {
    actionId: GatewayProviderActionID;
    channelId: GatewayChannelID;
    actionClaimToken: string;
    actionClaimGeneration: number;
    listenerClaimToken: string;
    listenerGeneration: number;
    metadata: GatewayDiscordDeliveryExecutionMetadata;
  }) {
    return initializeGatewayProviderActionDiscordDelivery(this.db, input);
  }

  async recordDiscordDeliveryChunk(input: {
    actionId: GatewayProviderActionID;
    channelId: GatewayChannelID;
    actionClaimToken: string;
    actionClaimGeneration: number;
    listenerClaimToken: string;
    listenerGeneration: number;
    expectedMetadata: GatewayDiscordDeliveryExecutionMetadata;
    chunkIndex: number;
    providerMessageId: string;
  }) {
    return recordGatewayProviderActionDiscordDeliveryChunk(this.db, input);
  }

  async repairDiscordDeliveryCoordinates(input: {
    actionId: GatewayProviderActionID;
    channelId: GatewayChannelID;
    operatorUserId: UserID;
    expectedMetadata: GatewayDiscordDeliveryExecutionMetadata;
    providerMessageIds: string[];
  }): Promise<boolean> {
    return repairGatewayProviderActionDiscordDeliveryCoordinates(this.db, input);
  }

  async abandonDiscordDelivery(input: {
    actionId: GatewayProviderActionID;
    channelId: GatewayChannelID;
    operatorUserId: UserID;
    expectedMetadata: GatewayDiscordDeliveryExecutionMetadata;
  }): Promise<boolean> {
    return abandonGatewayProviderActionDiscordDelivery(this.db, input);
  }

  async retry(input: {
    actionId: GatewayProviderActionID;
    channelId: GatewayChannelID;
    actionClaimToken: string;
    actionClaimGeneration: number;
    listenerClaimToken: string;
    listenerGeneration: number;
    errorCode: string;
    retryAfterMs: number;
  }): Promise<boolean> {
    return retryGatewayProviderAction(this.db, input);
  }

  async deadLetter(input: {
    actionId: GatewayProviderActionID;
    channelId: GatewayChannelID;
    actionClaimToken: string;
    actionClaimGeneration: number;
    listenerClaimToken: string;
    listenerGeneration: number;
    errorCode: string;
  }): Promise<boolean> {
    return deadLetterGatewayProviderAction(this.db, input);
  }

  async updateDiscordProgressHandle(input: {
    actionId: GatewayProviderActionID;
    channelId: GatewayChannelID;
    actionClaimToken: string;
    actionClaimGeneration: number;
    listenerClaimToken: string;
    listenerGeneration: number;
    mappingId: ThreadSessionMapID;
    expectedTaskId: TaskID;
    expectedRevision: number;
    expectedProviderMessageId?: string | null;
    providerMessageId: string | null;
  }) {
    return updateGatewayProviderActionProgressHandle(this.db, input);
  }

  async armDiscordProgressCreate(
    input: Parameters<typeof armGatewayProviderActionProgressCreate>[1]
  ) {
    return armGatewayProviderActionProgressCreate(this.db, input);
  }

  async settleDiscordProgressCleanupDebt(
    input: Parameters<typeof settleGatewayProviderActionProgressCleanupDebt>[1]
  ) {
    return settleGatewayProviderActionProgressCleanupDebt(this.db, input);
  }

  async recordDiscordProgressCleanupDebt(
    input: Parameters<typeof recordGatewayProviderActionProgressCleanupDebt>[1]
  ) {
    return recordGatewayProviderActionProgressCleanupDebt(this.db, input);
  }

  async prepareDiscordProgressCleanup(
    input: Parameters<typeof prepareGatewayProviderActionProgressCleanup>[1]
  ) {
    return prepareGatewayProviderActionProgressCleanup(this.db, input);
  }

  async findById(id: GatewayProviderActionID): Promise<GatewayProviderAction | null> {
    const row = await select(this.db)
      .from(gatewayProviderActions)
      .where(eq(gatewayProviderActions.id, id))
      .one();
    return row ? gatewayProviderActionFromRow(row) : null;
  }

  async countBacklog(channelId: GatewayChannelID): Promise<number> {
    const row = await select(this.db, { value: sql<number>`count(*)` })
      .from(gatewayProviderActions)
      .where(
        and(
          eq(gatewayProviderActions.gateway_channel_id, channelId),
          inArray(gatewayProviderActions.status, [...GATEWAY_PROVIDER_ACTION_ACTIVE_STATUSES])
        )
      )
      .one();
    return Number(row?.value ?? 0);
  }

  /** Durable content-free Cloud health state; returns bounded aggregates only. */
  async getBacklogMetrics(
    channelId: GatewayChannelID
  ): Promise<GatewayProviderActionBacklogMetrics> {
    assertProviderActionCanonicalId(channelId, 'Gateway channel ID');
    const partialCondition = isPostgresDatabase(this.db)
      ? sql`${gatewayProviderActions.execution_metadata} IS NOT NULL AND jsonb_array_length(${gatewayProviderActions.execution_metadata}->'chunks') > (SELECT count(*) FROM jsonb_array_elements(${gatewayProviderActions.execution_metadata}->'chunks') AS chunk WHERE chunk ? 'provider_message_id')`
      : sql`${gatewayProviderActions.execution_metadata} IS NOT NULL AND json_array_length(json_extract(${gatewayProviderActions.execution_metadata}, '$.chunks')) > (SELECT count(*) FROM json_each(json_extract(${gatewayProviderActions.execution_metadata}, '$.chunks')) WHERE json_type(value, '$.provider_message_id') = 'text')`;
    const [active, dead, oldest, partial, nonceIncomplete, historyIncomplete, formatterMismatch] =
      await Promise.all([
        select(this.db, { value: sql<number>`count(*)` })
          .from(gatewayProviderActions)
          .where(
            and(
              eq(gatewayProviderActions.gateway_channel_id, channelId),
              inArray(gatewayProviderActions.status, [...GATEWAY_PROVIDER_ACTION_ACTIVE_STATUSES])
            )
          )
          .one(),
        select(this.db, { value: sql<number>`count(*)` })
          .from(gatewayProviderActions)
          .where(
            and(
              eq(gatewayProviderActions.gateway_channel_id, channelId),
              eq(gatewayProviderActions.status, 'dead_letter')
            )
          )
          .one(),
        select(this.db, { notBefore: gatewayProviderActions.not_before })
          .from(gatewayProviderActions)
          .where(
            and(
              eq(gatewayProviderActions.gateway_channel_id, channelId),
              inArray(gatewayProviderActions.status, [...GATEWAY_PROVIDER_ACTION_ACTIVE_STATUSES])
            )
          )
          .orderBy(asc(gatewayProviderActions.not_before))
          .limit(1)
          .one(),
        select(this.db, { value: sql<number>`count(*)` })
          .from(gatewayProviderActions)
          .where(
            and(
              eq(gatewayProviderActions.gateway_channel_id, channelId),
              eq(gatewayProviderActions.kind, 'deliver_message'),
              inArray(gatewayProviderActions.status, [
                ...GATEWAY_PROVIDER_ACTION_ACTIVE_STATUSES,
                'dead_letter',
              ]),
              partialCondition
            )
          )
          .one(),
        select(this.db, { value: sql<number>`count(*)` })
          .from(gatewayProviderActions)
          .where(
            and(
              eq(gatewayProviderActions.gateway_channel_id, channelId),
              eq(gatewayProviderActions.last_error_code, 'discord_nonce_recovery_incomplete')
            )
          )
          .one(),
        select(this.db, { value: sql<number>`count(*)` })
          .from(gatewayProviderActions)
          .where(
            and(
              eq(gatewayProviderActions.gateway_channel_id, channelId),
              eq(gatewayProviderActions.last_error_code, 'discord_history_bounded_scan_incomplete')
            )
          )
          .one(),
        select(this.db, { value: sql<number>`count(*)` })
          .from(gatewayProviderActions)
          .where(
            and(
              eq(gatewayProviderActions.gateway_channel_id, channelId),
              eq(gatewayProviderActions.last_error_code, 'discord_formatter_mismatch')
            )
          )
          .one(),
      ]);
    const observedAt = await this.transactionNow(this.db, channelId);
    const oldestDue = oldest?.notBefore ? new Date(oldest.notBefore) : null;
    return {
      activeCount: Number(active?.value ?? 0),
      oldestDueAt: oldestDue?.toISOString() ?? null,
      oldestDueAgeMs: oldestDue ? Math.max(0, observedAt.getTime() - oldestDue.getTime()) : 0,
      deadLetterCount: Number(dead?.value ?? 0),
      partialDeliveryCount: Number(partial?.value ?? 0),
      nonceRecoveryIncompleteCount: Number(nonceIncomplete?.value ?? 0),
      historyIncompleteCount: Number(historyIncomplete?.value ?? 0),
      formatterMismatchCount: Number(formatterMismatch?.value ?? 0),
      observedAt: observedAt.toISOString(),
    };
  }
}
