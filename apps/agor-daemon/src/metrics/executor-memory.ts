import { EXECUTOR_MEMORY_FIELDS, type ExecutorMemorySample } from '@agor/core/types';
import type { DaemonMetrics } from './types.js';

/** Shared bounded projection for metrics and the trusted heartbeat callback. */
export function sanitizeExecutorMemory(sample: unknown): ExecutorMemorySample | undefined {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return;
  const values = (sample as Record<string, unknown>).current;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return;
  const current: ExecutorMemorySample['current'] = {};
  for (const field of EXECUTOR_MEMORY_FIELDS) {
    const value = (values as Record<string, unknown>)[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      current[field] = value;
    }
  }
  return Object.keys(current).length ? { current } : undefined;
}

/**
 * Called only after task-scoped runtime authority accepts the heartbeat.
 * Ignore unknown/malformed metrics without breaking liveness. Rebuild from the
 * fixed allowlist: arbitrary content and high-cardinality labels never reach an exporter.
 * These are heartbeat/time-weighted current observations, not per-run
 * peaks or a distinct-executor distribution (there is deliberately no ID tag).
 */
export function recordExecutorMemory(metrics: DaemonMetrics, sample: unknown): void {
  if (!metrics.enabled) return;
  const memory = sanitizeExecutorMemory(sample);
  if (!memory) return;
  for (const field of EXECUTOR_MEMORY_FIELDS) {
    const value = memory.current[field];
    if (value === undefined) continue;
    metrics.distribution(`executor.memory.current.${field}_bytes`, value);
  }
}
