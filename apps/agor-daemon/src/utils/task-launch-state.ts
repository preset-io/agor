import type { AgenticToolName, ExecutorMode, Task } from '@agor/core/types';
import { TaskStatus, usesExecutorRuntime } from '@agor/core/types';

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
  agenticTool: AgenticToolName,
  startedAt: string,
  executorMode: ExecutorMode = 'local'
): Pick<Task, 'status' | 'started_at' | 'executor_mode'> {
  const usesExecutor = usesExecutorRuntime(agenticTool);
  return {
    status: usesExecutor ? TaskStatus.DISPATCHING : TaskStatus.RUNNING,
    started_at: startedAt,
    ...(usesExecutor ? { executor_mode: executorMode } : {}),
  };
}
