import {
  EXECUTOR_MODES,
  SDK_FAILURE_REASONS,
  SDK_TERMINATION_STATES,
  SDK_WATCHDOG_ACTIONS,
  type Task,
  TaskStatus,
  TERMINATION_CAUSES,
} from '@agor/core/types';

function allowed<T extends string>(value: unknown, values: readonly T[]): T | null {
  return values.find((candidate) => candidate === value) ?? null;
}

/**
 * A closed projection, not an error-text classifier. Stored/runtime values still
 * get checked: legacy rows and provider extensions must not become free-form
 * analytics properties. Watchdog observations alone do not establish causation.
 * Confirmed cleanup-helper evidence (including OOM) is added by the settlement
 * owner, not inferred here from a message, exit code, signal, or missing heartbeat.
 */
export function taskFailureAnalytics(
  task: Pick<
    Task,
    'status' | 'termination_request' | 'sdk_failure' | 'executor_mode' | 'executor_connected_at'
  >
) {
  const terminationCause = allowed(task.termination_request?.cause, TERMINATION_CAUSES);
  const sdkReason = allowed(task.sdk_failure?.reason, SDK_FAILURE_REASONS);
  const terminationState = allowed(task.sdk_failure?.termination, SDK_TERMINATION_STATES);
  const watchdogAction = allowed(task.sdk_failure?.watchdog_action, SDK_WATCHDOG_ACTIONS);
  const elapsed = task.sdk_failure?.elapsed_ms;
  const failed = task.status === TaskStatus.FAILED || task.status === TaskStatus.TIMED_OUT;
  const unverified = terminationState === 'unverified' && task.status !== TaskStatus.COMPLETED;

  return {
    failure_reason: unverified
      ? 'termination_unverified'
      : !failed
        ? null
        : task.status === TaskStatus.TIMED_OUT
          ? 'timed_out'
          : terminationCause === 'sdk_health_failure' && watchdogAction === 'enforced'
            ? (sdkReason ?? terminationCause)
            : (terminationCause ?? 'unknown'),
    termination_cause: terminationCause,
    sdk_failure_reason: sdkReason,
    termination_state: terminationState,
    watchdog_action: watchdogAction,
    sdk_elapsed_ms:
      typeof elapsed === 'number' && Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null,
    executor_mode: allowed(task.executor_mode, EXECUTOR_MODES),
    executor_connected: !!task.executor_connected_at,
  };
}
