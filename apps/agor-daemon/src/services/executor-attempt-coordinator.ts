import { shortId, type TenantScopeAwareDatabase } from '@agor/core/db';
import type {
  ExecutorFinalizationEvidence,
  ExecutorTerminalCause,
  Params,
  Task,
} from '@agor/core/types';
import {
  EXECUTOR_CLEANUP_STATUS,
  EXECUTOR_FINALIZABLE_TASK_STATUSES,
  EXECUTOR_STATE_PERSISTENCE_REQUIREMENT,
  EXECUTOR_STATE_PERSISTENCE_STATUS,
  EXECUTOR_TERMINAL_CAUSE,
  isExecutorFinalizationReleasable,
  TaskStatus,
} from '@agor/core/types';
import type { Application, TasksServiceImpl } from '../declarations.js';
import {
  finishExecutorAttempt,
  isExecutorAttemptOwner,
  terminateExecutorAttempt,
} from '../executor-tracking.js';
import { persistExecutorSessionState } from '../utils/executor-session-state.js';
import {
  EXECUTOR_TERMINATION_REASONS,
  type ExecutorTerminationReason,
} from '../utils/executor-workload.js';
import { runKeyedSingleFlight } from '../utils/keyed-single-flight.js';
import { recoverConfiguredExecutorAttempt } from '../utils/spawn-executor.js';

const EXECUTOR_STATE_PERSISTENCE_ERROR = 'Executor session state could not be persisted';
const CLEANUP_MODE = {
  FINISH: 'finish',
  SKIP: 'skip',
  TERMINATE: 'terminate',
} as const;

interface SettlementPolicy {
  cleanupMode: (typeof CLEANUP_MODE)[keyof typeof CLEANUP_MODE];
  terminationReason: ExecutorTerminationReason;
}

function settlementPolicy(
  cleanupMode: SettlementPolicy['cleanupMode'],
  terminationReason: ExecutorTerminationReason = EXECUTOR_TERMINATION_REASONS.RECONCILIATION
): SettlementPolicy {
  return { cleanupMode, terminationReason };
}

/** Every durable terminal cause declares its cleanup policy exactly once. */
const SETTLEMENT_POLICY_BY_CAUSE: Record<ExecutorTerminalCause, SettlementPolicy> = {
  [EXECUTOR_TERMINAL_CAUSE.EXECUTOR_REPORTED]: settlementPolicy(CLEANUP_MODE.FINISH),
  [EXECUTOR_TERMINAL_CAUSE.UNEXPECTED_EXIT]: settlementPolicy(CLEANUP_MODE.FINISH),
  [EXECUTOR_TERMINAL_CAUSE.USER_STOP]: settlementPolicy(
    CLEANUP_MODE.TERMINATE,
    EXECUTOR_TERMINATION_REASONS.USER_STOP
  ),
  [EXECUTOR_TERMINAL_CAUSE.DISPATCH_TIMEOUT]: settlementPolicy(
    CLEANUP_MODE.TERMINATE,
    EXECUTOR_TERMINATION_REASONS.DISPATCH_TIMEOUT
  ),
  [EXECUTOR_TERMINAL_CAUSE.HEARTBEAT_LOST]: settlementPolicy(
    CLEANUP_MODE.TERMINATE,
    EXECUTOR_TERMINATION_REASONS.HEARTBEAT_LOST
  ),
  [EXECUTOR_TERMINAL_CAUSE.PERMISSION_TIMEOUT]: settlementPolicy(CLEANUP_MODE.FINISH),
  [EXECUTOR_TERMINAL_CAUSE.LAUNCH_FAILED_ABSENT]: settlementPolicy(CLEANUP_MODE.SKIP),
  [EXECUTOR_TERMINAL_CAUSE.LAUNCH_FAILED_UNKNOWN]: settlementPolicy(CLEANUP_MODE.TERMINATE),
  [EXECUTOR_TERMINAL_CAUSE.DAEMON_RESTART]: settlementPolicy(CLEANUP_MODE.TERMINATE),
};

