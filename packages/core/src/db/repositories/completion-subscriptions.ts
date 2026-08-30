/** Durable designated-child completion propagation and callback outbox. */

import type {
  BranchID,
  CompletionDelegationHop,
  CompletionSubscription,
  CompletionSubscriptionID,
  CompletionTerminalSnapshot,
  SessionID,
  TaskID,
  UserID,
} from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { and, asc, eq, inArray, isNotNull, isNull, like, lte, or, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database, SystemDatabase } from '../client';
import { insert, isSQLiteDatabase, select, update } from '../database-wrapper';
import {
  type CompletionSubscriptionInsert,
  type CompletionSubscriptionRow,
  completionSubscriptions,
  tasks,
} from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import {
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';

const ACTIVE_STATES = ['pending', 'delegated', 'running_downstream'] as const;
const DELIVERY_STATES = ['terminal_pending', 'delivery_failed'] as const;

export interface CompletionSubscriptionDiscoveryRef {
  tenant_id: string;
  subscription_id: CompletionSubscriptionID;
}

export interface CreateCompletionSubscriptionInput {
  subscription_id?: CompletionSubscriptionID;
  requested_by_user_id: UserID;
  origin_session_id: SessionID;
  origin_task_id: TaskID;
  callback_session_id: SessionID;
  root_session_id: SessionID;
  root_task_id: TaskID;
  root_branch_id?: BranchID;
  max_depth?: number;
}

export class CompletionContinuationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompletionContinuationConflictError';
  }
}

function asIso(value: Date | string | number): string {
  return new Date(value).toISOString();
}

function rowToSubscription(row: CompletionSubscriptionRow): CompletionSubscription {
  return {
    subscription_id: row.subscription_id as CompletionSubscriptionID,
    propagation_mode: 'root',
    join_policy: 'designated_child',
    state: row.state as CompletionSubscription['state'],
    requested_by_user_id: row.requested_by_user_id as UserID,
    origin_session_id: row.origin_session_id as SessionID,
    origin_task_id: row.origin_task_id as TaskID,
    callback_session_id: (row.callback_session_id as SessionID | null) ?? null,
    root_session_id: (row.root_session_id as SessionID | null) ?? null,
    root_task_id: (row.root_task_id as TaskID | null) ?? null,
    active_session_id: (row.active_session_id as SessionID | null) ?? null,
    active_task_id: (row.active_task_id as TaskID | null) ?? null,
    path: (row.path ?? []) as CompletionDelegationHop[],
    max_depth: row.max_depth,
    terminal_status: row.terminal_status as CompletionSubscription['terminal_status'],
    terminal_snapshot:
      (row.terminal_snapshot as CompletionTerminalSnapshot | null | undefined) ?? null,
    delivery_task_id: (row.delivery_task_id as TaskID | null) ?? null,
    delivery_attempt_count: row.delivery_attempt_count,
    next_delivery_at: row.next_delivery_at ? asIso(row.next_delivery_at) : null,
    last_delivery_error_code: row.last_delivery_error_code ?? null,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
    delegated_at: row.delegated_at ? asIso(row.delegated_at) : null,
    terminal_at: row.terminal_at ? asIso(row.terminal_at) : null,
    delivered_at: row.delivered_at ? asIso(row.delivered_at) : null,
  };
}

export class CompletionSubscriptionRepository {
  constructor(private readonly db: Database) {}

