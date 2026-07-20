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
import {
  PAGINATION,
  resolveExecutorHeartbeatConfig,
  resolveSdkWatchdogConfig,
} from '@agor/core/config';
import {
  enqueueTenantDatabasePostCommitCallback,
  shortId,
  TaskRepository,
  type TenantScopeAwareDatabase,
  type TerminationClaimInput,
  type TerminationClaimResult,
  type TerminationSettlementInput,
  type TerminationSettlementResult,
} from '@agor/core/db';
import { type Application, BadRequest, Conflict } from '@agor/core/feathers';
import { deriveTitleFromPrompt } from '@agor/core/sessions';
import type {
  ContentBlock,
  Paginated,
  QueryParams,
  RuntimeTelemetryInput,
  SdkFailure,
  SdkHealthFailureInput,
  Session,
  SessionID,
  Task,
  TaskID,
  UUID,
} from '@agor/core/types';
import {
  ExecutorPulseKind,
  isTerminalTaskStatus,
  SDK_WATCHDOG_FAILURE_REASONS,
  SessionStatus,
  type TaskMetadata,
  TaskStatus,
} from '@agor/core/types';
import { DrizzleService, type Query } from '../adapters/drizzle';
import { beginExecutorTermination } from '../termination-coordinator.js';
import { appendSystemMessage } from '../utils/append-system-message.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import {
  type ExecutorHeartbeatCallbackPayload,
  ExecutorHeartbeatCallbackRunner,
} from '../utils/executor-heartbeat-callback.js';
import { ensureRepoOriginAlignedById } from '../utils/realign-repo-origin';
import type { SessionsService } from './sessions';

/**
 * Task service params
 */
const COMPLETION_SIDE_EFFECT_TASK_STATUSES = new Set<Task['status']>([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.STOPPED,
]);

function isAnalyticsTerminalTaskStatus(status: Task['status'] | undefined): boolean {
  return isTerminalTaskStatus(status);
}

function isCompletionSideEffectTaskStatus(status: Task['status'] | undefined): boolean {
  return status !== undefined && COMPLETION_SIDE_EFFECT_TASK_STATUSES.has(status);
}

export type TaskParams = QueryParams<{
  session_id?: string;
  status?: Task['status'];
}> & {
  /**
   * Internal-only: terminal task patches normally drain queued work for the
   * owning session. Heartbeat-loss handling must not auto-start queued prompts.
   */
  suppressTerminalQueueProcessing?: boolean;
  /**
   * Internal-only escape hatch for preserving an ephemeral BTW fork after
   * terminal transition. Most callers should leave this unset.
   */
  suppressBtwCleanup?: boolean;
  /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
  _agorSqlSessionAccessUserId?: UUID;
};

interface CompletionCallbackDispatchResult {
  callbackTask?: Task;
}

/**
 * Extended tasks service with custom methods
 */
export class TasksService extends DrizzleService<Task, Partial<Task>, TaskParams> {
  private taskRepo: TaskRepository;
  private app: Application;
  private db: TenantScopeAwareDatabase;
  private heartbeatCallbackRunner: ExecutorHeartbeatCallbackRunner;
  private completionCallbackDispatches = new Map<
    string,
    Promise<CompletionCallbackDispatchResult>
  >();

