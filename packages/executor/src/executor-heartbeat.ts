import type { TaskID } from '@agor/core/types';
import type { AgorClient } from './services/feathers-client.js';

export interface ExecutorHeartbeatOptions {
  client: AgorClient;
  taskId: TaskID | string;
  enabled?: boolean;
  intervalMs?: number;
  now?: () => Date;
  warn?: (...args: unknown[]) => void;
}

export interface ExecutorHeartbeatHandle {
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 10_000;

/**
 * Emit a periodic liveness heartbeat for a running task.
 *
 * Design notes on starvation (see issue #1809):
 * - The heartbeat runs on its own `setInterval`, independent of the tool's
 *   async work. Tool execution (git/build/test, SDK streaming) is asynchronous
 *   subprocess/socket I/O, so it yields the event loop and the timer keeps
 *   firing on schedule.
 * - The `inFlight` guard only skips *overlapping* emits (e.g. a slow patch); it
 *   never blocks the timer itself, so a slow write cannot stall future ticks.
 * - A pathological CPU-bound *synchronous* tool call could still delay any
 *   main-thread timer in Node. That is why the daemon no longer treats a late
 *   heartbeat as proof of death: before failing a task it probes the executor
 *   OS process directly (`process.kill(pid, 0)`), which cannot be starved by
 *   anything happening inside the executor's event loop. The emitted heartbeat
 *   is a fast-path liveness refresh; the process probe is the authoritative,
 *   unblockable signal.
 */
export function startExecutorHeartbeat(options: ExecutorHeartbeatOptions): ExecutorHeartbeatHandle {
  const enabled = options.enabled ?? true;
  if (!enabled) {
    return { stop() {} };
  }

  const intervalMs =
    typeof options.intervalMs === 'number' &&
    Number.isFinite(options.intervalMs) &&
    options.intervalMs > 0
      ? Math.floor(options.intervalMs)
      : DEFAULT_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? console.warn;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const emit = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await options.client.service('tasks').patch(options.taskId, {
        last_executor_heartbeat_at: now().toISOString(),
      });
    } catch (error) {
      warn(
        '[executor-heartbeat] Failed to write heartbeat:',
        error instanceof Error ? error.message : String(error)
      );
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
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
