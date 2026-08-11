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
  assertTenantWritable,
  bindRepositoryToTenantUnitOfWork,
  type ExecutorOutcomeSettlementResult,
  enqueueTenantDatabasePostCommitCallback,
  generateId,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  shortId,
  type TaskDispatchClaimResult,
  TaskRepository,
  type TaskTerminationCoordinationClaimInput,
  type TaskTerminationCoordinationClaimResult,
  type TenantScopeAwareDatabase,
  type TerminationClaimInput,
  type TerminationClaimResult,
  type TerminationSettlementInput,
  type TerminationSettlementResult,
} from '@agor/core/db';
import { type Application, BadRequest, Conflict } from '@agor/core/feathers';
import { deriveTitleFromPrompt } from '@agor/core/sessions';
import type {
  AuthenticatedParams,
  ContentBlock,
  ExecutorSettlementInput,
  ExecutorTerminationCompleteInput,
  MessageID,
  Paginated,
  QueryParams,
  RuntimeTelemetryInput,
  SdkFailure,
  SdkHealthFailureInput,
  Session,
  SessionID,
  Task,
  TaskID,
  TaskPendingDispatchStatus,
  UUID,
} from '@agor/core/types';
import {
  deriveTaskRuntimeProgressState,
  ExecutorPulseKind,
  ExecutorSettlementInputSchema,
  isTaskExecuting,
  isTerminalTaskStatus,
  MessageRole,
  SDK_WATCHDOG_FAILURE_REASONS,
  SessionStatus,
  TaskStatus,
} from '@agor/core/types';
import { DrizzleService, type Query } from '../adapters/drizzle';
import {
  claimExecutorTermination,
  requestExecutorTermination,
  type TerminationInput,
} from '../termination-coordinator.js';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import {
  type ExecutorHeartbeatCallbackPayload,
  ExecutorHeartbeatCallbackRunner,
} from '../utils/executor-heartbeat-callback.js';
import { ensureRepoOriginAlignedById } from '../utils/realign-repo-origin';
import { deferWithTenantContext } from '../utils/tenant-db-scope.js';
import type { GatewayProgressData, GatewayService } from './gateway.js';
import type { SessionsService } from './sessions';

function executorTerminalStatus(
  settlement: Extract<ExecutorSettlementInput, { kind: 'quiesced' }>
): typeof TaskStatus.COMPLETED | typeof TaskStatus.FAILED | typeof TaskStatus.TIMED_OUT {
  if (settlement.result === 'success') return TaskStatus.COMPLETED;
  return settlement.failure_cause === 'interaction_timeout'
    ? TaskStatus.TIMED_OUT
    : TaskStatus.FAILED;
}

export type TaskParams = QueryParams<{
  session_id?: string;
  status?: Task['status'];
}> &
  AuthenticatedParams & {
    /**
     * Internal-only: skip the immediate queue trigger when the fleet worker or
     * ordered startup repair owns continuation. Other terminal consequences
     * still materialize.
     */
    suppressTerminalQueueProcessing?: boolean;
    /**
     * Internal-only escape hatch for preserving an ephemeral BTW fork after
     * terminal transition. Most callers should leave this unset.
     */
    suppressBtwCleanup?: boolean;
    /** Startup repair reruns only durable terminal consequences. */
    repairTerminalConsequences?: boolean;
    /** Internal RBAC SQL pushdown marker set by register-hooks for external regular users. */
    _agorSqlSessionAccessUserId?: UUID;
  };

interface CompletionCallbackDispatchResult {
  dispatched: boolean;
  callbackTask?: Task;
}

type DeferredTerminationInput = Omit<TerminationInput, 'app' | 'params'>;

/**
 * Extended tasks service with custom methods
 */
export class TasksService extends DrizzleService<Task, Partial<Task>, TaskParams> {
  private taskRepo: TaskRepository;
  private app: Application;
  private db: TenantScopeAwareDatabase;
  private heartbeatCallbackRunner: ExecutorHeartbeatCallbackRunner;

