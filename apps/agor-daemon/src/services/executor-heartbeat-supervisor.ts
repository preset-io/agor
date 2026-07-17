import type { ResolvedExecutorHeartbeatConfig } from '@agor/core/config';
import { shortId } from '@agor/core/db';
import { TaskStatus } from '@agor/core/types';
import type { Application, TasksServiceImpl } from '../declarations.js';
import { requestExecutorTermination } from '../termination-coordinator.js';

export const EXECUTOR_HEARTBEAT_LOST_MESSAGE =
  'Executor heartbeat lost; the executor may have crashed or disconnected.';

export interface ExecutorHeartbeatSupervisorOptions {
  app: Application;
  config: ResolvedExecutorHeartbeatConfig;
  dispatchConnectTimeoutMs?: number;
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
    if (this.timer) return;
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
      const nowMs = this.now().getTime();
      const dispatching = (await tasksService.getOrphaned()).filter(
        (task) => task.status === TaskStatus.DISPATCHING && !task.executor_connected_at
      );
      for (const task of dispatching) {
        const dispatchedMs = new Date(task.started_at ?? task.created_at).getTime();
        if (
          !Number.isFinite(dispatchedMs) ||
          nowMs - dispatchedMs <= (this.options.dispatchConnectTimeoutMs ?? 5 * 60_000)
        ) {
          continue;
        }
        const current = await this.options.app.service('tasks').get(task.task_id);
        if (current.status !== TaskStatus.DISPATCHING || current.executor_connected_at) continue;
        if (current.executor_mode === 'templated') {
          const warning =
            'Remote executor has not connected within the configured startup window; still waiting.';
          if (current.error_message !== warning) {
            await this.options.app
              .service('tasks')
              .patch(current.task_id, { error_message: warning }, { provider: undefined });
          }
          continue;
        }
        const session = await this.options.app.service('sessions').get(current.session_id);
        await requestExecutorTermination({
          app: this.options.app,
          taskId: current.task_id,
          cause: 'startup_timeout',
          errorMessage: 'Local executor did not connect before the startup deadline.',
          sdkFailure: {
            reason: 'startup_timeout',
            detected_at: this.now().toISOString(),
            tool: session.agentic_tool,
            termination: 'requested',
          },
        });
      }

      if (!this.options.config.enabled) return;
      const tasks = await tasksService.getActiveWithExecutorHeartbeat();
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

          const session = await this.options.app.service('sessions').get(current.session_id);
          const result = await requestExecutorTermination({
            app: this.options.app,
            taskId: current.task_id,
            cause: 'heartbeat_lost',
            errorMessage: EXECUTOR_HEARTBEAT_LOST_MESSAGE,
            sdkFailure: {
              reason: 'heartbeat_lost',
              detected_at: this.now().toISOString(),
              tool: session.agentic_tool,
              last_pulse: current.latest_executor_pulse,
              termination: 'requested',
            },
          });
          console.warn(
            `[executor-heartbeat] Stale task ${shortId(task.task_id)} containment ${result.status} (${nowMs - currentHeartbeatMs}ms old)`
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
