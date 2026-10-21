import { type Task, TaskStatus, TERMINATION_CAUSES } from '@agor/core/types';
import type { ExecutorCleanupCommandResult } from './executor-cleanup-command.js';

/** Project the recorded outcome; never infer a cause from error text or SDK observations. */
export function taskFailureAnalytics(
  task: Pick<Task, 'status' | 'termination_request'>,
  cleanupResult?: Pick<ExecutorCleanupCommandResult, 'confirmed' | 'cause'>
) {
  let failureReason: string | null = null;
  if (cleanupResult?.confirmed === true && cleanupResult.cause === 'oom_killed') {
    failureReason = 'oom_killed';
  } else if (task.status === TaskStatus.TIMED_OUT) {
    failureReason = 'timed_out';
  } else if (task.status === TaskStatus.FAILED) {
    // Stored values still need a closed allowlist before crossing the analytics boundary.
    failureReason =
      TERMINATION_CAUSES.find((cause) => cause === task.termination_request?.cause) ?? 'unknown';
  }
  return {
    succeeded: task.status === TaskStatus.COMPLETED && failureReason === null,
    failure_reason: failureReason,
  };
}
