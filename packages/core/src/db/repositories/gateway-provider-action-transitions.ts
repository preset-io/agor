/** Exact action/listener/config fences around one provider REST side effect. */

import { eq, sql } from 'drizzle-orm';
import { isDiscordSnowflake } from '../../gateway/connectors/discord-config';
import { discordDeliveryIdentityMatches } from '../../gateway/connectors/discord-delivery';
import {
  addDiscordProgressCleanupDebt,
  advanceDiscordProgressMetadata,
  type DiscordProgressCleanupDebt,
  parseDiscordProgressMetadata,
  removeDiscordProgressCleanupDebt,
} from '../../gateway/connectors/discord-progress';
import type {
  GatewayChannelID,
  GatewayDiscordDeliveryExecutionMetadata,
  GatewayDiscordProgressActionParams,
  GatewayProviderAction,
  GatewayProviderActionID,
  GatewayProviderActionResultMetadata,
  TaskID,
  ThreadSessionMapID,
  UserID,
} from '../../types';
import type { Database } from '../client';
import {
  isPostgresDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { gatewayChannels, gatewayProviderActions, threadSessionMap, users } from '../schema';
import { RepositoryError } from './base';
import {
  assertProviderActionPositiveInteger,
  assertProviderActionSanitizedErrorCode,
  GATEWAY_PROVIDER_ACTION_MAX_LEASE_MS,
  GATEWAY_PROVIDER_ACTION_MAX_RETRY_MS,
  gatewayProviderActionFromRow,
  parseGatewayProviderActionExecutionMetadata,
  parseGatewayProviderActionResult,
} from './gateway-provider-action-codec';

interface ExactActionClaimInput {
  actionId: GatewayProviderActionID;
  channelId: GatewayChannelID;
  actionClaimToken: string;
  actionClaimGeneration: number;
  listenerClaimToken: string;
  listenerGeneration: number;
}

async function transactionNow(
  db: Database,
  txDb: Database,
  channelId: GatewayChannelID
): Promise<Date> {
  if (!isPostgresDatabase(db)) return new Date();
  const row = await select(txDb, { value: sql<Date>`CURRENT_TIMESTAMP` })
    .from(gatewayChannels)
    .where(eq(gatewayChannels.id, channelId))
    .one();
  return row?.value instanceof Date ? row.value : new Date(String(row?.value));
}

async function exactCurrentClaim(db: Database, txDb: Database, input: ExactActionClaimInput) {
  await lockRowForUpdate(txDb, db, gatewayChannels, eq(gatewayChannels.id, input.channelId));
  await lockRowForUpdate(
    txDb,
    db,
    gatewayProviderActions,
    eq(gatewayProviderActions.id, input.actionId)
  );
  const [channel, action] = await Promise.all([
    select(txDb).from(gatewayChannels).where(eq(gatewayChannels.id, input.channelId)).one(),
    select(txDb)
      .from(gatewayProviderActions)
      .where(eq(gatewayProviderActions.id, input.actionId))
      .one(),
  ]);
  const now = await transactionNow(db, txDb, input.channelId);
  if (
    !channel?.enabled ||
    !channel.provider_installation_id ||
    !action ||
    action.gateway_channel_id !== input.channelId ||
    action.status !== 'processing' ||
    action.claim_token !== input.actionClaimToken ||
    action.claim_generation !== input.actionClaimGeneration ||
    action.claim_listener_token !== input.listenerClaimToken ||
    action.claim_listener_generation !== input.listenerGeneration ||
    !action.claim_expires_at ||
    new Date(action.claim_expires_at).getTime() <= now.getTime() ||
    channel.listener_claim_token !== input.listenerClaimToken ||
    channel.listener_generation !== input.listenerGeneration ||
    !channel.listener_lease_expires_at ||
    new Date(channel.listener_lease_expires_at).getTime() <= now.getTime() ||
    action.channel_type !== channel.channel_type ||
    action.provider_installation_id !== channel.provider_installation_id ||
    action.provider_config_generation !== channel.provider_config_generation
  ) {
    return null;
  }
  return { action, now };
}

/** Fresh database admission immediately before the external REST side effect. */
export async function admitGatewayProviderCall(
  db: Database,
  input: ExactActionClaimInput & { leaseMs: number }
): Promise<GatewayProviderAction | null> {
  assertProviderActionPositiveInteger(
    input.leaseMs,
    GATEWAY_PROVIDER_ACTION_MAX_LEASE_MS,
    'Gateway provider call lease'
  );
  return runDatabaseTransaction(
    db,
    async (txDb) => {
      const current = await exactCurrentClaim(db, txDb, input);
      if (!current) return null;
      if (
        current.action.kind === 'discord_notice' &&
        current.action.drop_after &&
        new Date(current.action.drop_after).getTime() <= current.now.getTime()
      ) {
        await update(txDb, gatewayProviderActions)
          .set({
            status: 'canceled',
            canceled_at: current.now,
            updated_at: current.now,
            last_error_code: 'notice_expired',
            claim_token: null,
            claim_expires_at: null,
            claim_listener_token: null,
            claim_listener_generation: null,
            claim_instance_id: null,
            claim_boot_id: null,
          })
          .where(eq(gatewayProviderActions.id, input.actionId))
          .run();
        return null;
      }
      if (
        current.action.kind === 'discord_thread_history' &&
        current.action.drop_after &&
        new Date(current.action.drop_after).getTime() <= current.now.getTime()
      ) {
        await update(txDb, gatewayProviderActions)
          .set({
            status: 'canceled',
            canceled_at: current.now,
            updated_at: current.now,
            last_error_code: 'discord_history_expired',
            claim_token: null,
            claim_expires_at: null,
            claim_listener_token: null,
            claim_listener_generation: null,
            claim_instance_id: null,
            claim_boot_id: null,
          })
          .where(eq(gatewayProviderActions.id, input.actionId))
          .run();
        return null;
      }
      if (
        current.action.kind === 'discord_progress' &&
        current.action.drop_after &&
        new Date(current.action.drop_after).getTime() <= current.now.getTime()
      ) {
        const mappingId = current.action.thread_session_map_id;
        if (mappingId && current.action.task_id && current.action.session_id) {
          await lockRowForUpdate(txDb, db, threadSessionMap, eq(threadSessionMap.id, mappingId));
          const mapping = await select(txDb)
            .from(threadSessionMap)
            .where(eq(threadSessionMap.id, mappingId))
            .one();
          const metadata = { ...((mapping?.metadata as Record<string, unknown> | null) ?? {}) };
          const progress = parseDiscordProgressMetadata(metadata);
          const params = current.action.params as GatewayDiscordProgressActionParams;
          if (
            mapping?.status === 'active' &&
            mapping.channel_id === input.channelId &&
            mapping.session_id === current.action.session_id &&
            progress &&
            progress.taskId === current.action.task_id &&
            progress.revision === params.revision
          ) {
            const advanced = advanceDiscordProgressMetadata(metadata, {
              taskId: current.action.task_id,
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
                params: {
                  state: 'done',
                  revision: cleanup.revision,
                  cleanup_reason: 'activity_expired',
                },
                not_before: current.now,
                drop_after: null,
                attempts: 0,
                updated_at: current.now,
                last_error_code: 'activity_expired',
                claim_token: null,
                claim_expires_at: null,
                claim_listener_token: null,
                claim_listener_generation: null,
                claim_instance_id: null,
                claim_boot_id: null,
              })
              .where(eq(gatewayProviderActions.id, input.actionId))
              .run();
            return null;
          }
        }
        await update(txDb, gatewayProviderActions)
          .set({
            status: 'canceled',
            canceled_at: current.now,
            updated_at: current.now,
            last_error_code: 'activity_expired_superseded',
            claim_token: null,
            claim_expires_at: null,
            claim_listener_token: null,
            claim_listener_generation: null,
            claim_instance_id: null,
            claim_boot_id: null,
          })
          .where(eq(gatewayProviderActions.id, input.actionId))
          .run();
        return null;
      }
      const row = await update(txDb, gatewayProviderActions)
        .set({
          claim_expires_at: new Date(current.now.getTime() + input.leaseMs),
          updated_at: current.now,
        })
        .where(eq(gatewayProviderActions.id, input.actionId))
        .returning()
        .one();
      return gatewayProviderActionFromRow(row);
    },
    { sqliteImmediate: true }
  );
}

export async function completeGatewayProviderAction(
  db: Database,
  input: ExactActionClaimInput & { result: GatewayProviderActionResultMetadata }
): Promise<boolean> {
  return runDatabaseTransaction(
    db,
    async (txDb) => {
      const current = await exactCurrentClaim(db, txDb, input);
      if (!current) return false;
      if (
        current.action.kind === 'discord_thread_history' &&
        current.action.drop_after &&
        new Date(current.action.drop_after).getTime() <= current.now.getTime()
      ) {
        await update(txDb, gatewayProviderActions)
          .set({
            status: 'canceled',
            canceled_at: current.now,
            updated_at: current.now,
            last_error_code: 'discord_history_expired',
            claim_token: null,
            claim_expires_at: null,
            claim_listener_token: null,
            claim_listener_generation: null,
            claim_instance_id: null,
            claim_boot_id: null,
          })
          .where(eq(gatewayProviderActions.id, input.actionId))
          .run();
        return false;
      }
      const result = parseGatewayProviderActionResult(input.result, current.action.kind);
      if (!result) throw new RepositoryError('Gateway provider action result is required');
      if (current.action.kind === 'deliver_message' || current.action.kind === 'discord_notice') {
        const execution = parseGatewayProviderActionExecutionMetadata(
          current.action.execution_metadata,
          current.action.kind
        );
        const last = execution?.chunks.at(-1);
        const resultProviderMessageId =
          result.kind === 'deliver_message' || result.kind === 'discord_notice'
            ? result.provider_message_id
            : undefined;
        if (
          !execution ||
          execution.chunks.some((chunk) => !chunk.provider_message_id) ||
          !last?.provider_message_id ||
          result.kind !== current.action.kind ||
          resultProviderMessageId !== last.provider_message_id
        ) {
          throw new RepositoryError(
            'Discord delivery cannot complete without every durable chunk coordinate'
          );
        }
      }
      const mutation = await update(txDb, gatewayProviderActions)
        .set({
          status: 'completed',
          result_metadata: result,
          completed_at: current.now,
          updated_at: current.now,
          last_error_code: null,
          claim_token: null,
          claim_expires_at: null,
          claim_listener_token: null,
          claim_listener_generation: null,
          claim_instance_id: null,
          claim_boot_id: null,
        })
        .where(eq(gatewayProviderActions.id, input.actionId))
        .run();
      return mutation.rowsAffected === 1;
    },
    { sqliteImmediate: true }
  );
}

export type GatewayDiscordDeliveryFreezeResult =
  | {
      outcome: 'initialized' | 'matched';
      metadata: GatewayDiscordDeliveryExecutionMetadata;
    }
  | { outcome: 'formatter_mismatch' | 'fenced' };

function assertUnexecutedDeliveryIdentity(
  value: GatewayDiscordDeliveryExecutionMetadata,
  kind: 'deliver_message' | 'discord_notice' = 'deliver_message'
): GatewayDiscordDeliveryExecutionMetadata {
  const parsed = parseGatewayProviderActionExecutionMetadata(value, kind);
  if (
    !parsed ||
    parsed.repair ||
    parsed.chunks.some((chunk) => chunk.provider_message_id !== undefined)
  ) {
    throw new RepositoryError('Discord delivery identity must not contain execution results');
  }
  return parsed;
}

/** Freeze formatter identity before the first Discord GET/PATCH/POST. */
export async function initializeGatewayProviderActionDiscordDelivery(
  db: Database,
  input: ExactActionClaimInput & { metadata: GatewayDiscordDeliveryExecutionMetadata }
): Promise<GatewayDiscordDeliveryFreezeResult> {
  return runDatabaseTransaction(
    db,
    async (txDb) => {
      const current = await exactCurrentClaim(db, txDb, input);
      if (current?.action.kind !== 'deliver_message' && current?.action.kind !== 'discord_notice') {
        return { outcome: 'fenced' };
      }
      const expected = assertUnexecutedDeliveryIdentity(input.metadata, current.action.kind);
      const persisted = parseGatewayProviderActionExecutionMetadata(
        current.action.execution_metadata,
        current.action.kind
      );
      if (persisted) {
        return discordDeliveryIdentityMatches(persisted, expected)
          ? { outcome: 'matched', metadata: persisted }
          : { outcome: 'formatter_mismatch' };
      }
      await update(txDb, gatewayProviderActions)
        .set({ execution_metadata: expected, updated_at: current.now })
        .where(eq(gatewayProviderActions.id, input.actionId))
        .run();
      return { outcome: 'initialized', metadata: expected };
    },
    { sqliteImmediate: true }
  );
}

export type GatewayDiscordDeliveryChunkRecordResult =
  | {
      outcome: 'recorded' | 'already_recorded';
      metadata: GatewayDiscordDeliveryExecutionMetadata;
    }
  | { outcome: 'formatter_mismatch' | 'coordinate_conflict' | 'out_of_order' | 'fenced' };

/** Persist one returned/recovered coordinate under the exact current action fence. */
export async function recordGatewayProviderActionDiscordDeliveryChunk(
  db: Database,
  input: ExactActionClaimInput & {
    expectedMetadata: GatewayDiscordDeliveryExecutionMetadata;
    chunkIndex: number;
    providerMessageId: string;
  }
): Promise<GatewayDiscordDeliveryChunkRecordResult> {
  if (!Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0) {
    throw new RepositoryError('Discord delivery chunk index is invalid');
  }
  if (!isDiscordSnowflake(input.providerMessageId)) {
    throw new RepositoryError('Discord delivery provider message ID is invalid');
  }
  return runDatabaseTransaction(
    db,
    async (txDb) => {
      const current = await exactCurrentClaim(db, txDb, input);
      if (current?.action.kind !== 'deliver_message' && current?.action.kind !== 'discord_notice') {
        return { outcome: 'fenced' };
      }
      const expected = assertUnexecutedDeliveryIdentity(
        input.expectedMetadata,
        current.action.kind
      );
      const persisted = parseGatewayProviderActionExecutionMetadata(
        current.action.execution_metadata,
        current.action.kind
      );
      if (!persisted || !discordDeliveryIdentityMatches(persisted, expected)) {
        return { outcome: 'formatter_mismatch' };
      }
      const checkpoint = persisted.chunks[input.chunkIndex];
      if (!checkpoint) throw new RepositoryError('Discord delivery chunk index is out of bounds');
      if (persisted.chunks.slice(0, input.chunkIndex).some((chunk) => !chunk.provider_message_id)) {
        return { outcome: 'out_of_order' };
      }
      if (checkpoint.provider_message_id) {
        return checkpoint.provider_message_id === input.providerMessageId
          ? { outcome: 'already_recorded', metadata: persisted }
          : { outcome: 'coordinate_conflict' };
      }
      if (persisted.chunks.some((chunk) => chunk.provider_message_id === input.providerMessageId)) {
        return { outcome: 'coordinate_conflict' };
      }
      const metadata: GatewayDiscordDeliveryExecutionMetadata = {
        ...persisted,
        chunks: persisted.chunks.map((chunk, index) =>
          index === input.chunkIndex
            ? { ...chunk, provider_message_id: input.providerMessageId }
            : chunk
        ),
      };
      parseGatewayProviderActionExecutionMetadata(metadata, current.action.kind);
      await update(txDb, gatewayProviderActions)
        .set({ execution_metadata: metadata, updated_at: current.now })
        .where(eq(gatewayProviderActions.id, input.actionId))
        .run();
      return { outcome: 'recorded', metadata };
    },
    { sqliteImmediate: true }
  );
}

interface GatewayDiscordDeliveryRepairBase {
  actionId: GatewayProviderActionID;
  channelId: GatewayChannelID;
  operatorUserId: UserID;
  expectedMetadata: GatewayDiscordDeliveryExecutionMetadata;
}

async function lockRepairTarget(
  db: Database,
  txDb: Database,
  input: GatewayDiscordDeliveryRepairBase
) {
  await lockRowForUpdate(txDb, db, gatewayChannels, eq(gatewayChannels.id, input.channelId));
  await lockRowForUpdate(
    txDb,
    db,
    gatewayProviderActions,
    eq(gatewayProviderActions.id, input.actionId)
  );
  const [channel, action, operator] = await Promise.all([
    select(txDb).from(gatewayChannels).where(eq(gatewayChannels.id, input.channelId)).one(),
    select(txDb)
      .from(gatewayProviderActions)
      .where(eq(gatewayProviderActions.id, input.actionId))
      .one(),
    select(txDb).from(users).where(eq(users.user_id, input.operatorUserId)).one(),
  ]);
  if (!operator) throw new RepositoryError('Discord delivery repair operator is invalid');
  if (
    !channel?.enabled ||
    !channel.provider_installation_id ||
    !action ||
    action.gateway_channel_id !== input.channelId ||
    action.kind !== 'deliver_message' ||
    action.status !== 'dead_letter' ||
    action.provider_installation_id !== channel.provider_installation_id ||
    action.provider_config_generation !== channel.provider_config_generation
  ) {
    return null;
  }
  const expected = assertUnexecutedDeliveryIdentity(input.expectedMetadata);
  const persisted = parseGatewayProviderActionExecutionMetadata(
    action.execution_metadata,
    action.kind
  );
  if (!persisted || !discordDeliveryIdentityMatches(persisted, expected)) return null;
  return { action, persisted, now: await transactionNow(db, txDb, input.channelId) };
}

/**
 * Audited no-POST repair after an operator has independently identified every
 * exact Discord coordinate. The only API exposure is the admin-only,
 * PostgreSQL-only, no-publish operation service; there is no blind retry UI.
 */
export async function repairGatewayProviderActionDiscordDeliveryCoordinates(
  db: Database,
  input: GatewayDiscordDeliveryRepairBase & { providerMessageIds: string[] }
): Promise<boolean> {
  if (
    input.providerMessageIds.length !== input.expectedMetadata.chunks.length ||
    new Set(input.providerMessageIds).size !== input.providerMessageIds.length ||
    input.providerMessageIds.some((id) => !isDiscordSnowflake(id))
  ) {
    throw new RepositoryError('Discord delivery repair coordinates are invalid');
  }
  return runDatabaseTransaction(
    db,
    async (txDb) => {
      const target = await lockRepairTarget(db, txDb, input);
      if (!target) return false;
      if (
        target.persisted.chunks.some(
          (chunk, index) =>
            chunk.provider_message_id !== undefined &&
            chunk.provider_message_id !== input.providerMessageIds[index]
        )
      ) {
        throw new RepositoryError('Discord delivery repair conflicts with a durable coordinate');
      }
      const metadata: GatewayDiscordDeliveryExecutionMetadata = {
        ...target.persisted,
        chunks: target.persisted.chunks.map((chunk, index) => ({
          ...chunk,
          provider_message_id: input.providerMessageIds[index],
        })),
        repair: {
          outcome: 'coordinates_recorded',
          operator_user_id: input.operatorUserId,
          repaired_at: target.now.toISOString(),
        },
      };
      parseGatewayProviderActionExecutionMetadata(metadata, 'deliver_message');
      const result = parseGatewayProviderActionResult(
        {
          kind: 'deliver_message',
          provider_message_id: input.providerMessageIds.at(-1),
        },
        'deliver_message'
      );
      const mutation = await update(txDb, gatewayProviderActions)
        .set({
          execution_metadata: metadata,
          result_metadata: result,
          status: 'completed',
          completed_at: target.now,
          updated_at: target.now,
          last_error_code: null,
        })
        .where(eq(gatewayProviderActions.id, input.actionId))
        .run();
      return mutation.rowsAffected === 1;
    },
    { sqliteImmediate: true }
  );
}

/** Audited abandonment never performs provider work and preserves partial coordinates. */
export async function abandonGatewayProviderActionDiscordDelivery(
  db: Database,
  input: GatewayDiscordDeliveryRepairBase
): Promise<boolean> {
  return runDatabaseTransaction(
    db,
    async (txDb) => {
      const target = await lockRepairTarget(db, txDb, input);
      if (!target) return false;
      const metadata: GatewayDiscordDeliveryExecutionMetadata = {
        ...target.persisted,
        repair: {
          outcome: 'abandoned',
          operator_user_id: input.operatorUserId,
          repaired_at: target.now.toISOString(),
        },
      };
      parseGatewayProviderActionExecutionMetadata(metadata, 'deliver_message');
      const mutation = await update(txDb, gatewayProviderActions)
        .set({
          execution_metadata: metadata,
          status: 'canceled',
          canceled_at: target.now,
          updated_at: target.now,
          last_error_code: 'operator_abandoned_delivery',
        })
        .where(eq(gatewayProviderActions.id, input.actionId))
        .run();
      return mutation.rowsAffected === 1;
    },
    { sqliteImmediate: true }
  );
}

export type GatewayProviderProgressHandleUpdate = 'updated' | 'superseded' | 'fenced';

/**
 * Persist/clear one progress handle only while both the exact provider action
 * claim and exact mapping task/revision snapshot still match.
 */
export async function updateGatewayProviderActionProgressHandle(
  db: Database,
  input: ExactActionClaimInput & {
    mappingId: string;
    expectedTaskId: TaskID;
    expectedRevision: number;
    expectedProviderMessageId?: string | null;
    providerMessageId: string | null;
  }
): Promise<GatewayProviderProgressHandleUpdate> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) {
    throw new RepositoryError('Discord progress revision is invalid');
  }
  for (const value of [input.expectedProviderMessageId, input.providerMessageId]) {
    if (value !== undefined && value !== null && !isDiscordSnowflake(value)) {
      throw new RepositoryError('Discord progress provider message ID is invalid');
    }
  }
  return runDatabaseTransaction(
    db,
    async (txDb) => {
      const current = await exactCurrentClaim(db, txDb, input);
      if (!current) return 'fenced';
      if (
        current.action.thread_session_map_id !== input.mappingId ||
        current.action.session_id === null ||
        current.action.task_id !== input.expectedTaskId
      ) {
        return 'superseded';
      }
      await lockRowForUpdate(txDb, db, threadSessionMap, eq(threadSessionMap.id, input.mappingId));
      const mapping = await select(txDb)
        .from(threadSessionMap)
        .where(eq(threadSessionMap.id, input.mappingId))
        .one();
      if (
        mapping?.status !== 'active' ||
        mapping.channel_id !== input.channelId ||
        mapping.session_id !== current.action.session_id
      ) {
        return 'superseded';
      }
      let metadata = {
        ...((mapping.metadata as Record<string, unknown> | null) ?? {}),
      };
      const progress = parseDiscordProgressMetadata(metadata);
      if (
        !progress ||
        progress.taskId !== input.expectedTaskId ||
        progress.revision !== input.expectedRevision ||
        (input.expectedProviderMessageId !== undefined &&
          (progress.providerMessageId ?? null) !== input.expectedProviderMessageId)
      ) {
        return 'superseded';
      }
      if (input.providerMessageId) {
        metadata.discord_progress_message_id = input.providerMessageId;
        const armed = progress.cleanupDebt.find((debt) => debt.taskId === input.expectedTaskId);
        if (armed) {
          metadata = removeDiscordProgressCleanupDebt(metadata, armed).metadata;
        }
      } else {
        delete metadata.discord_progress_message_id;
      }
      await update(txDb, threadSessionMap)
        .set({ metadata })
        .where(eq(threadSessionMap.id, mapping.id))
        .run();
      return 'updated';
    },
    { sqliteImmediate: true }
  );
}

