import { shortId, type TaskRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Params, SessionID } from '@agor/core/types';
import { isSessionExecuting, SessionStatus, TaskStatus } from '@agor/core/types';
import type { SessionsServiceImpl, TasksServiceImpl } from '../declarations.js';
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
  tasksService: Pick<TasksServiceImpl, 'patch'>;
  killExecutorProcess: (sessionId: string) => boolean;
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

  const processKilled = deps.killExecutorProcess(sessionId);
  if (!processKilled) {
    console.warn(
      `⚠️  [Stop] No tracked process for session ${shortId(sessionId)} — executor may have already exited`
    );
  }

  try {
    await deps.tasksService.patch(
      latestTask.task_id,
      {
        status: TaskStatus.STOPPED,
        completed_at: new Date().toISOString(),
      },
      {
        ...params,
        suppressTerminalQueueProcessing: true,
        suppressCompletionCallbacks: true,
      } as Params
    );
  } catch (error) {
    console.error(`❌ [Stop] Failed to patch task to STOPPED:`, error);
  }

  await markStoppedSessionPromptableNoDrain(deps.sessionsService, sessionId, params);

  return {
    success: true,
    status: SessionStatus.IDLE,
    stoppedTaskId: latestTask.task_id,
    queuedTasksPreserved: queuedTasks.length,
  };
}
