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