/** Arm stable-nonce cleanup before a create call can escape its later DB fence. */
export async function armGatewayProviderActionProgressCreate(
  db: Database,
  input: ExactActionClaimInput & {
    mappingId: ThreadSessionMapID;
    expectedTaskId: TaskID;
    expectedRevision: number;
  }
): Promise<GatewayProviderProgressHandleUpdate> {
  return runDatabaseTransaction(
    db,
    async (txDb) => {
      const current = await exactCurrentClaim(db, txDb, input);
      if (!current) return 'fenced';
      if (
        current.action.kind !== 'discord_progress' ||
        current.action.thread_session_map_id !== input.mappingId ||
        current.action.task_id !== input.expectedTaskId
      ) {
        return 'superseded';
      }
      await lockRowForUpdate(txDb, db, threadSessionMap, eq(threadSessionMap.id, input.mappingId));
      const mapping = await select(txDb)
        .from(threadSessionMap)
        .where(eq(threadSessionMap.id, input.mappingId))
        .one();
      if (
        mapping?.status !== 'active' ||
        mapping.channel_id !== input.channelId ||
        mapping.session_id !== current.action.session_id
      ) {
        return 'superseded';
      }
      const metadata = { ...((mapping.metadata as Record<string, unknown> | null) ?? {}) };
      const progress = parseDiscordProgressMetadata(metadata);
      if (
        !progress ||
        progress.taskId !== input.expectedTaskId ||
        progress.revision !== input.expectedRevision ||
        progress.providerMessageId
      ) {
        return 'superseded';
      }
      const next = addDiscordProgressCleanupDebt(metadata, { taskId: input.expectedTaskId });
      await update(txDb, threadSessionMap)
        .set({ metadata: next })
        .where(eq(threadSessionMap.id, mapping.id))
        .run();
      return 'updated';
    },
    { sqliteImmediate: true }
  );
}

