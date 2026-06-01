import { spawn } from 'node:child_process';
import type { ResolvedExecutorHeartbeatConfig } from '@agor/core/config';
import { shortId } from '@agor/core/db';

export interface ExecutorHeartbeatCallbackPayload {
  event: 'executor_heartbeat';
  task_id: string;
  session_id: string;
  branch_id?: string;
  last_executor_heartbeat_at: string;
}

export class ExecutorHeartbeatCallbackRunner {
  private runningByTask = new Set<string>();

  constructor(private config: Pick<ResolvedExecutorHeartbeatConfig, 'enabled' | 'callback'>) {}

  run(payload: ExecutorHeartbeatCallbackPayload): void {
    if (!this.config.enabled) return;

    const command = this.config.callback.command_template;
    if (!command) return;

    if (this.runningByTask.has(payload.task_id)) {
      console.warn(
        `[executor-heartbeat] Previous callback still running for task ${shortId(payload.task_id)}; skipping heartbeat callback`
      );
      return;
    }

    this.runningByTask.add(payload.task_id);
    const timeoutMs = this.config.callback.timeout_ms;
    const child = spawn('sh', ['-c', command], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (reason?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      this.runningByTask.delete(payload.task_id);
      if (reason) {
        console.warn(`[executor-heartbeat] Callback ${reason}`);
      }
    };

    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      console.warn(`[executor-heartbeat] Callback timed out after ${timeoutMs}ms`);
      child.kill('SIGTERM');
      killTimer = setTimeout(
        () => {
          if (!settled) {
            child.kill('SIGKILL');
          }
        },
        Math.min(timeoutMs, 1_000)
      );
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (error) => finish(`spawn failed: ${error.message}`));
    child.on('exit', (code, signal) => {
      if (code === 0 || timedOut) {
        finish();
      } else {
        finish(`exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
      }
    });

    child.stdin?.on('error', (error: Error) => {
      console.warn(`[executor-heartbeat] Callback stdin failed: ${error.message}`);
    });

    try {
      child.stdin?.end(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      console.warn(
        `[executor-heartbeat] Callback stdin failed:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
