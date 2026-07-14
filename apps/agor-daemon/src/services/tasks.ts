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
import {
  enqueueTenantDatabasePostCommitCallback,
  shortId,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, BadRequest, Conflict } from '@agor/core/feathers';
import type {
  ContentBlock,
  ExecutorClaim,
  ExecutorFinalizationEvidence,
  ExecutorLeaseTerminalCause,
  ExecutorTelemetryReport,
  Paginated,
  QueryParams,
  Session,
  SessionID,
  Task,
  TaskID,
  UUID,
} from '@agor/core/types';
import {
  EXECUTOR_CLEANUP_STATUS,
  EXECUTOR_FINALIZABLE_TASK_STATUSES,
  EXECUTOR_STATE_PERSISTENCE_REQUIREMENT,
  EXECUTOR_TERMINAL_CAUSE,
  isExecutorFinalizationReleasable,
  isMeaningfulPulse,
  isNaturalCompletion,
  isTerminalTaskStatus,
  normalizeTerminalTaskPatch,
  SessionStatus,
  sanitizePulse,
  type TaskMetadata,
  TaskStatus,
} from '@agor/core/types';
import { DrizzleService, type Query } from '../adapters/drizzle';
import { isTaskScopedExecutorParams } from '../auth/executor-runtime-scope.js';
import { untrackExecutorAttempt } from '../executor-tracking.js';
import { appendSystemMessage } from '../utils/append-system-message.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import {
  type ExecutorHeartbeatCallbackPayload,
  ExecutorHeartbeatCallbackRunner,
} from '../utils/executor-heartbeat-callback.js';
import { ensureRepoOriginAlignedById } from '../utils/realign-repo-origin';
import type { SessionsService } from './sessions';

const TASKS_SERVICE_PATH = 'tasks';
const TASK_PATCHED_EVENT = 'patched';
const EXECUTOR_HEARTBEAT_ANALYTICS_EVENT = 'executor.heartbeat';

/**
 * Task service params
 */
function isCompletionSideEffectTaskStatus(status: Task['status'] | undefined): boolean {
  return status !== undefined && (isNaturalCompletion(status) || status === TaskStatus.STOPPED);
}

