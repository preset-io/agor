import type { Params, Session, Task } from '@agor/core/types';
import {
  isTerminalTaskStatus,
  SessionStatus,
  sessionCanStartTask,
  TaskStatus,
} from '@agor/core/types';

export function isTaskBlockingPrompt(task: Task): boolean {
  return task.status !== TaskStatus.QUEUED && !isTerminalTaskStatus(task.status);
}

export { sessionCanStartTask };

export type TerminalQueueProcessingParams = Params & {
  suppressTerminalQueueProcessing?: boolean;
};

export function isTerminalQueueProcessingSuppressed(params?: Params): boolean {
  return (
    (params as TerminalQueueProcessingParams | undefined)?.suppressTerminalQueueProcessing === true
  );
}

/**
 * Detects the limbo state where persisted session status says "failed/not ready",
 * but there is no active task left to own that busy state. QUEUED tasks are not
 * blockers: they need the session to become promptable so the drainer can run.
 */
export function shouldReconcileSessionPromptState(
  session: Session,
  tasks: Task[],
  options: { ignoredTaskIds?: readonly string[] } = {}
): boolean {
  if (session.status !== SessionStatus.FAILED) return false;
  if (session.ready_for_prompt === true) return false;
  const ignoredTaskIds = new Set(options.ignoredTaskIds ?? []);
  return !tasks.some((task) => !ignoredTaskIds.has(task.task_id) && isTaskBlockingPrompt(task));
}