function terminalCause(task: Task): ExecutorTerminalCause {
  if (task.executor_terminal_cause) return task.executor_terminal_cause;
  if (task.status === TaskStatus.COMPLETED) return EXECUTOR_TERMINAL_CAUSE.EXECUTOR_REPORTED;
  if (task.status === TaskStatus.STOPPED) return EXECUTOR_TERMINAL_CAUSE.DAEMON_RESTART;
  if (task.status === TaskStatus.TIMED_OUT) return EXECUTOR_TERMINAL_CAUSE.PERMISSION_TIMEOUT;
  return EXECUTOR_TERMINAL_CAUSE.LAUNCH_FAILED_UNKNOWN;
}

function settlementPlan(task: Task) {
  const cause = terminalCause(task);
  return {
    ...SETTLEMENT_POLICY_BY_CAUSE[cause],
    statePersistenceRequired:
      !!task.executor_connected_at &&
      task.executor_finalization?.state_persistence_requirement ===
        EXECUTOR_STATE_PERSISTENCE_REQUIREMENT.REQUIRED,
  };
}

export interface ReconcileExecutorAttemptOptions {
  taskId: string;
  executorAttemptId: string;
  params?: Params;
}

export interface ReconcileExecutorAttemptResult {
  finalized: boolean;
  released: boolean;
}

interface ExecutorAttemptCoordinatorDependencies {
  db?: TenantScopeAwareDatabase;
  finishAttempt?: typeof finishExecutorAttempt;
  terminateAttempt?: typeof terminateExecutorAttempt;
  recoverAttempt?: typeof recoverConfiguredExecutorAttempt;
  persistState?: typeof persistExecutorSessionState;
  now?: () => Date;
}

/** One state-driven tail for every terminal executor attempt. */
export class ExecutorAttemptCoordinator {
  private readonly reconciliations = new Map<string, Promise<ReconcileExecutorAttemptResult>>();
  private readonly dependencies: Required<Omit<ExecutorAttemptCoordinatorDependencies, 'db'>> & {
    db?: TenantScopeAwareDatabase;
  };

  constructor(
    private readonly app: Pick<Application, 'service'>,
    dependencies: ExecutorAttemptCoordinatorDependencies = {}
  ) {
    this.dependencies = {
      ...dependencies,
      finishAttempt: dependencies.finishAttempt ?? finishExecutorAttempt,
      terminateAttempt: dependencies.terminateAttempt ?? terminateExecutorAttempt,
      recoverAttempt: dependencies.recoverAttempt ?? recoverConfiguredExecutorAttempt,
      persistState: dependencies.persistState ?? persistExecutorSessionState,
      now: dependencies.now ?? (() => new Date()),
    };
  }

  reconcile(options: ReconcileExecutorAttemptOptions): Promise<ReconcileExecutorAttemptResult> {
    return runKeyedSingleFlight(this.reconciliations, options.executorAttemptId, () =>
      this.reconcileOnce(options)
    );
  }

  private async reconcileOnce(
    options: ReconcileExecutorAttemptOptions
  ): Promise<ReconcileExecutorAttemptResult> {
    const tasksService = this.app.service('tasks') as unknown as TasksServiceImpl;
    const task = (await tasksService.get(options.taskId, options.params)) as Task;
    if (
      !isExecutorAttemptOwner(task, options.executorAttemptId) ||
      !EXECUTOR_FINALIZABLE_TASK_STATUSES.has(task.status)
    ) {
      return this.notFinalized(task);
    }

    const plan = settlementPlan(task);
    const cleanup = await this.cleanup(task, plan, options.params);
    const cleanupVerified = cleanup.status === EXECUTOR_CLEANUP_STATUS.VERIFIED;
    const statePersistenceStatus = await this.resolveStatePersistenceStatus(
      task,
      plan.statePersistenceRequired,
      cleanupVerified,
      options.params
    );
    const evidence: ExecutorFinalizationEvidence = {
      cleanup_status: cleanup.status,
      state_persistence_status: statePersistenceStatus,
      cleanup_error: cleanup.error ?? null,
      state_persistence_error:
        statePersistenceStatus === EXECUTOR_STATE_PERSISTENCE_STATUS.FAILED
          ? EXECUTOR_STATE_PERSISTENCE_ERROR
          : null,
      cleanup_verified_at: cleanupVerified
        ? (task.executor_finalization?.cleanup_verified_at ?? this.dependencies.now().toISOString())
        : null,
    };
    const finalization = await tasksService.finalizeExecutorAttempt(
      task.task_id,
      options.executorAttemptId,
      { evidence },
      options.params
    );

    if (finalization.finalized && !finalization.released) {
      console.error(
        `[executor-attempt] Session for task ${shortId(task.task_id)} remains fenced ` +
          `(cleanup=${cleanup.status}, state_persistence=${statePersistenceStatus})`
      );
    }
    return finalization;
  }

