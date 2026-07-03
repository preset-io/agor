import type { AgorExecutionSettings } from './types';

export const EXECUTOR_HEARTBEAT_DEFAULT_INTERVAL_MS = 10_000;
// Minimum grace period before a stale heartbeat is even considered for failure.
// Kept forgiving (90s) so a busy-but-alive executor under heavy git/build/test
// work or host load is not mistaken for a crash. The daemon additionally probes
// the executor process's liveness before failing, so this is a floor, not the
// sole safeguard. Fully overridable via `execution.executor_heartbeat.stale_after_ms`.
export const EXECUTOR_HEARTBEAT_MIN_STALE_AFTER_MS = 90_000;
export const EXECUTOR_HEARTBEAT_DEFAULT_CALLBACK_TIMEOUT_MS = 3_000;

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