/** Remove only one exact cleanup debt after its provider row is gone. */
export async function settleGatewayProviderActionProgressCleanupDebt(
  db: Database,
  input: ExactActionClaimInput & {
    mappingId: ThreadSessionMapID;
    debt: DiscordProgressCleanupDebt;
  }
): Promise<GatewayProviderProgressHandleUpdate> {
  if (
    !isDiscordSnowflake(input.debt.providerMessageId) &&
    input.debt.providerMessageId !== undefined
  ) {
    throw new RepositoryError('Discord progress cleanup provider message ID is invalid');
  }
  return runDatabaseTransaction(
    db,
    async (txDb) => {
      const current = await exactCurrentClaim(db, txDb, input);
      if (!current) return 'fenced';
      if (current.action.thread_session_map_id !== input.mappingId) return 'superseded';
      await lockRowForUpdate(txDb, db, threadSessionMap, eq(threadSessionMap.id, input.mappingId));
      const mapping = await select(txDb)
        .from(threadSessionMap)
        .where(eq(threadSessionMap.id, input.mappingId))
        .one();
      if (
        mapping?.status !== 'active' ||
        mapping.channel_id !== input.channelId ||
        mapping.session_id !== current.action.session_id
      ) {
        return 'superseded';
      }
      const metadata = { ...((mapping.metadata as Record<string, unknown> | null) ?? {}) };
      const removed = removeDiscordProgressCleanupDebt(metadata, input.debt);
      if (!removed.removed) return 'superseded';
      await update(txDb, threadSessionMap)
        .set({ metadata: removed.metadata })
        .where(eq(threadSessionMap.id, mapping.id))
        .run();
      return 'updated';
    },
    { sqliteImmediate: true }
  );
}

