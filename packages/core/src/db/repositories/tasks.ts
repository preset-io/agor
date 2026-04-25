/**
 * Task Repository
 *
 * Type-safe CRUD operations for tasks with short ID support.
 */

import type { SessionID, Task, TaskMetadata, UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { eq, like, sql } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, lockRowForUpdate, select, txAsDb, update } from '../database-wrapper';
import { type TaskInsert, type TaskRow, tasks } from '../schema';
import {
  AmbiguousIdError,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';
import { deepMerge } from './merge-utils';

/**
 * Task repository implementation
 */
export class TaskRepository implements BaseRepository<Task, Partial<Task>> {
  constructor(private db: Database) {}

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
      completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
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

    // Ensure git_state always has required fields
    const git_state = task.git_state ?? {
      ref_at_start: 'unknown',
      sha_at_start: 'unknown',
    };

    return {
      task_id: taskId,
      session_id: task.session_id,
      created_at: new Date(now), // Always use server timestamp, ignore client-provided value
      completed_at: task.completed_at ? new Date(task.completed_at) : undefined,
      status: task.status ?? TaskStatus.CREATED,
      queue_position: task.queue_position ?? null,
      created_by: task.created_by ?? 'anonymous',
      session_md5: task.session_md5 ?? null,
      data: {
        full_prompt: task.full_prompt ?? '',
        message_range: task.message_range ?? {
          start_index: 0,
          end_index: 0,
          start_timestamp: new Date(now).toISOString(),
        },
        git_state,
        model: task.model ?? 'claude-sonnet-4-6',
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
      },
    };
  }

  /**
   * Resolve short ID to full ID
   */
  private async resolveId(id: string): Promise<string> {
    // If already a full UUID, return as-is
    if (id.length === 36 && id.includes('-')) {
      return id;
    }

    // Short ID - need to resolve
    const normalized = id.replace(/-/g, '').toLowerCase();
    const pattern = `${normalized}%`;

    const results = await select(this.db).from(tasks).where(like(tasks.task_id, pattern)).all();

    if (results.length === 0) {
      throw new EntityNotFoundError('Task', id);
    }

    if (results.length > 1) {
      throw new AmbiguousIdError(
        'Task',
        id,
        results.map((r: { task_id: string }) => formatShortId(r.task_id as UUID))
      );
    }

    return results[0].task_id as UUID;
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

      // Retrieve all inserted tasks
      const taskIds = inserts.map((t) => t.task_id);
      const rows = await select(this.db)
        .from(tasks)
        .where(sql`${tasks.task_id} IN ${sql.raw(`(${taskIds.map((id) => `'${id}'`).join(',')})`)}`)
        .all();

      return rows.map((row: TaskRow) => this.rowToTask(row));
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
  async findAll(): Promise<Task[]> {
    try {
      const rows = await select(this.db).from(tasks).all();
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
        .where(
          sql`${tasks.status} IN ('running', 'stopping', 'awaiting_permission', 'awaiting_input')`
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
   * Update task by ID (atomic with database-level transaction)
   *
   * Uses a transaction to ensure read-merge-write is atomic, preventing race conditions
   * when multiple updates happen concurrently (e.g., task status + message_range updates).
   */
  async update(id: string, updates: Partial<Task>): Promise<Task> {
    try {
      const fullId = await this.resolveId(id);

      console.debug(
        `🔄 [TaskRepo] Updating task ${fullId.substring(0, 8)}${updates.status ? ` (status: ${updates.status})` : ''}`
      );

      // Use transaction to make read-merge-write atomic
      const result = await this.db.transaction(async (tx) => {
        // Acquire row-level lock on PostgreSQL to prevent lost updates

        await lockRowForUpdate(txAsDb(tx), this.db, tasks, eq(tasks.task_id, fullId));

        // STEP 1: Read current task (within transaction)
        const currentRow = await select(txAsDb(tx))
          .from(tasks)
          .where(eq(tasks.task_id, fullId))
          .one();

        if (!currentRow) {
          throw new EntityNotFoundError('Task', id);
        }

        const current = this.rowToTask(currentRow);

        // STEP 2: Deep merge updates into current task (in memory)
        // Preserves nested objects like message_range when doing partial updates
        const merged = deepMerge(current, updates);
        const insertData = this.taskToInsert(merged);

        // STEP 3: Write merged task (within same transaction)
        await update(txAsDb(tx), tasks)
          .set({
            status: insertData.status,
            queue_position: insertData.queue_position,
            completed_at: insertData.completed_at,
            session_md5: insertData.session_md5,
            data: insertData.data,
          })
          .where(eq(tasks.task_id, fullId))
          .run();

        // Return merged task (no need to re-fetch, we have it in memory)
        return merged;
      });
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
    return this.db.transaction(async (tx) => {
      const positionRow = await select(txAsDb(tx), {
        maxPos: sql<number | null>`max(${tasks.queue_position})`,
      })
        .from(tasks)
        .where(sql`${tasks.session_id} = ${input.session_id} AND ${tasks.status} = 'queued'`)
        .one();

      const nextPosition = (positionRow?.maxPos ?? 0) + 1;
      const insertData = this.taskToInsert({
        ...taskBase,
        queue_position: nextPosition,
      });
      await insert(txAsDb(tx), tasks).values(insertData).run();

      const row = await select(txAsDb(tx))
        .from(tasks)
        .where(eq(tasks.task_id, insertData.task_id))
        .one();
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