  constructor(db: TenantScopeAwareDatabase, app: Application) {
    const taskRepo = bindRepositoryToTenantUnitOfWork(db, new TaskRepository(db));
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

  /** Atomic daemon-side launch-intent fence plus its Session projection. */
  async claimDispatchAndProjectSession(
    taskId: string,
    expectedStatus: TaskPendingDispatchStatus,
    updates: Partial<Task>,
    params?: TaskParams
  ): Promise<TaskDispatchClaimResult> {
    const result = await this.taskRepo.claimDispatchAndProjectSession(
      taskId,
      expectedStatus,
      updates
    );
    if (result.outcome === 'claimed') {
      await this.runAfterTenantDatabaseCommit('publish dispatch claim', async () => {
        const internalParams = { ...(params ?? {}), provider: undefined } as TaskParams;
        const currentTask = (await this.taskRepo.findById(result.task.task_id)) ?? result.task;
        const currentSession = (await this.app
          .service('sessions')
          .get(result.task.session_id, internalParams)) as Session;
        emitServiceEvent(this.app, {
          path: 'tasks',
          event: 'patched',
          data: currentTask,
          params,
          id: currentTask.task_id,
        });
        emitServiceEvent(this.app, {
          path: 'sessions',
          event: 'patched',
          data: currentSession,
          params,
          id: currentSession.session_id,
        });
      });
    }
    return result;
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

    if (!Array.isArray(result)) {
      await this.autoTitleSession(result, params);
    }

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

  /**
   * Assign the deterministic title as soon as an eligible textual task exists.
   *
   * The prompt route also calls this after its repository-level pending-task
   * insert, which deliberately bypasses create() to own queue positioning.
   */
  async autoTitleSession(task: Task, params?: TaskParams): Promise<void> {
    if (!task.full_prompt) return;

    const autoTitle = deriveTitleFromPrompt(task.full_prompt);
    if (!autoTitle) return;

    try {
      const fresh = await this.app.service('sessions').get(task.session_id, params);
      // null/undefined means unset. An empty string is an explicit user choice.
      if (fresh.title == null) {
        // Keep trusted metadata separate from prompt-flow patches so external
        // collaborators do not need permission to edit session metadata.
        await this.app
          .service('sessions')
          .patch(task.session_id, { title: autoTitle }, { ...params, provider: undefined });
      }
    } catch (titleError) {
      const message = titleError instanceof Error ? titleError.message : String(titleError);
      console.warn(
        `⚠️  [TasksService] Auto-title failed for session ${shortId(task.session_id)}: ${message}`
      );
    }
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
    const claimed = result.outcome === 'claimed';
    const retryingActiveRequest =
      result.outcome === 'unchanged' &&
      result.task.status === TaskStatus.STOPPING &&
      !!result.task.termination_request &&
      !result.task.termination_request.executor_quiesced_at;
    if (!claimed && !retryingActiveRequest) return result;

    await this.runAfterTenantDatabaseCommit('publish termination claim', async () => {
      if (claimed) {
        emitServiceEvent(this.app, {
          path: 'tasks',
          event: 'patched',
          data: result.task,
          id: result.task.task_id,
          params,
        });
      }
      // A repeated claim keeps the original requested_at fence but
      // re-publishes the private control event. This makes Stop retryable
      // after a lost socket delivery without creating a new cancellation
      // epoch.
      emitServiceEvent(this.app, {
        path: 'tasks',
        event: 'termination_requested',
        data: result.task,
        id: result.task.task_id,
        method: 'patch',
        params,
      });
      if (claimed) {
        const session = await this.app
          .service('sessions')
          .get(result.task.session_id, { ...(params ?? {}), provider: undefined });
        emitServiceEvent(this.app, {
          path: 'sessions',
          event: 'patched',
          data: session,
          id: session.session_id,
          params,
        });
      }
    });
    return result;
  }

  async claimTerminationCoordination(
    input: TaskTerminationCoordinationClaimInput,
    params?: TaskParams
  ): Promise<TaskTerminationCoordinationClaimResult> {
    const result = await this.taskRepo.claimTerminationCoordination(input);
    if (result.outcome === 'claimed') {
      await this.runAfterTenantDatabaseCommit('publish termination coordination', async () => {
        emitServiceEvent(this.app, {
          path: 'tasks',
          event: 'patched',
          data: result.task,
          id: result.task.task_id,
          params,
        });
      });
    }
    return result;
  }

  async settleTermination(
    input: TerminationSettlementInput,
    params?: TaskParams
  ): Promise<TerminationSettlementResult> {
    const result = await this.taskRepo.settleTermination(input);
    if (result.outcome === 'unverified') {
      await this.runAfterTenantDatabaseCommit('publish termination settlement', async () => {
        emitServiceEvent(this.app, {
          path: 'tasks',
          event: 'patched',
          data: result.task,
          id: result.task.task_id,
          params,
        });
      });
      return result;
    }
    await this.reconcileTerminalSettlement(result, params);
    return result;
  }

  private async reconcileTerminalSettlement(
    result: ExecutorOutcomeSettlementResult | TerminationSettlementResult,
    params?: TaskParams
  ): Promise<void> {
    if (result.outcome !== 'transitioned' && result.outcome !== 'terminal') return;

    const reconcile = async () => {
      if (result.outcome === 'transitioned') {
        emitServiceEvent(this.app, {
          path: 'tasks',
          event: 'patched',
          data: result.task,
          id: result.task.task_id,
          params,
        });
        this.trackTaskCompleted(result.task);
      }

      const internalParams = { ...(params ?? {}), provider: undefined } as TaskParams;
      const isStop = result.task.status === TaskStatus.STOPPED;
      await this.reconcileTerminalTask(
        result.task,
        result.task.status,
        {
          ...internalParams,
          // The durable all-daemon queue worker reevaluates non-Stop terminal
          // outcomes. A Stop caller may still own one immediate hand-off.
          suppressTerminalQueueProcessing:
            !isStop || params?.suppressTerminalQueueProcessing === true,
        },
        true
      );
    };

    if (!enqueueTenantDatabasePostCommitCallback(reconcile)) await reconcile();
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

    if (!enqueueTenantDatabasePostCommitCallback(run)) await run();
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

  private deferTenantOrchestration(
    label: string,
    params: TaskParams | undefined,
    work: () => Promise<void>
  ): void {
    deferWithTenantContext(params, work, (error) => {
      console.warn(
        `⚠️  [TasksService] ${label} failed:`,
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  private async continueQueuedTasksAfterTerminalSettlement(
    task: Task,
    params?: TaskParams
  ): Promise<void> {
    if (!params?.suppressTerminalQueueProcessing) {
      const sessionsService = this.app.service('sessions') as unknown as SessionsService;
      await sessionsService.triggerQueueProcessing(
        task.session_id,
        params as Parameters<SessionsService['triggerQueueProcessing']>[1]
      );
      return;
    }
    console.log(
      `⏭️  [TasksService] Queue trigger suppressed for session ${shortId(task.session_id)} (suppressTerminalQueueProcessing)`
    );
  }

  private async updateGatewayRuntimeProjectionAfterCommit(
    task: Task,
    params?: TaskParams
  ): Promise<void> {
    const state = deriveTaskRuntimeProgressState(task);
    if (
      state !== 'working' &&
      state !== 'waiting' &&
      state !== 'incompatible' &&
      state !== 'stalled'
    ) {
      return;
    }
    this.deferTenantOrchestration('updateGatewayRuntimeProjection', params, async () => {
      try {
        await (this.app.service('gateway') as unknown as GatewayService).updateProgress({
          session_id: task.session_id,
          task_id: task.task_id,
          state,
          ...(task.error_message ? { error_message: task.error_message } : {}),
        });
      } catch (error) {
        console.warn(
          `[gateway] Failed to project runtime state for Task ${shortId(task.task_id)}:`,
          error
        );
      }
    });
  }

  private projectTerminalSession(
    task: Task,
    status: Task['status'],
    session: Session,
    params?: TaskParams
  ): Promise<Session> {
    const alreadyProjected = session.runtime_projection?.terminal_task_id === task.task_id;
    return this.app.service('sessions').patch(
      task.session_id,
      {
        status:
          status === TaskStatus.FAILED
            ? SessionStatus.FAILED
            : status === TaskStatus.TIMED_OUT
              ? SessionStatus.TIMED_OUT
              : SessionStatus.IDLE,
        ...(alreadyProjected ? {} : { ready_for_prompt: true }),
        runtime_projection: {
          terminal_task_id: task.task_id,
          applied_at:
            (alreadyProjected ? session.runtime_projection?.applied_at : undefined) ??
            new Date().toISOString(),
        },
      },
      params
    ) as Promise<Session>;
  }

  /**
   * Repair the coarse Session projection from durable Task truth. This is the
   * bounded startup/route repair entry point; normal terminal settlement uses
   * reconcileTerminalTask so terminal callbacks and gateway delivery share
   * the same owner.
   */
  async reconcileSessionState(sessionId: string, params?: TaskParams): Promise<Session> {
    const tasks = await this.taskRepo.findBySession(sessionId);
    const activeTask = [...tasks].reverse().find(isTaskExecuting);
    if (activeTask) {
      const status =
        activeTask.status === TaskStatus.STOPPING
          ? SessionStatus.STOPPING
          : activeTask.status === TaskStatus.AWAITING_PERMISSION
            ? SessionStatus.AWAITING_PERMISSION
            : activeTask.status === TaskStatus.AWAITING_INPUT
              ? SessionStatus.AWAITING_INPUT
              : SessionStatus.RUNNING;
      return this.app
        .service('sessions')
        .patch(sessionId, { status, ready_for_prompt: false }, params) as Promise<Session>;
    }

    const latestTerminalTask = [...tasks]
      .reverse()
      .find((task) => isTerminalTaskStatus(task.status));
    if (latestTerminalTask) {
      await this.reconcileTerminalTask(latestTerminalTask, latestTerminalTask.status, params);
      return this.app.service('sessions').get(sessionId, params) as Promise<Session>;
    }

    return this.app
      .service('sessions')
      .patch(
        sessionId,
        { status: SessionStatus.IDLE, ready_for_prompt: true },
        params
      ) as Promise<Session>;
  }

  private async materializeTerminalConsequences(
    task: Task,
    status: Task['status'],
    session: Session,
    continueQueue: boolean,
    params?: TaskParams
  ): Promise<void> {
    const gatewayData = this.gatewayTerminalData(task, status);
    if (status !== TaskStatus.STOPPED) {
      await this.dispatchCompletionCallbacks(task, session, params);
    }
    const gateway = this.app.service('gateway') as unknown as GatewayService;
    await gateway.finalizeTask(gatewayData);
    if (continueQueue) {
      await this.continueQueuedTasksAfterTerminalSettlement(task, params);
    }
    await this.taskRepo.markTerminalConsequencesComplete(task.task_id);
    gateway.deliverTerminalTaskAfterCommit(gatewayData, params);
  }

  private async finishTerminalConsequences(
    task: Task,
    status: Task['status'],
    session: Session,
    continueQueue: boolean,
    params?: TaskParams
  ): Promise<void> {
    const work = () =>
      this.materializeTerminalConsequences(task, status, session, continueQueue, params);
    if (params?.repairTerminalConsequences) {
      await work();
      return;
    }
    this.deferTenantOrchestration('materializeTerminalConsequences', params, work);
  }

  /**
   * Idempotently reconcile the Session-level consequences of a terminal Task.
   *
   * Task terminality is the durable trigger. Adapters, Session hooks, and
   * process-exit handlers must not independently project terminal state or
   * drain dependent work.
   */
  async reconcileTerminalTask(
    task: Task,
    status: Task['status'],
    params?: TaskParams,
    sessionProjectionAlreadyCommitted = false
  ): Promise<boolean> {
    if (!task.session_id || !this.app) return false;
    const session = await this.app.service('sessions').get(task.session_id, params);
    const repairOnly = params?.repairTerminalConsequences === true;

    if (!repairOnly && session.branch_id) {
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
    const isForcedTermination =
      !!task.termination_request && task.termination_request.cause !== 'runtime_settlement';

    if (latestTaskId && latestTaskId !== task.task_id) {
      console.log(
        `⏭️ [TasksService] Skipping session terminal-state update - task ${shortId(task.task_id)} is not the latest (latest: ${shortId(latestTaskId)})`
      );
      await this.finishTerminalConsequences(task, status, session, false, params);
      return false;
    }

    if (sessionProjectionAlreadyCommitted) {
      // Publish the latest Session fact rather than rewriting it. It may
      // already reflect a newer Task admitted after the settlement commit.
      emitServiceEvent(this.app, {
        path: 'sessions',
        event: 'patched',
        data: session,
        id: session.session_id,
        params,
      });
    } else {
      await this.projectTerminalSession(task, status, session, params);
      console.log(
        `✅ [TasksService] Session ${shortId(task.session_id)} status updated after terminal task (task ${shortId(task.task_id)} ${status})`
      );
    }

    // Defensive fallback for tasks created before create-time auto-title
    // ran (or after a transient title-patch failure). Later completed
    // textual tasks can still title a session left unset by blank or
    // image-only prompts.
    if (!repairOnly && status === TaskStatus.COMPLETED) {
      await this.autoTitleSession(task, params);
    }

    if (session.fork_origin === 'btw') {
      if (!isStop && !isForcedTermination) {
        await this.injectBtwResultMessage(task, session, params);
      }
      if (!suppressBtwCleanup) {
        await this.app
          .service('sessions')
          .patch(session.session_id, { archived: true, archived_reason: 'btw_completed' }, params);
        console.log(
          `📦 [TasksService] Auto-archived btw fork session ${shortId(session.session_id)}`
        );
      }
    }

    await this.finishTerminalConsequences(task, status, session, true, params);
    return true;
  }

  private gatewayTerminalData(task: Task, status: Task['status']): GatewayProgressData {
    return {
      session_id: task.session_id,
      task_id: task.task_id,
      state: status === TaskStatus.FAILED || status === TaskStatus.TIMED_OUT ? 'failed' : 'done',
      ...(task.error_message ? { error_message: task.error_message } : {}),
    };
  }

  /** Generic patches may update live Task facts, but the release gate owns terminality. */
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
    if (currentTask && isTerminalTaskStatus(nextStatus)) {
      throw new BadRequest('Terminal Tasks must settle through the runtime release gate');
    }
    const isRunningTransition =
      nextStatus === TaskStatus.RUNNING && currentTask?.status !== TaskStatus.RUNNING;

    const result = params?.provider
      ? await this.taskRepo.updateFromExecutor(id, data)
      : await super.patch(id, data, params);

    if (isRunningTransition && !Array.isArray(result)) {
      this.trackTaskStarted(result as Task);
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
    params?: TaskParams
  ): Promise<void> {
    const parentSessionId = btwSession.genealogy?.forked_from_session_id;
    if (!parentSessionId) return;
    const latestTask = (await this.taskRepo.findById(task.task_id)) ?? task;
    if (latestTask.metadata?.btw_result_delivery?.parent_session_id === parentSessionId) {
      console.log(
        `⏭️  [TasksService] BTW result for task ${shortId(task.task_id)} already delivered`
      );
      return;
    }

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
    const parentSession = await this.app.service('sessions').get(parentSessionId, params);
    const parentLatestTaskId = parentSession.tasks?.[parentSession.tasks.length - 1];

    // For remote btw, fetch the caller session's title
    const callerSessionId = btwSession.callback_config?.callback_session_id;
    let callerTitle: string | undefined;
    if (callerSessionId) {
      try {
        const callerSession = await this.app.service('sessions').get(callerSessionId, params);
        callerTitle = callerSession.title;
      } catch {
        // Caller session may have been deleted — not critical
      }
    }

    // Build preview from prompt + response
    const previewText = `Q: ${promptText.substring(0, 80)} → A: ${responseText.substring(0, 100)}`;

    const timestamp = new Date().toISOString();
    const delivered = await this.taskRepo.createBtwResultMessageOnce(
      task.task_id,
      parentSessionId,
      {
        message_id: generateId() as MessageID,
        task_id: parentLatestTaskId as TaskID | undefined,
        type: 'system',
        role: MessageRole.SYSTEM,
        timestamp,
        content: [{ type: 'text', text: responseText } as ContentBlock],
        content_preview: previewText.substring(0, 200),
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
      }
    );
    if (!delivered.created) {
      console.log(
        `⏭️  [TasksService] BTW result for task ${shortId(task.task_id)} already delivered`
      );
      return;
    }
    emitServiceEvent(this.app, {
      path: 'messages',
      event: 'created',
      data: delivered.message,
      id: delivered.message.message_id,
      params,
    });

    console.log(
      `💬 [TasksService] Injected btw result message into parent session ${shortId(parentSessionId)} from btw fork ${shortId(btwSession.session_id)}`
    );
  }

  /**
   * Centralized completion-callback dispatcher.
   *
   * Task-level and session-configured callbacks resolve to the same
   * target/event pair: `task_completion` delivered to
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
    const sessionTargetId = this.resolveCompletionCallbackTarget(childSession);
    const taskTargetId = task.metadata?.completion_callback?.target_session_id;
    const targetSessionIds = [
      ...new Set([sessionTargetId, taskTargetId].filter(Boolean)),
    ] as SessionID[];

    for (const targetSessionId of targetSessionIds) {
      const dispatchResult = await this.queueCallbackToSession(
        task,
        childSession,
        targetSessionId,
        params
      );

      if (dispatchResult.callbackTask?.status === TaskStatus.QUEUED) {
        try {
          console.log(
            `🔄 [TasksService] Triggering callback target queue processing for ${shortId(targetSessionId)} (callback queued)`
          );
          // Do not leak the child request's auth context into the target. The
          // callback Task is already durable; this is only a best-effort wake.
          await (this.app.service('sessions') as unknown as SessionsService).triggerQueueProcessing(
            targetSessionId,
            { tenant: params?.tenant }
          );
        } catch (error) {
          console.warn(
            '⚠️  [TasksService] Failed to trigger callback target queue processing (target may be deleted):',
            error
          );
        }
      }

      // A task-only callback must never consume a Session-level one-shot.
      const callbackMode = childSession.callback_config?.callback_mode ?? 'persistent';
      if (
        dispatchResult.dispatched &&
        targetSessionId === sessionTargetId &&
        callbackMode === 'once'
      ) {
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
          console.warn('⚠️  [TasksService] Failed to auto-disable callback:', error);
        }
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
  ): Promise<CompletionCallbackDispatchResult> {
    if (!targetSessionId) return { dispatched: false };

    try {
      // Get target session to check callback config
      // NOTE: DO NOT pass params here - params are from child session context (executor),
      // but we need to access target session without child's authentication constraints
      const targetSession = await this.app.service('sessions').get(targetSessionId);

      // Check callback config - child overrides take precedence over target defaults
      // For subsessions (parent_session_id), default is enabled=true
      // For remote sessions (callback_session_id), enabled is explicitly set at creation time
      const isExactTaskCallback =
        task.metadata?.completion_callback?.target_session_id === targetSessionId;
      const callbackEnabled =
        isExactTaskCallback ||
        (childSession.callback_config?.enabled ?? targetSession.callback_config?.enabled ?? true);

      if (!callbackEnabled) {
        console.log(
          `⏭️  [TasksService] Callbacks disabled for child session ${shortId(childSession.session_id)}`
        );
        return { dispatched: false };
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
        return { dispatched: false };
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
      const taskCallback = task.metadata?.completion_callback;
      const callbackCreator =
        (taskCallback?.target_session_id === targetSessionId
          ? taskCallback.requested_by_user_id
          : undefined) ??
        childSession.callback_config?.callback_created_by ??
        targetSession.created_by;
      const createCallbackTask = () =>
        this.taskRepo.createCompletionCallbackOnce(task.task_id, targetSessionId, {
          full_prompt: callbackMessage,
          created_by: callbackCreator,
          metadata: {
            is_agor_callback: true,
            source: 'agor',
            child_session_id: childSession.session_id,
            child_task_id: task.task_id,
            queued_by_user_id: callbackCreator,
          },
        });
      const tenantId = getCurrentTenantId() ?? params?.tenant?.tenant_id;
      const result = tenantId
        ? await runWithTenantDatabaseScope(this.db, tenantId, async (tenantDb) => {
            await assertTenantWritable(tenantDb, tenantId);
            return createCallbackTask();
          })
        : await createCallbackTask();
      if (!result.task) return { dispatched: true };

      if (result.created) {
        this.emit?.('queued', result.task);
        console.log(
          `🔔 Queued callback task ${shortId(result.task.task_id)} on session ${shortId(targetSessionId)} from child ${shortId(childSession.session_id)}`
        );
      }
      return { dispatched: true, callbackTask: result.task };
    } catch (error) {
      console.error(
        `❌ [TasksService] Failed to queue callback to ${targetSessionId} for session ${childSession.session_id}:`,
        error
      );
      throw error;
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

  private deferExecutorTermination(input: DeferredTerminationInput, params?: TaskParams): void {
    const coordinatorParams = { ...(params ?? {}), provider: undefined };
    deferWithTenantContext(
      params,
      () =>
        requestExecutorTermination({
          ...input,
          app: this.app,
          params: coordinatorParams,
        }).then(() => undefined),
      (error) =>
        console.error(`[termination] Failed to coordinate Task ${shortId(input.taskId)}:`, error)
    );
  }

  private async claimAndDeferExecutorTermination(
    input: DeferredTerminationInput,
    params?: TaskParams
  ): Promise<Task> {
    const claim = await claimExecutorTermination({
      ...input,
      app: this.app,
      params,
    });
    if (claim.outcome !== 'condition_changed') {
      this.deferExecutorTermination(input, params);
    }
    return claim.task;
  }

  async reportTerminationComplete(
    data: ExecutorTerminationCompleteInput,
    params?: TaskParams
  ): Promise<Task> {
    const task = await this.taskRepo.recordExecutorQuiescence(data);
    if (!task?.termination_request) {
      throw new Conflict(
        `Task ${shortId(data.task_id)} has no matching active termination request`
      );
    }
    const terminationRequest = task.termination_request;

    emitServiceEvent(this.app, {
      path: 'tasks',
      event: 'patched',
      data: task,
      id: task.task_id,
      params,
    });

    // Do not await containment here. A local executor must receive this RPC
    // response before it can exit, while the coordinator verifies that process
    // group only after the wrapper exits. Start recovery after this service
    // transaction commits and outside its ALS database scope; the durable
    // quiescence timestamp makes the deferred recovery restart/retry safe.
    this.deferExecutorTermination(
      {
        taskId: task.task_id,
        cause: terminationRequest.cause,
        errorMessage: terminationRequest.error_message ?? 'Executor stopped cooperatively.',
      },
      params
    );

    return task;
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

  async reportExecutorSettlement(
    data: ExecutorSettlementInput,
    params?: TaskParams
  ): Promise<Task> {
    const parsed = ExecutorSettlementInputSchema.safeParse(data);
    if (!parsed.success) throw new BadRequest('Invalid executor settlement payload');
    const settlement = parsed.data;

    if (settlement.kind === 'containment_required') {
      return this.claimAndDeferExecutorTermination(
        {
          taskId: settlement.task_id,
          cause: 'runtime_cleanup_failed',
          errorMessage: settlement.error_message,
          runtimeCleanupUnverified: settlement.runtime_cleanup_unverified,
        },
        params
      );
    }

    let sdkFailure: SdkFailure | undefined;
    if (settlement.result === 'failure' && settlement.failure_cause === 'agentic_tool_timeout') {
      const task = await this.get(settlement.task_id, params);
      const session = await this.app.service('sessions').get(task.session_id, params);
      sdkFailure = {
        reason: 'agentic_tool_timeout',
        detected_at: new Date().toISOString(),
        tool: session.agentic_tool,
        last_pulse: task.latest_executor_pulse,
        termination: 'verified',
      };
    }
    const result = await this.taskRepo.settleExecutorOutcome({
      taskId: settlement.task_id,
      status: executorTerminalStatus(settlement),
      taskPatch: settlement.task_patch,
      sdkFailure,
    });
    if (result.outcome === 'stopping' && result.task.termination_request) {
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
        console.warn(
          `[settlement] Failed to project STOPPING onto session ${shortId(result.task.session_id)}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
      this.deferExecutorTermination(
        {
          taskId: result.task.task_id,
          cause: result.task.termination_request.cause,
          errorMessage:
            result.task.termination_request.error_message ?? 'Executor runtime quiesced.',
        },
        params
      );
    } else {
      await this.reconcileTerminalSettlement(result, params);
    }
    return result.task;
  }

  async reportRuntimeTelemetry(data: RuntimeTelemetryInput, params?: TaskParams): Promise<Task> {
    for (const pulse of [data.pulse, data.progress]) {
      if (!pulse) continue;
      const { sequence, kind, detail } = pulse;
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
    if (data.progress && data.progress.kind !== ExecutorPulseKind.PROGRESS) {
      throw new BadRequest('retained progress pulse must have progress kind');
    }

    const task = await this.taskRepo.reportRuntimeTelemetry(
      data.task_id,
      data.pulse,
      data.progress
    );
    if (!task) {
      // Heartbeat responses are also the executor's durable control-plane
      // read. This lets a reconnected executor observe STOPPING through any
      // daemon even before cross-replica realtime fanout is enabled.
      const current = await this.taskRepo.findById(data.task_id);
      if (current?.status === TaskStatus.STOPPING && current.termination_request) return current;
      throw new Conflict(`Task ${shortId(data.task_id)} is not connected and active`);
    }
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
    await this.updateGatewayRuntimeProjectionAfterCommit(task, params);
    return task;
  }

  async reportSdkHealthFailure(data: SdkHealthFailureInput, params?: TaskParams): Promise<Task> {
    if (!SDK_WATCHDOG_FAILURE_REASONS.includes(data.reason))
      throw new BadRequest('invalid SDK health reason');
    for (const [name, value] of Object.entries({
      elapsed_ms: data.elapsed_ms,
      unknown_event_count: data.unknown_event_count,
      pulse_sequence_at_detection: data.pulse_sequence_at_detection,
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
    if (action === 'enforced' && data.pulse_sequence_at_detection === undefined) {
      throw new BadRequest('enforced SDK-health reports require pulse_sequence_at_detection');
    }
    const repeatedEnforcedFailure =
      action === 'enforced' &&
      current.sdk_failure?.reason === data.reason &&
      current.sdk_failure.watchdog_action === action &&
      (isTerminalTaskStatus(current.status) ||
        (current.status === TaskStatus.STOPPING &&
          current.termination_request?.cause === 'sdk_health_failure'));
    if (repeatedEnforcedFailure) return current;
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
      pulse_sequence_at_detection: data.pulse_sequence_at_detection,
      elapsed_ms: data.elapsed_ms,
      watchdog_action: action,
      unknown_event_count: data.unknown_event_count,
      sdk_version: data.sdk_version,
      termination: action === 'enforced' ? 'requested' : 'not_requested',
    };
    if (action === 'would_fire') {
      const observation = await this.taskRepo.recordSdkHealthObservation(data.task_id, failure);
      if (!observation) throw new Conflict(`Task ${shortId(data.task_id)} is no longer active`);
      if (observation.outcome === 'unchanged') return observation.task;
      emitServiceEvent(this.app, {
        path: 'tasks',
        event: 'patched',
        data: observation.task,
        id: observation.task.task_id,
        params,
      });
      await this.updateGatewayRuntimeProjectionAfterCommit(observation.task, params);
      return observation.task;
    }

    const stopping = await this.claimAndDeferExecutorTermination(
      {
        taskId: current.task_id,
        cause: 'sdk_health_failure',
        errorMessage:
          data.reason === 'adapter_incompatible'
            ? 'Agentic-tool adapter compatibility failed.'
            : data.reason === 'turn_timed_out'
              ? 'Agentic-tool turn exceeded its absolute deadline.'
              : `SDK activity stalled (${data.reason}).`,
        signalDelayMs: resolveSdkWatchdogConfig(this.app.get?.('config')?.execution).abort_grace_ms,
        sdkFailure: failure,
        expectedStatus: current.status,
      },
      params
    );
    await this.updateGatewayRuntimeProjectionAfterCommit(stopping, params);
    return stopping;
  }

  /**
   * Custom method: Bulk create tasks (for imports)
   */
  async createMany(taskList: Partial<Task>[]): Promise<Task[]> {
    return this.taskRepo.createMany(taskList);
  }
}

/**
 * Service factory function
 */
export function createTasksService(db: TenantScopeAwareDatabase, app: Application): TasksService {
  return new TasksService(db, app);
}