  private async cleanup(
    task: Task,
    plan: ReturnType<typeof settlementPlan>,
    params?: Params
  ): Promise<{
    status: (typeof EXECUTOR_CLEANUP_STATUS)[keyof typeof EXECUTOR_CLEANUP_STATUS];
    error?: string;
  }> {
    if (task.executor_finalization?.cleanup_status === EXECUTOR_CLEANUP_STATUS.VERIFIED) {
      return { status: EXECUTOR_CLEANUP_STATUS.VERIFIED };
    }

    if (plan.cleanupMode === CLEANUP_MODE.SKIP) {
      return { status: EXECUTOR_CLEANUP_STATUS.VERIFIED };
    }

    let cleanupError: string | undefined;
    try {
      const trackedStatus =
        plan.cleanupMode === CLEANUP_MODE.FINISH
          ? await this.dependencies.finishAttempt(task.session_id, task.executor_attempt_id!)
          : await this.dependencies.terminateAttempt(
              task.session_id,
              task.executor_attempt_id!,
              plan.terminationReason
            );
      if (trackedStatus === EXECUTOR_CLEANUP_STATUS.VERIFIED) return { status: trackedStatus };
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }

    try {
      const session = await this.app.service('sessions').get(task.session_id, params);
      const recovered = await this.dependencies.recoverAttempt({
        executorAttemptId: task.executor_attempt_id!,
        reason: plan.terminationReason,
        workload: task.executor_finalization?.workload,
        templateVariables: {
          session_id: task.session_id,
          task_id: task.task_id,
          branch_id: session.branch_id,
          executor_attempt_id: task.executor_attempt_id!,
          unix_user: task.executor_finalization?.workload?.unix_user,
        },
      });
      if (recovered) return { status: EXECUTOR_CLEANUP_STATUS.VERIFIED };
      cleanupError ??= 'Executor workload cleanup could not be verified';
    } catch (error) {
      cleanupError ??= error instanceof Error ? error.message : String(error);
    }
    return { status: EXECUTOR_CLEANUP_STATUS.UNRESOLVED, error: cleanupError };
  }

  private async resolveStatePersistenceStatus(
    task: Task,
    required: boolean,
    cleanupVerified: boolean,
    params?: Params
  ): Promise<ExecutorFinalizationEvidence['state_persistence_status']> {
    if (!required) return EXECUTOR_STATE_PERSISTENCE_STATUS.SKIPPED;
    if (task.session_md5) return EXECUTOR_STATE_PERSISTENCE_STATUS.VERIFIED;
    if (
      task.executor_finalization?.state_persistence_status ===
      EXECUTOR_STATE_PERSISTENCE_STATUS.VERIFIED
    ) {
      return EXECUTOR_STATE_PERSISTENCE_STATUS.VERIFIED;
    }
    if (!cleanupVerified) return EXECUTOR_STATE_PERSISTENCE_STATUS.PENDING;
    if (!this.dependencies.db) return EXECUTOR_STATE_PERSISTENCE_STATUS.FAILED;
    const persisted = await this.dependencies.persistState({
      app: this.app as Application,
      db: this.dependencies.db,
      taskId: task.task_id,
      executorAttemptId: task.executor_attempt_id!,
      params,
    });
    return persisted
      ? EXECUTOR_STATE_PERSISTENCE_STATUS.VERIFIED
      : EXECUTOR_STATE_PERSISTENCE_STATUS.FAILED;
  }

  private notFinalized(task: Task): ReconcileExecutorAttemptResult {
    return {
      finalized: false,
      released: task.executor_finalization
        ? isExecutorFinalizationReleasable(task.executor_finalization)
        : false,
    };
  }
}
