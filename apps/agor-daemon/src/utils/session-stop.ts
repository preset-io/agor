import { shortId, type TaskRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Params, SessionID, Task } from '@agor/core/types';
import {
  EXECUTOR_TERMINAL_CAUSE,
  isSessionExecuting,
  isTerminalTaskStatus,
  SessionStatus,
  TaskStatus,
  usesExecutorRuntime,
} from '@agor/core/types';
import type { SessionsServiceImpl, TasksServiceImpl } from '../declarations.js';
import { findActiveTasksForSession } from './session-tasks.js';

export interface StopSessionResult {
  success: boolean;
  status?: typeof SessionStatus.IDLE;
  reason?: string;
  stoppedTaskId?: string;
  queuedTasksPreserved?: number;
  executorAttempt?: { taskId: string; executorAttemptId: string };
}

export interface StopSessionDeps {
  app: Application;
  taskRepo: Pick<TaskRepository, 'findQueued'>;
  sessionsService: Pick<SessionsServiceImpl, 'get' | 'patch'>;
  tasksService: Pick<TasksServiceImpl, 'get' | 'patch'>;
}

/**
 * Stop semantics, in one place:
 * - target only the active task for the session;
 * - preserve queued work so it can drain after Stop;
 * - persist STOPPING + the write-once terminal cause under the turn lock;
 * - let the caller reconcile cleanup after releasing the lock.
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
    if (!usesExecutorRuntime(session.agentic_tool)) {
      await deps.sessionsService.patch(
        sessionId,
        { status: SessionStatus.IDLE, ready_for_prompt: true },
        params
      );
      return {
        success: true,
        status: SessionStatus.IDLE,
        reason: 'No active tasks found, session reset to idle',
        queuedTasksPreserved: queuedTasks.length,
      };
    }

    await deps.sessionsService.patch(
      sessionId,
      { status: SessionStatus.FAILED, ready_for_prompt: false },
      params
    );
    return {
      success: false,
      reason: 'No active executor attempt found; session remains fenced',
      queuedTasksPreserved: queuedTasks.length,
    };
  }

  const latestTask = targetTasksArray[0];

  console.log(
    `🛑 [Stop] Stopping task ${shortId(latestTask.task_id)} for session ${shortId(sessionId)}${options.reason ? ` (reason: ${options.reason})` : ''}`
  );

  if (latestTask.executor_attempt_id) {
    await deps.sessionsService.patch(
      sessionId,
      { status: SessionStatus.STOPPING, ready_for_prompt: false },
      params
    );
  }

  let stoppedTask: Task | Task[];
  try {
    stoppedTask = await deps.tasksService.patch(
      latestTask.task_id,
      {
        status: TaskStatus.STOPPED,
        completed_at: new Date().toISOString(),
        ...(latestTask.executor_attempt_id
          ? { executor_terminal_cause: EXECUTOR_TERMINAL_CAUSE.USER_STOP }
          : {}),
      },
      { ...params, provider: undefined }
    );
  } catch (error) {
    const currentTask = latestTask.executor_attempt_id
      ? await deps.tasksService.get(latestTask.task_id, { ...params, provider: undefined })
      : undefined;
    if (
      !currentTask ||
      currentTask.executor_attempt_id !== latestTask.executor_attempt_id ||
      !isTerminalTaskStatus(currentTask.status)
    ) {
      if (latestTask.executor_attempt_id) {
        await deps.sessionsService.patch(
          sessionId,
          { status: session.status, ready_for_prompt: session.ready_for_prompt },
          params
        );
      }
      throw error;
    }
    stoppedTask = currentTask;
  }

  if (!latestTask.executor_attempt_id) {
    await deps.sessionsService.patch(
      sessionId,
      { status: SessionStatus.IDLE, ready_for_prompt: true },
      params
    );
  }

  return {
    success: true,
    ...(!latestTask.executor_attempt_id ? { status: SessionStatus.IDLE } : {}),
    stoppedTaskId: latestTask.task_id,
    queuedTasksPreserved: queuedTasks.length,
    ...(latestTask.executor_attempt_id
      ? {
          executorAttempt: {
            taskId: Array.isArray(stoppedTask) ? latestTask.task_id : stoppedTask.task_id,
            executorAttemptId: latestTask.executor_attempt_id,
          },
        }
      : {}),
  };
}
