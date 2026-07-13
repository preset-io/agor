import type { AgenticToolName, Task } from '@agor/core/types';
import { TaskStatus, usesExecutorRuntime } from '@agor/core/types';

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
    status: usesExecutorRuntime(agenticTool) ? TaskStatus.DISPATCHING : TaskStatus.RUNNING,
    started_at: startedAt,
  };
}
