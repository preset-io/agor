import { EXECUTOR_MEMORY_FIELDS } from '@agor/core/types';
import type { DaemonMetrics } from './types.js';

/**
 * Called only after task-scoped runtime authority accepts the heartbeat.
 * Ignore unknown/malformed metrics without breaking liveness. Rebuild from the
 * fixed allowlist: arbitrary content and high-cardinality labels never reach an exporter.
 * These are heartbeat/time-weighted current observations, not per-run
 * peaks or a distinct-executor distribution (there is deliberately no ID tag).
 */
export function recordExecutorMemory(metrics: DaemonMetrics, sample: unknown): void {
  if (!metrics.enabled || !sample || typeof sample !== 'object') return;
  const values = (sample as Record<string, unknown>).current;
  if (!values || typeof values !== 'object') return;
  for (const field of EXECUTOR_MEMORY_FIELDS) {
    const value = (values as Record<string, unknown>)[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) continue;
    metrics.distribution(`executor.memory.current.${field}_bytes`, value);
  }
}
