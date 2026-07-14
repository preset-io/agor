import { EXECUTOR_HEARTBEAT_DEFAULT_INTERVAL_MS } from '@agor/core/config';
import {
  type ExecutorTelemetryReport,
  isMeaningfulPulse,
  PULSE_KINDS,
  type Pulse,
  sanitizePulse,
  type TaskID,
} from '@agor/core/types';
import type { AgorClient } from './services/feathers-client.js';

const DEFAULT_FLUSH_TIMEOUT_MS = 3_000;
const TERMINAL_LEASE_ERROR_CODES = new Set([401, 403, 409]);

/** Named view over the canonical ordered pulse contract exported by core. */
export const PULSE_KIND = {
  EXECUTOR_CONNECTED: PULSE_KINDS[0],
  SDK_STARTED: PULSE_KINDS[1],
  SDK_FIRST_EVENT: PULSE_KINDS[2],
  SDK_PROGRESS: PULSE_KINDS[3],
  ASSISTANT_MESSAGE: PULSE_KINDS[5],
  ASSISTANT_STREAM: PULSE_KINDS[6],
  THINKING_PROGRESS: PULSE_KINDS[7],
  TOOL_STARTED: PULSE_KINDS[8],
  TOOL_PROGRESS: PULSE_KINDS[9],
  TOOL_FINISHED: PULSE_KINDS[10],
  PERMISSION_WAIT_STARTED: PULSE_KINDS[11],
  PERMISSION_WAIT_ENDED: PULSE_KINDS[12],
} as const;

export { sanitizePulse } from '@agor/core/types';

export interface AgenticToolRuntime {
  pulse(pulse: Pulse): void;
  /** Best-effort lifecycle flush before the task's terminal write revokes this attempt. */
  flush?(timeoutMs?: number): Promise<boolean>;
}

export interface RuntimeOverseerOptions {
  client: AgorClient;
  taskId: TaskID | string;
  executorAttemptId: string;
  enabled?: boolean;
  heartbeatIntervalMs?: number;
  heartbeatStaleAfterMs?: number;
  onLeaseLost?: () => void;
  now?: () => number;
  warn?: (...args: unknown[]) => void;
}

export class RuntimeOverseer implements AgenticToolRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private latestPulse?: Pulse;
  private reportedPulse?: Pulse;
  private stopped = false;
  private inFlight?: Promise<void>;
  private lastSuccessfulHeartbeatAt: number;
  private leaseLost = false;

  constructor(private readonly options: RuntimeOverseerOptions) {
    this.lastSuccessfulHeartbeatAt = this.now();
  }

  start(): void {
    if (this.timer || this.stopped || this.enabled() === false) return;

    this.pulse({ kind: PULSE_KIND.EXECUTOR_CONNECTED });

    this.timer = setInterval(() => {
      this.checkLease();
      void this.heartbeat();
    }, this.heartbeatIntervalMs());
    this.timer.unref?.();

    // Emit one promptly instead of waiting for the first interval.
    void this.heartbeat();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  pulse(pulse: Pulse): void {
    if (this.stopped) return;

    const sanitized = sanitizePulse(pulse);
    if (!sanitized) return;
    if (!isMeaningfulPulse(sanitized)) return;
    this.latestPulse = sanitized;
  }

  async heartbeat(): Promise<void> {
    if (this.stopped || this.enabled() === false || this.inFlight) return;

    const pulse = this.pendingPulse();

    const request = this.report(true, pulse);
    this.inFlight = request;

    try {
      await request;
    } catch (error) {
      this.warn(
        '[runtime-overseer] Failed to write heartbeat:',
        error instanceof Error ? error.message : String(error)
      );
      if (this.isTerminalLeaseRejection(error)) {
        this.loseLease();
      } else {
        this.checkLease();
      }
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  async flush(timeoutMs?: number): Promise<boolean> {
    this.clearTimer();

    if (this.stopped || this.enabled() === false) return true;

    const deadline = Date.now() + this.flushTimeoutMs(timeoutMs);
    const inFlight = this.inFlight;
    if (inFlight) {
      if (
        !(await this.waitFor(
          inFlight.catch(() => {
            // heartbeat() owns warning; flush should not make shutdown fail.
          }),
          deadline
        ))
      ) {
        this.warn('[runtime-overseer] Timed out flushing in-flight heartbeat');
        return false;
      }
    }

    const pulse = this.pendingPulse();
    if (!pulse) return true;

    const delivery = this.flushPulse(pulse);
    if (!(await this.waitFor(delivery, deadline))) {
      this.warn('[runtime-overseer] Timed out flushing runtime pulse');
      return false;
    }
    return delivery;
  }

  private async flushPulse(pulse: Pulse): Promise<boolean> {
    try {
      await this.report(false, pulse);
      return true;
    } catch (error) {
      this.warn(
        '[runtime-overseer] Failed to flush runtime pulse:',
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  private async waitFor(promise: Promise<unknown>, deadline: number): Promise<boolean> {
    const timeoutMs = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      promise.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return completed;
  }

  private async report(heartbeat: boolean, pulse?: Pulse): Promise<void> {
    await this.options.client.service('tasks').reportExecutorTelemetry({
      task_id: this.options.taskId,
      executor_attempt_id: this.options.executorAttemptId,
      heartbeat,
      ...(pulse ? { pulse } : {}),
    } satisfies ExecutorTelemetryReport);
    if (heartbeat) this.lastSuccessfulHeartbeatAt = this.now();
    if (pulse) this.reportedPulse = pulse;
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private pendingPulse(): Pulse | undefined {
    return this.latestPulse !== this.reportedPulse ? this.latestPulse : undefined;
  }

  private flushTimeoutMs(timeoutMs?: number): number {
    return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? Math.floor(timeoutMs)
      : DEFAULT_FLUSH_TIMEOUT_MS;
  }

  private enabled(): boolean {
    return this.options.enabled ?? true;
  }

  private checkLease(): void {
    if (this.stopped || this.leaseLost || !this.options.onLeaseLost) return;
    const staleAfterMs = this.options.heartbeatStaleAfterMs;
    if (typeof staleAfterMs !== 'number' || !Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
      return;
    }
    if (this.now() - this.lastSuccessfulHeartbeatAt >= staleAfterMs) {
      this.loseLease();
    }
  }

  private loseLease(): void {
    if (this.leaseLost) return;
    this.leaseLost = true;
    this.stopped = true;
    this.clearTimer();
    this.options.onLeaseLost?.();
  }

  private isTerminalLeaseRejection(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as { code?: unknown; statusCode?: unknown };
    const code = typeof record.code === 'number' ? record.code : record.statusCode;
    return typeof code === 'number' && TERMINAL_LEASE_ERROR_CODES.has(code);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private heartbeatIntervalMs(): number {
    const interval = this.options.heartbeatIntervalMs;
    return typeof interval === 'number' && Number.isFinite(interval) && interval > 0
      ? Math.floor(interval)
      : EXECUTOR_HEARTBEAT_DEFAULT_INTERVAL_MS;
  }

  private warn(...args: unknown[]): void {
    (this.options.warn ?? console.warn)(...args);
  }
}
