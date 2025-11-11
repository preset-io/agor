/**
 * Task Repository
 *
 * Type-safe CRUD operations for tasks with short ID support.
 */

import type { Task, UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { eq, like, sql } from 'drizzle-orm';
import { formatShortId, generateId } from '../../lib/ids';
import type { Database } from '../client';
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
      created_at: new Date(row.created_at).toISOString(),
      completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
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
      created_by: task.created_by ?? 'anonymous',
      data: {
        description: task.description ?? '',
        full_prompt: task.full_prompt ?? task.description ?? '',
        message_range: task.message_range ?? {
          start_index: 0,
          end_index: 0,
          start_timestamp: new Date(now).toISOString(),
        },
        git_state,
        model: task.model ?? 'claude-sonnet-4-5',
        tool_use_count: task.tool_use_count ?? 0,
        usage: task.usage, // Token usage and cost tracking
        duration_ms: task.duration_ms, // Task execution duration
        agent_session_id: task.agent_session_id, // SDK session ID
        context_window: task.context_window, // Context window usage
        context_window_limit: task.context_window_limit, // Max context window
        report: task.report,
        permission_request: task.permission_request, // Permission state for UI approval flow
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

    const results = await this.db
      .select({ task_id: tasks.task_id })
      .from(tasks)
      .where(like(tasks.task_id, pattern))
      .all();

    if (results.length === 0) {
      throw new EntityNotFoundError('Task', id);
    }

    if (results.length > 1) {
      throw new AmbiguousIdError(
        'Task',
        id,
        results.map(r => formatShortId(r.task_id as UUID))
      );
    }

    return results[0].task_id as UUID;
  }

  /**
   * Create a new task
   */
  async create(data: Partial<Task>): Promise<Task> {
    try {
      const insert = this.taskToInsert(data);
      await this.db.insert(tasks).values(insert);

      const row = await this.db.select().from(tasks).where(eq(tasks.task_id, insert.task_id)).get();

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

      const inserts = taskList.map(task => this.taskToInsert(task));

      // Bulk insert all tasks
      await this.db.insert(tasks).values(inserts);

      // Retrieve all inserted tasks
      const taskIds = inserts.map(t => t.task_id);
      const rows = await this.db
        .select()
        .from(tasks)
        .where(sql`${tasks.task_id} IN ${sql.raw(`(${taskIds.map(id => `'${id}'`).join(',')})`)}`);

      return rows.map(row => this.rowToTask(row));
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
      const row = await this.db.select().from(tasks).where(eq(tasks.task_id, fullId)).get();

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
      const rows = await this.db.select().from(tasks).all();
      return rows.map(row => this.rowToTask(row));
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
      const rows = await this.db
        .select()
        .from(tasks)
        .where(eq(tasks.session_id, sessionId))
        .orderBy(tasks.created_at)
        .all();

      return rows.map(row => this.rowToTask(row));
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
      const rows = await this.db
        .select()
        .from(tasks)
        .where(eq(tasks.status, TaskStatus.RUNNING))
        .all();

      return rows.map(row => this.rowToTask(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find running tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find orphaned tasks (running, stopping, or awaiting permission)
   * These are tasks that were interrupted when daemon stopped
   */
  async findOrphaned(): Promise<Task[]> {
    try {
      const rows = await this.db
        .select()
        .from(tasks)
        .where(
          sql`${tasks.status} IN ('running', 'stopping', 'awaiting_permission')`
        )
        .all();

      return rows.map(row => this.rowToTask(row));
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
      const rows = await this.db.select().from(tasks).where(eq(tasks.status, status)).all();

      return rows.map(row => this.rowToTask(row));
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

      // Use transaction to make read-merge-write atomic
      return await this.db.transaction(async tx => {
        // STEP 1: Read current task (within transaction)
        const currentRow = await tx.select().from(tasks).where(eq(tasks.task_id, fullId)).get();

        if (!currentRow) {
          throw new EntityNotFoundError('Task', id);
        }

        const current = this.rowToTask(currentRow);

        // STEP 2: Deep merge updates into current task (in memory)
        // Preserves nested objects like message_range when doing partial updates
        const merged = deepMerge(current, updates);
        const insert = this.taskToInsert(merged);

        // STEP 3: Write merged task (within same transaction)
        await tx
          .update(tasks)
          .set({
            status: insert.status,
            completed_at: insert.completed_at,
            data: insert.data,
          })
          .where(eq(tasks.task_id, fullId));

        // Return merged task (no need to re-fetch, we have it in memory)
        return merged;
      });
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

      const result = await this.db.delete(tasks).where(eq(tasks.task_id, fullId)).run();

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
   * Count tasks for a session
   */
  async countBySession(sessionId: string): Promise<number> {
    try {
      const result = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(eq(tasks.session_id, sessionId))
        .get();

      return result?.count ?? 0;
    } catch (error) {
      throw new RepositoryError(
        `Failed to count tasks: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
