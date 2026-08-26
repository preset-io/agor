import type { AgorExecutionSettings } from './types';
import { resolveSafeIntegerInRange } from './validation';

export const EXECUTOR_HEARTBEAT_DEFAULT_INTERVAL_MS = 10_000;
export const EXECUTOR_HEARTBEAT_MIN_STALE_AFTER_MS = 30_000;
export const EXECUTOR_HEARTBEAT_DEFAULT_CALLBACK_TIMEOUT_MS = 3_000;
export const EXECUTOR_DISPATCH_CONNECT_TIMEOUT_MS = 5 * 60_000;
export type ResolvedSdkWatchdogConfig = Required<
  NonNullable<AgorExecutionSettings['sdk_watchdog']>
>;
export type ResolvedClaudeBackgroundTaskConfig = Required<
  NonNullable<AgorExecutionSettings['claude_background_tasks']>
>;

export const CLAUDE_BACKGROUND_TASK_SILENCE_TIMEOUT_MS = 30 * 60_000;
export const CLAUDE_BACKGROUND_TASK_SETTLED_GRACE_MS = 2 * 60_000;

export interface ResolvedExecutorHeartbeatConfig {
  enabled: boolean;
  interval_ms: number;
  stale_after_ms: number;
  callback: {
    command_template: string | null;
    timeout_ms: number;
  };
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function resolveExecutorHeartbeatConfig(
  execution?: AgorExecutionSettings
): ResolvedExecutorHeartbeatConfig {
  const raw = execution?.executor_heartbeat;
  const intervalMs = positiveIntegerOrDefault(
    raw?.interval_ms,
    EXECUTOR_HEARTBEAT_DEFAULT_INTERVAL_MS
  );
  const staleAfterMs = positiveIntegerOrDefault(
    raw?.stale_after_ms,
    Math.max(3 * intervalMs, EXECUTOR_HEARTBEAT_MIN_STALE_AFTER_MS)
  );
  const timeoutMs = positiveIntegerOrDefault(
    raw?.callback?.timeout_ms,
    EXECUTOR_HEARTBEAT_DEFAULT_CALLBACK_TIMEOUT_MS
  );

  return {
    // Default enabled: the heartbeat is a lightweight task-row timestamp patch,
    // and callback execution remains opt-in via command_template.
    enabled: raw?.enabled ?? true,
    interval_ms: intervalMs,
    stale_after_ms: staleAfterMs,
    callback: {
      command_template: raw?.callback?.command_template ?? null,
      timeout_ms: timeoutMs,
    },
  };
}

export function resolveDispatchConnectTimeoutMs(execution?: AgorExecutionSettings): number {
  return resolveSafeIntegerInRange(execution?.dispatch_connect_timeout_ms ?? undefined, {
    defaultValue: EXECUTOR_DISPATCH_CONNECT_TIMEOUT_MS,
    minimum: 1,
    path: 'execution.dispatch_connect_timeout_ms',
  });
}

export function resolveClaudeBackgroundTaskConfig(
  execution?: AgorExecutionSettings
): ResolvedClaudeBackgroundTaskConfig {
  const raw = execution?.claude_background_tasks;
  return {
    silence_timeout_ms: positiveSafeInteger(
      raw?.silence_timeout_ms,
      CLAUDE_BACKGROUND_TASK_SILENCE_TIMEOUT_MS,
      'execution.claude_background_tasks.silence_timeout_ms'
    ),
    settled_grace_ms: positiveSafeInteger(
      raw?.settled_grace_ms,
      CLAUDE_BACKGROUND_TASK_SETTLED_GRACE_MS,
      'execution.claude_background_tasks.settled_grace_ms'
    ),
  };
}

export function resolveSdkWatchdogConfig(
  execution?: AgorExecutionSettings
): ResolvedSdkWatchdogConfig {
  const raw = execution?.sdk_watchdog;
  if (raw?.mode && !['disabled', 'observe', 'enforce'].includes(raw.mode)) {
    throw new Error(
      'Config error: execution.sdk_watchdog.mode must be disabled, observe, or enforce'
    );
  }
  return {
    mode: raw?.mode ?? 'observe',
    first_progress_timeout_ms: resolveSafeIntegerInRange(raw?.first_progress_timeout_ms, {
      defaultValue: 180_000,
      minimum: 1,
      path: 'execution.sdk_watchdog.first_progress_timeout_ms',
    }),
    abort_grace_ms: resolveSafeIntegerInRange(raw?.abort_grace_ms, {
      defaultValue: 15_000,
      minimum: 1,
      path: 'execution.sdk_watchdog.abort_grace_ms',
    }),
    claude_idle_timeout_ms:
      raw?.claude_idle_timeout_ms === null
        ? null
        : resolveSafeIntegerInRange(raw?.claude_idle_timeout_ms, {
            defaultValue: 3_600_000,
            minimum: 1,
            path: 'execution.sdk_watchdog.claude_idle_timeout_ms',
          }),
  };
}
