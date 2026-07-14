import { shortId } from '@agor/core/db';
import { EXECUTOR_CLEANUP_STATUS, type ExecutorCleanupStatus, type Task } from '@agor/core/types';
import type {
  ExecutorTerminationReason,
  ExecutorWorkloadHandle,
} from './utils/executor-workload.js';

/**
 * Executor Attempt Tracking
 *
 * In-memory map of session → launch attempt → workload handle. A handle owns
 * local process-tree cleanup and, when configured, remote/container cleanup.
 */

const executorAttempts = new Map<string, Map<string, ExecutorWorkloadHandle>>();

export { EXECUTOR_CLEANUP_STATUS, type ExecutorCleanupStatus } from '@agor/core/types';

/**
 * Track an executor process for one session launch attempt.
 */
export function trackExecutorAttempt(
  sessionId: string,
  workload: ExecutorWorkloadHandle,
  executorAttemptId: string
): void {
  const attempts = executorAttempts.get(sessionId) ?? new Map();
  attempts.set(executorAttemptId, workload);
  executorAttempts.set(sessionId, attempts);
}

/**
 * Remove tracking for one session launch attempt.
 */
export function untrackExecutorAttempt(sessionId: string, executorAttemptId: string): void {
  const attempts = executorAttempts.get(sessionId);
  attempts?.delete(executorAttemptId);
  if (attempts?.size === 0) {
    executorAttempts.delete(sessionId);
  }
}

export function hasTrackedExecutorAttempt(sessionId: string, executorAttemptId: string): boolean {
  return executorAttempts.get(sessionId)?.has(executorAttemptId) === true;
}

/** Clean residual local processes; finalization owns durable release and untracking. */
export async function finishExecutorAttempt(
  sessionId: string,
  executorAttemptId: string
): Promise<ExecutorCleanupStatus> {
  const workload = executorAttempts.get(sessionId)?.get(executorAttemptId);
  if (!workload) return EXECUTOR_CLEANUP_STATUS.UNRESOLVED;
  await workload.finish();
  return EXECUTOR_CLEANUP_STATUS.VERIFIED;
}

/** Whether a spawned process attempt still owns the persisted task. */
export function isExecutorAttemptOwner(
  task: Pick<Task, 'executor_attempt_id'>,
  executorAttemptId: string
): boolean {
  return task.executor_attempt_id === executorAttemptId;
}

/**
 * Terminate the workload for a persisted session launch attempt.
 * Returns unresolved when no matching workload is tracked or cleanup fails.
 */
export async function terminateExecutorAttempt(
  sessionId: string,
  executorAttemptId: string,
  reason: ExecutorTerminationReason
): Promise<ExecutorCleanupStatus> {
  const workload = executorAttempts.get(sessionId)?.get(executorAttemptId);
  if (!workload) return EXECUTOR_CLEANUP_STATUS.UNRESOLVED;
  console.log(
    `🛑 [Executor] Terminating attempt ${shortId(executorAttemptId)} ` +
      `(PID ${workload.pid}, session ${shortId(sessionId)}, reason ${reason})`
  );
  await workload.terminate(reason);
  return EXECUTOR_CLEANUP_STATUS.VERIFIED;
}
