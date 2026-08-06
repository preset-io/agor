/**
 * Task Repository
 *
 * Type-safe CRUD operations for tasks with short ID support.
 */

import type {
  ExecutorPulse,
  ExecutorTerminationCompleteInput,
  SdkFailure,
  SessionID,
  Task,
  TaskID,
  TaskMetadata,
  TaskPendingDispatchStatus,
  TerminationCause,
  UUID,
} from '@agor/core/types';
import {
  EXECUTING_TASK_STATUSES,
  isTerminalTaskStatus,
  SessionStatus,
  sessionCanStartTask,
  TaskStatus,
} from '@agor/core/types';
import { and, asc, eq, gt, inArray, like, ne, or, sql } from 'drizzle-orm';
import { generateId, shortId } from '../../lib/ids';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  isPostgresDatabase,
  isSQLiteDatabase,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { type SessionRow, sessions, type TaskInsert, type TaskRow, tasks } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';
import { visibleSessionReferenceAccessExists } from './branch-access';
import { deepMerge } from './merge-utils';

function executorOwnsTask(row: Pick<TaskRow, 'status' | 'executor_connected_at'>): boolean {
  return (
    !!row.executor_connected_at &&
    (row.status === TaskStatus.RUNNING ||
      row.status === TaskStatus.AWAITING_PERMISSION ||
      row.status === TaskStatus.AWAITING_INPUT)
  );
}

function isExecutorResultStatus(status: Task['status']): boolean {
  return (
    status === TaskStatus.RUNNING ||
    status === TaskStatus.AWAITING_PERMISSION ||
    status === TaskStatus.AWAITING_INPUT ||
    isTerminalTaskStatus(status)
  );
}

function isSQLiteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes('SQLITE_BUSY') || error.message.includes('database is locked')) {
    return true;
  }
  return 'cause' in error && isSQLiteBusyError(error.cause);
}

function withTerminalTiming(
  current: Task,
  updates: Partial<Task>,
  now = new Date()
): Partial<Task> {
  if (!isTerminalTaskStatus(updates.status) || isTerminalTaskStatus(current.status)) return updates;

  const completedAt = updates.completed_at ?? now.toISOString();
  const startAt =
    current.started_at ?? current.message_range?.start_timestamp ?? current.created_at;
  const durationMs =
    updates.duration_ms ??
    current.duration_ms ??
    (startAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startAt)) : undefined);
  const range = current.message_range;
  const messageRange =
    range && (!range.end_timestamp || range.end_timestamp === range.start_timestamp)
      ? { ...range, ...updates.message_range, end_timestamp: completedAt }
      : updates.message_range;

  return {
    ...updates,
    completed_at: completedAt,
    duration_ms: durationMs,
    ...(messageRange ? { message_range: messageRange } : {}),
  };
}

export interface TerminationClaimInput {
  taskId: string;
  cause: TerminationCause;
  errorMessage: string;
  sdkFailure?: SdkFailure;
  expectedStatus?: Task['status'];
  expectedHeartbeatAt?: string;
  heartbeatStaleBefore?: string;
  requireExecutorDisconnected?: boolean;
  now?: Date;
}

export interface TerminationClaimResult {
  outcome: 'claimed' | 'unchanged' | 'condition_changed' | 'terminal';
  task: Task;
}

export interface TerminationSettlementInput {
  taskId: string;
  outcome: 'verified_absent' | 'unverified' | 'forced_unverified' | 'restart_unverified';
  errorMessage?: string;
  sdkFailure?: SdkFailure;
  now?: Date;
}

export interface TerminationSettlementResult {
  outcome: 'transitioned' | 'unverified' | 'condition_changed' | 'terminal';
  task: Task;
}

export interface TaskDispatchClaimResult {
  outcome: 'claimed' | 'already_claimed' | 'condition_changed';
  task: Task;
}

/** Routing-only row returned to the all-daemon queue recovery scanner. */
export interface QueuedSessionRef {
  session_id: SessionID;
  first_queued_at: number;
  tenant_id?: string;
}

export type QueuedSessionCursor = Pick<QueuedSessionRef, 'session_id' | 'tenant_id'>;

/**
 * Task repository implementation
 */
export class TaskRepository implements BaseRepository<Task, Partial<Task>> {
  constructor(private db: Database) {}

  /** Retry an entire SQLite mutation so a contending writer re-reads fresh state. */
  private async runTaskMutation<T>(mutation: () => Promise<T>, attempt = 0): Promise<T> {
    try {
      return await mutation();
    } catch (error) {
      // libSQL reports write contention immediately even with busy_timeout.
      if (isSQLiteDatabase(this.db) && attempt < 4 && isSQLiteBusyError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        return this.runTaskMutation(mutation, attempt + 1);
      }
      throw error;
    }
  }