export type GatewayProviderProgressCleanupDebtRecord =
  | 'updated'
  | 'already_owned'
  | 'superseded'
  | 'fenced';

/**
 * Preserve a stale-success coordinate under the still-current listener fence.
 * This deliberately does not require the superseded action claim.
 */
export async function recordGatewayProviderActionProgressCleanupDebt(
  db: Database,
  input: {
    channelId: GatewayChannelID;
    listenerClaimToken: string;
    listenerGeneration: number;
    mappingId: ThreadSessionMapID;
    taskId: TaskID;
    providerMessageId: string;
  }
): Promise<GatewayProviderProgressCleanupDebtRecord> {
  if (!isDiscordSnowflake(input.providerMessageId)) {
    throw new RepositoryError('Discord progress cleanup provider message ID is invalid');
  }
  return runDatabaseTransaction(
    db,
    async (txDb) => {
      await lockRowForUpdate(txDb, db, gatewayChannels, eq(gatewayChannels.id, input.channelId));
      await lockRowForUpdate(txDb, db, threadSessionMap, eq(threadSessionMap.id, input.mappingId));
      const [channel, mapping] = await Promise.all([
        select(txDb).from(gatewayChannels).where(eq(gatewayChannels.id, input.channelId)).one(),
        select(txDb).from(threadSessionMap).where(eq(threadSessionMap.id, input.mappingId)).one(),
      ]);
      const now = await transactionNow(db, txDb, input.channelId);
      if (
        !channel?.enabled ||
        channel.channel_type !== 'discord' ||
        channel.listener_claim_token !== input.listenerClaimToken ||
        channel.listener_generation !== input.listenerGeneration ||
        !channel.listener_lease_expires_at ||
        new Date(channel.listener_lease_expires_at).getTime() <= now.getTime()
      ) {
        return 'fenced';
      }
      if (mapping?.status !== 'active' || mapping.channel_id !== input.channelId) {
        return 'superseded';
      }
      const metadata = { ...((mapping.metadata as Record<string, unknown> | null) ?? {}) };
      const progress = parseDiscordProgressMetadata(metadata);
      if (!progress) return 'superseded';
      if (
        progress.taskId === input.taskId &&
        progress.providerMessageId === input.providerMessageId
      ) {
        return 'already_owned';
      }
      const next = addDiscordProgressCleanupDebt(metadata, {
        taskId: input.taskId,
        providerMessageId: input.providerMessageId,
      });
      await update(txDb, threadSessionMap)
        .set({ metadata: next })
        .where(eq(threadSessionMap.id, mapping.id))
        .run();
      return 'updated';
    },
    { sqliteImmediate: true }
  );
}

