import type { AgenticToolName, Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';

/**
 * Build the task fields persisted immediately before launch. CLI sessions have
 * no executor connection, so they skip DISPATCHING and remain without an
 * executor connection timestamp.
 */
export function buildTaskLaunchState(
  agenticTool: AgenticToolName,
  startedAt: string
): Pick<Task, 'status' | 'started_at'> {
  return {
    status: agenticTool === 'claude-code-cli' ? TaskStatus.RUNNING : TaskStatus.DISPATCHING,
    started_at: startedAt,
  };
}
