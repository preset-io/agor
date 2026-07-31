/** Executor-owned task finalization. */
import { shortId } from '@agor/core/db';
import type { Task } from '@agor/core/types';
import { isTerminalTaskStatus, type TaskStatus } from '@agor/core/types';
import type { AgorClient } from './services/feathers-client.js';

export type AgenticToolTerminalStatus =
  | typeof TaskStatus.COMPLETED
  | typeof TaskStatus.FAILED
  | typeof TaskStatus.STOPPED
  | typeof TaskStatus.TIMED_OUT;

export type AgenticToolTaskPatch = Omit<Partial<Task>, 'status' | 'completed_at'>;

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

/**
 * Persist the one normalized outcome produced after an agentic-tool runtime
 * has settled. Already-terminal tasks are left untouched so daemon-owned
 * termination and process fail-safes remain idempotent.
 */
export async function finalizeTask(
  client: AgorClient,
  taskId: string,
  outcome: AgenticToolOutcome
): Promise<boolean> {
  const current = (await client.service('tasks').get(taskId)) as Task;
  if (isTerminalTaskStatus(current.status)) {
    console.log(
      `[executor] Task ${shortId(taskId)} already terminal (${current.status}), skipping ${outcome.status} finalization`
    );
    return false;
  }
  await client.service('tasks').patch(taskId, {
    ...(outcome.taskPatch ?? {}),
    status: outcome.status,
    completed_at: new Date().toISOString(),
  });
  return true;
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