  /** Run a mutation against the latest row under the dialect's write lock. */
  private async mutateLockedTask<T>(
    id: string,
    mutation: (txDb: Database, row: TaskRow, fullId: string) => Promise<T>
  ): Promise<T> {
    const fullId = await this.resolveId(id);
    return this.runTaskMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, fullId));
          const row = await select(txDb).from(tasks).where(eq(tasks.task_id, fullId)).one();
          if (!row) throw new EntityNotFoundError('Task', id);
          return mutation(txDb, row, fullId);
        },
        { sqliteImmediate: true }
      )
    );
  }

  /**
   * Lock a Task together with its owning Session, always Session first.
   *
   * Session-first ordering is the cross-daemon turn mutex. It serializes
   * claims for different Tasks in the same Session, whereas a Task-only lock
   * can prevent duplicate launch of one Task but cannot prevent two distinct
   * Tasks from launching concurrently.
   */
  private async mutateLockedSessionTask<T>(
    id: string,
    mutation: (
      txDb: Database,
      taskRow: TaskRow,
      sessionRow: SessionRow,
      fullId: string
    ) => Promise<T>
  ): Promise<T> {
    const fullId = await this.resolveId(id);
    const routing = await select(this.db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, fullId))
      .one();
    if (!routing) throw new EntityNotFoundError('Task', id);

    return this.runTaskMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await lockRowForUpdate(
            txDb,
            this.db,
            sessions,
            eq(sessions.session_id, routing.session_id)
          );
          const sessionRow = await select(txDb)
            .from(sessions)
            .where(eq(sessions.session_id, routing.session_id))
            .one();
          if (!sessionRow) throw new EntityNotFoundError('Session', routing.session_id);

          await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, fullId));
          const taskRow = await select(txDb).from(tasks).where(eq(tasks.task_id, fullId)).one();
          if (!taskRow) throw new EntityNotFoundError('Task', id);
          if (taskRow.session_id !== sessionRow.session_id) {
            throw new RepositoryError('Task changed Session during dispatch admission');
          }
          return mutation(txDb, taskRow, sessionRow, fullId);
        },
        { sqliteImmediate: true }
      )
    );
  }

  /**
   * Convert database row to Task type
   */
  private rowToTask(row: TaskRow): Task {
    return {
      task_id: row.task_id as UUID,
      session_id: row.session_id as UUID,
      status: row.status,
      queue_position: row.queue_position ?? undefined,
      created_at: new Date(row.created_at).toISOString(),
      started_at: row.started_at ? new Date(row.started_at).toISOString() : undefined,
      executor_connected_at: row.executor_connected_at
        ? new Date(row.executor_connected_at).toISOString()
        : undefined,
      completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
      last_executor_heartbeat_at: row.last_executor_heartbeat_at
        ? new Date(row.last_executor_heartbeat_at).toISOString()
        : undefined,
      created_by: row.created_by,
      ...row.data,
    };
  }

  /**
   * Convert Task to database insert format
   */
  private taskToInsert(task: Partial<Task>): TaskInsert {
    const now = Date.now();
    const taskId = task.task_id ?? generateId();

    if (!task.session_id) {
      throw new RepositoryError('session_id is required when creating a task');
    }
    if (!task.created_by) {
      throw new RepositoryError('created_by is required when creating a task');
    }

    // Ensure git_state always has required fields
    const git_state = task.git_state ?? {
      ref_at_start: 'unknown',
      sha_at_start: 'unknown',
    };

    return {
      task_id: taskId,
      session_id: task.session_id,
      created_at: new Date(now), // Always use server timestamp, ignore client-provided value
      started_at: task.started_at ? new Date(task.started_at) : undefined,
      executor_connected_at: task.executor_connected_at
        ? new Date(task.executor_connected_at)
        : undefined,
      completed_at: task.completed_at ? new Date(task.completed_at) : undefined,
      last_executor_heartbeat_at: task.last_executor_heartbeat_at
        ? new Date(task.last_executor_heartbeat_at)
        : undefined,
      status: task.status ?? TaskStatus.CREATED,
      queue_position: task.queue_position ?? null,
      created_by: task.created_by,
      data: {
        full_prompt: task.full_prompt ?? '',
        message_range: task.message_range ?? {
          start_index: 0,
          end_index: 0,
          start_timestamp: new Date(now).toISOString(),
        },
        git_state,
        // Filled in by the executor after the turn — don't substitute a default.
        ...(task.model ? { model: task.model } : {}),
        tool_use_count: task.tool_use_count ?? 0,
        duration_ms: task.duration_ms, // Task execution duration
        agent_session_id: task.agent_session_id, // SDK session ID
        error_message: task.error_message, // Human-readable failure reason when status='failed'
        raw_sdk_response: task.raw_sdk_response, // Raw SDK response - single source of truth for token accounting
        normalized_sdk_response: task.normalized_sdk_response, // Normalized for UI consumption
        computed_context_window: task.computed_context_window, // Cumulative context window (computed by tool.computeContextWindow())
        report: task.report,
        permission_request: task.permission_request, // Permission state for UI approval flow
        metadata: task.metadata, // Generic metadata bag (e.g., is_agor_callback, source)
        executor_mode: task.executor_mode,
        latest_executor_pulse: task.latest_executor_pulse,
        sdk_failure: task.sdk_failure,
        termination_request: task.termination_request,
        sdk_watchdog_mode: task.sdk_watchdog_mode,
      },
    };
  }

  /**
   * Resolve short ID to full ID via the centralized helper.
   */
  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'Task', async (pattern) => {
      const rows = await select(this.db)
        .from(tasks)
        .where(like(tasks.task_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: { task_id: string }) => r.task_id);
    });
  }

  /**
   * Create a new task
   */
  async create(data: Partial<Task>): Promise<Task> {
    try {
      const insertData = this.taskToInsert(data);
      await insert(this.db, tasks).values(insertData).run();

      const row = await select(this.db)
        .from(tasks)
        .where(eq(tasks.task_id, insertData.task_id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created task');
      }

      return this.rowToTask(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Bulk create multiple tasks (for imports)
   */
  async createMany(taskList: Partial<Task>[]): Promise<Task[]> {
    try {
      // Handle empty array
      if (taskList.length === 0) {
        return [];
      }

      const inserts = taskList.map((task) => this.taskToInsert(task));

      // Bulk insert all tasks
      await insert(this.db, tasks).values(inserts).run();

      // Retrieve all inserted tasks. SQLite SELECT order is undefined without
      // an ORDER BY — we used to rely on UUIDv7's monotonic counter to make
      // `id ASC` mirror insertion order, but `generateId` now passes random
      // bytes to `uuid.v7()` (so 24-char short IDs don't collide for same-ms
      // IDs), which breaks sub-ms sort. Re-impose insertion order explicitly
      // by mapping returned rows back to the input order. Use drizzle's
      // `inArray` so the query is parameterized rather than string-built.
      const taskIds = inserts.map((t) => t.task_id);
      const rows = await select(this.db).from(tasks).where(inArray(tasks.task_id, taskIds)).all();

      const rowsById = new Map(rows.map((r: TaskRow) => [r.task_id, r]));
      return taskIds.map((id) => this.rowToTask(rowsById.get(id) as TaskRow));
    } catch (error) {
      throw new RepositoryError(
        `Failed to bulk create tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find task by ID (supports short ID)
   */
  async findById(id: string): Promise<Task | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db).from(tasks).where(eq(tasks.task_id, fullId)).one();

      return row ? this.rowToTask(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all tasks
   */
  async findAll(filter?: {
    sessionId?: SessionID;
    sessionIds?: SessionID[];
    status?: Task['status'];
    visibleToUserId?: UUID;
  }): Promise<Task[]> {
    try {
      if (filter?.sessionIds !== undefined && filter.sessionIds.length === 0) return [];

      const conditions = [];
      if (filter?.sessionId) conditions.push(eq(tasks.session_id, filter.sessionId));
      if (filter?.sessionIds !== undefined)
        conditions.push(inArray(tasks.session_id, filter.sessionIds));
      if (filter?.status) conditions.push(eq(tasks.status, filter.status));
      if (filter?.visibleToUserId) {
        conditions.push(
          visibleSessionReferenceAccessExists(this.db, filter.visibleToUserId, tasks.session_id)
        );
      }

      const query = select(this.db).from(tasks);
      const rows =
        conditions.length > 0 ? await query.where(and(...conditions)).all() : await query.all();
      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all tasks for a session
   */
  async findBySession(sessionId: string): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(eq(tasks.session_id, sessionId))
        .orderBy(tasks.created_at)
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find tasks by session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find running tasks across all sessions
   */
  async findRunning(): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(eq(tasks.status, TaskStatus.RUNNING))
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find running tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find orphaned tasks (dispatching, running, stopping, awaiting permission, or awaiting input)
   * These are tasks that were interrupted when daemon stopped.
   *
   * NOTE: QUEUED tasks are intentionally NOT considered orphans — they were
   * never spawned, so they have no executor to recover. The startup queue
   * drainer (see register-routes.ts processNextQueuedTask) picks them up
   * once any session goes idle. See never-lose-prompt §C.
   */
  async findOrphaned(): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(
          sql`${tasks.status} IN ('dispatching', 'running', 'stopping', 'awaiting_permission', 'awaiting_input')`
        )
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find orphaned tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find active tasks that have emitted at least one executor heartbeat.
   *
   * Tasks with a null heartbeat are intentionally skipped so enabling the
   * supervisor does not fail legacy/pre-migration rows or tasks still inside
   * startup grace before the executor sends its first heartbeat.
   */
  async findActiveWithExecutorHeartbeat(): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(
          sql`${tasks.status} IN ('running', 'stopping', 'awaiting_permission', 'awaiting_input') AND ${tasks.last_executor_heartbeat_at} IS NOT NULL`
        )
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find active tasks with executor heartbeat: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find tasks by status
   */
  async findByStatus(status: Task['status']): Promise<Task[]> {
    try {
      const rows = await select(this.db).from(tasks).where(eq(tasks.status, status)).all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find tasks by status: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Atomically claim a daemon-dispatched task for its authenticated executor.
   * Repeated claims after the first successful transition are idempotent.
   */
  async connectExecutor(id: string): Promise<{ task: Task; transitioned: boolean } | null> {
    try {
      return await this.mutateLockedTask(id, async (txDb, row, fullId) => {
        if (row.status === TaskStatus.RUNNING && row.executor_connected_at) {
          return { task: this.rowToTask(row), transitioned: false };
        }
        if (row.status !== TaskStatus.DISPATCHING) return null;

        const connectedAt = new Date();
        // Successful connection resolves any nonterminal startup diagnostic.
        const data = { ...row.data };
        delete data.error_message;
        await update(txDb, tasks)
          .set({
            status: TaskStatus.RUNNING,
            executor_connected_at: connectedAt,
            last_executor_heartbeat_at: connectedAt,
            data,
          })
          .where(eq(tasks.task_id, fullId))
          .run();

        return {
          task: this.rowToTask({
            ...row,
            status: TaskStatus.RUNNING,
            executor_connected_at: connectedAt,
            last_executor_heartbeat_at: connectedAt,
            data,
          }),
          transitioned: true,
        };
      });
    } catch (error) {
      if (error instanceof RepositoryError || error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to connect executor: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Record a nonterminal warning only while a templated executor is still pending. */
  async recordExecutorStartupWarning(id: string, warning: string): Promise<Task | null> {
    return this.mutateLockedTask(id, async (txDb, row, fullId) => {
      if (
        row.status !== TaskStatus.DISPATCHING ||
        row.executor_connected_at ||
        row.data.executor_mode !== 'templated'
      ) {
        return null;
      }
      if (row.data.error_message === warning) return null;

      const data = { ...row.data, error_message: warning };
      await update(txDb, tasks).set({ data }).where(eq(tasks.task_id, fullId)).run();
      return this.rowToTask({ ...row, data });
    });
  }

  /** Atomically stamp heartbeat time and advance the latest pulse fact. */
  async reportRuntimeTelemetry(
    id: string,
    pulse?: Omit<ExecutorPulse, 'observed_at'>,
    observedAt = new Date()
  ): Promise<Task | null> {
    return this.mutateLockedTask(id, async (txDb, row, fullId) => {
      if (!executorOwnsTask(row)) return null;

      const previous = row.data.latest_executor_pulse;
      const latest =
        pulse && (!previous || pulse.sequence > previous.sequence)
          ? { ...pulse, observed_at: observedAt.toISOString() }
          : previous;
      const data = { ...row.data, latest_executor_pulse: latest };
      await update(txDb, tasks)
        .set({ last_executor_heartbeat_at: observedAt, data })
        .where(eq(tasks.task_id, fullId))
        .run();
      return this.rowToTask({ ...row, last_executor_heartbeat_at: observedAt, data });
    });
  }

  /**
   * Persist the scoped executor's cooperative-stop completion.
   *
   * The request timestamp fences delayed reports, while the row lock makes the
   * report idempotent against duplicate socket delivery/reconnect recovery.
   */
  async recordExecutorQuiescence(
    input: ExecutorTerminationCompleteInput,
    observedAt = new Date()
  ): Promise<Task | null> {
    return this.mutateLockedTask(input.task_id, async (txDb, row, fullId) => {
      const current = this.rowToTask(row);
      const request = current.termination_request;
      if (
        current.status !== TaskStatus.STOPPING ||
        !request ||
        request.requested_at !== input.requested_at
      ) {
        return null;
      }
      if (request.executor_quiesced_at) return current;

      const data = {
        ...row.data,
        termination_request: {
          ...request,
          executor_quiesced_at: observedAt.toISOString(),
        },
      };
      await update(txDb, tasks).set({ data }).where(eq(tasks.task_id, fullId)).run();
      return this.rowToTask({ ...row, data });
    });
  }

  /** Record observe-only SDK health evidence only while the executor still owns the task. */
  async recordSdkHealthObservation(id: string, failure: SdkFailure): Promise<Task | null> {
    return this.mutateLockedTask(id, async (txDb, row, fullId) => {
      if (!executorOwnsTask(row)) return null;

      const data = { ...row.data, sdk_failure: failure };
      await update(txDb, tasks).set({ data }).where(eq(tasks.task_id, fullId)).run();
      return this.rowToTask({ ...row, data });
    });
  }

  /** Atomically validate and persist ownership of a termination request. */
  async claimTermination(input: TerminationClaimInput): Promise<TerminationClaimResult> {
    return this.mutateLockedTask(input.taskId, async (txDb, row, fullId) => {
      const current = this.rowToTask(row);
      if (isTerminalTaskStatus(current.status)) return { outcome: 'terminal', task: current };

      const staleBefore = input.heartbeatStaleBefore
        ? Date.parse(input.heartbeatStaleBefore)
        : undefined;
      const heartbeatAt = current.last_executor_heartbeat_at
        ? Date.parse(current.last_executor_heartbeat_at)
        : undefined;
      const conditionChanged =
        (input.expectedStatus !== undefined && current.status !== input.expectedStatus) ||
        (input.expectedHeartbeatAt !== undefined &&
          current.last_executor_heartbeat_at !== input.expectedHeartbeatAt) ||
        (staleBefore !== undefined &&
          (!Number.isFinite(heartbeatAt) || heartbeatAt! > staleBefore)) ||
        (input.requireExecutorDisconnected === true && !!current.executor_connected_at);
      if (conditionChanged) return { outcome: 'condition_changed', task: current };

      const existing = current.termination_request;
      const cause = input.cause === 'user_stop' || !existing ? input.cause : existing.cause;
      if (current.status === TaskStatus.STOPPING && existing?.cause === cause) {
        return { outcome: 'unchanged', task: current };
      }
      const incomingWins =
        !existing || input.cause === 'user_stop' || existing.cause === input.cause;
      const request = {
        cause,
        requested_at: existing?.requested_at ?? (input.now ?? new Date()).toISOString(),
        error_message:
          cause === input.cause
            ? input.errorMessage
            : (existing?.error_message ?? input.errorMessage),
        ...(existing?.executor_quiesced_at
          ? { executor_quiesced_at: existing.executor_quiesced_at }
          : {}),
      };
      const sdkFailure = incomingWins
        ? (input.sdkFailure ?? current.sdk_failure)
        : current.sdk_failure;
      const failureTermination: SdkFailure['termination'] =
        sdkFailure?.termination === 'unverified' ? 'unverified' : 'requested';
      const data = {
        ...row.data,
        termination_request: request,
        ...(sdkFailure ? { sdk_failure: { ...sdkFailure, termination: failureTermination } } : {}),
      };
      await update(txDb, tasks)
        .set({ status: TaskStatus.STOPPING, data })
        .where(eq(tasks.task_id, fullId))
        .run();
      return {
        outcome: 'claimed',
        task: this.rowToTask({ ...row, status: TaskStatus.STOPPING, data }),
      };
    });
  }

  /** Atomically record containment evidence and, when safe, terminalize the task. */
  async settleTermination(input: TerminationSettlementInput): Promise<TerminationSettlementResult> {
    return this.mutateLockedTask(input.taskId, async (txDb, row, fullId) => {
      const current = this.rowToTask(row);
      if (isTerminalTaskStatus(current.status)) return { outcome: 'terminal', task: current };
      const restartRelease = input.outcome === 'restart_unverified';
      if (
        !restartRelease &&
        (current.status !== TaskStatus.STOPPING || !current.termination_request)
      ) {
        return { outcome: 'condition_changed', task: current };
      }

      if (restartRelease && (!input.sdkFailure || !input.errorMessage)) {
        throw new RepositoryError('restart settlement requires unverified failure evidence');
      }

      if (input.outcome === 'unverified') {
        const failure = input.sdkFailure ?? current.sdk_failure;
        if (!failure || !input.errorMessage) {
          throw new RepositoryError('unverified settlement requires failure evidence');
        }
        const data = {
          ...row.data,
          sdk_failure: { ...failure, termination: 'unverified' as const },
          error_message: input.errorMessage,
        };
        await update(txDb, tasks).set({ data }).where(eq(tasks.task_id, fullId)).run();
        return {
          outcome: 'unverified',
          task: this.rowToTask({ ...row, data }),
        };
      }

      if (
        input.outcome === 'forced_unverified' &&
        current.sdk_failure?.termination !== 'unverified'
      ) {
        return { outcome: 'condition_changed', task: current };
      }

      const finalStatus = restartRelease
        ? TaskStatus.STOPPED
        : input.outcome === 'forced_unverified'
          ? TaskStatus.FAILED
          : current.termination_request!.cause === 'user_stop'
            ? TaskStatus.STOPPED
            : TaskStatus.FAILED;
      const terminal = withTerminalTiming(
        current,
        { status: finalStatus },
        input.now ?? new Date()
      );
      const completedAt = new Date(terminal.completed_at!);
      const failure = input.sdkFailure ?? current.sdk_failure;
      const data = {
        ...row.data,
        duration_ms: terminal.duration_ms,
        message_range: terminal.message_range ?? current.message_range,
        ...(failure
          ? {
              sdk_failure: {
                ...failure,
                termination:
                  input.outcome === 'forced_unverified' || restartRelease
                    ? ('unverified' as const)
                    : ('verified' as const),
              },
            }
          : {}),
        ...(finalStatus === TaskStatus.FAILED || restartRelease
          ? {
              error_message:
                input.errorMessage ??
                current.termination_request?.error_message ??
                current.error_message,
            }
          : {}),
      };
      await update(txDb, tasks)
        .set({ status: finalStatus, completed_at: completedAt, data })
        .where(eq(tasks.task_id, fullId))
        .run();
      return {
        outcome: 'transitioned',
        task: this.rowToTask({ ...row, status: finalStatus, completed_at: completedAt, data }),
      };
    });
  }

  /**
   * Update task by ID (atomic with database-level transaction)
   *
   * Uses a transaction to ensure read-merge-write is atomic, preventing race conditions
   * when multiple updates happen concurrently (e.g., task status + message_range updates).
   */
  private async updateTask(
    id: string,
    updates: Partial<Task>,
    executorUpdate: boolean
  ): Promise<Task> {
    try {
      return await this.mutateLockedTask(id, async (txDb, currentRow, fullId) => {
        console.debug(
          `🔄 [TaskRepo] Updating task ${shortId(fullId)}${updates.status ? ` (status: ${updates.status})` : ''}`
        );
        const current = this.rowToTask(currentRow);

        if (executorUpdate) {
          if (!executorOwnsTask(currentRow)) {
            throw new RepositoryError('Task is not connected and executor-writable');
          }
          if (updates.status !== undefined && !isExecutorResultStatus(updates.status)) {
            throw new RepositoryError('Task status is not executor-managed');
          }
          if (
            updates.status === TaskStatus.RUNNING &&
            current.status !== TaskStatus.AWAITING_PERMISSION &&
            current.status !== TaskStatus.AWAITING_INPUT
          ) {
            throw new RepositoryError('running task status is server-managed');
          }
        }

        // Terminal task status is immutable at the row-locked mutation boundary.
        // Service-level checks are useful for friendly idempotence, but cannot
        // make a terminal-vs-resume race safe because their read happens before
        // this transaction acquires the lock. Metadata-only updates remain
        // allowed for existing callers.
        if (
          isTerminalTaskStatus(current.status) &&
          updates.status !== undefined &&
          updates.status !== current.status
        ) {
          throw new RepositoryError(
            `terminal task status cannot be changed from ${current.status}`
          );
        }

        // The authenticated executor claim is the only path allowed to cross
        // this boundary. connectExecutor performs its own guarded SQL update
        // above; generic service update/patch calls flow through this method.
        if (current.status === TaskStatus.DISPATCHING && updates.status === TaskStatus.RUNNING) {
          throw new RepositoryError('dispatching tasks must be claimed through connectExecutor');
        }
        if (updates.status === TaskStatus.STOPPING && current.status !== TaskStatus.STOPPING) {
          throw new RepositoryError('stopping tasks must be claimed through claimTermination');
        }
        if (
          current.status === TaskStatus.STOPPING &&
          current.termination_request &&
          updates.status !== undefined &&
          updates.status !== TaskStatus.STOPPING
        ) {
          throw new RepositoryError(
            'termination-owned tasks must be settled through settleTermination'
          );
        }

        const merged = {
          ...deepMerge(current, withTerminalTiming(current, updates)),
          task_id: current.task_id,
          session_id: current.session_id,
          created_by: current.created_by,
          created_at: current.created_at,
        };
        const insertData = this.taskToInsert(merged);

        await update(txDb, tasks)
          .set({
            status: insertData.status,
            queue_position: insertData.queue_position,
            started_at: insertData.started_at,
            executor_connected_at: insertData.executor_connected_at,
            completed_at: insertData.completed_at,
            last_executor_heartbeat_at: insertData.last_executor_heartbeat_at,
            data: insertData.data,
          })
          .where(eq(tasks.task_id, fullId))
          .run();

        return merged;
      });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to update task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async update(id: string, updates: Partial<Task>): Promise<Task> {
    return this.updateTask(id, updates, false);
  }

  /** Apply executor-owned result fields only while the executor still owns the locked row. */
  async updateFromExecutor(id: string, updates: Partial<Task>): Promise<Task> {
    return this.updateTask(id, updates, true);
  }

  /**
   * Delete task by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, tasks)
        .where(and(eq(tasks.task_id, fullId), eq(tasks.status, TaskStatus.QUEUED)))
        .run();

      if (result.rowsAffected === 0) {
        const existing = await select(this.db).from(tasks).where(eq(tasks.task_id, fullId)).one();
        if (!existing) throw new EntityNotFoundError('Task', id);
        throw new RepositoryError('Only queued tasks can be deleted');
      }
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Create a pending task — either CREATED (will spawn immediately) or
   * QUEUED (will drain later) — owning the sentinel defaults that the
   * caller would otherwise have to assemble by hand.
   *
   * For QUEUED tasks, `queue_position = max(queue_position) + 1` is computed
   * while holding the owning Session row lock. A transaction by itself does
   * not serialize PostgreSQL READ COMMITTED readers; the Session lock is the
   * durable per-queue sequencer shared by every daemon. (The schema also
   * carries a partial unique index as defense in depth.)
   *
   * Sentinel contract: while a task carries `message_range.start_index = -1`
   * and `git_state.sha_at_start = ''`, it has not yet been pinned to real
   * conversation/git state. spawnTaskExecutor is the sole place that
   * overwrites these on the way to RUNNING.
   */
  async createPending(input: {
    /** Optional stable identity used by idempotent internal producers. */
    task_id?: TaskID;
    session_id: SessionID;
    full_prompt: string;
    created_by: string;
    status: TaskPendingDispatchStatus;
    metadata?: TaskMetadata;
  }): Promise<Task> {
    const taskBase: Partial<Task> = {
      task_id: input.task_id,
      session_id: input.session_id,
      full_prompt: input.full_prompt,
      created_by: input.created_by,
      status: input.status,
      metadata: input.metadata,
      // Sentinels — overwritten by spawnTaskExecutor at the status → RUNNING
      // transition. While `start_index === -1` / `sha_at_start === ''`, the
      // task is intentionally unpinned.
      message_range: {
        start_index: -1,
        end_index: -1,
        start_timestamp: new Date().toISOString(),
      },
      git_state: {
        ref_at_start: '',
        sha_at_start: '',
      },
      tool_use_count: 0,
    };

    if (input.status === TaskStatus.CREATED && !input.task_id) {
      return this.create(taskBase);
    }

    if (input.status === TaskStatus.CREATED) {
      const insertData = this.taskToInsert(taskBase);
      await insert(this.db, tasks).values(insertData).onConflictDoNothing().run();
      const row = await select(this.db).from(tasks).where(eq(tasks.task_id, input.task_id!)).one();
      if (!row) throw new RepositoryError('Failed to retrieve idempotent pending task');
      const existing = this.rowToTask(row);
      if (
        existing.session_id !== input.session_id ||
        existing.created_by !== input.created_by ||
        existing.full_prompt !== input.full_prompt
      ) {
        throw new RepositoryError(`Task identity ${input.task_id} is already in use`);
      }
      return existing;
    }

    // QUEUED: lock the durable Session row before max+1. This is required on
    // PostgreSQL: two ordinary READ COMMITTED transactions can otherwise read
    // the same max concurrently and merely turn the unique index into a loser
    // error rather than making one ordered admission decision.
    return this.runTaskMutation(() =>
      runDatabaseTransaction(
        this.db,
        async (txDb) => {
          await lockRowForUpdate(
            txDb,
            this.db,
            sessions,
            eq(sessions.session_id, input.session_id)
          );
          const sessionRow = await select(txDb)
            .from(sessions)
            .where(eq(sessions.session_id, input.session_id))
            .one();
          if (!sessionRow) throw new EntityNotFoundError('Session', input.session_id);

          let existingCreated: Task | undefined;
          if (input.task_id) {
            await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, input.task_id));
            const existingRow = await select(txDb)
              .from(tasks)
              .where(eq(tasks.task_id, input.task_id))
              .one();
            if (existingRow) {
              const existing = this.rowToTask(existingRow);
              if (
                existing.session_id !== input.session_id ||
                existing.created_by !== input.created_by ||
                existing.full_prompt !== input.full_prompt
              ) {
                throw new RepositoryError(`Task identity ${input.task_id} is already in use`);
              }
              if (existing.status !== TaskStatus.CREATED) return existing;

              // A stable internal producer may recover a standalone SQLite
              // crash that committed CREATED before launch admission. Move
              // that same Task into the durable queue rather than letting it
              // jump an already-admitted prompt or remain undiscoverable.
              existingCreated = existing;
            }
          }

          const positionRow = await select(txDb, {
            maxPos: sql<number | null>`max(${tasks.queue_position})`,
          })
            .from(tasks)
            .where(sql`${tasks.session_id} = ${input.session_id} AND ${tasks.status} = 'queued'`)
            .one();

          const nextPosition = (positionRow?.maxPos ?? 0) + 1;
          if (existingCreated) {
            await update(txDb, tasks)
              .set({ status: TaskStatus.QUEUED, queue_position: nextPosition })
              .where(eq(tasks.task_id, existingCreated.task_id))
              .run();
            return {
              ...existingCreated,
              status: TaskStatus.QUEUED,
              queue_position: nextPosition,
            };
          }

          const insertData = this.taskToInsert({
            ...taskBase,
            queue_position: nextPosition,
          });
          await insert(txDb, tasks).values(insertData).run();

          const row = await select(txDb)
            .from(tasks)
            .where(eq(tasks.task_id, insertData.task_id))
            .one();
          if (!row) throw new RepositoryError('Failed to retrieve created queued task');
          return this.rowToTask(row);
        },
        { sqliteImmediate: true }
      )
    );
  }

  /**
   * Atomically claim the CREATED/QUEUED -> DISPATCHING transition.
   *
   * The Session row lock, queue-head check, and Task expected-state check are
   * the fence. A Task-only fence prevents duplicate launch of one Task but is
   * insufficient when two daemons claim different Tasks for the same Session.
   * A loser may do preparatory reads, but it cannot write launch intent,
   * transcript/session state, or spawn an executor.
   */
  async claimDispatchAndProjectSession(
    id: string,
    expectedStatus: TaskPendingDispatchStatus,
    updates: Partial<Task>
  ): Promise<TaskDispatchClaimResult> {
    return this.mutateLockedSessionTask(id, async (txDb, currentRow, sessionRow, fullId) => {
      const current = this.rowToTask(currentRow);
      if (current.status !== expectedStatus) {
        return {
          outcome:
            current.status === TaskStatus.DISPATCHING || current.status === TaskStatus.RUNNING
              ? 'already_claimed'
              : 'condition_changed',
          task: current,
        };
      }
      if (updates.status !== TaskStatus.DISPATCHING) {
        throw new RepositoryError('Dispatch claim must transition to dispatching');
      }

      // A queue claimant may only take the durable head. An explicit CREATED
      // task may not jump an existing prompt queue. Both checks run under the
      // same Session lock that serializes enqueue position assignment.
      const queuedHead = await select(txDb, { task_id: tasks.task_id })
        .from(tasks)
        .where(and(eq(tasks.session_id, current.session_id), eq(tasks.status, TaskStatus.QUEUED)))
        .orderBy(asc(tasks.queue_position), asc(tasks.created_at), asc(tasks.task_id))
        .limit(1)
        .one();
      if (
        (expectedStatus === TaskStatus.QUEUED && queuedHead?.task_id !== fullId) ||
        (expectedStatus === TaskStatus.CREATED && queuedHead != null)
      ) {
        return { outcome: 'condition_changed', task: current };
      }

      const competingExecution = await select(txDb, { task_id: tasks.task_id })
        .from(tasks)
        .where(
          and(
            eq(tasks.session_id, current.session_id),
            ne(tasks.task_id, fullId),
            inArray(tasks.status, [...EXECUTING_TASK_STATUSES])
          )
        )
        .limit(1)
        .one();
      if (
        competingExecution ||
        !sessionCanStartTask(sessionRow.status, sessionRow.ready_for_prompt)
      ) {
        return { outcome: 'condition_changed', task: current };
      }

      const merged: Task = {
        ...deepMerge(current, updates),
        task_id: current.task_id,
        session_id: current.session_id,
        created_by: current.created_by,
        created_at: current.created_at,
        // Queue ownership ends at the durable launch-intent transition.
        queue_position: undefined,
      };
      const insertData = this.taskToInsert(merged);
      await update(txDb, tasks)
        .set({
          status: insertData.status,
          queue_position: insertData.queue_position,
          started_at: insertData.started_at,
          executor_connected_at: insertData.executor_connected_at,
          completed_at: insertData.completed_at,
          last_executor_heartbeat_at: insertData.last_executor_heartbeat_at,
          data: insertData.data,
        })
        .where(eq(tasks.task_id, fullId))
        .run();

      // The launch-intent transition and its Session projection are one
      // durable state change. Keeping this write inside the task-claim
      // transaction (independent of any request-scope policy) closes the kill
      // point where a Task
      // could be DISPATCHING while its Session remained IDLE and omitted the
      // task from data.tasks.
      const sessionTasks = sessionRow.data.tasks.includes(current.task_id)
        ? sessionRow.data.tasks
        : [...sessionRow.data.tasks, current.task_id];
      await update(txDb, sessions)
        .set({
          status: SessionStatus.RUNNING,
          ready_for_prompt: false,
          updated_at: new Date(),
          data: { ...sessionRow.data, tasks: sessionTasks },
        })
        .where(eq(sessions.session_id, current.session_id))
        .run();
      return { outcome: 'claimed', task: merged };
    });
  }

  /**
   * Find all QUEUED tasks for a session, ordered by queue_position ascending.
   */
  async findQueued(sessionId: string): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(sql`${tasks.session_id} = ${sessionId} AND ${tasks.status} = 'queued'`)
        .orderBy(asc(tasks.queue_position), asc(tasks.created_at), asc(tasks.task_id))
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find queued tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Return the next QUEUED task to drain (lowest queue_position) for a session,
   * or null if none.
   */
  async getNextQueued(sessionId: string): Promise<Task | null> {
    try {
      const row = await select(this.db)
        .from(tasks)
        .where(sql`${tasks.session_id} = ${sessionId} AND ${tasks.status} = 'queued'`)
        .orderBy(asc(tasks.queue_position), asc(tasks.created_at), asc(tasks.task_id))
        .limit(1)
        .one();

      return row ? this.rowToTask(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to get next queued task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Bounded routing-only discovery for all-daemon queue recovery.
   *
   * The cursor is fairness state only. QUEUED rows remain the durable
   * authority, and callers wrap after an empty page. PostgreSQL system scope
   * exposes only queued rows through the dedicated RLS capability; each
   * returned Session must be reloaded and mutated in its trusted tenant scope.
   */
  async findQueuedSessionRefs(
    limit = 25,
    after?: QueuedSessionCursor
  ): Promise<QueuedSessionRef[]> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new RepositoryError('Queued Session discovery limit must be between 1 and 1000');
    }

    const tenantColumn = (tasks as unknown as { tenant_id?: typeof tasks.session_id }).tenant_id;
    const postgresTenantColumn = isPostgresDatabase(this.db) ? tenantColumn : undefined;
    const afterCondition = postgresTenantColumn
      ? after?.tenant_id
        ? or(
            gt(postgresTenantColumn, after.tenant_id),
            and(eq(postgresTenantColumn, after.tenant_id), gt(tasks.session_id, after.session_id))
          )
        : undefined
      : after
        ? gt(tasks.session_id, after.session_id)
        : undefined;
    const columns = {
      session_id: tasks.session_id,
      first_queued_at: sql<Date | number>`min(${tasks.created_at})`,
      ...(postgresTenantColumn ? { tenant_id: postgresTenantColumn } : {}),
    };
    const grouped = select(this.db, columns)
      .from(tasks)
      .where(and(eq(tasks.status, TaskStatus.QUEUED), afterCondition))
      .groupBy(
        ...(postgresTenantColumn ? [postgresTenantColumn, tasks.session_id] : [tasks.session_id])
      );
    const rows = postgresTenantColumn
      ? await grouped.orderBy(asc(postgresTenantColumn), asc(tasks.session_id)).limit(limit).all()
      : await grouped.orderBy(asc(tasks.session_id)).limit(limit).all();

    return (rows as Array<Record<string, unknown>>).map((row) => ({
      session_id: row.session_id as SessionID,
      first_queued_at:
        row.first_queued_at instanceof Date
          ? row.first_queued_at.getTime()
          : new Date(row.first_queued_at as string | number).getTime(),
      ...(typeof row.tenant_id === 'string' ? { tenant_id: row.tenant_id } : {}),
    }));
  }

  /**
   * Count tasks for a session
   */
  async countBySession(sessionId: string): Promise<number> {
    try {
      const result = await select(this.db, { count: sql<number>`count(*)` })
        .from(tasks)
        .where(eq(tasks.session_id, sessionId))
        .one();

      return result?.count ?? 0;
    } catch (error) {
      throw new RepositoryError(
        `Failed to count tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
