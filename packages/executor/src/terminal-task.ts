/** Executor-side settlement reporting. The daemon owns durable terminality. */
import type { ExecutorFailureCause, ExecutorOutcomePatch, Task } from '@agor/core/types';
import { formatExecutorFailure } from './safe-executor-error.js';
import type { AgorClient } from './services/feathers-client.js';

export type AgenticToolTaskPatch = ExecutorOutcomePatch;

/**
 * Normalized result returned by an agentic-tool adapter after its runtime has
 * settled. Only the executor finalizer may add terminal lifecycle fields.
 */
export interface AgenticToolOutcome {
  result: 'success' | 'failure';
  failureCause?: ExecutorFailureCause;
  taskPatch?: AgenticToolTaskPatch;
  /** Re-thrown after terminal persistence so fatal executor exits stay non-zero. */
  error?: Error;
}

/** Cleanup uncertainty must reach daemon containment, never a terminal outcome. */
export class RuntimeCleanupError extends Error {
  constructor(
    label: string,
    cause: unknown,
    readonly runtimeCleanupUnverified = false
  ) {
    super(`${label} runtime cleanup failed`, { cause });
    this.name = 'RuntimeCleanupError';
  }
}

export async function awaitRuntimeCleanup(
  cleanup: Promise<void>,
  timeoutMs: number,
  label: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} cleanup exceeded ${timeoutMs}ms`)),
          timeoutMs
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Report the one normalized outcome produced after an agentic-tool runtime
 * has settled. The daemon applies lifecycle race guards and terminal timing.
 */
export async function finalizeTask(
  client: AgorClient,
  taskId: string,
  outcome: AgenticToolOutcome
): Promise<Task> {
  return client.service('tasks').reportExecutorSettlement(
    outcome.result === 'success'
      ? { task_id: taskId, kind: 'quiesced', result: 'success', task_patch: outcome.taskPatch }
      : {
          task_id: taskId,
          kind: 'quiesced',
          result: 'failure',
          failure_cause: outcome.failureCause ?? 'runtime_failure',
          task_patch: outcome.taskPatch,
        }
  );
}

export async function requestContainment(
  client: AgorClient,
  taskId: string,
  error: unknown
): Promise<void> {
  const message = formatExecutorFailure(error);
  await client.service('tasks').reportExecutorSettlement({
    task_id: taskId,
    kind: 'containment_required',
    error_message: `Agentic-tool runtime cleanup could not be verified: ${message}`,
    ...(error instanceof RuntimeCleanupError && error.runtimeCleanupUnverified
      ? { runtime_cleanup_unverified: true }
      : {}),
  });
}

/**
 * Best-effort wrapper for process fail-safe paths that must still exit when
 * the daemon connection is already unavailable.
 */
export async function tryRequestContainment(
  client: AgorClient,
  taskId: string,
  error: unknown
): Promise<void> {
  try {
    await requestContainment(client, taskId, error);
  } catch (reportError) {
    console.error('[executor] Failed to request runtime containment:', reportError);
  }
}