/** Convert the current task's activity into non-expiring cleanup under an exact action fence. */
export async function prepareGatewayProviderActionProgressCleanup(
  db: Database,
  input: ExactActionClaimInput & {
    mappingId: ThreadSessionMapID;
    taskId: TaskID;
  }
): Promise<GatewayProviderProgressHandleUpdate> {
  return runDatabaseTransaction(
    db,
    async (txDb) => {
      const current = await exactCurrentClaim(db, txDb, input);
      if (!current) return 'fenced';
      if (
        current.action.thread_session_map_id !== input.mappingId ||
        current.action.task_id !== input.taskId
      ) {
        return 'superseded';
      }
      await lockRowForUpdate(txDb, db, threadSessionMap, eq(threadSessionMap.id, input.mappingId));
      const mapping = await select(txDb)
        .from(threadSessionMap)
        .where(eq(threadSessionMap.id, input.mappingId))
        .one();
      if (
        mapping?.status !== 'active' ||
        mapping.channel_id !== input.channelId ||
        mapping.session_id !== current.action.session_id
      ) {
        return 'superseded';
      }
      const metadata = { ...((mapping.metadata as Record<string, unknown> | null) ?? {}) };
      const progress = parseDiscordProgressMetadata(metadata);
      if (!progress || progress.taskId !== input.taskId) return 'superseded';
      const advanced = advanceDiscordProgressMetadata(metadata, {
        taskId: input.taskId,
        state: 'done',
      });
      if (advanced.changed) {
        await update(txDb, threadSessionMap)
          .set({ metadata: advanced.metadata })
          .where(eq(threadSessionMap.id, mapping.id))
          .run();
      }
      return 'updated';
    },
    { sqliteImmediate: true }
  );
}

