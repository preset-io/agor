import { classifyProviderFallback } from '@agor/core';
import type { TaskDispatchClaimResult } from '@agor/core/db';
import type { Task } from '@agor/core/types';
import type { DaemonMetrics } from './types.js';

function executorMode(task: Task): 'local' | 'templated' {
  return task.executor_mode === 'templated' ? 'templated' : 'local';
}

function taskSurface(task: Task): 'gateway' | 'ui' | 'unknown' {
  if (task.metadata?.gateway_task_source || task.metadata?.source === 'gateway') {
    return 'gateway';
  }
  if (task.metadata?.source === 'agor') {
    return 'ui';
  }
  return 'unknown';
}

// 0 -> none, 1-4 -> short, >=5 -> long, non-finite/null -> unknown
function toolChainLength(task: Task): 'none' | 'short' | 'long' | 'unknown' {
  if (task.recorded_tool_count == null || !Number.isFinite(task.recorded_tool_count)) {
    return 'unknown';
  }
  if (task.recorded_tool_count === 0) {
    return 'none';
  }
  if (task.recorded_tool_count <= 4) {
    return 'short';
  }
  return 'long';
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

const settledTasks = new WeakSet<object>();

export function recordTaskSettlement(metrics: DaemonMetrics, task: Task): void {
  if (settledTasks.has(task)) {
    return;
  }
  settledTasks.add(task);

  const tags = { status: task.status, mode: executorMode(task) } as const;
  metrics.increment('task.settlements', 1, tags);

  const executionDuration = durationBetween(task.started_at, task.completed_at);
  if (executionDuration !== undefined) {
    metrics.distribution('task.dispatch_to_settlement.duration_ms', executionDuration, tags);
  }
  const connectedDuration = durationBetween(task.executor_connected_at, task.completed_at);
  if (connectedDuration !== undefined) {
    metrics.distribution('task.connected_to_settlement.duration_ms', connectedDuration, tags);
  }

  const fallbackKind = classifyProviderFallback(task);
  if (fallbackKind) {
    metrics.increment('task.provider_fallback', 1, {
      fallback_kind: fallbackKind,
      surface: taskSurface(task),
      tool_chain: toolChainLength(task),
      mode: executorMode(task),
    });
  }
}
