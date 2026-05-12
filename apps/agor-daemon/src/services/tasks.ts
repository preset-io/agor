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
import { PAGINATION } from '@agor/core/config';
import { type Database, TaskRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  ContentBlock,
  Paginated,
  QueryParams,
  Session,
  SessionID,
  Task,
} from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { appendSystemMessage } from '../utils/append-system-message.js';
import { ensureRepoOriginAlignedById } from '../utils/realign-repo-origin';
import type { SessionsService } from './sessions';

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
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
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
    // If filtering by session_id as a scalar string, use repository shortcut.
    // Note: `session_id` may be injected as `{ $in: [...] }` by the RBAC scoping
    // hook — in that case we fall through to `super.find`, whose adapter's
    // `filterData` handles $in natively.
    if (typeof params?.query?.session_id === 'string') {
      const tasks = await this.taskRepo.findBySession(params.query.session_id);

      // Apply pagination if enabled
      if (this.paginate) {
        const limit = params.query.$limit ?? this.paginate.default ?? PAGINATION.DEFAULT_LIMIT;
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
        const limit = params.query.$limit ?? this.paginate.default ?? PAGINATION.DEFAULT_LIMIT;
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
    console.log(
      `🔍 [TasksService.create] Called with status: ${data.status}, TaskStatus.RUNNING: ${TaskStatus.RUNNING}`
    );
    const result = await super.create(data, params);
    console.log(
      `🔍 [TasksService.create] Result is array: ${Array.isArray(result)}, this.app exists: ${!!this.app}`
    );

    // If task is created with RUNNING status, atomically update session status to RUNNING
    // NOTE: create() always returns a single Task (not an array) in practice
    if (data.status === TaskStatus.RUNNING && !Array.isArray(result) && this.app) {
      console.log(`🔍 [TasksService.create] ENTERING session status update block`);
      console.log(
        `🔍 [TasksService.create] About to patch session ${result.session_id.substring(0, 8)}`
      );
      try {
        const patchResult = await this.app.service('sessions').patch(
          result.session_id,
          {
            status: 'running',
            ready_for_prompt: false,
          },
          params
        );

        console.log(
          `✅ [TasksService] Session ${result.session_id.substring(0, 8)} status updated to RUNNING (task ${result.task_id.substring(0, 8)} created)`,
          `Patch result status: ${patchResult.status}`
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
    // When transitioning to a terminal status, auto-compute duration, completed_at,
    // and end_timestamp. This ensures ALL code paths (complete, fail, stop handler)
    // get correct timing data without duplicating logic.
    const isTerminalTransition =
      data.status === TaskStatus.COMPLETED ||
      data.status === TaskStatus.FAILED ||
      data.status === TaskStatus.STOPPED;

    if (isTerminalTransition) {
      // Only fetch the current task if we actually need to compute something
      const currentTask = await this.get(id, params);

      // Guard: skip if task is already in a terminal state (e.g. adding a report
      // after completion). We only compute timing on the actual transition.
      const wasAlreadyTerminal =
        currentTask?.status === TaskStatus.COMPLETED ||
        currentTask?.status === TaskStatus.FAILED ||
        currentTask?.status === TaskStatus.STOPPED;

      if (!wasAlreadyTerminal) {
        const completedAt = data.completed_at || new Date().toISOString();

        // Ensure completed_at is always set
        if (!data.completed_at) {
          data.completed_at = completedAt;
        }

        // Compute duration_ms if not explicitly provided (null check, not falsy,
        // so an explicit 0 is preserved)
        if (data.duration_ms == null) {
          const startTime =
            currentTask?.started_at ||
            currentTask?.message_range?.start_timestamp ||
            currentTask?.created_at;
          if (startTime) {
            data.duration_ms = Math.max(
              0,
              new Date(completedAt).getTime() - new Date(startTime).getTime()
            );
          }
        }

        // Set end_timestamp if not already meaningfully set
        const endTs = currentTask?.message_range?.end_timestamp;
        const startTs = currentTask?.message_range?.start_timestamp;
        if (currentTask?.message_range && (!endTs || endTs === startTs)) {
          data.message_range = {
            ...currentTask.message_range,
            ...data.message_range,
            end_timestamp: completedAt,
          };
        }
      }
    }

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
          // CRITICAL: Check if THIS task is still the current/latest task before updating session
          // If a new task has started, we must NOT set the session to IDLE
          const session = await this.app.service('sessions').get(task.session_id, params);

          // Realign on terminal transition — decoupled from session-state
          // updates and callback delivery so an error there doesn't skip it.
          if (session.worktree_id) {
            this.app
              .service('worktrees')
              .get(session.worktree_id, params)
              .then((worktree) => {
                const repoId = worktree?.repo_id;
                if (!repoId) return;
                return ensureRepoOriginAlignedById(this.app, repoId);
              })
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                console.warn(
                  `⚠️  [TasksService] ensureRepoOriginAlignedById failed for session ${task.session_id?.substring(0, 8)}: ${message}`
                );
              });
          }

          const latestTaskId = session.tasks?.[session.tasks.length - 1];

          if (latestTaskId && latestTaskId !== task.task_id) {
            console.log(
              `⏭️ [TasksService] Skipping session IDLE update - task ${task.task_id.substring(0, 8)} is not the latest (latest: ${latestTaskId.substring(0, 8)})`
            );
            // Still process callbacks (task completed, callback target needs to know)
            const earlyCallbackTarget =
              session.callback_config?.callback_session_id ?? session.genealogy?.parent_session_id;
            if (earlyCallbackTarget) {
              await this.queueCallbackToSession(task, session, earlyCallbackTarget, params);
            }
            return result;
          }

          // For STOPPED tasks: The stop endpoint directly patches session → IDLE with
          // ready_for_prompt=false. Skip the session update here to avoid racing with it.
          //
          // For COMPLETED/FAILED tasks: Normal completion - set ready_for_prompt=true
          // to allow auto-queue-processing of any pending messages.
          const isUserInitiatedStop = data.status === TaskStatus.STOPPED;

          if (isUserInitiatedStop) {
            console.log(
              `⏭️ [TasksService] Skipping session IDLE update for STOPPED task ${task.task_id.substring(0, 8)} — stop endpoint handles session state`
            );
          } else {
            await this.app.service('sessions').patch(
              task.session_id,
              {
                status: 'idle',
                ready_for_prompt: true,
              },
              params
            );

            console.log(
              `✅ [TasksService] Session ${task.session_id.substring(0, 8)} status updated to IDLE (task ${task.task_id.substring(0, 8)} ${data.status})`
            );
          }

          // Queue callback to the target session if configured
          // callback_config.callback_session_id is the single source of truth for both:
          // - Subsessions (spawn sets it to parent session ID)
          // - Remote sessions (create sets it when enableCallback is true)
          // Fallback: legacy spawned sessions may only have genealogy.parent_session_id
          // Fallback to genealogy.parent_session_id for legacy spawned sessions
          const callbackTarget =
            session.callback_config?.callback_session_id ?? session.genealogy?.parent_session_id;
          if (callbackTarget) {
            const targetSessionId = callbackTarget;
            await this.queueCallbackToSession(task, session, targetSessionId, params);

            // CRITICAL: After queuing callback, ALWAYS trigger target's queue processing.
            // The queue processor uses a promise-based lock that will:
            // - If target is busy: wait for current processing, then retry (self-healing)
            // - If target is idle: immediately process the callback
            // - If target becomes idle while waiting: the retry will catch it
            //
            // DO NOT check target status before triggering - let the queue processor handle it.
            // This ensures callbacks are never missed due to timing issues.
            try {
              const sessionsService = this.app.service('sessions') as unknown as SessionsService;
              if (sessionsService.triggerQueueProcessing) {
                console.log(
                  `🔄 [TasksService] Triggering callback target queue processing for ${targetSessionId.substring(0, 8)} (callback queued)`
                );
                // Pass empty params to avoid leaking child's auth context to target
                // The queue processor will reconstruct target auth from queued task metadata
                await sessionsService.triggerQueueProcessing(targetSessionId, {});
              }
            } catch (error) {
              // Don't throw - target issues shouldn't break child queue processing
              console.warn(
                `⚠️  [TasksService] Failed to trigger callback target queue processing (target may be deleted):`,
                error
              );
            }
          }

          // Post-callback cleanup: runs independently of whether callback was delivered.
          // "once" mode: auto-disable callback after first delivery attempt
          // Default to "persistent" for backward compat — legacy sessions without callback_mode
          // should continue firing on every completion as they always have.
          if (callbackTarget) {
            const callbackMode = session.callback_config?.callback_mode ?? 'persistent';
            if (callbackMode === 'once') {
              try {
                await this.app.service('sessions').patch(session.session_id, {
                  callback_config: {
                    ...session.callback_config,
                    enabled: false,
                  },
                });
                console.log(
                  `🔕 [TasksService] Auto-disabled callback for session ${session.session_id.substring(0, 8)} (once mode)`
                );
              } catch (error) {
                console.warn(`⚠️  [TasksService] Failed to auto-disable callback:`, error);
              }
            }
          }

          // "btw" fork origin: auto-archive the ephemeral fork after task completion.
          // Runs regardless of callback success — btw forks should always be cleaned up.
          if (session.fork_origin === 'btw') {
            try {
              await this.app.service('sessions').patch(session.session_id, {
                archived: true,
                archived_reason: 'btw_completed',
              });
              console.log(
                `📦 [TasksService] Auto-archived btw fork session ${session.session_id.substring(0, 8)}`
              );
            } catch (error) {
              console.warn(`⚠️  [TasksService] Failed to auto-archive btw fork:`, error);
            }

            // Inject a result message into the parent session's conversation.
            // This is a non-prompt system message — it shows up in the UI but doesn't
            // trigger a new prompt cycle. The parent's agent never sees it.
            await this.injectBtwResultMessage(task, session, params);
          }

          // IMPORTANT: Now that session is idle, process any queued tasks (including callbacks)
          // This handles the case where callbacks were queued while this session was running
          const sessionsService = this.app.service('sessions') as unknown as SessionsService;
          if (sessionsService.triggerQueueProcessing) {
            await sessionsService.triggerQueueProcessing(task.session_id);
          }
        } catch (error) {
          console.error('❌ [TasksService] Failed to process task completion:', error);
        }
      }
    }

    return result;
  }

  /**
   * Inject a btw result message into the parent session's conversation.
   * This is a system message that appears in the UI but does NOT trigger a prompt cycle.
   * Shows: originating session (if remote), the question asked, and the response.
   */
  private async injectBtwResultMessage(
    task: Task,
    btwSession: Session,
    _params?: TaskParams
  ): Promise<void> {
    const parentSessionId = btwSession.genealogy?.forked_from_session_id;
    if (!parentSessionId) return;

    try {
      const messagesService = this.app.service('messages');

      // Fetch all messages from the btw fork's task to extract prompt + response
      const messagesResult = await messagesService.find({
        query: {
          session_id: btwSession.session_id,
          task_id: task.task_id,
        },
      });

      const allMessages = messagesResult.data || messagesResult;
      const messageList = Array.isArray(allMessages) ? allMessages : [];

      // Extract the original prompt (first user message or task description)
      // biome-ignore lint/suspicious/noExplicitAny: Message type varies based on service response format
      const userMessages = messageList.filter((msg: any) => msg.role === 'user');
      let promptText = '';
      if (userMessages.length > 0) {
        const firstUser = userMessages[0];
        promptText =
          typeof firstUser.content === 'string'
            ? firstUser.content
            : Array.isArray(firstUser.content)
              ? firstUser.content
                  // biome-ignore lint/suspicious/noExplicitAny: Content block types vary by SDK
                  .filter((b: any) => b.type === 'text')
                  // biome-ignore lint/suspicious/noExplicitAny: Content block types vary by SDK
                  .map((b: any) => b.text || '')
                  .join('\n\n')
              : '';
      }
      if (!promptText) {
        promptText = task.full_prompt?.substring(0, 120) || btwSession.title || '(no prompt)';
      }

      // Extract the last assistant response
      const assistantMessages = messageList
        // biome-ignore lint/suspicious/noExplicitAny: Message type varies based on service response format
        .filter((msg: any) => msg.role === 'assistant')
        // biome-ignore lint/suspicious/noExplicitAny: Message type varies based on service response format
        .sort((a: any, b: any) => (b.index || 0) - (a.index || 0));

      let responseText = '';
      if (assistantMessages.length > 0) {
        const lastMsg = assistantMessages[0];
        responseText =
          typeof lastMsg.content === 'string'
            ? lastMsg.content
            : Array.isArray(lastMsg.content)
              ? lastMsg.content
                  // biome-ignore lint/suspicious/noExplicitAny: Content block types vary by SDK
                  .filter((block: any) => block.type === 'text')
                  // biome-ignore lint/suspicious/noExplicitAny: Content block types vary by SDK
                  .map((block: any) => block.text || '')
                  .join('\n\n')
              : '';
      }

      if (!responseText) {
        responseText = `(btw fork completed with status: ${task.status}, but no text response was found)`;
      }

      // Find the parent's current running task to attach the message to
      const parentSession = await this.app.service('sessions').get(parentSessionId);
      const parentLatestTaskId = parentSession.tasks?.[parentSession.tasks.length - 1];

      // For remote btw, fetch the caller session's title
      const callerSessionId = btwSession.callback_config?.callback_session_id;
      let callerTitle: string | undefined;
      if (callerSessionId) {
        try {
          const callerSession = await this.app.service('sessions').get(callerSessionId);
          callerTitle = callerSession.title;
        } catch {
          // Caller session may have been deleted — not critical
        }
      }

      // Build preview from prompt + response
      const previewText = `Q: ${promptText.substring(0, 80)} → A: ${responseText.substring(0, 100)}`;

      // Create via service so FeathersJS broadcasts the `created` event to all clients
      await appendSystemMessage({
        app: this.app,
        db: this.db,
        sessionId: parentSessionId,
        taskId: parentLatestTaskId as string | undefined,
        content: [{ type: 'text', text: responseText } as ContentBlock],
        contentPreview: previewText.substring(0, 200),
        metadata: {
          is_btw_result: true,
          // The ephemeral btw fork session
          btw_session_id: btwSession.session_id,
          btw_task_id: task.task_id,
          btw_status: task.status,
          btw_title: btwSession.title,
          btw_prompt: promptText,
          // For remote btw: the session that initiated the btw (via MCP callback_session_id).
          // Absent for local btw (user clicked btw button from parent session's UI).
          btw_caller_session_id: btwSession.callback_config?.callback_session_id,
          btw_caller_title: callerTitle,
          source: 'agor',
        },
      });

      console.log(
        `💬 [TasksService] Injected btw result message into parent session ${parentSessionId.substring(0, 8)} from btw fork ${btwSession.session_id.substring(0, 8)}`
      );
    } catch (error) {
      console.warn(`⚠️  [TasksService] Failed to inject btw result message:`, error);
      // Non-critical — don't break task completion
    }
  }

  /**
   * Queue callback message to a target session when a session completes.
   * The target is always callback_config.callback_session_id, set by both
   * spawn (defaults to parent) and create (when enableCallback is true).
   */
  private async queueCallbackToSession(
    task: Task,
    childSession: Session,
    targetSessionId: SessionID,
    params?: TaskParams
  ): Promise<void> {
    if (!targetSessionId) return;

    try {
      // Get target session to check callback config
      // NOTE: DO NOT pass params here - params are from child session context (executor),
      // but we need to access target session without child's authentication constraints
      const targetSession = await this.app.service('sessions').get(targetSessionId);

      // Check callback config - child overrides take precedence over target defaults
      // For subsessions (parent_session_id), default is enabled=true
      // For remote sessions (callback_session_id), enabled is explicitly set at creation time
      const callbackEnabled =
        childSession.callback_config?.enabled ?? targetSession.callback_config?.enabled ?? true;

      if (!callbackEnabled) {
        console.log(
          `⏭️  [TasksService] Callbacks disabled for child session ${childSession.session_id.substring(0, 8)}`
        );
        return;
      }

      // Check if we should include original spawn prompt - child overrides take precedence
      const includeOriginalPrompt =
        childSession.callback_config?.include_original_prompt ??
        targetSession.callback_config?.include_original_prompt ??
        false;

      // Get spawn prompt from task (truncated to 120 chars for the callback template).
      const spawnPrompt = includeOriginalPrompt
        ? task.full_prompt?.substring(0, 120) || '(no prompt available)'
        : undefined;

      // Fetch last assistant message from child session (if callback config allows)
      let lastAssistantMessage: string | undefined;

      // Check if we should include last message - child overrides take precedence
      const includeLastMessage =
        childSession.callback_config?.include_last_message ??
        targetSession.callback_config?.include_last_message ??
        true;

      if (includeLastMessage) {
        try {
          // Query messages service for last assistant message in this task
          const messagesService = this.app.service('messages');
          const messages = await messagesService.find({
            ...params,
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
        parentSessionId: targetSessionId.substring(0, 8), // backward compat
        callbackSessionId: targetSessionId.substring(0, 8),
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
      const customTemplate = targetSession.callback_config?.template;
      const callbackMessage = renderChildCompletionCallback(context, customTemplate);

      // Validate target session has a creator for authentication
      if (!targetSession.created_by) {
        console.warn(
          `⚠️  [TasksService] Cannot queue callback: target session ${targetSessionId.substring(0, 8)} has no creator (anonymous session)`
        );
        return;
      }

      // Create QUEUED task on the target session carrying the callback prompt.
      // The metadata bag survives the queue → run transition: spawnTaskExecutor
      // re-stamps `is_agor_callback` and `source` onto the synthesized
      // user-message row so the UI's callback styling (MessageBlock.tsx) holds.
      //
      // IMPORTANT: queued_by_user_id = the person who set up the callback
      // (task attribution), NOT the target session owner. Execution still runs
      // as the target session's Unix user. Falls back to target session creator
      // for backward compat (legacy sessions without callback_created_by).
      const callbackCreator =
        childSession.callback_config?.callback_created_by ?? targetSession.created_by;
      const callbackTask = await this.taskRepo.createPending({
        session_id: targetSessionId,
        full_prompt: callbackMessage,
        created_by: callbackCreator,
        status: TaskStatus.QUEUED,
        metadata: {
          is_agor_callback: true,
          source: 'agor',
          child_session_id: childSession.session_id,
          child_task_id: task.task_id,
          queued_by_user_id: callbackCreator,
        },
      });

      // Emit so reactive-session subscribers see the new queued task.
      this.emit?.('queued', callbackTask);

      console.log(
        `🔔 Queued callback task ${callbackTask.task_id.substring(0, 8)} on session ${targetSessionId.substring(0, 8)} from child ${childSession.session_id.substring(0, 8)}`
      );

      // NOTE: Queue processing is handled automatically via task completion hook.
      // When target session becomes idle, it will drain queued tasks including this callback.
    } catch (error) {
      console.error(
        `❌ [TasksService] Failed to queue callback to ${targetSessionId} for session ${childSession.session_id}:`,
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
    // duration_ms and end_timestamp are auto-computed by patch() hook
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
        await this.app.service('sessions').patch(
          completedTask.session_id,
          {
            ready_for_prompt: true,
          },
          params
        );
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
    // duration_ms and end_timestamp are auto-computed by patch() hook
    return this.patch(
      id,
      {
        status: TaskStatus.FAILED,
        completed_at: new Date().toISOString(),
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
