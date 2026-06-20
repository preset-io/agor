import type { AgenticToolName, TaskID, TaskMetadata } from '@agor/core/types';
import type { AgorClient } from './services/feathers-client.js';

const DEFAULT_FIRST_PROGRESS_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_PROGRESS_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000;

type TimerHandle = ReturnType<typeof setInterval>;

export interface AgentProgressWatchdogOptions {
  client: Pick<AgorClient, 'service'>;
  taskId: TaskID;
  toolName: AgenticToolName;
  abortController: AbortController;
  firstProgressTimeoutMs?: number;
  idleProgressTimeoutMs?: number;
  checkIntervalMs?: number;
  nowMs?: () => number;
}

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export class AgentProgressWatchdog {
  private readonly firstProgressTimeoutMs: number;
  private readonly idleProgressTimeoutMs: number;
  private readonly checkIntervalMs: number;
  private readonly nowMs: () => number;
  private timer?: TimerHandle;
  private startedAtMs?: number;
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
    this.firstProgressTimeoutMs =
      options.firstProgressTimeoutMs ??
      envNumber('AGOR_AGENT_PROGRESS_FIRST_TIMEOUT_MS', DEFAULT_FIRST_PROGRESS_TIMEOUT_MS);
    this.idleProgressTimeoutMs =
      options.idleProgressTimeoutMs ??
      envNumber('AGOR_AGENT_PROGRESS_IDLE_TIMEOUT_MS', DEFAULT_IDLE_PROGRESS_TIMEOUT_MS);
    this.checkIntervalMs =
      options.checkIntervalMs ??
      envNumber('AGOR_AGENT_PROGRESS_WATCHDOG_INTERVAL_MS', DEFAULT_CHECK_INTERVAL_MS);
    this.nowMs = options.nowMs ?? Date.now;
  }

  start(): void {
    if (this.timer) return;

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
        elapsed_ms: nowMs - (this.lastAgentProgressAtMs ?? this.startedAtMs),
      },
    };
  }

  private async check(): Promise<void> {
    if (this.checkInFlight || this.stalled || !this.startedAtMs) return;

    const now = this.nowMs();
    const hasAgentProgress = this.lastAgentProgressAtMs !== undefined;
    const referenceAtMs = this.lastAgentProgressAtMs ?? this.startedAtMs;
    const timeoutMs = hasAgentProgress ? this.idleProgressTimeoutMs : this.firstProgressTimeoutMs;
    const elapsedMs = now - referenceAtMs;

    if (elapsedMs < timeoutMs) return;

    this.checkInFlight = true;
    try {
      await this.markStalled(now, timeoutMs, hasAgentProgress);
    } finally {
      this.checkInFlight = false;
    }
  }

  private async markStalled(now: number, timeoutMs: number, hadProgress: boolean): Promise<void> {
    if (this.stalled || !this.startedAtMs) return;

    this.stalled = true;
    this.stop();

    const reason = hadProgress
      ? `${this.options.toolName} task stalled: no agent progress for ${timeoutMs}ms after ${this.lastAgentProgressLabel ?? 'last progress'}.`
      : `${this.options.toolName} task stalled: no agent progress within ${timeoutMs}ms after executor start.`;
    this.stallReason = reason;
    this.stalledAtMs = now;
    this.stalledTimeoutMs = timeoutMs;
    const metadata = this.getDiagnosticMetadata(now);

    try {
      await this.options.client.service('tasks').patch(this.options.taskId, {
        status: 'failed',
        completed_at: toIso(now),
        error_message: reason,
        metadata,
      });
    } catch (error) {
      console.error(`[${this.options.toolName}] Failed to mark task stalled:`, error);
    }

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
