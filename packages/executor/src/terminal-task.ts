/** Executor-side settlement reporting. The daemon owns durable terminality. */
import type { ExecutorOutcomePatch, ExecutorSettlementStatus } from '@agor/core/types';
import type { AgorClient } from './services/feathers-client.js';

export type AgenticToolTerminalStatus = ExecutorSettlementStatus;
export type AgenticToolTaskPatch = ExecutorOutcomePatch;

/**
 * Normalized result returned by an agentic-tool adapter after its runtime has
 * settled. Only the executor finalizer may add terminal lifecycle fields.
 */
export interface AgenticToolOutcome {
  status: AgenticToolTerminalStatus;
  taskPatch?: AgenticToolTaskPatch;
  /** Re-thrown after terminal persistence so fatal executor exits stay non-zero. */
  error?: Error;
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
): Promise<boolean> {
  const settled = await client.service('tasks').reportExecutorSettlement({
    task_id: taskId,
    kind: 'quiesced',
    status: outcome.status,
    task_patch: outcome.taskPatch,
  });
  return settled.status === outcome.status;
}

export async function requestContainment(
  client: AgorClient,
  taskId: string,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await client.service('tasks').reportExecutorSettlement({
    task_id: taskId,
    kind: 'containment_required',
    error_message: `Agentic-tool runtime cleanup could not be verified: ${message}`,
  });
}

/**
 * Best-effort wrapper for process fail-safe paths that must still exit when
 * the daemon connection is already unavailable.
 */
export async function tryFinalizeTask(
  client: AgorClient,
  taskId: string,
  outcome: AgenticToolOutcome
): Promise<boolean> {
  try {
    return await finalizeTask(client, taskId, outcome);
  } catch (patchError) {
    console.error('[executor] Failed to update task status:', patchError);
    return false;
  }
}

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
