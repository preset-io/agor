import { and, asc, desc, eq, getTableColumns, inArray } from 'drizzle-orm';
import { DISCORD_METADATA_KEY } from '../../gateway/discord-identifiers';
import { generateId } from '../../lib/ids';
import type {
  GatewayChannelID,
  GatewayChatCommand,
  GatewayChatCommandReceipt,
  GatewayChatCommandSnapshot,
  GatewayInboundEvent,
  SessionID,
  Task,
  TaskID,
  UserID,
} from '../../types';
import { EXECUTING_TASK_STATUSES, hasMinimumRole, ROLES, TaskStatus } from '../../types';
import type { Database } from '../client';
import {
  getDatabaseWallClock,
  insert,
  isPostgresDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  branches,
  gatewayChannels,
  gatewayInboundEvents,
  sessions,
  type ThreadSessionMapRow,
  tasks,
  threadSessionMap,
} from '../schema';
import { RepositoryError } from './base';
import { BranchRepository } from './branches';
import { GatewayInboundEventRepository } from './gateway-inbound-events';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

const RECEIPT_KEY = 'chat_command_v1';
type EventAuthority = Pick<
  GatewayInboundEvent,
  | 'id'
  | 'processing_token'
  | 'provider_config_generation'
  | 'verified_app_id'
  | 'verified_tenant_id'
  | 'thread_id'
  | 'gateway_channel_id'
>;

export interface GatewayChatCommandInput {
  channelId: GatewayChannelID;
  threadId: string;
  sessionId: SessionID | null;
  userId: UserID;
  command: Exclude<GatewayChatCommand, 'help'>;
  expected: GatewayChatCommandSnapshot | null;
  /** Canonical and legacy/alias coordinates for an unmentioned thread command. */
  implicitThreadIds?: string[];
  /** Trusted listener/HTTP claim, not a caller-supplied event ID alone. */
  event?: EventAuthority;
  /** Standalone Slack/Discord still need durable command identity. */
  providerEventId?: string;
  listenerToken?: string;
  /** Trusted deployment policy, identical to the public queue-management gate. */
  allowSuperadmin?: boolean;
}

/**
 * DB-only command admission. The caller holds the tenant authorization fence.
 * Lock order: user, branch, session, channel, occurrence, tasks. Queue mutation,
 * termination claim and replay receipt commit together. No provider/process I/O.
 */
export class GatewayChatCommandRepository {
  constructor(private db: Database) {}

  /**
   * Tenant-scoped, provider-scoped connected targets; never guess by which
   * session is busy or by the sender's differing permissions on each bot.
   * Elect one mapping to reply, including when several bots share one Session.
   * Aliases use the same retained metadata as ordinary inbound routing.
   */
  async resolveImplicitTarget(
    channelId: GatewayChannelID,
    threadIds: string[]
  ): Promise<{
    outcome: 'selected' | 'ambiguous' | 'not_target';
    sessionId: SessionID | null;
  }> {
    const channel = await select(this.db, { channel_type: gatewayChannels.channel_type })
      .from(gatewayChannels)
      .where(eq(gatewayChannels.id, channelId))
      .one();
    if (!channel) return { outcome: 'not_target', sessionId: null };
    const rows: ThreadSessionMapRow[] = await select(this.db, getTableColumns(threadSessionMap))
      .from(threadSessionMap)
      .innerJoin(gatewayChannels, eq(gatewayChannels.id, threadSessionMap.channel_id))
      .innerJoin(sessions, eq(sessions.session_id, threadSessionMap.session_id))
      .where(
        and(
          eq(gatewayChannels.channel_type, channel.channel_type),
          eq(gatewayChannels.enabled, true),
          eq(threadSessionMap.status, 'active'),
          eq(sessions.archived, false),
          eq(sessions.branch_id, gatewayChannels.target_branch_id)
        )
      )
      .orderBy(asc(threadSessionMap.created_at), asc(threadSessionMap.id))
      .all();
    const candidates = rows.filter((row) => {
      const metadata = row.metadata ?? {};
      const aliases = [metadata.gateway_reply_aliases, metadata.slack_thread_aliases].flatMap(
        (value) => (Array.isArray(value) ? value : [])
      );
      return threadIds.some((id) => row.thread_id === id || aliases.includes(id));
    });
    const first = candidates[0];
    if (!first || first.channel_id !== channelId) return { outcome: 'not_target', sessionId: null };
    const distinctSessions = new Set(candidates.map((row) => row.session_id));
    return {
      outcome: distinctSessions.size === 1 ? 'selected' : 'ambiguous',
      sessionId: first.session_id as SessionID,
    };
  }

