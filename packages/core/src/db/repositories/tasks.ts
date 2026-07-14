/**
 * Task Repository
 *
 * Type-safe CRUD operations for tasks with short ID support.
 */

import type {
  ExecutorLeaseTerminalCause,
  SessionID,
  Task,
  TaskMetadata,
  UUID,
} from '@agor/core/types';
import {
  EXECUTING_TASK_STATUSES,
  EXECUTOR_FINALIZABLE_TASK_STATUSES,
  isExecutorFinalizationReleasable,
  isTerminalTaskStatus,
  normalizeTerminalTaskPatch,
  TaskStatus,
} from '@agor/core/types';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { generateId, shortId } from '../../lib/ids';
import { EXECUTOR_TERMINAL_CAUSE, type ExecutorTerminalCause } from '../../types/task';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  isPostgresDatabase,
  isSQLiteDatabase,
  lockRowForUpdate,
  select,
  txAsDb,
  update,
} from '../database-wrapper';
import { sessions, type TaskInsert, type TaskRow, tasks } from '../schema';
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

export interface ActiveExecutorAttemptRef {
  task_id: Task['task_id'];
  tenant_id?: string;
}

function isSQLiteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes('SQLITE_BUSY') || error.message.includes('database is locked')) {
    return true;
  }
  return 'cause' in error && isSQLiteBusyError(error.cause);
}

/**
 * Task repository implementation
 */
export class TaskRepository implements BaseRepository<Task, Partial<Task>> {
  constructor(private db: Database) {}

  /** Acquire the task write lock consistently across database dialects. */
  private async lockTaskForMutation(txDb: Database, taskId: string): Promise<void> {
    // PostgreSQL provides a real row lock. SQLite transactions begin deferred,
    // so acquire the write lock with a no-op row update before reading.
    if (isSQLiteDatabase(this.db)) {
      await update(txDb, tasks)
        .set({ status: sql`${tasks.status}` })
        .where(eq(tasks.task_id, taskId))
        .run();
      return;
    }

    await lockRowForUpdate(txDb, this.db, tasks, eq(tasks.task_id, taskId));
  }

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