export async function retryGatewayProviderAction(
  db: Database,
  input: ExactActionClaimInput & { errorCode: string; retryAfterMs: number }
): Promise<boolean> {
  assertProviderActionSanitizedErrorCode(input.errorCode);
  if (
    !Number.isInteger(input.retryAfterMs) ||
    input.retryAfterMs < 0 ||
    input.retryAfterMs > GATEWAY_PROVIDER_ACTION_MAX_RETRY_MS
  ) {
    throw new RepositoryError('Gateway provider action retry delay is invalid');
  }
  return runDatabaseTransaction(
    db,
    async (txDb) => {
      const current = await exactCurrentClaim(db, txDb, input);
      if (!current) return false;
      const mutation = await update(txDb, gatewayProviderActions)
        .set({
          status: 'retry',
          not_before: new Date(current.now.getTime() + input.retryAfterMs),
          updated_at: current.now,
          last_error_code: input.errorCode,
          claim_token: null,
          claim_expires_at: null,
          claim_listener_token: null,
          claim_listener_generation: null,
          claim_instance_id: null,
          claim_boot_id: null,
        })
        .where(eq(gatewayProviderActions.id, input.actionId))
        .run();
      return mutation.rowsAffected === 1;
    },
    { sqliteImmediate: true }
  );
}

export async function deadLetterGatewayProviderAction(
  db: Database,
  input: ExactActionClaimInput & { errorCode: string }
): Promise<boolean> {
  assertProviderActionSanitizedErrorCode(input.errorCode);
  return runDatabaseTransaction(
    db,
    async (txDb) => {
      const current = await exactCurrentClaim(db, txDb, input);
      if (!current) return false;
      const mutation = await update(txDb, gatewayProviderActions)
        .set({
          status: 'dead_letter',
          dead_lettered_at: current.now,
          updated_at: current.now,
          last_error_code: input.errorCode,
          claim_token: null,
          claim_expires_at: null,
          claim_listener_token: null,
          claim_listener_generation: null,
          claim_instance_id: null,
          claim_boot_id: null,
        })
        .where(eq(gatewayProviderActions.id, input.actionId))
        .run();
      return mutation.rowsAffected === 1;
    },
    { sqliteImmediate: true }
  );
}