function isValidExecutorAttemptId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export type TaskParams = QueryParams<{
  task_id?: string;
  session_id?: string;
  status?: Task['status'];
}> & {
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
    if (params?._agorSqlSessionAccessUserId) {
      return super.find(params);
    }

    // If filtering by session_id as a scalar string, use repository shortcut.
    // Note: `session_id` may be injected as `{ $in: [...] }` by the RBAC scoping
    // hook — in that case we fall through to `super.find`, whose adapter's
    // `filterData` handles $in natively.
    if (typeof params?.query?.session_id === 'string' && params.query.task_id === undefined) {
      const statusQuery = params.query.status as TaskStatus | { $in?: TaskStatus[] } | undefined;
      const requestedStatuses =
        typeof statusQuery === 'string'
          ? new Set([statusQuery])
          : Array.isArray(statusQuery?.$in)
            ? new Set(statusQuery.$in)
            : undefined;
      const sessionTasks = await this.taskRepo.findBySession(params.query.session_id);
      const tasks = requestedStatuses
        ? sessionTasks.filter((task) => requestedStatuses.has(task.status))
        : sessionTasks;

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
            status: SessionStatus.RUNNING,
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

  async failExpiredExecutorAttempt(
    id: string,
    data: {
      executor_attempt_id: string;
      stale_before: string;
      completed_at?: string;
      error_message: string;
      terminal_cause: ExecutorLeaseTerminalCause;
    },
    params?: TaskParams
  ): Promise<{ task: Task; transitioned: boolean }> {
    const failure = await this.taskRepo.failExpiredExecutorAttempt(id, {
      executorAttemptId: data.executor_attempt_id,
      staleBefore: data.stale_before,
      completedAt: data.completed_at ?? new Date().toISOString(),
      errorMessage: data.error_message,
      terminalCause: data.terminal_cause,
    });
    if (!failure.transitioned) {
      console.log(
        `⏭️ [TasksService] Skipping expired executor lease for task ${shortId(failure.task.task_id)} ` +
          `(status=${failure.task.status})`
      );
      return failure;
    }
    this.publishExecutorLeaseFailure(failure.task, params);
    return failure;
  }

  private publishExecutorLeaseFailure(task: Task, params?: TaskParams): void {
    this.trackTaskCompleted(task);
    emitServiceEvent(this.app, {
      path: TASKS_SERVICE_PATH,
      event: TASK_PATCHED_EVENT,
      data: task,
      params,
      id: task.task_id,
    });
  }

  /** Whether this terminal attempt still owns the session readiness fence. */
  async ownsExecutorFinalizationFence(
    taskId: string,
    executorAttemptId: string,
    params?: TaskParams
  ): Promise<boolean> {
    const task = await this.get(taskId, params);
    if (
      task.executor_attempt_id !== executorAttemptId ||
      !EXECUTOR_FINALIZABLE_TASK_STATUSES.has(task.status)
    ) {
      return false;
    }

    const session = await this.app.service('sessions').get(task.session_id, params);
    if (session.ready_for_prompt) return false;

    const taskIndex = session.tasks?.indexOf(task.task_id) ?? -1;
    if (taskIndex < 0) return false;
    const laterTaskIds = session.tasks?.slice(taskIndex + 1) ?? [];
    const laterTasks = await Promise.all(laterTaskIds.map((id: string) => this.get(id, params)));
    return laterTasks.every(
      (laterTask) =>
        laterTask.status === TaskStatus.QUEUED ||
        (laterTask.status === TaskStatus.STOPPED &&
          !laterTask.started_at &&
          !laterTask.executor_attempt_id)
    );
  }

  /**
   * The single release gate for executor-owned turns. Task status records the
   * outcome; ready_for_prompt remains false until workload cleanup and any
   * required state persistence are both proven.
   */
  async finalizeExecutorAttempt(
    taskId: string,
    executorAttemptId: string,
    options: {
      evidence: ExecutorFinalizationEvidence;
    },
    params?: TaskParams
  ): Promise<{ finalized: boolean; released: boolean }> {
    if (!(await this.ownsExecutorFinalizationFence(taskId, executorAttemptId, params))) {
      const task = await this.get(taskId, params);
      if (
        task.executor_attempt_id === executorAttemptId &&
        EXECUTOR_FINALIZABLE_TASK_STATUSES.has(task.status) &&
        options.evidence.cleanup_status === EXECUTOR_CLEANUP_STATUS.VERIFIED
      ) {
        untrackExecutorAttempt(task.session_id, executorAttemptId);
      }
      return { finalized: false, released: false };
    }

    const task = await this.get(taskId, params);
    const durableFinalization = {
      ...task.executor_finalization,
      state_persistence_requirement:
        task.executor_finalization?.state_persistence_requirement ??
        EXECUTOR_STATE_PERSISTENCE_REQUIREMENT.NOT_REQUIRED,
      ...options.evidence,
    };
    await super.patch(
      taskId,
      { executor_finalization: durableFinalization },
      { ...params, provider: undefined }
    );
    const targetStatus =
      task.status === TaskStatus.FAILED
        ? SessionStatus.FAILED
        : task.status === TaskStatus.TIMED_OUT
          ? SessionStatus.TIMED_OUT
          : SessionStatus.IDLE;
    const released = isExecutorFinalizationReleasable(durableFinalization);
    const sessionsService = this.app.service('sessions');
    if (released) {
      const session = (await sessionsService.get(task.session_id, params)) as Session;
      await this.dispatchCompletionSideEffectsAfterCommit(task, session, params);
    }
    await sessionsService.patch(
      task.session_id,
      {
        status: released ? targetStatus : SessionStatus.FAILED,
        ready_for_prompt: released,
      },
      params
    );

    if (options.evidence.cleanup_status === EXECUTOR_CLEANUP_STATUS.VERIFIED) {
      untrackExecutorAttempt(task.session_id, executorAttemptId);
    }
    return { finalized: true, released };
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

  private publishExecutorHeartbeat(task: Task, heartbeatAt: string): void {
    analyticsLogger.track(
      EXECUTOR_HEARTBEAT_ANALYTICS_EVENT,
      {
        task_id: task.task_id,
        session_id: task.session_id,
        status: task.status,
        last_executor_heartbeat_at: heartbeatAt,
      },
      { userId: task.created_by }
    );
    this.handleExecutorHeartbeat(task, heartbeatAt).catch((error) => {
      console.warn(
        `⚠️  [TasksService] Executor heartbeat callback failed for task ${shortId(task.task_id)}:`,
        error
      );
    });
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

  /** Run terminal side effects that must not precede executor cleanup. */
  private async dispatchCompletionSideEffectsAfterCommit(
    task: Task,
    session: Session,
    params?: TaskParams
  ): Promise<void> {
    await this.runAfterTenantDatabaseCommit('dispatchCompletionSideEffects', async () => {
      const hasCompletionOutput = isNaturalCompletion(task.status);

      if (session.branch_id) {
        this.app
          .service('branches')
          .get(session.branch_id, params)
          .then((branch) => {
            if (branch?.repo_id)
              return ensureRepoOriginAlignedById(this.app, branch.repo_id, params);
          })
          .catch((error: unknown) => {
            console.warn(
              `⚠️  [TasksService] Failed to realign repo for session ${shortId(session.session_id)}:`,
              error instanceof Error ? error.message : String(error)
            );
          });
      }

      if (hasCompletionOutput) {
        await this.dispatchCompletionCallbacks(task, session, params);
      }

      if (session.fork_origin !== 'btw') return;

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

      if (hasCompletionOutput) {
        await this.injectBtwResultMessage(task, session, params);
      }
    });
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
    if (currentTask && isTerminalTaskStatus(currentTask.status) && nextStatus !== undefined) {
      console.warn(
        `⏭️ [TasksService] Ignoring status rewrite for terminal task ${shortId(currentTask.task_id)} ` +
          `(${currentTask.status} → ${nextStatus})`
      );
      return currentTask;
    }
    const isAnalyticsTerminalTransition =
      isTerminalTaskStatus(nextStatus) && !isTerminalTaskStatus(currentTask?.status);
    const isCompletionSideEffectTransition =
      isCompletionSideEffectTaskStatus(nextStatus) &&
      !isCompletionSideEffectTaskStatus(currentTask?.status);
    const isExecutorCompletion =
      !!currentTask?.executor_attempt_id &&
      nextStatus !== undefined &&
      EXECUTOR_FINALIZABLE_TASK_STATUSES.has(nextStatus);
    const isQueuedCancellation =
      currentTask?.status === TaskStatus.QUEUED && nextStatus === TaskStatus.STOPPED;
    const isRunningTransition =
      nextStatus === TaskStatus.RUNNING && currentTask?.status !== TaskStatus.RUNNING;

    // When transitioning to a terminal status, auto-compute duration, completed_at,
    // and end_timestamp. This ensures ALL code paths (complete, fail, stop handler)
    // get correct timing data without duplicating logic.
    if (isAnalyticsTerminalTransition && currentTask && nextStatus !== undefined) {
      data = normalizeTerminalTaskPatch(currentTask, { ...data, status: nextStatus });
    }

    let result: Task | Task[];
    if (
      currentTask?.executor_attempt_id &&
      nextStatus !== undefined &&
      isTerminalTaskStatus(nextStatus)
    ) {
      const executorReported = isTaskScopedExecutorParams(
        params ?? {},
        currentTask.task_id,
        currentTask.executor_attempt_id
      );
      const defaultCause =
        nextStatus === TaskStatus.TIMED_OUT
          ? EXECUTOR_TERMINAL_CAUSE.PERMISSION_TIMEOUT
          : executorReported
            ? EXECUTOR_TERMINAL_CAUSE.EXECUTOR_REPORTED
            : nextStatus === TaskStatus.STOPPED
              ? EXECUTOR_TERMINAL_CAUSE.USER_STOP
              : nextStatus === TaskStatus.COMPLETED
                ? EXECUTOR_TERMINAL_CAUSE.EXECUTOR_REPORTED
                : EXECUTOR_TERMINAL_CAUSE.LAUNCH_FAILED_UNKNOWN;
      const transition = await this.taskRepo.transitionOwnedExecutorAttemptToTerminal(id, {
        executorAttemptId: currentTask.executor_attempt_id,
        terminalCause: data.executor_terminal_cause ?? defaultCause,
        patch: { ...data, status: nextStatus },
      });
      if (!transition.transitioned) {
        console.warn(
          `⏭️ [TasksService] Ignoring competing executor terminal outcome for task ${shortId(transition.task.task_id)} ` +
            `(winner=${transition.task.status}/${transition.task.executor_terminal_cause ?? 'legacy'})`
        );
        return transition.task;
      }
      result = transition.task;
      emitServiceEvent(this.app, {
        path: TASKS_SERVICE_PATH,
        event: TASK_PATCHED_EVENT,
        data: transition.task,
        params,
        id: transition.task.task_id,
      });
    } else {
      result = await super.patch(id, data, params);
    }

    if (isRunningTransition && !Array.isArray(result)) {
      this.trackTaskStarted(result as Task);
    }

    if (data.last_executor_heartbeat_at && !Array.isArray(result)) {
      this.publishExecutorHeartbeat(result as Task, data.last_executor_heartbeat_at);
    }

    // Emit analytics for terminal task transitions, including timeouts that do not
    // run the broader task-completion side effects below.
    if (isAnalyticsTerminalTransition) {
      const task = result as Task;
      this.trackTaskCompleted(task);
    }

    // Executor terminal heads only claim the durable winner. The coordinator
    // owns cleanup, persistence, release, completion effects, and queue drain.
    if (isExecutorCompletion || isQueuedCancellation) return result;

    // Run completion side effects only for statuses that historically completed
    // executor turns. Timeout paths patch session state separately and should not
    // enqueue callbacks, mark sessions promptable, archive forks, or drain queues here.
    if (isCompletionSideEffectTransition) {
      // Since tasks are patched one at a time, result is always a single Task (not an array)
      const task = result as Task;

      if (task.session_id && this.app) {
        try {
          // CRITICAL: Check if THIS task is still the current/latest task before updating session
          // If a new task has started, we must NOT set the session to IDLE
          const session = await this.app.service('sessions').get(task.session_id, params);

          const latestTaskId = session.tasks?.[session.tasks.length - 1];
          // STOPPED tasks (user-cancelled or daemon-shutdown cleanup) never notify
          // parent sessions. A stopped child represents abandoned work — the parent
          // should not resume or be informed; it has its own lifecycle.
          const isStop = data.status === TaskStatus.STOPPED;

          if (latestTaskId && latestTaskId !== task.task_id) {
            console.log(
              `⏭️ [TasksService] Skipping session terminal-state update - task ${shortId(task.task_id)} is not the latest (latest: ${shortId(latestTaskId)})`
            );
            // Process completion callbacks only for naturally-terminal tasks (COMPLETED/FAILED).
            // STOPPED means the work was abandoned — don't notify the parent.
            if (!isStop) {
              await this.dispatchCompletionCallbacksAfterCommit(task, session, params);
            }
            return result;
          }

          await this.app.service('sessions').patch(
            task.session_id,
            {
              status: task.status === TaskStatus.FAILED ? SessionStatus.FAILED : SessionStatus.IDLE,
              ready_for_prompt: true,
            },
            params
          );

          console.log(
            `✅ [TasksService] Session ${shortId(task.session_id)} released after terminal task ${shortId(task.task_id)} (${task.status})`
          );
          await this.dispatchCompletionSideEffectsAfterCommit(task, session, params);
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

  /** Internal helper for hooks that must validate persisted executor connection state. */
  async findByIdForScopeCheck(taskId: TaskID): Promise<Task | null> {
    return this.taskRepo.findById(taskId);
  }

  /** Claim a DISPATCHING task after executor transport authentication. */
  async connectExecutor(data: ExecutorClaim, params?: TaskParams): Promise<Task> {
    if (!isValidExecutorAttemptId(data.executor_attempt_id)) {
      throw new BadRequest('Invalid executor claim');
    }

    const connection = await this.taskRepo.connectExecutor(data.task_id, data.executor_attempt_id);
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
      // The guarded repository transition bypasses the standard patch method,
      // so publish the canonical patched event explicitly for reactive clients.
      emitServiceEvent(this.app, {
        path: TASKS_SERVICE_PATH,
        event: TASK_PATCHED_EVENT,
        data: connection.task,
        params,
        id: connection.task.task_id,
      });
    }
    return connection.task;
  }

  /** Accept bounded executor telemetry and stamp it with daemon-observed time. */
  async reportExecutorTelemetry(data: ExecutorTelemetryReport, params?: TaskParams): Promise<Task> {
    if (
      !isValidExecutorAttemptId(data.executor_attempt_id) ||
      typeof data.heartbeat !== 'boolean'
    ) {
      throw new BadRequest('Invalid executor telemetry');
    }

    const pulse = data.pulse === undefined ? undefined : sanitizePulse(data.pulse);
    if (data.pulse !== undefined && !pulse) {
      throw new BadRequest('Invalid executor telemetry');
    }
    const meaningfulPulse = pulse && isMeaningfulPulse(pulse) ? pulse : undefined;
    if (!data.heartbeat && !meaningfulPulse) {
      throw new BadRequest('Executor telemetry must include a heartbeat or pulse');
    }

    const observedAt = new Date().toISOString();
    const updated = await this.taskRepo.recordExecutorTelemetry(
      data.task_id,
      data.executor_attempt_id,
      {
        ...(data.heartbeat ? { last_executor_heartbeat_at: observedAt } : {}),
        ...(meaningfulPulse
          ? { latest_executor_pulse: { ...meaningfulPulse, at: observedAt } }
          : {}),
      }
    );
    if (!updated) {
      throw new Conflict('Executor does not own this task or telemetry is no longer accepted');
    }
    emitServiceEvent(this.app, {
      path: TASKS_SERVICE_PATH,
      event: TASK_PATCHED_EVENT,
      data: updated,
      params,
      id: updated.task_id,
    });
    if (data.heartbeat) this.publishExecutorHeartbeat(updated, observedAt);
    return updated;
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
    return (await this.patch(
      id,
      {
        status: TaskStatus.COMPLETED,
        completed_at: new Date().toISOString(),
        report: data.report,
      },
      params
    )) as Task;
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
export function createTasksService(db: TenantScopeAwareDatabase, app: Application): TasksService {
  return new TasksService(db, app);
}
