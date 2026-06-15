import type { Session, Task } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';

export const TERMINAL_TASK_STATUSES: ReadonlySet<Task['status']> = new Set<Task['status']>([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.STOPPED,
  TaskStatus.TIMED_OUT,
]);

export function isTerminalTaskStatus(status: Task['status'] | undefined): boolean {
  return status !== undefined && TERMINAL_TASK_STATUSES.has(status);
}

export function isTaskBlockingPrompt(task: Task): boolean {
  return task.status !== TaskStatus.QUEUED && !isTerminalTaskStatus(task.status);
}

export function sessionCanStartTask(status: Session['status'], readyForPrompt?: boolean): boolean {
  return (
    status === SessionStatus.IDLE || (status === SessionStatus.FAILED && readyForPrompt === true)
  );
}

/**
 * Detects the limbo state where persisted session status says "failed/not ready",
 * but there is no active task left to own that busy state. QUEUED tasks are not
 * blockers: they need the session to become promptable so the drainer can run.
 */
export function shouldReconcileSessionPromptState(session: Session, tasks: Task[]): boolean {
  if (session.status !== SessionStatus.FAILED) return false;
  if (session.ready_for_prompt === true) return false;
  return !tasks.some(isTaskBlockingPrompt);
}
