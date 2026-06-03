/**
 * Tasks Service
 *
 * Provides REST + WebSocket API for task management.
 * Uses DrizzleService adapter with TaskRepository.
 */

import { analyticsLogger } from '@agor/core/analytics';
import {
  type ChildCompletionContext,
  renderChildCompletionCallback,
} from '@agor/core/callbacks/child-completion-template';
import { PAGINATION, resolveExecutorHeartbeatConfig } from '@agor/core/config';
import { type Database, shortId, TaskRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  ContentBlock,
  Paginated,
  QueryParams,
  Session,
  SessionID,
  Task,
  TaskID,
} from '@agor/core/types';
import { type TaskMetadata, TaskStatus } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { appendSystemMessage } from '../utils/append-system-message.js';
import {
  type ExecutorHeartbeatCallbackPayload,
  ExecutorHeartbeatCallbackRunner,
} from '../utils/executor-heartbeat-callback.js';
import { ensureRepoOriginAlignedById } from '../utils/realign-repo-origin';
import type { SessionsService } from './sessions';

/**
 * Task service params
 */
const ANALYTICS_TERMINAL_TASK_STATUSES = new Set<Task['status']>([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.STOPPED,
  TaskStatus.TIMED_OUT,
]);

const COMPLETION_SIDE_EFFECT_TASK_STATUSES = new Set<Task['status']>([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.STOPPED,
]);

function isAnalyticsTerminalTaskStatus(status: Task['status'] | undefined): boolean {
  return status !== undefined && ANALYTICS_TERMINAL_TASK_STATUSES.has(status);
}

function isCompletionSideEffectTaskStatus(status: Task['status'] | undefined): boolean {
  return status !== undefined && COMPLETION_SIDE_EFFECT_TASK_STATUSES.has(status);
}

export type TaskParams = QueryParams<{
  session_id?: string;
  status?: Task['status'];
}> & {
  /**
   * Internal-only: terminal task patches normally transition the owning session
   * back to idle. Heartbeat-loss handling marks the session failed instead.
   */
  suppressTerminalSessionIdle?: boolean;
  /**
   * Internal-only: terminal task patches normally drain queued work for the
   * owning session. Heartbeat-loss handling must not auto-start queued prompts.
   */
  suppressTerminalQueueProcessing?: boolean;
};

interface CompletionCallbackDispatchResult {
  callbackTask?: Task;
  /** True only for the caller that actually evaluated/attempted dispatch under the lock. */
  didAttemptDispatch: boolean;
}

/**
 * Extended tasks service with custom methods
 */
