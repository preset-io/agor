import type { Pulse, PulseSnapshot, Task, TaskID } from '@agor/core/types';
import type { AgorClient } from './services/feathers-client.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_KIND_LENGTH = 120;
const MAX_ID_LENGTH = 160;
const MAX_LABEL_LENGTH = 120;
const MAX_METADATA_STRING_LENGTH = 200;
const SAFE_METADATA_KEYS = new Set(['event', 'status', 'type']);
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

export interface RuntimeOverseerFlushOptions {
  timeoutMs?: number;
  stopTimer?: boolean;
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
        executor_runtime: this.snapshotForHeartbeat(heartbeatAt),
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

  async flush(options: RuntimeOverseerFlushOptions = {}): Promise<boolean> {
    if (options.stopTimer) {
      this.clearTimer();
    }

    const timeoutMs = this.flushTimeoutMs(options.timeoutMs);
    const inFlight = this.inFlight;
    if (inFlight) {
      const completed = await this.waitFor(
        inFlight.catch(() => {
          // heartbeat() owns warning; flush should not make shutdown fail.
        }),
        timeoutMs
      );
      if (!completed) {
        this.warn('[runtime-overseer] Timed out flushing in-flight heartbeat');
        return false;
      }
      while (this.inFlight === inFlight) {
        await Promise.resolve();
      }
    }

    const completed = await this.waitFor(this.heartbeat(), timeoutMs);
    if (!completed) {
      this.warn('[runtime-overseer] Timed out flushing heartbeat');
    }
    return completed;
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
      timer.unref?.();

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

  snapshotForHeartbeat(
    heartbeatAt = this.now().toISOString()
  ): NonNullable<Task['executor_runtime']> {
    return {
      heartbeat_at: heartbeatAt,
      latest_pulse: this.latestPulse,
    };
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
  const metadata = pulse.metadata ? sanitizeMetadata(pulse.metadata) : undefined;

  return {
    kind,
    ...(id ? { id } : {}),
    ...(label ? { label } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function sanitizeMetadata(metadata: Pulse['metadata']): NonNullable<Pulse['metadata']> {
  if (!metadata) return {};

  const sanitized: NonNullable<Pulse['metadata']> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;

    if (typeof value === 'string') {
      sanitized[key] =
        value.length > MAX_METADATA_STRING_LENGTH
          ? value.slice(0, MAX_METADATA_STRING_LENGTH)
          : value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = value;
    } else if (typeof value === 'boolean' || value === null) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function trimString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}
