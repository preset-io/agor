import { shortId, type TaskRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Params, SessionID } from '@agor/core/types';
import { isSessionExecuting, SessionStatus } from '@agor/core/types';
import type { SessionsServiceImpl } from '../declarations.js';
import { requestExecutorTermination, type TerminationResult } from '../termination-coordinator.js';
import { requireActiveAgenticTool } from './agentic-tool-runtime.js';
import { findActiveTasksForSession } from './session-tasks.js';

export interface StopSessionResult {
  success: boolean;
  status?: typeof SessionStatus.IDLE;
  reason?: string;
  stoppedTaskId?: string;
  queuedTasksPreserved?: number;
}

export interface StopSessionDeps {
  app: Application;
  taskRepo: Pick<TaskRepository, 'findQueued'>;
  sessionsService: Pick<SessionsServiceImpl, 'get' | 'patch'>;
  requestTermination?: typeof requestExecutorTermination;
}

/**
 * Repair a stopped session with no active Task while the Stop route holds the
 * turn lock.
 *
 * With no terminal Task, the route schedules queue processing after the lock
 * is released. Doing it here would wait on the same in-flight lock.
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
    params
  );
}

/**
 * Stop semantics, in one place:
 * - target only the active task for the session;
 * - preserve queued work so it can drain after Stop;
 * - let terminal reconciliation own Session projection and queue continuation;
 * - repair the no-active-Task edge case directly.
 *
 * Callers must hold the session turn lock while invoking this function. They
 * trigger queue processing after release only for the no-active-Task result.
 */
export async function stopSessionPreserveQueue(
  deps: StopSessionDeps,
  sessionId: SessionID,
  params: Params = {},
  options: { reason?: string } = {}
): Promise<StopSessionResult> {
  const session = await deps.sessionsService.get(sessionId, params);

  if (!isSessionExecuting(session)) {
    return {
      success: false,
      reason: `Session cannot be stopped (status: ${session.status})`,
    };
  }

  const targetTasksArray = await findActiveTasksForSession(deps.app, sessionId, params);
  const queuedTasks = await deps.taskRepo.findQueued(sessionId);

  if (targetTasksArray.length === 0) {
    console.warn(
      `⚠️  [Stop] No active tasks for session ${shortId(sessionId)}, resetting to IDLE${options.reason ? ` (reason: ${options.reason})` : ''}`
    );
    await markStoppedSessionPromptableNoDrain(deps.sessionsService, sessionId, params);
    return {
      success: true,
      status: SessionStatus.IDLE,
      reason: 'No active tasks found, session reset to idle',
      queuedTasksPreserved: queuedTasks.length,
    };
  }

  const latestTask = targetTasksArray[0];

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
  });
  if (termination.status !== 'terminal') {
    return {
      success: false,
      reason:
        termination.task.error_message ??
        termination.reason ??
        'Task state changed before Stop could be completed.',
      stoppedTaskId: latestTask.task_id,
      queuedTasksPreserved: queuedTasks.length,
    };
  }

  return {
    success: true,
    status: SessionStatus.IDLE,
    stoppedTaskId: latestTask.task_id,
    queuedTasksPreserved: queuedTasks.length,
  };
}
