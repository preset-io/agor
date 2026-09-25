import { shortId } from '@agor/core/db';
import type { ExecutorPulseKind, Task, TaskID } from '@agor/core/types';
import type { AgorClient } from './services/feathers-client.js';

export interface ExecutorHeartbeatOptions {
  client: AgorClient;
  taskId: TaskID | string;
  enabled?: boolean;
  intervalMs?: number;
  warn?: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
  /** Observe the durable Task returned by any daemon handling this heartbeat. */
  onTask?: (task: Task) => void;
}

export interface ExecutorHeartbeatHandle {
  recordPulse(kind: ExecutorPulseKind, detail?: string): void;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 10_000;

export function startExecutorHeartbeat(options: ExecutorHeartbeatOptions): ExecutorHeartbeatHandle {
  const enabled = options.enabled ?? true;
  if (!enabled) {
    return { recordPulse() {}, stop() {} };
  }

  const intervalMs =
    typeof options.intervalMs === 'number' &&
    Number.isFinite(options.intervalMs) &&
    options.intervalMs > 0
      ? Math.floor(options.intervalMs)
      : DEFAULT_INTERVAL_MS;
  const warn = options.warn ?? console.warn;
  const log = options.log ?? console.log;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sequence = 0;
  let consecutiveFailures = 0;
  let firstFailureAt = 0;
  let latestPulse: { sequence: number; kind: ExecutorPulseKind; detail?: string } | undefined;

  const emit = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const task = await options.client.service('tasks').reportRuntimeTelemetry({
        task_id: options.taskId,
        ...(latestPulse ? { pulse: latestPulse } : {}),
      });
      if (consecutiveFailures > 0) {
        log(
          `[executor.heartbeat] event=recovered task_id=${shortId(String(options.taskId))} ` +
            `missed_writes=${consecutiveFailures} outage_ms=${Date.now() - firstFailureAt}`
        );
        consecutiveFailures = 0;
      }
      options.onTask?.(task as Task);
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures === 1) {
        firstFailureAt = Date.now();
        // Class/code only: error messages can echo request payloads.
        const code = (error as { code?: unknown } | null)?.code;
        warn(
          `[executor.heartbeat] event=write_failed task_id=${shortId(String(options.taskId))} ` +
            `error=${JSON.stringify(error instanceof Error ? error.name : 'unknown')} ` +
            `code=${typeof code === 'string' || typeof code === 'number' ? code : 'none'} ` +
            'retrying=true'
        );
      }
    } finally {
      inFlight = false;
    }
  };

  void emit();
  timer = setInterval(() => {
    void emit();
  }, intervalMs);
  timer.unref?.();

  return {
    recordPulse(kind, detail) {
      sequence += 1;
      latestPulse = { sequence, kind, ...(detail ? { detail } : {}) };
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
