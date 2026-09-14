import { shortId, type TaskRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Params, SessionID, SessionStopResult, TaskID } from '@agor/core/types';
import { isSessionExecuting, isTerminalTaskStatus, SessionStatus } from '@agor/core/types';
import type { SessionsServiceImpl } from '../declarations.js';
import {
  requestExecutorTermination,
  type TerminationInput,
  type TerminationResult,
} from '../termination-coordinator.js';
import { requireActiveAgenticTool } from './agentic-tool-runtime.js';
import type { findActiveTasksForSession } from './session-tasks.js';

export interface StopSessionDeps {
  app: Application;
  taskRepo: Pick<TaskRepository, 'findQueued'>;
  sessionsService: Pick<SessionsServiceImpl, 'get' | 'patch'>;
  findActiveTasks: typeof findActiveTasksForSession;
  requestTermination?: typeof requestExecutorTermination;
  /** Opens a required tenant database scope for nested service reads. */
  runInTenantDatabaseScope: <T>(work: () => Promise<T>) => Promise<T>;
  /**
   * Opens one fresh, write-gated tenant database unit for each durable
   * termination step. The Stop route itself deliberately has no route-wide
   * database transaction because it may wait for executor quiescence.
   */
  runInFreshTenantWriteDatabase: TerminationInput['runInFreshTenantWriteDatabase'];
}

/**
 * Mark a stopped session promptable without letting the session after.patch
 * hook drain the queue while the Stop route still holds the turn lock.
 *
 * The route schedules queue processing after the lock is released. Doing it
 * here would deadlock/retry against the same in-flight lock.
 */
export async function markStoppedSessionPromptableNoDrain(
  sessionsService: Pick<SessionsServiceImpl, 'patch'>,
  sessionId: SessionID,
  params?: Params
): Promise<void> {
  await sessionsService.patch(
    sessionId,
    {
      status: SessionStatus.IDLE,
      ready_for_prompt: true,
    },
    {
      ...(params ?? {}),
      suppressTerminalQueueProcessing: true,
    } as Params
  );
}

/**
 * Stop semantics, in one place:
 * - target only the active task for the session;
 * - preserve queued work so it can drain after Stop;
 * - suppress task-terminal side effects that would independently drain or
 *   dispatch callbacks for a user-stopped turn;
 * - leave the session idle/promptable before the caller kicks the queue
 *   drainer after releasing the session turn lock.
 *
 * Callers must hold the session turn lock while invoking this function, and
 * must trigger queue processing only after the lock is released.
 */
export async function stopSessionPreserveQueue(
  deps: StopSessionDeps,
  sessionId: SessionID,
  params: Params = {},
  options: { reason?: string; expectedTaskId?: TaskID } = {}
): Promise<SessionStopResult> {
  const session = await deps.runInTenantDatabaseScope(() =>
    deps.sessionsService.get(sessionId, params)
  );

  // Stop is idempotent across retries and the per-session turn lock. A
  // concurrent caller can observe the first caller's already-committed idle
  // projection; report the requested postcondition instead of a false failure.
  if (session.status === SessionStatus.IDLE) {
    const queuedTasks = await deps.taskRepo.findQueued(sessionId);
    return {
      success: true,
      outcome: 'already_idle',
      status: SessionStatus.IDLE,
      reason: 'Session is already idle',
      queuedTasksPreserved: queuedTasks.length,
    };
  }

  if (!isSessionExecuting(session)) {
    return {
      success: false,
      outcome: 'not_stoppable',
      reason: `Session cannot be stopped (status: ${session.status})`,
    };
  }

  const targetTasksArray = await deps.runInTenantDatabaseScope(() =>
    deps.findActiveTasks(deps.app, sessionId, params)
  );
  const queuedTasks = await deps.taskRepo.findQueued(sessionId);

  if (targetTasksArray.length === 0) {
    console.warn(
      `⚠️  [Stop] No active tasks for session ${shortId(sessionId)}, resetting to IDLE${options.reason ? ` (reason: ${options.reason})` : ''}`
    );
    await deps.runInFreshTenantWriteDatabase(() =>
      markStoppedSessionPromptableNoDrain(deps.sessionsService, sessionId, params)
    );
    return {
      success: true,
      outcome: 'stopped',
      status: SessionStatus.IDLE,
      reason: 'No active tasks found, session reset to idle',
      queuedTasksPreserved: queuedTasks.length,
    };
  }

  const latestTask = targetTasksArray[0];
  if (options.expectedTaskId && latestTask.task_id !== options.expectedTaskId) {
    return {
      success: false,
      outcome: 'condition_changed',
      reason: 'Execution changed before Stop could be claimed. Review the current state and retry.',
      queuedTasksPreserved: queuedTasks.length,
    };
  }

  console.log(
    `🛑 [Stop] Stopping task ${shortId(latestTask.task_id)} for session ${shortId(sessionId)}${options.reason ? ` (reason: ${options.reason})` : ''}`
  );

  requireActiveAgenticTool(session.agentic_tool);

  const terminate = deps.requestTermination ?? requestExecutorTermination;
  const termination: TerminationResult = await terminate({
    app: deps.app,
    taskId: latestTask.task_id,
    cause: 'user_stop',
    errorMessage: options.reason ?? 'Stopped by user.',
    params,
    runInFreshTenantWriteDatabase: deps.runInFreshTenantWriteDatabase,
  });
  if (termination.status === 'pending') {
    return {
      success: false,
      outcome: 'pending',
      status: SessionStatus.STOPPING,
      reason: termination.reason,
      stoppedTaskId: latestTask.task_id,
      queuedTasksPreserved: queuedTasks.length,
      pendingCode: termination.pendingCode,
    };
  }
  if (termination.status === 'unverified') {
    if (isTerminalTaskStatus(termination.task.status)) {
      return {
        success: false,
        outcome: 'condition_changed',
        reason: termination.reason,
        stoppedTaskId: latestTask.task_id,
        queuedTasksPreserved: queuedTasks.length,
      };
    }
    return {
      success: false,
      outcome: 'unverified',
      status: SessionStatus.STOPPING,
      reason: termination.task.error_message ?? termination.reason,
      stoppedTaskId: latestTask.task_id,
      queuedTasksPreserved: queuedTasks.length,
    };
  }
  if (termination.status === 'condition_changed') {
    return {
      success: false,
      outcome: 'condition_changed',
      reason:
        termination.task.error_message ?? 'Task state changed before Stop could be completed.',
      stoppedTaskId: latestTask.task_id,
      queuedTasksPreserved: queuedTasks.length,
    };
  }

  return {
    success: true,
    outcome: 'stopped',
    status: SessionStatus.IDLE,
    stoppedTaskId: latestTask.task_id,
    queuedTasksPreserved: queuedTasks.length,
  };
}
