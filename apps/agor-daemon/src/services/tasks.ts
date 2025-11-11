/**
 * Tasks Service
 *
 * Provides REST + WebSocket API for task management.
 * Uses DrizzleService adapter with TaskRepository.
 */

import { type Database, TaskRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Paginated, QueryParams, Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

/**
 * Task service params
 */
export type TaskParams = QueryParams<{
  session_id?: string;
  status?: Task['status'];
}>;

/**
 * Extended tasks service with custom methods
 */
export class TasksService extends DrizzleService<Task, Partial<Task>, TaskParams> {
  private taskRepo: TaskRepository;
  private app: Application;

  constructor(db: Database, app: Application) {
    const taskRepo = new TaskRepository(db);
    super(taskRepo, {
      id: 'task_id',
      resourceType: 'Task',
      paginate: {
        default: 100,
        max: 500,
      },
      multi: ['patch', 'remove'],
    });

    this.taskRepo = taskRepo;
    this.app = app;
  }

  /**
   * Override find to support session-based filtering
   */
  async find(params?: TaskParams): Promise<Task[] | Paginated<Task>> {
    // If filtering by session_id, use repository method
    if (params?.query?.session_id) {
      const tasks = await this.taskRepo.findBySession(params.query.session_id);

      // Apply pagination if enabled
      if (this.paginate) {
        const limit = params.query.$limit ?? this.paginate.default ?? 100;
        const skip = params.query.$skip ?? 0;

        return {
          total: tasks.length,
          limit,
          skip,
          data: tasks.slice(skip, skip + limit),
        };
      }

      return tasks;
    }

    // If filtering by status
    if (params?.query?.status === TaskStatus.RUNNING) {
      const tasks = await this.taskRepo.findRunning();

      if (this.paginate) {
        const limit = params.query.$limit ?? this.paginate.default ?? 100;
        const skip = params.query.$skip ?? 0;

        return {
          total: tasks.length,
          limit,
          skip,
          data: tasks.slice(skip, skip + limit),
        };
      }

      return tasks;
    }

    // Otherwise use default find
    return super.find(params);
  }

  /**
   * Override patch to detect task completion and set ready_for_prompt
   */
  async patch(id: string, data: Partial<Task>, params?: TaskParams): Promise<Task | Task[]> {
    const result = await super.patch(id, data, params);

    // If task is being marked as completed, set session's ready_for_prompt flag
    if (data.status === TaskStatus.COMPLETED) {
      // Handle both single task and array of tasks
      const tasks = Array.isArray(result) ? result : [result];

      for (const task of tasks) {
        console.log(
          `[TasksService] Task ${task.task_id} marked as completed via patch, setting ready_for_prompt for session ${task.session_id}`
        );

        if (task.session_id && this.app) {
          try {
            await this.app.service('sessions').patch(task.session_id, {
              ready_for_prompt: true,
            });
            console.log(
              `✅ [TasksService] Set ready_for_prompt=true for session ${task.session_id}`
            );
          } catch (error) {
            console.error('❌ [TasksService] Failed to set ready_for_prompt flag:', error);
          }
        }
      }
    }

    return result;
  }

  /**
   * Custom method: Get running tasks across all sessions
   */
  async getRunning(_params?: TaskParams): Promise<Task[]> {
    return this.taskRepo.findRunning();
  }

  /**
   * Custom method: Get orphaned tasks (running, stopping, awaiting permission)
   */
  async getOrphaned(_params?: TaskParams): Promise<Task[]> {
    return this.taskRepo.findOrphaned();
  }

  /**
   * Custom method: Bulk create tasks (for imports)
   */
  async createMany(taskList: Partial<Task>[]): Promise<Task[]> {
    return this.taskRepo.createMany(taskList);
  }

  /**
   * Custom method: Complete a task
   */
  async complete(
    id: string,
    data: { report?: Task['report'] },
    params?: TaskParams
  ): Promise<Task> {
    const completedTask = (await this.patch(
      id,
      {
        status: TaskStatus.COMPLETED,
        completed_at: new Date().toISOString(),
        report: data.report,
      },
      params
    )) as Task;

    // Set the session's ready_for_prompt flag to true when task completes successfully
    console.log(
      `[TasksService] Task ${id} completed, setting ready_for_prompt for session ${completedTask.session_id}`
    );
    if (completedTask.session_id && this.app) {
      try {
        await this.app.service('sessions').patch(completedTask.session_id, {
          ready_for_prompt: true,
        });
        console.log(
          `✅ [TasksService] Set ready_for_prompt=true for session ${completedTask.session_id}`
        );
      } catch (error) {
        console.error('❌ [TasksService] Failed to set ready_for_prompt flag:', error);
      }
    } else {
      console.warn(
        `⚠️ [TasksService] Cannot set ready_for_prompt: session_id=${completedTask.session_id}, app=${!!this.app}`
      );
    }

    return completedTask;
  }

  /**
   * Custom method: Fail a task
   */
  async fail(id: string, _data: { error?: string }, params?: TaskParams): Promise<Task> {
    return this.patch(
      id,
      {
        status: TaskStatus.FAILED,
        completed_at: new Date().toISOString(),
        // Don't set report for failed tasks - error info should be in task description
      },
      params
    ) as Promise<Task>;
  }
}

/**
 * Service factory function
 */
export function createTasksService(db: Database, app: Application): TasksService {
  return new TasksService(db, app);
}