export class TasksService extends DrizzleService<Task, Partial<Task>, TaskParams> {
  private taskRepo: TaskRepository;
  private app: Application;
  private db: Database;
  private heartbeatCallbackRunner: ExecutorHeartbeatCallbackRunner;
  private completionCallbackDispatches = new Map<
    string,
    Promise<CompletionCallbackDispatchResult>
  >();

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
    const heartbeatConfig = resolveExecutorHeartbeatConfig(app.get?.('config')?.execution);
    this.heartbeatCallbackRunner = new ExecutorHeartbeatCallbackRunner(heartbeatConfig);
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
      console.log(`🔍 [TasksService.create] About to patch session ${shortId(result.session_id)}`);
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
          `✅ [TasksService] Session ${shortId(result.session_id)} status updated to RUNNING (task ${shortId(result.task_id)} created)`,
          `Patch result status: ${patchResult.status}`
        );
      } catch (error) {
        console.error('❌ [TasksService] Failed to update session status to RUNNING:', error);
      }
    }

    if (!Array.isArray(result)) {
      this.trackTaskCreated(result);
      if (result.status === TaskStatus.RUNNING) {
        this.trackTaskStarted(result);
      }
    }

    return result;
  }

  private baseTaskAnalyticsProperties(task: Task): Record<string, unknown> {
    return {
      task_id: task.task_id,
      session_id: task.session_id,
      status: task.status,
      model: task.model ?? task.normalized_sdk_response?.primaryModel ?? null,
      queue_position: task.queue_position ?? null,
      tool_use_count: task.tool_use_count ?? 0,
      is_callback: task.metadata?.is_agor_callback === true,
      source: task.metadata?.source ?? null,
    };
  }

  private trackTaskCreated(task: Task): void {
    analyticsLogger.track('task.created', this.baseTaskAnalyticsProperties(task), {
      userId: task.created_by,
    });
  }

  private trackTaskStarted(task: Task): void {
    analyticsLogger.track(
      'task.started',
      {
        ...this.baseTaskAnalyticsProperties(task),
        started_at: task.started_at ?? null,
      },
      { userId: task.created_by }
    );
  }

  private trackTaskCompleted(task: Task): void {
    const normalized = task.normalized_sdk_response;
    analyticsLogger.track(
      'task.completed',
      {
        ...this.baseTaskAnalyticsProperties(task),
        completed_at: task.completed_at ?? null,
        duration_ms: task.duration_ms ?? normalized?.durationMs ?? null,
        input_tokens: normalized?.tokenUsage?.inputTokens ?? null,
        output_tokens: normalized?.tokenUsage?.outputTokens ?? null,
        total_tokens: normalized?.tokenUsage?.totalTokens ?? null,
        cost_usd: normalized?.costUsd ?? null,
        context_window_limit: normalized?.contextWindowLimit ?? null,
        context_window_percentage: normalized?.contextUsageSnapshot?.percentage ?? null,
        has_error: Boolean(task.error_message),
      },
      { userId: task.created_by }
    );
  }

  async getActiveWithExecutorHeartbeat(): Promise<Task[]> {
    return this.taskRepo.findActiveWithExecutorHeartbeat();
  }

  async failForLostHeartbeat(
    id: string,
    data: { completed_at?: string; error_message: string },
    params?: TaskParams
  ): Promise<Task> {
    const result = await this.patch(
      id,
      {
        status: TaskStatus.FAILED,
        completed_at: data.completed_at,
        error_message: data.error_message,
      },
      {
        ...params,
        suppressTerminalSessionIdle: true,
        suppressTerminalQueueProcessing: true,
      }
    );
    return result as Task;
  }

  private async handleExecutorHeartbeat(task: Task, heartbeatAt: string): Promise<void> {
    const payload: ExecutorHeartbeatCallbackPayload = {
      event: 'executor_heartbeat',
      task_id: task.task_id,
      session_id: task.session_id,
      last_executor_heartbeat_at: heartbeatAt,
    };

    try {
      const session = await this.app.service('sessions').get(task.session_id);
      if (session?.branch_id) {
        payload.branch_id = session.branch_id;
      }
    } catch (error) {
      console.warn(
        `⚠️  [TasksService] Could not resolve branch_id for heartbeat task ${shortId(task.task_id)}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    this.heartbeatCallbackRunner.run(payload);
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
    const nextStatus = data.status;
    const mayTransitionStatus =
      nextStatus === TaskStatus.RUNNING || isAnalyticsTerminalTaskStatus(nextStatus);
    const currentTask = mayTransitionStatus ? await this.get(id, params) : undefined;
    const isAnalyticsTerminalTransition =
      isAnalyticsTerminalTaskStatus(nextStatus) &&
      !isAnalyticsTerminalTaskStatus(currentTask?.status);
    const isCompletionSideEffectTransition =
      isCompletionSideEffectTaskStatus(nextStatus) &&
      !isCompletionSideEffectTaskStatus(currentTask?.status);
    const isRunningTransition =
      nextStatus === TaskStatus.RUNNING && currentTask?.status !== TaskStatus.RUNNING;

    // When transitioning to a terminal status, auto-compute duration, completed_at,
    // and end_timestamp. This ensures ALL code paths (complete, fail, stop handler)
    // get correct timing data without duplicating logic.
    if (isAnalyticsTerminalTransition && currentTask) {
      const completedAt = data.completed_at || new Date().toISOString();

      // Ensure completed_at is always set
      if (!data.completed_at) {
        data.completed_at = completedAt;
      }

      // Compute duration_ms if not explicitly provided (null check, not falsy,
      // so an explicit 0 is preserved)
      if (data.duration_ms == null) {
        const startTime =
          currentTask.started_at ||
          currentTask.message_range?.start_timestamp ||
          currentTask.created_at;
        if (startTime) {
          data.duration_ms = Math.max(
            0,
            new Date(completedAt).getTime() - new Date(startTime).getTime()
          );
        }
      }

      // Set end_timestamp if not already meaningfully set
      const endTs = currentTask.message_range?.end_timestamp;
      const startTs = currentTask.message_range?.start_timestamp;
      if (currentTask.message_range && (!endTs || endTs === startTs)) {
        data.message_range = {
          ...currentTask.message_range,
          ...data.message_range,
          end_timestamp: completedAt,
        };
      }
    }

    const result = await super.patch(id, data, params);

    if (isRunningTransition && !Array.isArray(result)) {
      this.trackTaskStarted(result as Task);
    }

    if (data.last_executor_heartbeat_at && !Array.isArray(result)) {
      analyticsLogger.track(
        'executor.heartbeat',
        {
          task_id: (result as Task).task_id,
          session_id: (result as Task).session_id,
          status: (result as Task).status,
          last_executor_heartbeat_at: data.last_executor_heartbeat_at,
        },
        { userId: (result as Task).created_by }
      );
      this.handleExecutorHeartbeat(result as Task, data.last_executor_heartbeat_at).catch(
        (error) => {
          console.warn(
            `⚠️  [TasksService] Executor heartbeat callback failed for task ${shortId((result as Task).task_id)}:`,
            error
          );
        }
      );
    }

    // Emit analytics for terminal task transitions, including timeouts that do not
    // run the broader task-completion side effects below.
    if (isAnalyticsTerminalTransition) {
      const task = result as Task;
      this.trackTaskCompleted(task);
    }

    // Run completion side effects only for statuses that historically completed
    // executor turns. Timeout paths patch session state separately and should not
    // enqueue callbacks, mark sessions idle, archive forks, or drain queues here.
    if (isCompletionSideEffectTransition) {
      // Since tasks are patched one at a time, result is always a single Task (not an array)
      const task = result as Task;

      if (task.session_id && this.app) {
        try {
          // CRITICAL: Check if THIS task is still the current/latest task before updating session
          // If a new task has started, we must NOT set the session to IDLE
          const session = await this.app.service('sessions').get(task.session_id, params);

          // Realign on terminal transition — decoupled from session-state
          // updates and callback delivery so an error there doesn't skip it.
          if (session.branch_id) {
            this.app
              .service('branches')
              .get(session.branch_id, params)
              .then((branch) => {
                const repoId = branch?.repo_id;
                if (!repoId) return;
                return ensureRepoOriginAlignedById(this.app, repoId);
              })
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                console.warn(
                  `⚠️  [TasksService] ensureRepoOriginAlignedById failed for session ${task.session_id ? shortId(task.session_id) : 'unknown'}: ${message}`
                );
              });
          }

          const latestTaskId = session.tasks?.[session.tasks.length - 1];

          if (latestTaskId && latestTaskId !== task.task_id) {
            console.log(
              `⏭️ [TasksService] Skipping session IDLE update - task ${shortId(task.task_id)} is not the latest (latest: ${shortId(latestTaskId)})`
            );
            // Still process completion callbacks (task completed, callback target needs to know).
            // Route through the same centralized/idempotent dispatcher used by the normal
            // completion path so races cannot enqueue duplicate parent callbacks.
            await this.dispatchCompletionCallbacks(task, session, params);
            return result;
          }

          // For STOPPED tasks: The stop endpoint directly patches session → IDLE with
          // ready_for_prompt=false. Skip the session update here to avoid racing with it.
          //
          // For other terminal tasks: Normal completion - set ready_for_prompt=true
          // to allow auto-queue-processing of any pending messages.
          const isUserInitiatedStop = data.status === TaskStatus.STOPPED;

          if (isUserInitiatedStop) {
            console.log(
              `⏭️ [TasksService] Skipping session IDLE update for STOPPED task ${shortId(task.task_id)} — stop endpoint handles session state`
            );
          } else if (params?.suppressTerminalSessionIdle) {
            console.log(
              `⏭️ [TasksService] Skipping session IDLE update for task ${shortId(task.task_id)} (${data.status}) due to internal patch params`
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
              `✅ [TasksService] Session ${shortId(task.session_id)} status updated to IDLE (task ${shortId(task.task_id)} ${data.status})`
            );
          }

          await this.dispatchCompletionCallbacks(task, session, params);

          // "btw" fork origin: auto-archive the ephemeral fork after task completion.
          // Runs regardless of callback success — btw forks should always be cleaned up.
          if (session.fork_origin === 'btw') {
            try {
              await this.app.service('sessions').patch(session.session_id, {
                archived: true,
                archived_reason: 'btw_completed',
              });
              console.log(
                `📦 [TasksService] Auto-archived btw fork session ${shortId(session.session_id)}`
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
          if (!params?.suppressTerminalQueueProcessing && sessionsService.triggerQueueProcessing) {
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
        `💬 [TasksService] Injected btw result message into parent session ${shortId(parentSessionId)} from btw fork ${shortId(btwSession.session_id)}`
      );
    } catch (error) {
      console.warn(`⚠️  [TasksService] Failed to inject btw result message:`, error);
      // Non-critical — don't break task completion
    }
  }

  /**
   * Centralized completion-callback dispatcher.
   *
   * Both subsessions and generic callback_config callbacks resolve to the same
   * target/event pair: `session_completion` delivered to
   * `callback_config.callback_session_id`, with a genealogy-parent fallback for
   * legacy spawned sessions. Keeping all routing here prevents a completed child
   * from notifying its parent once via the rich/template path and again via a
   * second generic/raw path.
   */
  private async dispatchCompletionCallbacks(
    task: Task,
    childSession: Session,
    params?: TaskParams
  ): Promise<void> {
    const targetSessionId = this.resolveCompletionCallbackTarget(childSession);
    if (!targetSessionId) return;

    const dispatchResult = await this.dispatchCompletionCallbackOnce(
      task,
      childSession,
      targetSessionId,
      params
    );

    if (dispatchResult.callbackTask) {
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
            `🔄 [TasksService] Triggering callback target queue processing for ${shortId(targetSessionId)} (callback queued)`
          );
          // Pass empty params to avoid leaking child's auth context to target.
          // The queue processor reconstructs target auth from queued task metadata.
          await sessionsService.triggerQueueProcessing(targetSessionId, {});
        }
      } catch (error) {
        // Don't throw - target issues shouldn't break child queue processing.
        console.warn(
          `⚠️  [TasksService] Failed to trigger callback target queue processing (target may be deleted):`,
          error
        );
      }
    }

    // Post-callback cleanup: runs independently of whether callback was delivered.
    // "once" mode: auto-disable callback after first delivery attempt.
    // Default to "persistent" for backward compat — legacy sessions without
    // callback_mode should continue firing on every completion as they always have.
    const callbackMode = childSession.callback_config?.callback_mode ?? 'persistent';
    if (dispatchResult.didAttemptDispatch && callbackMode === 'once') {
      try {
        await this.app.service('sessions').patch(childSession.session_id, {
          callback_config: {
            ...childSession.callback_config,
            enabled: false,
          },
        });
        console.log(
          `🔕 [TasksService] Auto-disabled callback for session ${shortId(childSession.session_id)} (once mode)`
        );
      } catch (error) {
        console.warn(`⚠️  [TasksService] Failed to auto-disable callback:`, error);
      }
    }
  }

  private resolveCompletionCallbackTarget(childSession: Session): SessionID | undefined {
    // callback_config.callback_session_id is the single source of truth for both:
    // - Subsessions (spawn sets it to parent session ID)
    // - Remote sessions (create sets it when enableCallback is true)
    // Fallback: legacy spawned sessions may only have genealogy.parent_session_id.
    return (
      childSession.callback_config?.callback_session_id ?? childSession.genealogy?.parent_session_id
    );
  }

  private callbackDispatchMetadataKey(targetSessionId: SessionID): string {
    return `session_completion:${targetSessionId}`;
  }

  private hasCompletionCallbackDispatch(
    metadata: TaskMetadata | undefined,
    targetSessionId: SessionID
  ): boolean {
    return (metadata?.callback_dispatches ?? []).some(
      (dispatch) =>
        dispatch.event === 'session_completion' && dispatch.target_session_id === targetSessionId
    );
  }

  private async markCompletionCallbackDispatched(
    task: Task,
    targetSessionId: SessionID,
    queuedTaskId: TaskID | undefined,
    params?: TaskParams
  ): Promise<void> {
    const latestTask = (await this.taskRepo.findById(task.task_id)) ?? task;
    if (this.hasCompletionCallbackDispatch(latestTask.metadata, targetSessionId)) return;

    const metadata: TaskMetadata = {
      ...(latestTask.metadata ?? {}),
      callback_dispatches: [
        ...(latestTask.metadata?.callback_dispatches ?? []),
        {
          event: 'session_completion',
          target_session_id: targetSessionId,
          queued_task_id: queuedTaskId,
          dispatched_at: new Date().toISOString(),
        },
      ],
    };

    await super.patch(task.task_id, { metadata } as Partial<Task>, params);
  }

  private async dispatchCompletionCallbackOnce(
    task: Task,
    childSession: Session,
    targetSessionId: SessionID,
    params?: TaskParams
  ): Promise<CompletionCallbackDispatchResult> {
    const dispatchKey = `${task.task_id}:${this.callbackDispatchMetadataKey(targetSessionId)}`;
    const existingDispatch = this.completionCallbackDispatches.get(dispatchKey);
    if (existingDispatch) {
      await existingDispatch;
      return { didAttemptDispatch: false };
    }

    const dispatch = (async (): Promise<CompletionCallbackDispatchResult> => {
      const latestTask = (await this.taskRepo.findById(task.task_id)) ?? task;
      if (this.hasCompletionCallbackDispatch(latestTask.metadata, targetSessionId)) {
        console.log(
          `⏭️  [TasksService] Completion callback for task ${shortId(task.task_id)} to ${shortId(targetSessionId)} already dispatched`
        );
        return { didAttemptDispatch: false };
      }

      const queuedCallbackTask = await this.queueCallbackToSession(
        task,
        childSession,
        targetSessionId,
        params
      );
      if (queuedCallbackTask) {
        try {
          await this.markCompletionCallbackDispatched(
            task,
            targetSessionId,
            queuedCallbackTask.task_id,
            params
          );
        } catch (error) {
          console.warn(
            `⚠️  [TasksService] Failed to mark completion callback dispatched for task ${shortId(task.task_id)} to ${shortId(targetSessionId)} after queueing:`,
            error
          );
        }
      }

      return { callbackTask: queuedCallbackTask, didAttemptDispatch: true };
    })();

    this.completionCallbackDispatches.set(dispatchKey, dispatch);
    try {
      return await dispatch;
    } finally {
      this.completionCallbackDispatches.delete(dispatchKey);
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
  ): Promise<Task | undefined> {
    if (!targetSessionId) return undefined;

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
          `⏭️  [TasksService] Callbacks disabled for child session ${shortId(childSession.session_id)}`
        );
        return undefined;
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
        childSessionId: shortId(childSession.session_id),
        childSessionFullId: childSession.session_id,
        childTaskId: shortId(task.task_id),
        childTaskFullId: task.task_id,
        parentSessionId: shortId(targetSessionId), // backward compat
        callbackSessionId: shortId(targetSessionId),
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
          `⚠️  [TasksService] Cannot queue callback: target session ${shortId(targetSessionId)} has no creator (anonymous session)`
        );
        return undefined;
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
        `🔔 Queued callback task ${shortId(callbackTask.task_id)} on session ${shortId(targetSessionId)} from child ${shortId(childSession.session_id)}`
      );

      // NOTE: Queue processing is handled by the centralized dispatcher after
      // it confirms a callback task was actually queued.
      return callbackTask;
    } catch (error) {
      console.error(
        `❌ [TasksService] Failed to queue callback to ${targetSessionId} for session ${childSession.session_id}:`,
        error
      );
      // Don't throw - callback failure shouldn't break task completion
      return undefined;
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
