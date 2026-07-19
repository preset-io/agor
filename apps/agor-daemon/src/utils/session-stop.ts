import { shortId, type TaskRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Params, SessionID } from '@agor/core/types';
import { isSessionExecuting, SessionStatus, usesExecutorRuntime } from '@agor/core/types';
import type { SessionsServiceImpl } from '../declarations.js';
import { requestExecutorTermination, type TerminationResult } from '../termination-coordinator.js';
import { findActiveTasksForSession } from './session-tasks.js';

export interface StopSessionResult {
  success: boolean;
  status?: typeof SessionStatus.IDLE;
  reason?: string;
  stoppedTaskId?: string;
  queuedTasksPreserved?: number;
  queueHandled?: boolean;
}

export interface StopSessionDeps {
  app: Application;
  taskRepo: Pick<TaskRepository, 'findQueued'>;
  sessionsService: Pick<SessionsServiceImpl, 'get' | 'patch'>;
  requestTermination?: typeof requestExecutorTermination;
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

  if (!usesExecutorRuntime(session.agentic_tool)) {
    const { stopClaudeCliTask } = await import('../services/claude-cli-integration.js');
    const termination = await stopClaudeCliTask({
      app: deps.app,
      session,
      task: latestTask,
      params,
    });
    return {
      success: termination.status === 'terminal',
      status: termination.status === 'terminal' ? SessionStatus.IDLE : undefined,
      reason: termination.reason,
      stoppedTaskId: latestTask.task_id,
      queuedTasksPreserved: queuedTasks.length,
      queueHandled: termination.queueHandled,
    };
  }

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