  constructor(db: TenantScopeAwareDatabase, app: Application) {
    const taskRepo = new TaskRepository(db);
    super(taskRepo, {
      id: 'task_id',
      resourceType: 'Task',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
      multi: ['patch'],
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
    if (params?._agorSqlSessionAccessUserId) {
      return super.find(params);
    }

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

  protected async fetchData(query: Query, params?: TaskParams): Promise<Task[]> {
    const sessionId = query.session_id;
    const filter: Parameters<TaskRepository['findAll']>[0] = {};

    if (typeof sessionId === 'string') {
      filter.sessionId = sessionId as SessionID;
    } else if (
      sessionId &&
      typeof sessionId === 'object' &&
      Array.isArray(sessionId.$in) &&
      sessionId.$in.every((el: unknown) => typeof el === 'string')
    ) {
      filter.sessionIds = sessionId.$in as SessionID[];
    }
    if (typeof query.status === 'string') filter.status = query.status as Task['status'];
    if (params?._agorSqlSessionAccessUserId) {
      filter.visibleToUserId = params._agorSqlSessionAccessUserId;
    }

    return this.taskRepo.findAll(filter);
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

  async claimTermination(
    input: TerminationClaimInput,
    params?: TaskParams
  ): Promise<TerminationClaimResult> {
    const result = await this.taskRepo.claimTermination(input);
    if (result.outcome !== 'claimed') return result;

    emitServiceEvent(this.app, {
      path: 'tasks',
      event: 'patched',
      data: result.task,
      id: result.task.task_id,
      params,
    });
    try {
      await this.app
        .service('sessions')
        .patch(
          result.task.session_id,
          { status: SessionStatus.STOPPING, ready_for_prompt: false },
          { ...(params ?? {}), provider: undefined }
        );
    } catch (error) {
      // The durable Task claim owns termination. A transient projection write
      // must not prevent the coordinator from containing the process.
      console.warn(
        `[termination] Failed to project STOPPING onto session ${shortId(result.task.session_id)}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
    return result;
  }

  async settleTermination(
    input: TerminationSettlementInput,
    params?: TaskParams
  ): Promise<TerminationSettlementResult> {
    const result = await this.taskRepo.settleTermination(input);
    if (result.outcome !== 'transitioned' && result.outcome !== 'unverified') return result;

    emitServiceEvent(this.app, {
      path: 'tasks',
      event: 'patched',
      data: result.task,
      id: result.task.task_id,
      params,
    });
    if (result.outcome === 'unverified') return result;

    this.trackTaskCompleted(result.task);
    const internalParams = { ...(params ?? {}), provider: undefined } as TaskParams;
    const isStop = result.task.status === TaskStatus.STOPPED;
    const completionParams = {
      ...internalParams,
      // Failure containment never drains queued work automatically. User Stop
      // delegates that hand-off to its caller while the session lock is held;
      // a late CLI confirmation has no caller and drains here instead.
      suppressTerminalQueueProcessing: !isStop || params?.suppressTerminalQueueProcessing === true,
    };
    const sessionProjected = await this.processCompletionSideEffects(
      result.task,
      result.task.status,
      completionParams
    );
    if (!sessionProjected) {
      try {
        await this.projectTerminalSession(result.task, result.task.status, completionParams);
      } catch (error) {
        console.warn(
          `[termination] Failed to settle session ${shortId(result.task.session_id)}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    return result;
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

  private async runAfterTenantDatabaseCommit(
    label: string,
    work: () => Promise<void>
  ): Promise<void> {
    const run = async () => {
      try {
        await work();
      } catch (error) {
        console.warn(
          `⚠️  [TasksService] ${label} failed:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    };

    if (enqueueTenantDatabasePostCommitCallback(run)) {
      return;
    }

    await run();
  }

  private async triggerQueueProcessingAfterCommit(
    sessionId: string,
    params?: TaskParams
  ): Promise<void> {
    const sessionsService = this.app.service('sessions') as unknown as SessionsService;
    const sessionParams = params as Parameters<SessionsService['triggerQueueProcessing']>[1];

    await this.runAfterTenantDatabaseCommit('triggerQueueProcessing', () =>
      sessionsService.triggerQueueProcessing(sessionId, sessionParams)
    );
  }

  private async dispatchCompletionCallbacksAfterCommit(
    task: Task,
    session: Session,
    params?: TaskParams
  ): Promise<void> {
    await this.runAfterTenantDatabaseCommit('dispatchCompletionCallbacks', () =>
      this.dispatchCompletionCallbacks(task, session, params)
    );
  }

  private projectTerminalSession(
    task: Task,
    status: Task['status'],
    params?: TaskParams
  ): Promise<Session> {
    return this.app.service('sessions').patch(
      task.session_id,
      {
        status: status === TaskStatus.FAILED ? SessionStatus.FAILED : SessionStatus.IDLE,
        ready_for_prompt: true,
      },
      params
    ) as Promise<Session>;
  }

  private async processCompletionSideEffects(
    task: Task,
    status: Task['status'],
    params?: TaskParams
  ): Promise<boolean> {
    if (!task.session_id || !this.app) return false;
    try {
      const session = await this.app.service('sessions').get(task.session_id, params);

      if (session.branch_id) {
        this.app
          .service('branches')
          .get(session.branch_id, params)
          .then((branch) => {
            const repoId = branch?.repo_id;
            if (!repoId) return;
            return ensureRepoOriginAlignedById(this.app, repoId, params);
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(
              `⚠️  [TasksService] ensureRepoOriginAlignedById failed for session ${shortId(task.session_id)}: ${message}`
            );
          });
      }

      const latestTaskId = session.tasks?.[session.tasks.length - 1];
      const suppressBtwCleanup = params?.suppressBtwCleanup === true;
      const isStop = status === TaskStatus.STOPPED;
      const isTermination = task.termination_request !== undefined;

      if (latestTaskId && latestTaskId !== task.task_id && !isTermination) {
        console.log(
          `⏭️ [TasksService] Skipping session terminal-state update - task ${shortId(task.task_id)} is not the latest (latest: ${shortId(latestTaskId)})`
        );
        if (!isStop) {
          await this.dispatchCompletionCallbacksAfterCommit(task, session, params);
        }
        return false;
      }

      await this.projectTerminalSession(task, status, params);
      console.log(
        `✅ [TasksService] Session ${shortId(task.session_id)} status updated after terminal task (task ${shortId(task.task_id)} ${status})`
      );

      // Keep the prompt-flow patch above separate from this trusted metadata
      // patch so collaborators do not need title-edit permission to complete a task.
      if (status === TaskStatus.COMPLETED && task.full_prompt) {
        const autoTitle = deriveTitleFromPrompt(task.full_prompt);
        if (autoTitle) {
          try {
            const fresh = await this.app.service('sessions').get(task.session_id, params);
            if (fresh.title == null) {
              await this.app
                .service('sessions')
                .patch(task.session_id, { title: autoTitle }, { ...params, provider: undefined });
            }
          } catch (error) {
            console.warn(
              `⚠️  [TasksService] Auto-title failed for session ${shortId(task.session_id)}:`,
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      }

      if (!isStop) {
        await this.dispatchCompletionCallbacksAfterCommit(task, session, params);
      }

      if (session.fork_origin === 'btw') {
        if (!suppressBtwCleanup) {
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
        }

        if (!isStop && !isTermination) {
          await this.injectBtwResultMessage(task, session, params);
        }
      }

      if (!params?.suppressTerminalQueueProcessing) {
        await this.triggerQueueProcessingAfterCommit(task.session_id, params);
      } else {
        console.log(
          `⏭️  [TasksService] Queue trigger suppressed for session ${shortId(task.session_id)} (suppressTerminalQueueProcessing)`
        );
      }
      return true;
    } catch (error) {
      console.error('❌ [TasksService] Failed to process task completion:', error);
      return false;
    }
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
    const currentTask = nextStatus !== undefined ? await this.get(id, params) : undefined;
    if (
      currentTask?.status === TaskStatus.STOPPING &&
      currentTask.termination_request &&
      params?.provider &&
      isTerminalTaskStatus(nextStatus)
    ) {
      console.log(
        `⏭️ [TasksService] Coordinator owns terminality for stopping task ${shortId(currentTask.task_id)}`
      );
      return currentTask;
    }
    if (currentTask && isTerminalTaskStatus(currentTask.status) && nextStatus !== undefined) {
      console.warn(
        `⏭️ [TasksService] Ignoring status rewrite for terminal task ${shortId(currentTask.task_id)} ` +
          `(${currentTask.status} → ${nextStatus})`
      );
      return currentTask;
    }
    const isAnalyticsTerminalTransition =
      isAnalyticsTerminalTaskStatus(nextStatus) &&
      !isAnalyticsTerminalTaskStatus(currentTask?.status);
    const isCompletionSideEffectTransition =
      isCompletionSideEffectTaskStatus(nextStatus) &&
      !isCompletionSideEffectTaskStatus(currentTask?.status);
    const isRunningTransition =
      nextStatus === TaskStatus.RUNNING && currentTask?.status !== TaskStatus.RUNNING;

    const result = params?.provider
      ? await this.taskRepo.updateFromExecutor(id, data)
      : await super.patch(id, data, params);

    if (isRunningTransition && !Array.isArray(result)) {
      this.trackTaskStarted(result as Task);
    }

    // Emit analytics for terminal task transitions, including timeouts that do not
    // run the broader task-completion side effects below.
    if (isAnalyticsTerminalTransition) {
      const task = result as Task;
      this.trackTaskCompleted(task);
    }

    // Run completion side effects only for statuses that historically completed
    // executor turns. Timeout paths patch session state separately and should not
    // enqueue callbacks, mark sessions promptable, archive forks, or drain queues here.
    if (isCompletionSideEffectTransition) {
      await this.processCompletionSideEffects(result as Task, data.status!, params);
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
      // - If target is promptable: immediately process the callback
      // - If target becomes promptable while waiting: the retry will catch it
      //
      // DO NOT check target status before triggering - let the queue processor handle it.
      // This ensures callbacks are never missed due to timing issues.
      try {
        console.log(
          `🔄 [TasksService] Triggering callback target queue processing for ${shortId(targetSessionId)} (callback queued)`
        );
        // Pass empty params to avoid leaking child's auth context to target.
        // The queue processor reconstructs target auth from queued task metadata.
        await this.triggerQueueProcessingAfterCommit(targetSessionId, {});
      } catch (error) {
        // Don't throw - target issues shouldn't break child queue processing.
        console.warn(
          `⚠️  [TasksService] Failed to trigger callback target queue processing (target may be deleted):`,
          error
        );
      }
    }

    // Post-callback cleanup: only runs after a callback task was actually
    // queued. "once" means "after firing" — do not permanently disable a
    // one-shot callback when delivery was skipped or failed before queueing.
    // Default to "persistent" for backward compat — legacy sessions without
    // callback_mode should continue firing on every completion as they always have.
    const callbackMode = childSession.callback_config?.callback_mode ?? 'persistent';
    if (dispatchResult.callbackTask && callbackMode === 'once') {
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
      return {};
    }

    const dispatch = (async (): Promise<CompletionCallbackDispatchResult> => {
      const latestTask = (await this.taskRepo.findById(task.task_id)) ?? task;
      if (this.hasCompletionCallbackDispatch(latestTask.metadata, targetSessionId)) {
        console.log(
          `⏭️  [TasksService] Completion callback for task ${shortId(task.task_id)} to ${shortId(targetSessionId)} already dispatched`
        );
        return {};
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

      return { callbackTask: queuedCallbackTask };
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

      // Get the original prompt from the completed task. When requested, it is
      // rendered as a section inside the single templated callback body (never
      // queued as its own callback/message).
      const spawnPrompt = includeOriginalPrompt
        ? task.full_prompt || '(no prompt available)'
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
   * Custom method: Get orphaned tasks (dispatching, running, stopping, awaiting permission)
   */
  async getOrphaned(_params?: TaskParams): Promise<Task[]> {
    return this.taskRepo.findOrphaned();
  }

  async findByIdForScopeCheck(taskId: TaskID): Promise<Task | null> {
    return this.taskRepo.findById(taskId);
  }

  async connectExecutor(data: { task_id: string }, params?: TaskParams): Promise<Task> {
    const connection = await this.taskRepo.connectExecutor(data.task_id);
    if (!connection) {
      const current = await this.taskRepo.findById(data.task_id);
      throw new Conflict(
        `Task ${shortId(data.task_id)} cannot connect an executor from status ${current?.status ?? 'unknown'}`
      );
    }
    if (connection.transitioned) {
      const startedAt = Date.parse(connection.task.started_at ?? '');
      const connectedAt = Date.parse(connection.task.executor_connected_at ?? '');
      if (Number.isFinite(startedAt) && Number.isFinite(connectedAt)) {
        console.log(
          `🔌 [TasksService] Executor connected for task ${shortId(connection.task.task_id)} ` +
            `in ${Math.max(0, connectedAt - startedAt)}ms`
        );
      }
      this.trackTaskStarted(connection.task);
      emitServiceEvent(this.app, {
        path: 'tasks',
        event: 'patched',
        data: connection.task,
        id: connection.task.task_id,
        params,
      });
    }
    return connection.task;
  }

  async recordExecutorStartupWarning(
    taskId: string,
    warning: string,
    params?: TaskParams
  ): Promise<Task | null> {
    const task = await this.taskRepo.recordExecutorStartupWarning(taskId, warning);
    if (task) {
      emitServiceEvent(this.app, {
        path: 'tasks',
        event: 'patched',
        data: task,
        id: task.task_id,
        params,
      });
    }
    return task;
  }

  async reportRuntimeTelemetry(data: RuntimeTelemetryInput, params?: TaskParams): Promise<Task> {
    if (data.pulse) {
      const { sequence, kind, detail } = data.pulse;
      if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new BadRequest('pulse sequence must be a positive safe integer');
      }
      if (!Object.values(ExecutorPulseKind).includes(kind)) {
        throw new BadRequest('invalid executor pulse kind');
      }
      if (
        detail !== undefined &&
        (!/^[A-Za-z0-9._:/-]+$/.test(detail) || Buffer.byteLength(detail, 'utf8') > 128)
      ) {
        throw new BadRequest('pulse detail must be a bounded identifier');
      }
    }

    const task = await this.taskRepo.reportRuntimeTelemetry(data.task_id, data.pulse);
    if (!task) throw new Conflict(`Task ${shortId(data.task_id)} is not connected and active`);
    analyticsLogger.track(
      'executor.heartbeat',
      {
        task_id: task.task_id,
        session_id: task.session_id,
        status: task.status,
        last_executor_heartbeat_at: task.last_executor_heartbeat_at,
      },
      { userId: task.created_by }
    );
    void this.handleExecutorHeartbeat(task, task.last_executor_heartbeat_at!).catch((error) =>
      console.warn('Executor heartbeat callback failed:', error)
    );
    emitServiceEvent(this.app, {
      path: 'tasks',
      event: 'patched',
      data: task,
      id: task.task_id,
      params,
    });
    return task;
  }

  async reportSdkHealthFailure(data: SdkHealthFailureInput, params?: TaskParams): Promise<Task> {
    if (!SDK_WATCHDOG_FAILURE_REASONS.includes(data.reason))
      throw new BadRequest('invalid SDK health reason');
    for (const [name, value] of Object.entries({
      elapsed_ms: data.elapsed_ms,
      unknown_event_count: data.unknown_event_count,
    })) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new BadRequest(`${name} must be a non-negative safe integer`);
      }
    }
    if (
      data.sdk_version !== undefined &&
      (!/^[A-Za-z0-9@/._-]+$/.test(data.sdk_version) || data.sdk_version.length > 128)
    ) {
      throw new BadRequest('sdk_version must be a bounded identifier');
    }

    const current = await this.get(data.task_id, params);
    const mode = current.sdk_watchdog_mode ?? 'observe';
    if (mode === 'disabled') throw new Conflict('SDK watchdog is disabled for this Task');
    const action =
      data.reason === 'unknown_activity' || mode === 'observe' ? 'would_fire' : 'enforced';
    if (data.watchdog_action !== action) {
      throw new BadRequest(`watchdog_action must be ${action} for this Task`);
    }
    const duplicate =
      current.sdk_failure?.reason === data.reason &&
      current.sdk_failure.watchdog_action === action &&
      (action === 'would_fire' ||
        isTerminalTaskStatus(current.status) ||
        (current.status === TaskStatus.STOPPING &&
          current.termination_request?.cause === 'sdk_health_failure'));
    if (duplicate) return current;
    if (
      isTerminalTaskStatus(current.status) ||
      current.status === TaskStatus.STOPPING ||
      !current.executor_connected_at
    ) {
      throw new Conflict(`Task ${shortId(data.task_id)} is not connected and active`);
    }
    const session = await this.app.service('sessions').get(current.session_id, params);
    const failure: SdkFailure = {
      reason: data.reason,
      detected_at: new Date().toISOString(),
      tool: session.agentic_tool,
      last_pulse: current.latest_executor_pulse,
      elapsed_ms: data.elapsed_ms,
      watchdog_action: action,
      unknown_event_count: data.unknown_event_count,
      sdk_version: data.sdk_version,
      termination: action === 'enforced' ? 'requested' : 'not_requested',
    };
    if (action === 'would_fire') {
      const observed = await this.taskRepo.recordSdkHealthObservation(data.task_id, failure);
      if (!observed) throw new Conflict(`Task ${shortId(data.task_id)} is no longer active`);
      emitServiceEvent(this.app, {
        path: 'tasks',
        event: 'patched',
        data: observed,
        id: observed.task_id,
        params,
      });
      return observed;
    }

    return beginExecutorTermination({
      app: this.app,
      taskId: current.task_id,
      cause: 'sdk_health_failure',
      errorMessage: `SDK activity stalled (${data.reason}).`,
      params,
      signalDelayMs: resolveSdkWatchdogConfig(this.app.get?.('config')?.execution).abort_grace_ms,
      sdkFailure: failure,
    });
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
    // Terminal timing is computed atomically by TaskRepository.update().
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
  async fail(id: string, data: { error?: string }, params?: TaskParams): Promise<Task> {
    // Terminal timing is computed atomically by TaskRepository.update().
    return this.patch(
      id,
      {
        status: TaskStatus.FAILED,
        completed_at: new Date().toISOString(),
        error_message: data.error,
      },
      params
    ) as Promise<Task>;
  }
}

/**
 * Service factory function
 */
export function createTasksService(db: TenantScopeAwareDatabase, app: Application): TasksService {
  return new TasksService(db, app);
}
