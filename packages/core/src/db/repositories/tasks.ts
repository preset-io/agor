/**
 * Task Repository
 *
 * Type-safe CRUD operations for tasks with short ID support.
 */

import type { SessionID, Task, TaskMetadata, UUID } from '@agor/core/types';
import {
  EXECUTING_TASK_STATUSES,
  isTerminalTaskStatus,
  SessionStatus,
  TaskStatus,
} from '@agor/core/types';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { generateId, shortId } from '../../lib/ids';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
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

/**
 * Task repository implementation
 */
export class TaskRepository implements BaseRepository<Task, Partial<Task>> {
  constructor(private db: Database) {}

  private lockTask(db: Database, taskId: string): Promise<void> {
    return lockRowForUpdate(db, this.db, tasks, eq(tasks.task_id, taskId));
  }

  private lockSession(db: Database, sessionId: SessionID): Promise<void> {
    return lockRowForUpdate(db, this.db, sessions, eq(sessions.session_id, sessionId));
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
        executor_attempt: task.executor_attempt,
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
   * Find orphaned tasks (running, stopping, awaiting permission, or awaiting input)
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

  /** Atomically admit the queue head, or keep the contender durably queued. */
  async admitExecutorTurn(input: {
    taskId: string;
    sessionId: SessionID;
    patch: Partial<Task> & {
      status: typeof TaskStatus.DISPATCHING | typeof TaskStatus.RUNNING;
    };
  }): Promise<Task> {
    const fullId = await this.resolveId(input.taskId);
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        await this.lockSession(db, input.sessionId);
        await this.lockTask(db, fullId);

        const session = await select(db)
          .from(sessions)
          .where(eq(sessions.session_id, input.sessionId))
          .one();
        const row = await select(db).from(tasks).where(eq(tasks.task_id, fullId)).one();
        if (!session || !row || row.session_id !== input.sessionId) {
          throw new RepositoryError('Task and session no longer form a valid turn');
        }

        const current = this.rowToTask(row);
        if (current.status !== TaskStatus.CREATED && current.status !== TaskStatus.QUEUED) {
          throw new RepositoryError(`Task is not claimable (${current.status})`);
        }

        const active = await select(db, { task_id: tasks.task_id })
          .from(tasks)
          .where(
            and(
              eq(tasks.session_id, input.sessionId),
              inArray(tasks.status, [...EXECUTING_TASK_STATUSES])
            )
          )
          .limit(1)
          .one();
        const queueHead = await select(db, { task_id: tasks.task_id })
          .from(tasks)
          .where(and(eq(tasks.session_id, input.sessionId), eq(tasks.status, TaskStatus.QUEUED)))
          .orderBy(tasks.queue_position)
          .limit(1)
          .one();
        const canRun =
          session.status !== SessionStatus.STOPPING &&
          !active &&
          (current.status === TaskStatus.QUEUED ? queueHead?.task_id === fullId : !queueHead);

        if (!canRun) {
          if (current.status === TaskStatus.QUEUED) return current;
          const position = await select(db, {
            max: sql<number | null>`max(${tasks.queue_position})`,
          })
            .from(tasks)
            .where(eq(tasks.session_id, input.sessionId))
            .one();
          const queued = {
            ...current,
            status: TaskStatus.QUEUED,
            queue_position: (position?.max ?? 0) + 1,
          } satisfies Task;
          const data = this.taskToInsert(queued);
          await update(db, tasks)
            .set({ status: data.status, queue_position: data.queue_position, data: data.data })
            .where(eq(tasks.task_id, fullId))
            .run();
          return queued;
        }

        const admitted = deepMerge(current, input.patch);
        admitted.queue_position = undefined;
        const data = this.taskToInsert(admitted);
        await update(db, tasks)
          .set({
            status: data.status,
            queue_position: null,
            started_at: data.started_at,
            data: data.data,
          })
          .where(eq(tasks.task_id, fullId))
          .run();
        await update(db, sessions)
          .set({
            status: SessionStatus.RUNNING,
            ready_for_prompt: false,
            updated_at: new Date(),
            data: {
              ...session.data,
              tasks: session.data.tasks.includes(fullId)
                ? session.data.tasks
                : [...session.data.tasks, fullId],
            },
          })
          .where(eq(sessions.session_id, input.sessionId))
          .run();
        return admitted;
      },
      { sqliteImmediate: true }
    );
  }

  /** Authenticated executor connection. Reconnect by the winning attempt is idempotent. */
  async connectExecutor(
    id: string,
    attemptId: string
  ): Promise<{ task: Task; transitioned: boolean } | null> {
    const fullId = await this.resolveId(id);
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        await this.lockTask(db, fullId);
        const row = await select(db).from(tasks).where(eq(tasks.task_id, fullId)).one();
        if (!row) throw new EntityNotFoundError('Task', id);
        const current = this.rowToTask(row);
        if (current.executor_attempt?.id !== attemptId) return null;
        if (current.status === TaskStatus.RUNNING && current.executor_connected_at) {
          return { task: current, transitioned: false };
        }
        if (current.status !== TaskStatus.DISPATCHING) return null;

        const connectedAt = new Date();
        const task = {
          ...current,
          status: TaskStatus.RUNNING,
          executor_connected_at: connectedAt.toISOString(),
        } satisfies Task;
        await update(db, tasks)
          .set({ status: task.status, executor_connected_at: connectedAt })
          .where(eq(tasks.task_id, fullId))
          .run();
        await update(db, sessions)
          .set({ status: SessionStatus.RUNNING, ready_for_prompt: false, updated_at: new Date() })
          .where(eq(sessions.session_id, current.session_id))
          .run();
        return { task, transitioned: true };
      },
      { sqliteImmediate: true }
    );
  }

  /** Project an executor runtime state onto its owning session atomically. */
  async transitionExecutorRuntime(
    id: string,
    attemptId: string,
    status:
      | typeof TaskStatus.RUNNING
      | typeof TaskStatus.AWAITING_PERMISSION
      | typeof TaskStatus.AWAITING_INPUT
  ): Promise<Task | null> {
    const fullId = await this.resolveId(id);
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        await this.lockTask(db, fullId);
        const row = await select(db).from(tasks).where(eq(tasks.task_id, fullId)).one();
        if (!row) throw new EntityNotFoundError('Task', id);
        const current = this.rowToTask(row);
        if (
          current.executor_attempt?.id !== attemptId ||
          !current.executor_connected_at ||
          isTerminalTaskStatus(current.status)
        ) {
          return null;
        }
        const task = { ...current, status } satisfies Task;
        await update(db, tasks).set({ status }).where(eq(tasks.task_id, fullId)).run();
        await update(db, sessions)
          .set({ status, ready_for_prompt: false, updated_at: new Date() })
          .where(eq(sessions.session_id, current.session_id))
          .run();
        return task;
      },
      { sqliteImmediate: true }
    );
  }

  /** Persist bounded executor telemetry only while the attempt owns an active task. */
  async recordExecutorTelemetry(
    id: string,
    attemptId: string,
    telemetry: Pick<Task, 'last_executor_heartbeat_at'>
  ): Promise<Task | null> {
    const fullId = await this.resolveId(id);
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        await this.lockTask(db, fullId);
        const row = await select(db).from(tasks).where(eq(tasks.task_id, fullId)).one();
        if (!row) throw new EntityNotFoundError('Task', id);
        const current = this.rowToTask(row);
        if (
          current.executor_attempt?.id !== attemptId ||
          !current.executor_connected_at ||
          !EXECUTING_TASK_STATUSES.has(current.status) ||
          current.status === TaskStatus.DISPATCHING
        ) {
          return null;
        }
        const task = { ...current, ...telemetry } satisfies Task;
        const data = this.taskToInsert(task);
        await update(db, tasks)
          .set({
            last_executor_heartbeat_at: data.last_executor_heartbeat_at,
            data: data.data,
          })
          .where(eq(tasks.task_id, fullId))
          .run();
        return task;
      },
      { sqliteImmediate: true }
    );
  }

  /**
   * Update task by ID (atomic with database-level transaction)
   *
   * Uses a transaction to ensure read-merge-write is atomic, preventing race conditions
   * when multiple updates happen concurrently (e.g., task status + message_range updates).
   */
  async update(id: string, updates: Partial<Task>): Promise<Task> {
    try {
      const fullId = await this.resolveId(id);

      console.debug(
        `🔄 [TaskRepo] Updating task ${shortId(fullId)}${updates.status ? ` (status: ${updates.status})` : ''}`
      );

      const result = await runDatabaseTransaction(
        this.db,
        async (db) => {
          await this.lockTask(db, fullId);

          const currentRow = await select(db).from(tasks).where(eq(tasks.task_id, fullId)).one();

          if (!currentRow) throw new EntityNotFoundError('Task', id);

          const current = this.rowToTask(currentRow);

          if (
            isTerminalTaskStatus(current.status) &&
            updates.status !== undefined &&
            updates.status !== current.status
          ) {
            throw new RepositoryError(
              `terminal task status cannot be changed from ${current.status}`
            );
          }
          if (current.status === TaskStatus.DISPATCHING && updates.status === TaskStatus.RUNNING) {
            throw new RepositoryError('dispatching tasks must connect through connectExecutor');
          }

          const merged = deepMerge(current, updates);
          const insertData = this.taskToInsert(merged);

          await update(db, tasks)
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
        },
        { sqliteImmediate: true }
      );
      return result;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update task: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
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
    return runDatabaseTransaction(
      this.db,
      async (db) => {
        await this.lockSession(db, input.session_id);
        const positionRow = await select(db, {
          maxPos: sql<number | null>`max(${tasks.queue_position})`,
        })
          .from(tasks)
          .where(and(eq(tasks.session_id, input.session_id), eq(tasks.status, TaskStatus.QUEUED)))
          .one();

        const insertData = this.taskToInsert({
          ...taskBase,
          queue_position: (positionRow?.maxPos ?? 0) + 1,
        });
        await insert(db, tasks).values(insertData).run();
        const row = await select(db).from(tasks).where(eq(tasks.task_id, insertData.task_id)).one();
        if (!row) throw new RepositoryError('Failed to retrieve created queued task');
        return this.rowToTask(row);
      },
      { sqliteImmediate: true }
    );
  }

  /**
   * Find all QUEUED tasks for a session, ordered by queue_position ascending.
   */
  async findQueued(sessionId: string): Promise<Task[]> {
    try {
      const rows = await select(this.db)
        .from(tasks)
        .where(sql`${tasks.session_id} = ${sessionId} AND ${tasks.status} = 'queued'`)
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
        .where(sql`${tasks.session_id} = ${sessionId} AND ${tasks.status} = 'queued'`)
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