  async snapshot(sessionId: SessionID): Promise<GatewayChatCommandSnapshot> {
    const active = await select(this.db, { task_id: tasks.task_id })
      .from(tasks)
      .where(
        and(eq(tasks.session_id, sessionId), inArray(tasks.status, [...EXECUTING_TASK_STATUSES]))
      )
      .orderBy(desc(tasks.created_at), desc(tasks.task_id))
      .limit(1)
      .one();
    const queued = await select(this.db, { task_id: tasks.task_id })
      .from(tasks)
      .where(and(eq(tasks.session_id, sessionId), eq(tasks.status, TaskStatus.QUEUED)))
      .orderBy(asc(tasks.queue_position), asc(tasks.created_at), asc(tasks.task_id))
      .all();
    return {
      task_id: active?.task_id ?? null,
      queued_task_ids: queued.map((t: { task_id: TaskID }) => t.task_id),
    } as GatewayChatCommandSnapshot;
  }

  async execute(input: GatewayChatCommandInput): Promise<{
    receipt: GatewayChatCommandReceipt;
    removed: Task[];
    claimed: Task | null;
  }> {
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        const actor = await new UsersRepository(tx).getWriteAuthorityProjectionForUpdate(
          input.userId
        );
        const receipt: GatewayChatCommandReceipt = {
          command: input.command,
          session_id: input.sessionId,
          user_id: input.userId,
          task_id: null,
          queued_count: 0,
          cancelled_count: 0,
          outcome: 'denied',
        };
        const denied = { receipt, removed: [], claimed: null };
        if (!actor || !hasMinimumRole(actor.role, ROLES.MEMBER)) return denied;
        const initialChannel = await select(tx)
          .from(gatewayChannels)
          .where(eq(gatewayChannels.id, input.channelId))
          .one();
        if (!initialChannel) return denied;
        await lockRowForUpdate(
          tx,
          tx,
          branches,
          eq(branches.branch_id, initialChannel.target_branch_id)
        );
        const branchRepo = new BranchRepository(tx);
        const branch = await branchRepo.findById(initialChannel.target_branch_id);
        if (!branch) return denied;
        let canManageQueue = true;
        if (input.sessionId) {
          await lockRowForUpdate(tx, tx, sessions, eq(sessions.session_id, input.sessionId));
          const session = await new SessionRepository(tx).findById(input.sessionId);
          if (!session || session.branch_id !== branch.branch_id) return denied;
          const authority = await branchRepo.resolveSessionPromptAuthority(
            branch.branch_id,
            input.userId,
            session.created_by as UserID,
            session.sdk_home_scope
          );
          if (!authority.allowed) return denied;
          // Resolve before admission; enforce only for the selected target.
          // Ambiguous/non-target commands do not manage a queue.
          if (
            input.command === 'stop-clear' &&
            !(input.allowSuperadmin === true && hasMinimumRole(actor.role, ROLES.SUPERADMIN)) &&
            (await branchRepo.resolveUserAccess(branch, input.userId)).can !== 'all'
          )
            canManageQueue = false;
        } else if (
          !['session', 'prompt', 'all'].includes(
            (await branchRepo.resolveUserAccess(branch, input.userId)).can
          )
        )
          return denied;

        await lockRowForUpdate(tx, tx, gatewayChannels, eq(gatewayChannels.id, input.channelId));
        const channel = await select(tx)
          .from(gatewayChannels)
          .where(eq(gatewayChannels.id, input.channelId))
          .one();
        if (!channel?.enabled || channel.target_branch_id !== branch.branch_id) return denied;
        const now = await getDatabaseWallClock(
          tx,
          gatewayChannels,
          eq(gatewayChannels.id, input.channelId)
        );
        if (!now) throw new RepositoryError('Gateway command channel is unavailable');
        if (
          input.listenerToken &&
          (channel.listener_claim_token !== input.listenerToken ||
            !channel.listener_lease_expires_at ||
            new Date(channel.listener_lease_expires_at) <= now)
        ) {
          throw new RepositoryError('Gateway command listener ownership changed');
        }
        if (channel.channel_type === 'teams') {
          if (!input.event)
            throw new RepositoryError('Gateway command requires verified event authority');
          await new GatewayInboundEventRepository(tx).assertTeamsTaskAdmission(input.event);
        }
        if (isPostgresDatabase(tx) && !input.event)
          throw new RepositoryError(
            'Gateway commands require durable event authority on PostgreSQL'
          );
        if (
          input.event &&
          channel.channel_type !== 'teams' &&
          (!input.listenerToken || input.event.processing_token !== input.listenerToken)
        )
          throw new RepositoryError('Gateway commands require listener authority');
        if (!input.event && !input.providerEventId)
          throw new RepositoryError('Gateway command requires a provider occurrence');
        // Namespaced standalone receipts cannot collide with listener event IDs.
        const predicate = input.event
          ? and(
              eq(gatewayInboundEvents.id, input.event.id),
              eq(gatewayInboundEvents.gateway_channel_id, input.channelId)
            )!
          : and(
              eq(gatewayInboundEvents.provider_event_id, `chat-command:${input.providerEventId}`),
              eq(gatewayInboundEvents.gateway_channel_id, input.channelId)
            )!;
        if (!input.event) {
          await insert(tx, gatewayInboundEvents)
            .values({
              id: generateId(),
              gateway_channel_id: input.channelId,
              provider_event_id: `chat-command:${input.providerEventId}`,
              thread_id: input.threadId,
              status: 'processing',
              processing_token: generateId(),
              processing_expires_at: now,
              received_at: now,
              next_attempt_at: now,
            })
            .onConflictDoNothing()
            .run();
        }
        await lockRowForUpdate(tx, tx, gatewayInboundEvents, predicate);
        const event = await select(tx).from(gatewayInboundEvents).where(predicate).one();
        // Re-read the clock after a possible event-lock wait; transaction-start
        // time must not keep an expired provider/listener lease authoritative.
        const admittedAt = await getDatabaseWallClock(tx, gatewayInboundEvents, predicate);
        if (
          input.listenerToken &&
          admittedAt &&
          channel.listener_lease_expires_at &&
          new Date(channel.listener_lease_expires_at) <= admittedAt
        ) {
          throw new RepositoryError('Gateway command listener ownership changed');
        }
        if (
          !event ||
          !admittedAt ||
          // Occurrence identity precedes Discord preparation; routing uses the
          // verified public-thread reply coordinate recorded by preparation.
          (input.event && event.thread_id !== input.event.thread_id) ||
          (event.thread_id !== input.threadId &&
            !(
              channel.channel_type === 'discord' &&
              event.delivery_metadata?.[DISCORD_METADATA_KEY.threadId] === input.threadId
            )) ||
          (input.event &&
            (event.status !== 'processing' ||
              event.processing_token !== input.event.processing_token ||
              new Date(event.processing_expires_at) <= admittedAt))
        )
          throw new RepositoryError('Gateway command event authority changed');
        const stored = event.delivery_metadata?.[RECEIPT_KEY] as
          | GatewayChatCommandReceipt
          | undefined;
        if (stored) {
          if (
            stored.command !== input.command ||
            (stored.session_id !== null && stored.session_id !== input.sessionId) ||
            stored.user_id !== input.userId
          )
            throw new RepositoryError('Gateway command occurrence is already bound');
          if (!canManageQueue && !['ambiguous', 'not_target'].includes(stored.outcome))
            return denied;
          return { receipt: stored, removed: [], claimed: null };
        }

        let removed: Task[] = [];
        let claimed: Task | null = null;
        const implicitTarget = input.implicitThreadIds
          ? await new GatewayChatCommandRepository(tx).resolveImplicitTarget(
              input.channelId,
              input.implicitThreadIds
            )
          : null;
        if (implicitTarget && implicitTarget.outcome !== 'selected') {
          // Persist ambiguity and non-target receipts too: a later redelivery
          // must not act merely because another bot disconnected in between.
          receipt.outcome = implicitTarget.outcome;
        } else if (implicitTarget && implicitTarget.sessionId !== input.sessionId) {
          receipt.outcome = 'not_target';
        } else if (!input.sessionId) {
          // Persist the no-session observation too. A redelivery after a new
          // mapping appears must not acquire that mapping's task or queue.
          receipt.outcome = 'idle';
        } else {
          // Queue management requires Manager even when the queue is empty,
          // including replay of a previously authorized selected command.
          if (!canManageQueue) return denied;
          const expected = input.expected;
          if (!expected) throw new RepositoryError('Gateway command requires a task snapshot');
          const taskRepo = new TaskRepository(tx);
          const current = await new GatewayChatCommandRepository(tx).snapshot(input.sessionId);
          const sameQueue =
            current.queued_task_ids.length === expected.queued_task_ids.length &&
            current.queued_task_ids.every((id, i) => id === expected.queued_task_ids[i]);
          receipt.queued_count = current.queued_task_ids.length;
          if (input.command === 'stop' && current.queued_task_ids.length > 0) {
            receipt.outcome = 'queue_not_empty';
          } else if (current.task_id !== expected.task_id || !sameQueue) {
            receipt.outcome = 'condition_changed';
          } else {
            // The Session lock excludes both admission and dispatch until commit.
            if (input.command === 'stop-clear' && current.queued_task_ids.length > 0) {
              const cancelled = await taskRepo.mutateQueued(input.sessionId, {
                cancel: current.queued_task_ids,
              });
              if (cancelled.outcome !== 'changed')
                throw new RepositoryError('Gateway command queue changed');
              removed = cancelled.removed;
              receipt.cancelled_count = removed.length;
            }
            receipt.task_id = current.task_id;
            receipt.outcome = current.task_id ? 'requested' : 'idle';
            if (current.task_id) {
              const result = await taskRepo.claimTermination({
                taskId: current.task_id,
                cause: 'user_stop',
                errorMessage: 'Stopped by user.',
                requestedBy: { requested_by_user_id: input.userId, requested_via: 'api' },
              });
              if (result.outcome !== 'claimed' && result.outcome !== 'unchanged')
                throw new RepositoryError('Gateway command task changed');
              claimed = result.task;
            }
          }
        }
        await update(tx, gatewayInboundEvents)
          .set({
            delivery_metadata: { ...event.delivery_metadata, [RECEIPT_KEY]: receipt },
            ...(!input.event
              ? { status: 'completed' as const, completed_at: now, session_id: input.sessionId }
              : {}),
          })
          .where(predicate)
          .run();
        return { receipt, removed, claimed };
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }
}
