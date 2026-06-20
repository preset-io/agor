import type { Application } from '@agor/core/feathers';
import type { Params, Task } from '@agor/core/types';
import { isActiveExecutorTaskStatus, TaskStatus } from '@agor/core/types';
import type { CapturedExecutorOutput } from './spawn-executor.js';

export function formatExecutorExitError(
  code: number | null,
  output?: Pick<CapturedExecutorOutput, 'stderrTail' | 'combinedTail'>
): string {
  const codeText = code ?? 'unknown';
  const rawTail = (output?.stderrTail?.trim() || output?.combinedTail?.trim() || '').trim();
  const tail = rawTail.length > 4000 ? rawTail.slice(rawTail.length - 4000) : rawTail;
  return tail
    ? `Executor exited unexpectedly with code ${codeText}.\n\nLast executor stderr/output:\n${tail}`
    : `Executor exited unexpectedly with code ${codeText}.`;
}

export function isTaskStillActiveForExecutorExit(task: Pick<Task, 'status'>): boolean {
  return isActiveExecutorTaskStatus(task.status);
}

export async function markActiveTaskFailedForExecutorExit({
  app,
  params,
  taskId,
  code,
  output,
  suppressTerminalSideEffects = false,
}: {
  app: Application;
  params: Params;
  taskId: string;
  code: number | null;
  output?: CapturedExecutorOutput;
  suppressTerminalSideEffects?: boolean;
}): Promise<{ patched: boolean; task?: Task }> {
  const currentTask = await app.service('tasks').get(taskId, params);
  if (!isTaskStillActiveForExecutorExit(currentTask)) {
    return { patched: false, task: currentTask };
  }

  const patchParams = suppressTerminalSideEffects
    ? {
        ...params,
        suppressTerminalSessionIdle: true,
        suppressTerminalQueueProcessing: true,
      }
    : params;

  await app.service('tasks').patch(
    taskId,
    {
      status: TaskStatus.FAILED,
      completed_at: new Date().toISOString(),
      error_message: formatExecutorExitError(code, output),
    },
    patchParams
  );

  return { patched: true, task: currentTask };
}
