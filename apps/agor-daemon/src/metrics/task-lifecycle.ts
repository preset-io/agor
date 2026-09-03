import type { TaskDispatchClaimResult } from '@agor/core/db';
import type { Task } from '@agor/core/types';
import type { DaemonMetrics } from './types.js';

function executorMode(task: Task): 'local' | 'templated' {
  return task.executor_mode === 'templated' ? 'templated' : 'local';
}

function durationBetween(start: string | undefined, end: string | undefined): number | undefined {
  const startMs = Date.parse(start ?? '');
  const endMs = Date.parse(end ?? '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  return Math.max(0, endMs - startMs);
}

export function recordDispatchClaim(metrics: DaemonMetrics, result: TaskDispatchClaimResult): void {
  const tags = { outcome: result.outcome, mode: executorMode(result.task) } as const;
  metrics.increment('executor.dispatches', 1, tags);
  if (result.outcome !== 'claimed') return;
  const duration = durationBetween(result.task.created_at, result.task.started_at);
  if (duration !== undefined) {
    metrics.distribution('executor.request_to_dispatch.duration_ms', duration, tags);
  }
}

export function recordExecutorConnected(metrics: DaemonMetrics, task: Task): void {
  const tags = { outcome: 'connected', mode: executorMode(task) } as const;
  metrics.increment('executor.connections', 1, tags);

  const dispatchToConnected = durationBetween(task.started_at, task.executor_connected_at);
  if (dispatchToConnected !== undefined) {
    metrics.distribution('executor.dispatch_to_connected.duration_ms', dispatchToConnected, tags);
  }
  const requestToConnected = durationBetween(task.created_at, task.executor_connected_at);
  if (requestToConnected !== undefined) {
    metrics.distribution('executor.request_to_connected.duration_ms', requestToConnected, tags);
  }
}

export function recordTaskSettlement(metrics: DaemonMetrics, task: Task): void {
  const tags = { status: task.status, mode: executorMode(task) } as const;
  metrics.increment('task.settlements', 1, tags);

  // Rare, worth tracking: the agent ended its turn with background work still
  // running that never reported completion in time, so the turn was settled and
  // the background work stopped. Flagged on the Task by the executor.
  if (task.metadata?.background_task_timeout) {
    metrics.increment('task.background_task_timeout', 1, { mode: executorMode(task) });
  }

  const executionDuration = durationBetween(task.started_at, task.completed_at);
  if (executionDuration !== undefined) {
    metrics.distribution('task.dispatch_to_settlement.duration_ms', executionDuration, tags);
  }
  const connectedDuration = durationBetween(task.executor_connected_at, task.completed_at);
  if (connectedDuration !== undefined) {
    metrics.distribution('task.connected_to_settlement.duration_ms', connectedDuration, tags);
  }
}
