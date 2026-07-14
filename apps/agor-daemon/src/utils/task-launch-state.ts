import { randomUUID } from 'node:crypto';
import type { AgenticToolName, Task } from '@agor/core/types';
import {
  createPendingExecutorFinalization,
  EXECUTOR_STATE_PERSISTENCE_REQUIREMENT,
  TaskStatus,
  usesExecutorRuntime,
} from '@agor/core/types';

/**
 * Build the task fields persisted immediately before launch. CLI sessions have
 * no executor connection, so they skip DISPATCHING and remain without an
 * executor connection timestamp.
 */
export function buildTaskLaunchState(
  agenticTool: AgenticToolName,
  startedAt: string,
  statePersistenceRequired = false
): Pick<Task, 'status' | 'started_at'> &
  Partial<Pick<Task, 'executor_attempt_id' | 'executor_finalization'>> {
  if (!usesExecutorRuntime(agenticTool)) {
    return { status: TaskStatus.RUNNING, started_at: startedAt };
  }

  return {
    status: TaskStatus.DISPATCHING,
    started_at: startedAt,
    executor_attempt_id: randomUUID(),
    executor_finalization: createPendingExecutorFinalization(
      undefined,
      statePersistenceRequired
        ? EXECUTOR_STATE_PERSISTENCE_REQUIREMENT.REQUIRED
        : EXECUTOR_STATE_PERSISTENCE_REQUIREMENT.NOT_REQUIRED
    ),
  };
}
