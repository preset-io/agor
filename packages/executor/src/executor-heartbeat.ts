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
  /** Flush coalesced telemetry and return the newest acknowledged progress sequence. */
  flushProgressThrough(decisionSequence: number): Promise<number | undefined>;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 10_000;

interface TelemetryWriteResult {
  succeeded: boolean;
  pulseSequence?: number;
  progressSequence?: number;
}

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
  let inFlight: Promise<TelemetryWriteResult> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let latestPulse: { sequence: number; kind: ExecutorPulseKind; detail?: string } | undefined;
  let latestProgress: { sequence: number; kind: 'progress'; detail?: string } | undefined;

  const emit = (): Promise<TelemetryWriteResult> => {
    if (stopped) return Promise.resolve({ succeeded: false });
    if (inFlight) return inFlight;
    const pulse = latestPulse;
    const progress = latestProgress;
    const report: Promise<TelemetryWriteResult> = options.client
      .service('tasks')
      .reportRuntimeTelemetry({
        task_id: options.taskId,
        ...(pulse ? { pulse } : {}),
        ...(progress ? { progress } : {}),
      })
      .then((task) => {
        options.onTask?.(task as Task);
        return {
          succeeded: true,
          ...(pulse ? { pulseSequence: pulse.sequence } : {}),
          ...(progress ? { progressSequence: progress.sequence } : {}),
        };
      })
      .catch(async (error) => {
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
        return { succeeded: false };
      });
    inFlight = report;
    void report.finally(() => {
      if (inFlight === report) inFlight = null;
    });
    return report;
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
    async flushProgressThrough(decisionSequence) {
      const first = await emit();
      if (!first.succeeded) return undefined;

      let acknowledgedProgress = first.progressSequence;
      if (
        !stopped &&
        (latestProgress?.sequence ?? -1) > Math.max(decisionSequence, acknowledgedProgress ?? -1)
      ) {
        const coalesced = await emit();
        if (coalesced.succeeded) {
          acknowledgedProgress = Math.max(
            acknowledgedProgress ?? -1,
            coalesced.progressSequence ?? -1
          );
        }
      }
      return acknowledgedProgress !== undefined && acknowledgedProgress >= 0
        ? acknowledgedProgress
        : undefined;
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (pulseTimer) clearTimeout(pulseTimer);
    },
  };
}
