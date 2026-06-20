import type { AgenticToolName, TaskID, TaskMetadata } from '@agor/core/types';

const DEFAULT_FIRST_AGENT_PROGRESS_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000;

type TimerHandle = ReturnType<typeof setInterval>;

export interface AgentProgressWatchdogOptions {
  taskId: TaskID;
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

export class AgentProgressWatchdog {
  private readonly firstAgentProgressTimeoutMs: number;
  private readonly checkIntervalMs: number;
  private readonly nowMs: () => number;
  private timer?: TimerHandle;
  private startedAtMs?: number;
  private pausedAtMs?: number;
  private lastActivityAtMs?: number;
  private lastActivityLabel?: string;
  private lastAgentProgressAtMs?: number;
  private lastAgentProgressLabel?: string;
  private checkInFlight = false;
  private stalled = false;
  private stallReason?: string;
  private stalledAtMs?: number;
  private stalledTimeoutMs?: number;

  constructor(private readonly options: AgentProgressWatchdogOptions) {
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

    this.startedAtMs = this.nowMs();
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
    if (this.stalled) return;

    this.lastActivityAtMs = this.nowMs();
    this.lastActivityLabel = label;
  }

  markAgentProgress(label: string): void {
    if (this.stalled) return;

    const now = this.nowMs();
    this.lastActivityAtMs = now;
    this.lastActivityLabel = label;
    this.lastAgentProgressAtMs = now;
    this.lastAgentProgressLabel = label;
    this.stop();
  }

  pause(label: string): void {
    if (this.stalled || this.lastAgentProgressAtMs !== undefined) return;

    const now = this.nowMs();
    this.pausedAtMs = now;
    this.lastActivityAtMs = now;
    this.lastActivityLabel = label;
    this.stop();
  }

  resume(label: string): void {
    if (
      this.stalled ||
      this.lastAgentProgressAtMs !== undefined ||
      this.firstAgentProgressTimeoutMs === 0
    ) {
      return;
    }

    const now = this.nowMs();
    this.startedAtMs = now;
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
    if (!this.startedAtMs || !this.stallReason || !this.stalledAtMs || !this.stalledTimeoutMs) {
      return undefined;
    }

    return {
      agent_progress_watchdog: {
        status: 'stalled',
        tool: this.options.toolName,
        reason: this.stallReason,
        started_at: toIso(this.startedAtMs),
        stalled_at: toIso(this.stalledAtMs),
        first_progress_seen: this.lastAgentProgressAtMs !== undefined,
        last_progress_at: this.lastAgentProgressAtMs
          ? toIso(this.lastAgentProgressAtMs)
          : undefined,
        last_progress_label: this.lastAgentProgressLabel,
        last_activity_at: this.lastActivityAtMs ? toIso(this.lastActivityAtMs) : undefined,
        last_activity_label: this.lastActivityLabel,
        timeout_ms: this.stalledTimeoutMs,
        elapsed_ms: nowMs - this.startedAtMs,
      },
    };
  }

  private async check(): Promise<void> {
    if (
      this.checkInFlight ||
      this.stalled ||
      !this.startedAtMs ||
      this.pausedAtMs !== undefined ||
      this.lastAgentProgressAtMs !== undefined
    ) {
      return;
    }

    const now = this.nowMs();
    const timeoutMs = this.firstAgentProgressTimeoutMs;
    const elapsedMs = now - this.startedAtMs;

    if (elapsedMs < timeoutMs) return;

    this.checkInFlight = true;
    try {
      await this.markStalled(now, timeoutMs);
    } finally {
      this.checkInFlight = false;
    }
  }

  private async markStalled(now: number, timeoutMs: number): Promise<void> {
    if (this.stalled || !this.startedAtMs) return;

    this.stalled = true;
    this.stop();

    const reason = `${this.options.toolName} task stalled: no agent progress within ${timeoutMs}ms after executor start.`;
    this.stallReason = reason;
    this.stalledAtMs = now;
    this.stalledTimeoutMs = timeoutMs;

    if (!this.options.abortController.signal.aborted) {
      this.options.abortController.abort(reason);
    }
  }
}

export function startAgentProgressWatchdog(
  options: AgentProgressWatchdogOptions
): AgentProgressWatchdog {
  const watchdog = new AgentProgressWatchdog(options);
  watchdog.start();
  return watchdog;
}