  /** Keep transaction creation in one place; callers operate on the dialect-neutral DB wrapper. */
  private runTaskTransaction<T>(work: (txDb: Database) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(txAsDb(tx)));
  }

  /** Resolve, lock, and load a task once for every atomic read-modify-write path. */
  private async mutateLockedTask<T>(
    id: string,
    failureMessage: string,
    mutation: (context: { txDb: Database; fullId: string; current: Task }) => Promise<T>
  ): Promise<T> {
    try {
      const fullId = await this.resolveId(id);
      return await this.runTaskMutation(() =>
        this.runTaskTransaction(async (txDb) => {
          await this.lockTaskForMutation(txDb, fullId);
          const row = await select(txDb).from(tasks).where(eq(tasks.task_id, fullId)).one();
          if (!row) throw new EntityNotFoundError('Task', id);
          return mutation({ txDb, fullId, current: this.rowToTask(row) });
        })
      );
    } catch (error) {
      if (error instanceof RepositoryError || error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `${failureMessage}: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Apply the canonical timestamps and durable cause for an executor terminal winner. */
  private buildExecutorTerminalTask(
    current: Task,
    terminalCause: ExecutorTerminalCause,
    patch: Partial<Task> & { status: Task['status'] }
  ): Task {
    return deepMerge(current, {
      ...normalizeTerminalTaskPatch(current, patch),
      executor_terminal_cause: terminalCause,
    }) satisfies Task;
  }

  /** Persist every column that can be changed by an executor terminal patch. */
  private async writeExecutorTerminalTask(
    txDb: Database,
    fullId: string,
    terminalTask: Task
  ): Promise<void> {
    const insertData = this.taskToInsert(terminalTask);
    await update(txDb, tasks)
      .set({
        status: insertData.status,
        queue_position: insertData.queue_position,
        completed_at: insertData.completed_at,
        session_md5: insertData.session_md5,
        data: insertData.data,
      })
      .where(eq(tasks.task_id, fullId))
      .run();
  }

  private async transitionExecutorAttempt(
    id: string,
    ownsTransition: (current: Task) => boolean,
    buildTerminalTask: (current: Task) => Task,
    failureMessage: string
  ): Promise<{ task: Task; transitioned: boolean }> {
    return this.mutateLockedTask(id, failureMessage, async ({ txDb, fullId, current }) => {
      if (!ownsTransition(current)) return { task: current, transitioned: false };

      const task = buildTerminalTask(current);
      await this.writeExecutorTerminalTask(txDb, fullId, task);
      return { task, transitioned: true };
    });
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
      session_md5: row.session_md5 ?? undefined,
      ...row.data,
    };
  }

  /**
   * Convert Task to database insert format
   */
  private taskToInsert(task: Partial<Task>): TaskInsert {
    const now = Date.now();
    const taskId = task.task_id ?? generateId();
    const status = task.status ?? TaskStatus.CREATED;

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
      status,
      queue_position: status === TaskStatus.QUEUED ? (task.queue_position ?? null) : null,
      created_by: task.created_by,
      session_md5: task.session_md5 ?? null,
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
        executor_attempt_id: task.executor_attempt_id,
        executor_terminal_cause: task.executor_terminal_cause,
        executor_finalization: task.executor_finalization,
        latest_executor_pulse: task.latest_executor_pulse,
        metadata: task.metadata, // Generic metadata bag (e.g., is_agor_callback, source)
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
   * NOTE: QUEUED tasks are intentionally not returned here because they never
   * owned an executor. Startup handles them separately before reconciling
   * session readiness.
   */
  async findOrphaned(): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(inArray(tasks.status, [...EXECUTING_TASK_STATUSES]))
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find orphaned tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Routing-only discovery for the background executor-attempt reconciler. */
  async findActiveExecutorAttemptRefs(): Promise<ActiveExecutorAttemptRef[]> {
    try {
      const tenantColumn = (tasks as unknown as { tenant_id?: unknown }).tenant_id;
      const columns =
        isPostgresDatabase(this.db) && tenantColumn
          ? { task_id: tasks.task_id, tenant_id: tenantColumn }
          : { task_id: tasks.task_id };
      const rows = await select(this.db, columns)
        .from(tasks)
        .innerJoin(sessions, eq(tasks.session_id, sessions.session_id))
        .where(
          or(
            inArray(tasks.status, [...EXECUTING_TASK_STATUSES]),
            and(
              inArray(tasks.status, [...EXECUTOR_FINALIZABLE_TASK_STATUSES]),
              eq(sessions.ready_for_prompt, false)
            )
          )
        )
        .all();

      return (rows as Array<{ task_id: string; tenant_id?: unknown }>).map((row) => ({
        task_id: row.task_id as Task['task_id'],
        ...(typeof row.tenant_id === 'string' && row.tenant_id.length > 0
          ? { tenant_id: row.tenant_id }
          : {}),
      }));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find active executor attempts: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Atomically fail an executor attempt whose dispatch or heartbeat lease expired. */
  async failExpiredExecutorAttempt(
    id: string,
    params: {
      executorAttemptId: string;
      staleBefore: string;
      completedAt: string;
      errorMessage: string;
      terminalCause: ExecutorLeaseTerminalCause;
    }
  ): Promise<{ task: Task; transitioned: boolean }> {
    const staleBefore = Date.parse(params.staleBefore);
    return this.transitionExecutorAttempt(
      id,
      (current) => {
        const leaseAt =
          params.terminalCause === EXECUTOR_TERMINAL_CAUSE.DISPATCH_TIMEOUT
            ? Date.parse(current.started_at ?? '')
            : Date.parse(current.last_executor_heartbeat_at ?? current.executor_connected_at ?? '');
        const ownsLease =
          params.terminalCause === EXECUTOR_TERMINAL_CAUSE.DISPATCH_TIMEOUT
            ? current.status === TaskStatus.DISPATCHING && !current.executor_connected_at
            : EXECUTING_TASK_STATUSES.has(current.status);
        return (
          current.executor_attempt_id === params.executorAttemptId &&
          Number.isFinite(staleBefore) &&
          Number.isFinite(leaseAt) &&
          leaseAt <= staleBefore &&
          ownsLease
        );
      },
      (current) =>
        this.buildExecutorTerminalTask(current, params.terminalCause, {
          status: TaskStatus.FAILED,
          completed_at: params.completedAt,
          error_message: params.errorMessage,
        }),
      'Failed to expire executor attempt'
    );
  }

  /**
   * Atomically commit the first terminal outcome for an executor attempt.
   * Every competing head joins here; later terminal writers observe the winner.
   */
  async transitionOwnedExecutorAttemptToTerminal(
    id: string,
    params: {
      executorAttemptId: string;
      terminalCause: ExecutorTerminalCause;
      patch: Partial<Task> & { status: Task['status'] };
    }
  ): Promise<{ task: Task; transitioned: boolean }> {
    if (!isTerminalTaskStatus(params.patch.status)) {
      throw new RepositoryError('Executor terminal transition requires a terminal status');
    }

    return this.transitionExecutorAttempt(
      id,
      (current) =>
        current.executor_attempt_id === params.executorAttemptId &&
        !isTerminalTaskStatus(current.status),
      (current) => this.buildExecutorTerminalTask(current, params.terminalCause, params.patch),
      'Failed to commit executor terminal outcome'
    );
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
   * Repeated claims from the winning process attempt are idempotent.
   */
  async connectExecutor(
    id: string,
    executorAttemptId: string
  ): Promise<{ task: Task; transitioned: boolean } | null> {
    return this.mutateLockedTask(
      id,
      'Failed to connect executor',
      async ({ txDb, fullId, current }) => {
        if (current.executor_attempt_id !== executorAttemptId) return null;
        if (current.status === TaskStatus.RUNNING && current.executor_connected_at) {
          return { task: current, transitioned: false };
        }
        if (current.status !== TaskStatus.DISPATCHING) return null;

        const connectedAt = new Date();
        const claimedTask = {
          ...current,
          status: TaskStatus.RUNNING,
          executor_connected_at: connectedAt.toISOString(),
          last_executor_heartbeat_at: connectedAt.toISOString(),
        } satisfies Task;
        await update(txDb, tasks)
          .set({
            status: TaskStatus.RUNNING,
            executor_connected_at: connectedAt,
            last_executor_heartbeat_at: connectedAt,
          })
          .where(eq(tasks.task_id, fullId))
          .run();

        return { task: claimedTask, transitioned: true };
      }
    );
  }

  /** Atomically record active telemetry or a final terminal pulse for the owning attempt. */
  async recordExecutorTelemetry(
    id: string,
    executorAttemptId: string,
    telemetry: Pick<Task, 'last_executor_heartbeat_at' | 'latest_executor_pulse'>
  ): Promise<Task | null> {
    return this.mutateLockedTask(
      id,
      'Failed to record executor telemetry',
      async ({ txDb, fullId, current }) => {
        if (current.executor_attempt_id !== executorAttemptId) return null;
        const ownsActiveTask =
          current.status !== TaskStatus.DISPATCHING && EXECUTING_TASK_STATUSES.has(current.status);
        const isFinalPulse =
          isTerminalTaskStatus(current.status) &&
          telemetry.last_executor_heartbeat_at === undefined &&
          telemetry.latest_executor_pulse !== undefined &&
          (!current.executor_finalization ||
            !isExecutorFinalizationReleasable(current.executor_finalization));
        if (!ownsActiveTask && !isFinalPulse) return null;

        const updated = { ...current, ...telemetry } satisfies Task;
        const insertData = this.taskToInsert(updated);
        await update(txDb, tasks)
          .set({
            ...(telemetry.last_executor_heartbeat_at !== undefined
              ? { last_executor_heartbeat_at: insertData.last_executor_heartbeat_at }
              : {}),
            ...(telemetry.latest_executor_pulse !== undefined ? { data: insertData.data } : {}),
          })
          .where(eq(tasks.task_id, fullId))
          .run();

        return updated;
      }
    );
  }

  /**
   * Update task by ID (atomic with database-level transaction)
   *
   * Uses a transaction to ensure read-merge-write is atomic, preventing race conditions
   * when multiple updates happen concurrently (e.g., task status + message_range updates).
   */
  async update(id: string, updates: Partial<Task>): Promise<Task> {
    return this.mutateLockedTask(id, 'Failed to update task', async ({ txDb, fullId, current }) => {
      console.debug(
        `🔄 [TaskRepo] Updating task ${shortId(fullId)}${updates.status ? ` (status: ${updates.status})` : ''}`
      );

      // Status transitions are guarded again under the row lock so service-level
      // preflight reads cannot race a terminal writer or executor claim.
      if (
        isTerminalTaskStatus(current.status) &&
        updates.status !== undefined &&
        updates.status !== current.status
      ) {
        throw new RepositoryError(`terminal task status cannot be changed from ${current.status}`);
      }
      if (current.status === TaskStatus.DISPATCHING && updates.status === TaskStatus.RUNNING) {
        throw new RepositoryError('dispatching tasks must be claimed through connectExecutor');
      }

      const merged = deepMerge(current, updates);
      // A pulse is a complete snapshot, not a nested patch.
      if (updates.latest_executor_pulse !== undefined) {
        merged.latest_executor_pulse = updates.latest_executor_pulse;
      }
      if (merged.status !== TaskStatus.QUEUED) merged.queue_position = undefined;
      const insertData = this.taskToInsert(merged);

      await update(txDb, tasks)
        .set({
          status: insertData.status,
          queue_position: insertData.queue_position,
          started_at: insertData.started_at,
          executor_connected_at: insertData.executor_connected_at,
          completed_at: insertData.completed_at,
          last_executor_heartbeat_at: insertData.last_executor_heartbeat_at,
          session_md5: insertData.session_md5,
          data: insertData.data,
        })
        .where(eq(tasks.task_id, fullId))
        .run();

      return merged;
    });
  }

  /**
   * Delete task by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, tasks).where(eq(tasks.task_id, fullId)).run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('Task', id);
      }
    } catch (error) {
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
   * inside a transaction so concurrent writers don't both observe the same
   * max and collide. (The schema also carries a partial unique index on
   * `(session_id, queue_position) WHERE status='queued'` as a belt-and-
   * suspenders against transaction-isolation surprises.)
   *
   * Sentinel contract: while a task carries `message_range.start_index = -1`
   * and `git_state.sha_at_start = ''`, it has not yet been pinned to real
   * conversation/git state. spawnTaskExecutor is the sole place that
   * overwrites these on the way to RUNNING.
   */
  async createPending(input: {
    session_id: SessionID;
    full_prompt: string;
    created_by: string;
    status: typeof TaskStatus.CREATED | typeof TaskStatus.QUEUED;
    metadata?: TaskMetadata;
  }): Promise<Task> {
    const taskBase: Partial<Task> = {
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

    if (input.status === TaskStatus.CREATED) {
      return this.create(taskBase);
    }

    // QUEUED: serialize the read-then-insert in a transaction so concurrent
    // callers can't both observe the same `max(queue_position)` and produce
    // duplicate positions. Two prompts arriving in the same tick now order
    // deterministically instead of racing.
    return this.runTaskTransaction(async (txDb) => {
      const positionRow = await select(txDb, {
        maxPos: sql<number | null>`max(${tasks.queue_position})`,
      })
        .from(tasks)
        .where(and(eq(tasks.session_id, input.session_id), eq(tasks.status, TaskStatus.QUEUED)))
        .one();

      const nextPosition = (positionRow?.maxPos ?? 0) + 1;
      const insertData = this.taskToInsert({
        ...taskBase,
        queue_position: nextPosition,
      });
      await insert(txDb, tasks).values(insertData).run();

      const row = await select(txDb).from(tasks).where(eq(tasks.task_id, insertData.task_id)).one();
      if (!row) {
        throw new RepositoryError('Failed to retrieve created queued task');
      }
      return this.rowToTask(row);
    });
  }

  /**
   * Find all QUEUED tasks for a session, ordered by queue_position ascending.
   */
  async findQueued(sessionId: string): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(and(eq(tasks.session_id, sessionId), eq(tasks.status, TaskStatus.QUEUED)))
        .orderBy(tasks.queue_position)
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
        .where(and(eq(tasks.session_id, sessionId), eq(tasks.status, TaskStatus.QUEUED)))
        .orderBy(tasks.queue_position)
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
