import type { TaskID } from '@agor/core/types';
import { RuntimeOverseer } from './runtime-overseer.js';
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

export function startExecutorHeartbeat(options: ExecutorHeartbeatOptions): ExecutorHeartbeatHandle {
  const runtime = new RuntimeOverseer({
    client: options.client,
    taskId: options.taskId,
    enabled: options.enabled,
    heartbeatIntervalMs: options.intervalMs,
    now: options.now,
    warn: options.warn,
  });
  runtime.start();
  return { stop: () => runtime.stop() };
}
