import type { Task } from '@agor/core/types';
import { isTerminalTaskStatus, sessionCanStartTask, TaskStatus } from '@agor/core/types';

export function isTaskBlockingPrompt(task: Task): boolean {
  return task.status !== TaskStatus.QUEUED && !isTerminalTaskStatus(task.status);
}

export { sessionCanStartTask };
