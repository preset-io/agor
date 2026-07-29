import type { ExecutorMode, Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';

export type ExecutorExitDisposition = 'authoritative' | 'passive' | 'ambiguous';

export function classifyExecutorExit(input: {
  mode: ExecutorMode;
  code: number | null;
  nonzeroMayHaveDispatched: boolean;
}): ExecutorExitDisposition {
  if (input.mode === 'local') return 'authoritative';
  if (input.code === 0) return 'passive';
  return input.nonzeroMayHaveDispatched ? 'ambiguous' : 'authoritative';
}

export function buildTaskLaunchState(
  startedAt: string,
  executorMode: ExecutorMode = 'local'
): Pick<Task, 'status' | 'started_at' | 'executor_mode'> {
  return {
    status: TaskStatus.DISPATCHING,
    started_at: startedAt,
    executor_mode: executorMode,
  };
}
