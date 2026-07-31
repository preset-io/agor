import type { ExecutorPulseKind, Task, TaskID } from '@agor/core/types';
import type { AgorClient } from './services/feathers-client.js';

export interface ExecutorHeartbeatOptions {
  client: AgorClient;
  taskId: TaskID | string;
  enabled?: boolean;
  intervalMs?: number;
  warn?: (...args: unknown[]) => void;
  /** Observe the durable Task returned by any daemon handling this heartbeat. */
  onTask?: (task: Task) => void;
  /** Reconcile durable Task ownership after a rejected telemetry write. */
  onReportError?: (error: unknown) => void | Promise<void>;
}

export interface ExecutorHeartbeatHandle {
  recordPulse(kind: ExecutorPulseKind, detail?: string): number;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 10_000;

export function startExecutorHeartbeat(options: ExecutorHeartbeatOptions): ExecutorHeartbeatHandle {
  const enabled = options.enabled ?? true;
  const intervalMs =
    typeof options.intervalMs === 'number' &&
    Number.isFinite(options.intervalMs) &&
    options.intervalMs > 0
      ? Math.floor(options.intervalMs)
      : DEFAULT_INTERVAL_MS;
  const warn = options.warn ?? console.warn;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let latestPulse: { sequence: number; kind: ExecutorPulseKind; detail?: string } | undefined;
  let latestProgress: { sequence: number; kind: 'progress'; detail?: string } | undefined;

  const emit = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const task = await options.client.service('tasks').reportRuntimeTelemetry({
        task_id: options.taskId,
        ...(latestPulse ? { pulse: latestPulse } : {}),
        ...(latestProgress ? { progress: latestProgress } : {}),
      });
      options.onTask?.(task as Task);
    } catch (error) {
      warn(
        '[executor-heartbeat] Failed to write heartbeat:',
        error instanceof Error ? error.message : String(error)
      );
      try {
        await options.onReportError?.(error);
      } catch (reconcileError) {
        warn(
          '[executor-heartbeat] Failed to reconcile Task ownership:',
          reconcileError instanceof Error ? reconcileError.message : String(reconcileError)
        );
      }
    } finally {
      inFlight = false;
    }
  };

  const schedulePulseFlush = () => {
    if (enabled || stopped || pulseTimer) return;
    pulseTimer = setTimeout(async () => {
      const scheduledSequence = sequence;
      await emit();
      pulseTimer = undefined;
      if (sequence > scheduledSequence) schedulePulseFlush();
    }, intervalMs);
    pulseTimer.unref?.();
  };

  if (enabled) {
    void emit();
    timer = setInterval(() => {
      void emit();
    }, intervalMs);
    timer.unref?.();
  }

  return {
    recordPulse(kind, detail) {
      sequence += 1;
      latestPulse = { sequence, kind, ...(detail ? { detail } : {}) };
      if (kind === 'progress') {
        latestProgress = { sequence, kind, ...(detail ? { detail } : {}) };
      }
      schedulePulseFlush();
      return sequence;
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (pulseTimer) clearTimeout(pulseTimer);
    },
  };
}