  async createRoot(input: CreateCompletionSubscriptionInput): Promise<CompletionSubscription> {
    const maxDepth = input.max_depth ?? 8;
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 32) {
      throw new RepositoryError('Completion propagation max depth must be between 1 and 32');
    }
    const now = new Date();
    const tenantId = isSQLiteDatabase(this.db) ? undefined : getCurrentTenantId();
    if (!isSQLiteDatabase(this.db) && !tenantId) {
      throw new RepositoryError('Completion subscription creation requires tenant identity');
    }
    const row: CompletionSubscriptionInsert = {
      subscription_id: input.subscription_id ?? (generateId() as CompletionSubscriptionID),
      propagation_mode: 'root',
      join_policy: 'designated_child',
      state: 'pending',
      requested_by_user_id: input.requested_by_user_id,
      origin_session_id: input.origin_session_id,
      origin_task_id: input.origin_task_id,
      callback_session_id: input.callback_session_id,
      root_session_id: input.root_session_id,
      root_task_id: input.root_task_id,
      active_session_id: input.root_session_id,
      active_task_id: input.root_task_id,
      path: [
        {
          session_id: input.root_session_id,
          task_id: input.root_task_id,
          ...(input.root_branch_id ? { branch_id: input.root_branch_id } : {}),
        },
      ],
      max_depth: maxDepth,
      terminal_status: null,
      terminal_snapshot: null,
      delivery_task_id: null,
      delivery_attempt_count: 0,
      next_delivery_at: null,
      last_delivery_error_code: null,
      created_at: now,
      updated_at: now,
      delegated_at: null,
      terminal_at: null,
      delivered_at: null,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    };
    await insert(this.db, completionSubscriptions).values(row).run();
    return rowToSubscription(row as CompletionSubscriptionRow);
  }

  async get(id: CompletionSubscriptionID): Promise<CompletionSubscription> {
    const row = await select(this.db)
      .from(completionSubscriptions)
      .where(eq(completionSubscriptions.subscription_id, id))
      .one();
    if (!row) throw new EntityNotFoundError('CompletionSubscription', id);
    return rowToSubscription(row);
  }

  async resolveId(id: string): Promise<CompletionSubscriptionID> {
    return (await resolveByShortIdPrefix(id, 'CompletionSubscription', async (pattern) => {
      const rows = await select(this.db, { id: completionSubscriptions.subscription_id })
        .from(completionSubscriptions)
        .where(like(completionSubscriptions.subscription_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((row: { id: string }) => row.id);
    })) as CompletionSubscriptionID;
  }

  async findActiveForTask(taskId: TaskID): Promise<CompletionSubscription | null> {
    const rows = await select(this.db)
      .from(completionSubscriptions)
      .where(
        and(
          eq(completionSubscriptions.active_task_id, taskId),
          inArray(completionSubscriptions.state, [...ACTIVE_STATES])
        )
      )
      .limit(2)
      .all();
    if (rows.length > 1) {
      throw new RepositoryError(`Task ${taskId} owns more than one active completion subscription`);
    }
    return rows[0] ? rowToSubscription(rows[0]) : null;
  }

  async designateContinuation(input: {
    subscription_id?: CompletionSubscriptionID;
    from_task_id: TaskID;
    to_session_id: SessionID;
    to_task_id: TaskID;
    to_branch_id?: BranchID;
  }): Promise<CompletionSubscription> {
    const current = input.subscription_id
      ? await this.get(input.subscription_id)
      : await this.findActiveForTask(input.from_task_id);
    if (
      !current ||
      current.active_task_id !== input.from_task_id ||
      !ACTIVE_STATES.includes(current.state as (typeof ACTIVE_STATES)[number])
    ) {
      throw new CompletionContinuationConflictError(
        'The current task has no active root completion request to continue'
      );
    }
    if (current.path.length >= current.max_depth) {
      throw new CompletionContinuationConflictError(
        `Completion propagation reached its maximum depth of ${current.max_depth}`
      );
    }
    if (current.path.some((hop) => hop.task_id === input.to_task_id)) {
      throw new CompletionContinuationConflictError('Completion continuation would create a cycle');
    }

    const now = new Date();
    const path: CompletionDelegationHop[] = [
      ...current.path,
      {
        session_id: input.to_session_id,
        task_id: input.to_task_id,
        ...(input.to_branch_id ? { branch_id: input.to_branch_id } : {}),
        delegated_at: now.toISOString(),
      },
    ];
    const result = await update(this.db, completionSubscriptions)
      .set({
        active_session_id: input.to_session_id,
        active_task_id: input.to_task_id,
        path,
        state: 'delegated',
        delegated_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(completionSubscriptions.subscription_id, current.subscription_id),
          eq(completionSubscriptions.active_task_id, input.from_task_id),
          inArray(completionSubscriptions.state, [...ACTIVE_STATES])
        )
      )
      .run();
    if (result.rowsAffected !== 1) {
      throw new CompletionContinuationConflictError(
        'Another delegated child already continues this completion request'
      );
    }
    return this.get(current.subscription_id);
  }

  async markRunningForTask(taskId: TaskID): Promise<void> {
    await update(this.db, completionSubscriptions)
      .set({ state: 'running_downstream', updated_at: new Date() })
      .where(
        and(
          eq(completionSubscriptions.active_task_id, taskId),
          inArray(completionSubscriptions.state, ['pending', 'delegated'])
        )
      )
      .run();
  }

  async markTerminalForTask(
    taskId: TaskID,
    snapshot: CompletionTerminalSnapshot
  ): Promise<CompletionSubscription | null> {
    const now = new Date(snapshot.completed_at);
    const result = await update(this.db, completionSubscriptions)
      .set({
        state: 'terminal_pending',
        terminal_status: snapshot.status,
        terminal_snapshot: snapshot,
        terminal_at: now,
        next_delivery_at: now,
        last_delivery_error_code: null,
        updated_at: now,
      })
      .where(
        and(
          eq(completionSubscriptions.active_task_id, taskId),
          inArray(completionSubscriptions.state, [...ACTIVE_STATES])
        )
      )
      .run();
    if (result.rowsAffected === 0) return null;
    return this.findByTerminalTask(taskId);
  }

  /**
   * `expectedActiveTaskId` must be the active Task ID (or `null`) the caller
   * actually observed as missing. Guarding the write on it prevents a
   * concurrent `designateContinuation` from moving the subscription onto a
   * new Task between the caller's read and this write from being clobbered
   * back to `terminal_pending` for the now-stale prior Task.
   */
  async markMissingActive(
    id: CompletionSubscriptionID,
    expectedActiveTaskId: TaskID | null,
    completedAt = new Date()
  ): Promise<void> {
    const current = await this.get(id);
    if (!ACTIVE_STATES.includes(current.state as (typeof ACTIVE_STATES)[number])) return;
    if (current.active_task_id !== expectedActiveTaskId) return;
    const terminal = current.path.at(-1);
    if (!terminal) throw new RepositoryError('Completion subscription has no delegation path');
    const snapshot: CompletionTerminalSnapshot = {
      session_id: terminal.session_id,
      task_id: terminal.task_id,
      ...(terminal.branch_id ? { branch_id: terminal.branch_id } : {}),
      status: 'failed',
      completed_at: completedAt.toISOString(),
      reason: 'The designated downstream task or session was deleted before completion.',
    };
    await update(this.db, completionSubscriptions)
      .set({
        state: 'terminal_pending',
        terminal_status: 'failed',
        terminal_snapshot: snapshot,
        terminal_at: completedAt,
        next_delivery_at: completedAt,
        updated_at: completedAt,
      })
      .where(
        and(
          eq(completionSubscriptions.subscription_id, id),
          inArray(completionSubscriptions.state, [...ACTIVE_STATES]),
          expectedActiveTaskId
            ? eq(completionSubscriptions.active_task_id, expectedActiveTaskId)
            : isNull(completionSubscriptions.active_task_id)
        )
      )
      .run();
  }

  private async findByTerminalTask(taskId: TaskID): Promise<CompletionSubscription | null> {
    const row = await select(this.db)
      .from(completionSubscriptions)
      .where(
        and(
          eq(completionSubscriptions.active_task_id, taskId),
          inArray(completionSubscriptions.state, [
            'terminal_pending',
            'delivery_failed',
            'delivered',
          ])
        )
      )
      .one();
    return row ? rowToSubscription(row) : null;
  }

  async findDueRefs(
    db: SystemDatabase | Database,
    options: { limit?: number; now?: Date } = {}
  ): Promise<CompletionSubscriptionDiscoveryRef[]> {
    const limit = options.limit ?? 100;
    const now = options.now ?? new Date();
    const rows = await select(db, {
      ...(isSQLiteDatabase(db)
        ? {}
        : {
            tenant_id: sql<string>`${completionSubscriptions}.${sql.identifier('tenant_id')}`,
          }),
      subscription_id: completionSubscriptions.subscription_id,
    })
      .from(completionSubscriptions)
      .where(
        and(
          inArray(completionSubscriptions.state, [...DELIVERY_STATES]),
          isNotNull(completionSubscriptions.next_delivery_at),
          lte(completionSubscriptions.next_delivery_at, now)
        )
      )
      .orderBy(
        asc(completionSubscriptions.next_delivery_at),
        asc(completionSubscriptions.subscription_id)
      )
      .limit(limit)
      .all();
    return rows.map((row: { tenant_id?: string; subscription_id: string }) => ({
      tenant_id: 'tenant_id' in row ? String(row.tenant_id) : 'default',
      subscription_id: row.subscription_id as CompletionSubscriptionID,
    }));
  }

  /**
   * Narrow restart-reconciliation discovery. It selects only subscriptions
   * whose designated task is now terminal or missing, rather than polling
   * running downstream work.
   */
  async findActiveRefs(
    db: SystemDatabase | Database,
    options: { limit?: number } = {}
  ): Promise<CompletionSubscriptionDiscoveryRef[]> {
    const rows = await select(db, {
      ...(isSQLiteDatabase(db)
        ? {}
        : {
            tenant_id: sql<string>`${completionSubscriptions}.${sql.identifier('tenant_id')}`,
          }),
      subscription_id: completionSubscriptions.subscription_id,
    })
      .from(completionSubscriptions)
      .leftJoin(tasks, eq(tasks.task_id, completionSubscriptions.active_task_id))
      .where(
        and(
          inArray(completionSubscriptions.state, [...ACTIVE_STATES]),
          or(
            isNull(completionSubscriptions.active_task_id),
            isNull(tasks.task_id),
            inArray(tasks.status, [
              TaskStatus.COMPLETED,
              TaskStatus.FAILED,
              TaskStatus.STOPPED,
              TaskStatus.TIMED_OUT,
            ])
          )
        )
      )
      .orderBy(
        asc(completionSubscriptions.updated_at),
        asc(completionSubscriptions.subscription_id)
      )
      .limit(options.limit ?? 100)
      .all();
    return rows.map((row: { tenant_id?: string; subscription_id: string }) => ({
      tenant_id: 'tenant_id' in row ? String(row.tenant_id) : 'default',
      subscription_id: row.subscription_id as CompletionSubscriptionID,
    }));
  }

  async recordDelivered(id: CompletionSubscriptionID, deliveryTaskId: TaskID): Promise<void> {
    await update(this.db, completionSubscriptions)
      .set({
        state: 'delivered',
        delivery_task_id: deliveryTaskId,
        delivered_at: new Date(),
        next_delivery_at: null,
        last_delivery_error_code: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(completionSubscriptions.subscription_id, id),
          inArray(completionSubscriptions.state, [...DELIVERY_STATES])
        )
      )
      .run();
  }

  async recordDeliveryFailure(
    id: CompletionSubscriptionID,
    errorCode: string
  ): Promise<CompletionSubscription> {
    const current = await this.get(id);
    if (!DELIVERY_STATES.includes(current.state as (typeof DELIVERY_STATES)[number])) {
      return current;
    }
    const attempt = current.delivery_attempt_count + 1;
    const exhausted = attempt >= 8;
    const delayMs = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(attempt - 1, 8));
    // Gate on DELIVERY_STATES so a worker racing a concurrent `recordDelivered`
    // (e.g. this call observed a stale pre-success read) can never clobber an
    // already-delivered row back to `delivery_failed`. The attempt counter
    // increments atomically in SQL so a concurrent double-failure can't lose
    // a count even though the derived backoff window is best-effort.
    await update(this.db, completionSubscriptions)
      .set({
        state: 'delivery_failed',
        delivery_attempt_count: sql`${completionSubscriptions.delivery_attempt_count} + 1`,
        next_delivery_at: exhausted ? null : new Date(Date.now() + delayMs),
        last_delivery_error_code: errorCode.slice(0, 96),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(completionSubscriptions.subscription_id, id),
          inArray(completionSubscriptions.state, [...DELIVERY_STATES])
        )
      )
      .run();
    return this.get(id);
  }
}
