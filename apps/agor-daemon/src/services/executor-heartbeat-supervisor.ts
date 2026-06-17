import type { ResolvedExecutorHeartbeatConfig } from '@agor/core/config';
import { shortId } from '@agor/core/db';
import type { Application, TasksServiceImpl } from '../declarations.js';

export const EXECUTOR_HEARTBEAT_LOST_MESSAGE =
  'Executor heartbeat lost; the executor may have crashed or disconnected.';

export interface ExecutorHeartbeatSupervisorOptions {
  app: Application;
  config: ResolvedExecutorHeartbeatConfig;
  tickIntervalMs?: number;
  now?: () => Date;
}

export class ExecutorHeartbeatSupervisor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;

  constructor(private options: ExecutorHeartbeatSupervisorOptions) {
    this.tickIntervalMs = options.tickIntervalMs ?? Math.min(options.config.interval_ms, 30_000);
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (!this.options.config.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.checkOnce();
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async checkOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tasksService = this.options.app.service('tasks') as unknown as TasksServiceImpl;
      const tasks = await tasksService.getActiveWithExecutorHeartbeat();
      const nowMs = this.now().getTime();
      for (const task of tasks) {
        if (!task.last_executor_heartbeat_at) continue;
        const heartbeatMs = new Date(task.last_executor_heartbeat_at).getTime();
        if (!Number.isFinite(heartbeatMs)) continue;
        if (nowMs - heartbeatMs <= this.options.config.stale_after_ms) continue;

        try {
          const current = await this.options.app.service('tasks').get(task.task_id);
          if (current.status !== task.status || !current.last_executor_heartbeat_at) continue;
          const currentHeartbeatMs = new Date(current.last_executor_heartbeat_at).getTime();
          if (!Number.isFinite(currentHeartbeatMs)) continue;
          if (nowMs - currentHeartbeatMs <= this.options.config.stale_after_ms) continue;

          await tasksService.failForLostHeartbeat(task.task_id, {
            completed_at: this.now().toISOString(),
            error_message: EXECUTOR_HEARTBEAT_LOST_MESSAGE,
          });
          console.warn(
            `[executor-heartbeat] Marked task ${shortId(task.task_id)} failed after stale heartbeat (${nowMs - currentHeartbeatMs}ms old)`
          );
        } catch (error) {
          console.warn(
            `[executor-heartbeat] Failed to process stale task ${shortId(task.task_id)}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    } catch (error) {
      console.warn(
        '[executor-heartbeat] Supervisor check failed:',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.running = false;
    }
  }
}
