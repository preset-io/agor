/**
 * Tasks Service
 *
 * Provides REST + WebSocket API for task management.
 * Uses DrizzleService adapter with TaskRepository.
 */

import {
  type ChildCompletionContext,
  renderChildCompletionCallback,
} from '@agor/core/callbacks/child-completion-template';
import { type Database, MessagesRepository, TaskRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Paginated, QueryParams, Session, Task } from '@agor/core/types';
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
  private db: Database;

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
    this.db = db;
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
   * Override create to atomically update session status when task is created with RUNNING status
   */
  async create(data: Partial<Task>, params?: TaskParams): Promise<Task | Task[]> {
    const result = await super.create(data, params);

    // If task is created with RUNNING status, atomically update session status to RUNNING
    // NOTE: create() always returns a single Task (not an array) in practice
    if (data.status === TaskStatus.RUNNING && !Array.isArray(result) && this.app) {
      try {
        await this.app.service('sessions').patch(result.session_id, {
          status: 'running',
          ready_for_prompt: false,
        });

        console.log(
          `✅ [TasksService] Session ${result.session_id.substring(0, 8)} status updated to RUNNING (task ${result.task_id.substring(0, 8)} created)`
        );
      } catch (error) {
        console.error('❌ [TasksService] Failed to update session status to RUNNING:', error);
      }
    }

    return result;
  }

  /**
   * Override patch to detect task completion and:
   * 1. Atomically update session status to IDLE when task reaches terminal state
   * 2. Set ready_for_prompt flag
   * 3. Queue callback to parent session (if exists)
   *
   * NOTE: Tasks are only ever patched one at a time (never in bulk), so we don't need to loop.
   */
  async patch(id: string, data: Partial<Task>, params?: TaskParams): Promise<Task | Task[]> {
    const result = await super.patch(id, data, params);

    // If task is being marked as completed, failed, or stopped (terminal status)
    if (
      data.status === TaskStatus.COMPLETED ||
      data.status === TaskStatus.FAILED ||
      data.status === TaskStatus.STOPPED
    ) {
      // Since tasks are patched one at a time, result is always a single Task (not an array)
      const task = result as Task;

      if (task.session_id && this.app) {
        try {
          // ATOMICALLY update session status to IDLE and set ready_for_prompt
          // This ensures WebSocket events are emitted immediately via FeathersJS service layer
          await this.app.service('sessions').patch(task.session_id, {
            status: 'idle',
            ready_for_prompt: true,
          });

          console.log(
            `✅ [TasksService] Session ${task.session_id.substring(0, 8)} status updated to IDLE (task ${task.task_id.substring(0, 8)} ${data.status})`
          );

          // Check if session has parent and queue callback
          const session = await this.app.service('sessions').get(task.session_id);
          if (session.genealogy?.parent_session_id) {
            await this.queueParentCallback(task, session, params);
          }
        } catch (error) {
          console.error('❌ [TasksService] Failed to process task completion:', error);
        }
      }
    }

    return result;
  }

  /**
   * Queue callback message to parent session when child completes
   */
  private async queueParentCallback(
    task: Task,
    childSession: Session,
    params?: TaskParams
  ): Promise<void> {
    const parentSessionId = childSession.genealogy?.parent_session_id;
    if (!parentSessionId) return;

    try {
      // Get parent session to check callback config
      const parentSession = await this.app.service('sessions').get(parentSessionId);

      // Check callback config - child overrides take precedence over parent defaults
      const callbackEnabled =
        childSession.callback_config?.enabled ?? parentSession.callback_config?.enabled ?? true;

      if (!callbackEnabled) {
        console.log(
          `⏭️  [TasksService] Callbacks disabled for child session ${childSession.session_id.substring(0, 8)}`
        );
        return;
      }

      // Check if we should include original spawn prompt - child overrides take precedence
      const includeOriginalPrompt =
        childSession.callback_config?.include_original_prompt ??
        parentSession.callback_config?.include_original_prompt ??
        false;

      // Get spawn prompt from task description (only if enabled)
      const spawnPrompt = includeOriginalPrompt
        ? task.description || '(no prompt available)'
        : undefined;

      // Fetch last assistant message from child session (if callback config allows)
      let lastAssistantMessage: string | undefined;

      // Check if we should include last message - child overrides take precedence
      const includeLastMessage =
        childSession.callback_config?.include_last_message ??
        parentSession.callback_config?.include_last_message ??
        true;

      if (includeLastMessage) {
        try {
          // Query messages service for last assistant message in this task
          const messagesService = this.app.service('messages');
          const messages = await messagesService.find({
            query: {
              session_id: childSession.session_id,
              task_id: task.task_id,
            },
          });

          // MessagesService.find() ignores role/sort/limit when task_id is present
          // So we need to filter and sort manually
          const allMessages = messages.data || messages;
          const assistantMessages = (Array.isArray(allMessages) ? allMessages : [])
            // biome-ignore lint/suspicious/noExplicitAny: Message type varies based on service response format
            .filter((msg: any) => msg.role === 'assistant')
            // biome-ignore lint/suspicious/noExplicitAny: Message type varies based on service response format
            .sort((a: any, b: any) => (b.index || 0) - (a.index || 0)); // Descending by index

          if (assistantMessages.length > 0) {
            const lastMsg = assistantMessages[0];
            // Extract text content from content blocks or string
            if (typeof lastMsg.content === 'string') {
              lastAssistantMessage = lastMsg.content;
            } else if (Array.isArray(lastMsg.content)) {
              // Find text blocks and concatenate
              const textBlocks = lastMsg.content
                // biome-ignore lint/suspicious/noExplicitAny: Content block types vary by SDK
                .filter((block: any) => block.type === 'text')
                // biome-ignore lint/suspicious/noExplicitAny: Content block types vary by SDK
                .map((block: any) => block.text || '')
                .join('\n\n');
              lastAssistantMessage = textBlocks || undefined;
            }
          }
        } catch (error) {
          console.warn(
            `⚠️  [TasksService] Could not fetch last assistant message for callback:`,
            error
          );
          // Continue without last message - not critical
        }
      }

      // Build callback context
      const context: ChildCompletionContext = {
        childSessionId: childSession.session_id.substring(0, 8),
        childSessionFullId: childSession.session_id,
        childTaskId: task.task_id.substring(0, 8),
        childTaskFullId: task.task_id,
        parentSessionId: parentSessionId.substring(0, 8),
        spawnPrompt,
        status: task.status, // COMPLETED, FAILED, etc.
        completedAt: task.completed_at || new Date().toISOString(),
        messageCount:
          task.message_range?.end_index !== undefined &&
          task.message_range?.start_index !== undefined
            ? task.message_range.end_index - task.message_range.start_index + 1
            : 0,
        toolUseCount: task.tool_use_count || 0,
        lastAssistantMessage,
      };

      // Render callback message using template
      const customTemplate = parentSession.callback_config?.template;
      const callbackMessage = renderChildCompletionCallback(context, customTemplate);

      // Queue message to parent session with special metadata
      const messageRepo = new MessagesRepository(this.db);

      // Create queued message with Agor callback metadata
      await messageRepo.createQueued(parentSessionId, callbackMessage, {
        is_agor_callback: true,
        source: 'agor',
        child_session_id: childSession.session_id,
        child_task_id: task.task_id,
      });

      console.log(
        `🔔 Queued callback to parent ${parentSessionId.substring(0, 8)} from child ${childSession.session_id.substring(0, 8)}`
      );

      // If parent is idle, trigger queue processing immediately
      if (parentSession.status === 'idle') {
        // Trigger queue processing via custom method
        // biome-ignore lint/suspicious/noExplicitAny: Service type casting required for custom method access
        const sessionsService = this.app.service('sessions') as any;
        await sessionsService.triggerQueueProcessing(parentSessionId, params);
      }
    } catch (error) {
      console.error(
        `❌ [TasksService] Failed to queue parent callback for session ${childSession.session_id}:`,
        error
      );
      // Don't throw - callback failure shouldn't break task completion
    }
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
    if (completedTask.session_id && this.app) {
      try {
        await this.app.service('sessions').patch(completedTask.session_id, {
          ready_for_prompt: true,
        });
      } catch (error) {
        console.error('❌ Failed to set ready_for_prompt flag:', error);
      }
    } else {
      console.warn(
        `⚠️ Cannot set ready_for_prompt: session_id=${completedTask.session_id}, app=${!!this.app}`
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
