import type { Pulse, PulseSnapshot, Task, TaskID } from '@agor/core/types';
import type { AgorClient } from './services/feathers-client.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_KIND_LENGTH = 120;
const MAX_ID_LENGTH = 160;
const MAX_LABEL_LENGTH = 120;
const DEFAULT_FLUSH_TIMEOUT_MS = 3_000;

export interface AgenticToolRuntime {
  pulse(pulse: Pulse): void;
}

export interface RuntimeOverseerOptions {
  client: AgorClient;
  taskId: TaskID | string;
  enabled?: boolean;
  heartbeatIntervalMs?: number;
  now?: () => Date;
  warn?: (...args: unknown[]) => void;
}

export class RuntimeOverseer implements AgenticToolRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private latestPulse?: PulseSnapshot;
  private stopped = false;
  private inFlight?: Promise<void>;

  constructor(private readonly options: RuntimeOverseerOptions) {}

  start(): void {
    if (this.timer || this.stopped || this.enabled() === false) return;

    this.pulse({ kind: 'executor.connected' });

    this.timer = setInterval(() => {
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

    const now = this.now();
    this.latestPulse = {
      ...sanitizePulse(pulse),
      at: now.toISOString(),
    };
  }

  async heartbeat(): Promise<void> {
    if (this.stopped || this.enabled() === false || this.inFlight) return;

    const now = this.now();
    const heartbeatAt = now.toISOString();

    this.inFlight = (async () => {
      await this.options.client.service('tasks').patch(this.options.taskId, {
        last_executor_heartbeat_at: heartbeatAt,
        latest_executor_pulse: this.latestPulse,
      } satisfies Partial<Task>);
    })();

    try {
      await this.inFlight;
    } catch (error) {
      this.warn(
        '[runtime-overseer] Failed to write heartbeat:',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.inFlight = undefined;
    }
  }

  async flush(timeoutMs?: number): Promise<boolean> {
    this.clearTimer();

    if (this.stopped || this.enabled() === false) return true;

    const resolvedTimeoutMs = this.flushTimeoutMs(timeoutMs);
    const inFlight = this.inFlight;
    if (inFlight) {
      const completed = await this.waitFor(
        inFlight.catch(() => {
          // heartbeat() owns warning; flush should not make shutdown fail.
        }),
        resolvedTimeoutMs
      );
      if (!completed) {
        this.warn('[runtime-overseer] Timed out flushing in-flight heartbeat');
        return false;
      }
      while (this.inFlight === inFlight) {
        await Promise.resolve();
      }
    }

    const pulse = this.latestPulse;
    if (!pulse) return true;

    const completed = await this.waitFor(this.flushPulse(pulse), resolvedTimeoutMs);
    if (!completed) {
      this.warn('[runtime-overseer] Timed out flushing runtime pulse');
    }
    return completed;
  }

  private async flushPulse(pulse: PulseSnapshot): Promise<void> {
    try {
      await this.options.client.service('tasks').patch(this.options.taskId, {
        latest_executor_pulse: pulse,
      } satisfies Partial<Task>);
    } catch (error) {
      this.warn(
        '[runtime-overseer] Failed to flush runtime pulse:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private waitFor(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) {
      return promise.then(
        () => true,
        () => true
      );
    }

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);

      promise.then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // The caller deliberately treats flush as best-effort.
          resolve(true);
        }
      );
    });
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private flushTimeoutMs(timeoutMs?: number): number {
    return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? Math.floor(timeoutMs)
      : DEFAULT_FLUSH_TIMEOUT_MS;
  }

  private enabled(): boolean {
    return this.options.enabled ?? true;
  }

  private heartbeatIntervalMs(): number {
    const interval = this.options.heartbeatIntervalMs;
    return typeof interval === 'number' && Number.isFinite(interval) && interval > 0
      ? Math.floor(interval)
      : DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private warn(...args: unknown[]): void {
    (this.options.warn ?? console.warn)(...args);
  }
}

export function sanitizePulse(pulse: Pulse): Pulse {
  const kind = (trimString(pulse.kind, MAX_KIND_LENGTH) ?? 'sdk.unknown') as Pulse['kind'];
  const id = trimString(pulse.id, MAX_ID_LENGTH);
  const label = trimString(pulse.label, MAX_LABEL_LENGTH);

  return {
    kind,
    ...(id ? { id } : {}),
    ...(label ? { label } : {}),
  };
}

function trimString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}
