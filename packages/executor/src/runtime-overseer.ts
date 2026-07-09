import type { Pulse, PulseSnapshot, Task, TaskID } from '@agor/core/types';
import type { AgorClient } from './services/feathers-client.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_RECENT_PULSES = 10;
const MAX_ID_LENGTH = 160;
const MAX_LABEL_LENGTH = 120;
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_STRING_LENGTH = 200;
const SENSITIVE_METADATA_KEY =
  /(?:api[_-]?key|authorization|bearer|credential|password|secret|token)/i;
const DEFAULT_FLUSH_TIMEOUT_MS = 3_000;

type InternalPulseSnapshot = PulseSnapshot & {
  atMs: number;
};

export interface RuntimeTimeout {
  rule: 'no_runtime_pulse';
  message: string;
  elapsed_ms: number;
  latest_pulse?: PulseSnapshot;
  recent_pulses: PulseSnapshot[];
}

export interface AgenticToolRuntime {
  pulse(pulse: Pulse): void;
}

export interface RuntimeOverseerOptions {
  client: AgorClient;
  taskId: TaskID | string;
  enabled?: boolean;
  heartbeatIntervalMs?: number;
  noPulseTimeoutMs?: number;
  maxRecentPulses?: number;
  abortController?: AbortController;
  onTimeout?: (timeout: RuntimeTimeout) => Promise<void>;
  now?: () => Date;
  warn?: (...args: unknown[]) => void;
}

export interface RuntimeOverseerHandle {
  stop(): void;
}

export interface RuntimeOverseerFlushOptions {
  timeoutMs?: number;
  stopTimer?: boolean;
}

export class RuntimeOverseer implements AgenticToolRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private latestPulse?: InternalPulseSnapshot;
  private recentPulses: InternalPulseSnapshot[] = [];
  private stopped = false;
  private timedOut = false;
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
    if (this.stopped || this.timedOut) return;

    const now = this.now();
    const snapshot: InternalPulseSnapshot = {
      ...sanitizePulse(pulse),
      at: now.toISOString(),
      atMs: now.getTime(),
    };

    this.latestPulse = snapshot;
    this.recentPulses.push(snapshot);

    const max = this.maxRecentPulses();
    while (this.recentPulses.length > max) {
      this.recentPulses.shift();
    }
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

      await this.checkTimeouts(now);
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

  async checkTimeouts(now = this.now()): Promise<void> {
    if (!this.options.noPulseTimeoutMs || this.timedOut) return;

    const latest = this.latestPulse;
    if (!latest) return;

    const elapsedMs = now.getTime() - latest.atMs;
    if (elapsedMs <= this.options.noPulseTimeoutMs) return;

    await this.timeout({
      rule: 'no_runtime_pulse',
      message: `No runtime pulse for ${formatDuration(elapsedMs)}. Last pulse: ${latest.kind}${latest.label ? ` (${latest.label})` : ''}.`,
      elapsed_ms: elapsedMs,
      latest_pulse: stripInternalPulse(latest),
      recent_pulses: this.recentPulses.map(stripInternalPulse),
    });
  }

  snapshotForHeartbeat(
    heartbeatAt = this.now().toISOString()
  ): NonNullable<Task['executor_runtime']> {
    return {
      heartbeat_at: heartbeatAt,
      latest_pulse: this.latestPulse ? stripInternalPulse(this.latestPulse) : undefined,
    };
  }

  recentPulseSnapshots(): PulseSnapshot[] {
    return this.recentPulses.map(stripInternalPulse);
  }

  private async timeout(timeout: RuntimeTimeout): Promise<void> {
    if (this.timedOut) return;
    this.timedOut = true;

    this.warn('[runtime-overseer] Timeout:', timeout.message);
    this.options.abortController?.abort(timeout.message);
    await this.options.onTimeout?.(timeout);
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

  private maxRecentPulses(): number {
    const max = this.options.maxRecentPulses;
    return typeof max === 'number' && Number.isFinite(max) && max > 0
      ? Math.floor(max)
      : DEFAULT_MAX_RECENT_PULSES;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private warn(...args: unknown[]): void {
    (this.options.warn ?? console.warn)(...args);
  }
}

export function sanitizePulse(pulse: Pulse): Pulse {
  return {
    kind: typeof pulse.kind === 'string' && pulse.kind.length > 0 ? pulse.kind : 'sdk.unknown',
    ...(trimString(pulse.id, MAX_ID_LENGTH) ? { id: trimString(pulse.id, MAX_ID_LENGTH) } : {}),
    ...(trimString(pulse.label, MAX_LABEL_LENGTH)
      ? { label: trimString(pulse.label, MAX_LABEL_LENGTH) }
      : {}),
    ...(pulse.metadata ? { metadata: sanitizeMetadata(pulse.metadata) } : {}),
  };
}

export function stripInternalPulse(snapshot: InternalPulseSnapshot): PulseSnapshot {
  const { atMs: _atMs, ...pulse } = snapshot;
  return pulse;
}

function sanitizeMetadata(metadata: Pulse['metadata']): NonNullable<Pulse['metadata']> {
  if (!metadata) return {};

  const sanitized: NonNullable<Pulse['metadata']> = {};
  for (const [rawKey, value] of Object.entries(metadata).slice(0, MAX_METADATA_KEYS)) {
    const key = trimString(rawKey, MAX_METADATA_KEY_LENGTH);
    if (!key || SENSITIVE_METADATA_KEY.test(key)) continue;

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

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}
