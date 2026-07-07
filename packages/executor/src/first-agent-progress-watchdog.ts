import type { AgenticToolName, TaskMetadata } from '@agor/core/types';

const DEFAULT_FIRST_AGENT_PROGRESS_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000;

type TimerHandle = ReturnType<typeof setInterval>;

export interface FirstAgentProgressWatchdogOptions {
  toolName: AgenticToolName;
  abortController: AbortController;
  firstAgentProgressTimeoutMs?: number;
  checkIntervalMs?: number;
  nowMs?: () => number;
}

function envNumber(name: string, fallback: number): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export class FirstAgentProgressWatchdog {
  private readonly firstAgentProgressTimeoutMs: number;
  private readonly checkIntervalMs: number;
  private readonly nowMs: () => number;
  private timer?: TimerHandle;
  private watchdogStartedAtMs?: number;
  private pausedAtMs?: number;
  private lastActivityAtMs?: number;
  private lastActivityLabel?: string;
  private firstProgressSeen = false;
  private checkInFlight = false;
  private stalled = false;
  private stallReason?: string;
  private stalledAtMs?: number;
  private stalledTimeoutMs?: number;

  constructor(private readonly options: FirstAgentProgressWatchdogOptions) {
    this.firstAgentProgressTimeoutMs =
      options.firstAgentProgressTimeoutMs ??
      envNumber('AGOR_AGENT_FIRST_PROGRESS_TIMEOUT_MS', DEFAULT_FIRST_AGENT_PROGRESS_TIMEOUT_MS) ??
      DEFAULT_FIRST_AGENT_PROGRESS_TIMEOUT_MS;
    this.checkIntervalMs =
      options.checkIntervalMs ??
      envNumber('AGOR_AGENT_PROGRESS_WATCHDOG_INTERVAL_MS', DEFAULT_CHECK_INTERVAL_MS) ??
      DEFAULT_CHECK_INTERVAL_MS;
    this.nowMs = options.nowMs ?? Date.now;
  }

  start(): void {
    if (this.timer || this.firstAgentProgressTimeoutMs === 0) return;

    this.watchdogStartedAtMs = this.nowMs();
    this.timer = setInterval(() => {
      void this.check();
    }, this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = undefined;
  }

  markActivity(label: string): void {
    if (this.stalled || this.firstProgressSeen) return;

    this.lastActivityAtMs = this.nowMs();
    this.lastActivityLabel = label;
  }

  markAgentProgress(label: string): void {
    if (this.stalled || this.firstProgressSeen) return;

    const now = this.nowMs();
    this.firstProgressSeen = true;
    this.lastActivityAtMs = now;
    this.lastActivityLabel = label;
    this.stop();
  }

  pause(label: string): void {
    if (this.stalled || this.firstProgressSeen) return;

    const now = this.nowMs();
    this.pausedAtMs = now;
    this.lastActivityAtMs = now;
    this.lastActivityLabel = label;
    this.stop();
  }

  resume(label: string): void {
    if (this.stalled || this.firstProgressSeen || this.firstAgentProgressTimeoutMs === 0) {
      return;
    }

    const now = this.nowMs();
    this.watchdogStartedAtMs = now;
    this.lastActivityAtMs = now;
    this.lastActivityLabel = label;
    this.pausedAtMs = undefined;
    this.start();
  }

  hasStalled(): boolean {
    return this.stalled;
  }

  getStallReason(): string | undefined {
    return this.stallReason;
  }

  getDiagnosticMetadata(nowMs = this.stalledAtMs ?? this.nowMs()): TaskMetadata | undefined {
    if (
      this.watchdogStartedAtMs === undefined ||
      !this.stallReason ||
      this.stalledAtMs === undefined ||
      this.stalledTimeoutMs === undefined
    ) {
      return undefined;
    }

    return {
      first_agent_progress_watchdog: {
        status: 'stalled',
        tool: this.options.toolName,
        reason: this.stallReason,
        watchdog_started_at: toIso(this.watchdogStartedAtMs),
        stalled_at: toIso(this.stalledAtMs),
        last_activity_at:
          this.lastActivityAtMs === undefined ? undefined : toIso(this.lastActivityAtMs),
        last_activity_label: this.lastActivityLabel,
        timeout_ms: this.stalledTimeoutMs,
        elapsed_ms: nowMs - this.watchdogStartedAtMs,
      },
    };
  }

  private async check(): Promise<void> {
    if (
      this.checkInFlight ||
      this.stalled ||
      this.watchdogStartedAtMs === undefined ||
      this.pausedAtMs !== undefined ||
      this.firstProgressSeen
    ) {
      return;
    }

    const now = this.nowMs();
    const timeoutMs = this.firstAgentProgressTimeoutMs;
    const elapsedMs = now - this.watchdogStartedAtMs;

    if (elapsedMs < timeoutMs) return;

    this.checkInFlight = true;
    try {
      await this.markStalled(now, timeoutMs);
    } finally {
      this.checkInFlight = false;
    }
  }

  private async markStalled(now: number, timeoutMs: number): Promise<void> {
    if (this.stalled || this.watchdogStartedAtMs === undefined) return;

    this.stalled = true;
    this.stop();

    const reason = `${this.options.toolName} task startup stalled: no first meaningful agent event within ${timeoutMs}ms after SDK watchdog start.`;
    this.stallReason = reason;
    this.stalledAtMs = now;
    this.stalledTimeoutMs = timeoutMs;

    if (!this.options.abortController.signal.aborted) {
      this.options.abortController.abort(reason);
    }
  }
}

export function startFirstAgentProgressWatchdog(
  options: FirstAgentProgressWatchdogOptions
): FirstAgentProgressWatchdog {
  const watchdog = new FirstAgentProgressWatchdog(options);
  watchdog.start();
  return watchdog;
}
