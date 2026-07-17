import type { ResolvedSdkWatchdogConfig } from '@agor/core/config';
import type { ExecutorPulseKind, SdkHealthFailureInput } from '@agor/core/types';

type WatchdogEvidence = Omit<SdkHealthFailureInput, 'task_id'>;
type AbortControllerWithCause = AbortController & { agorAbortCause?: string };

export function markSdkHealthAbort(controller: AbortController): void {
  (controller as AbortControllerWithCause).agorAbortCause = 'sdk_health_failure';
  controller.abort();
}

export function isSdkHealthAbort(controller: AbortController): boolean {
  return (controller as AbortControllerWithCause).agorAbortCause === 'sdk_health_failure';
}

interface WatchdogState {
  startedAt?: number;
  lastRawAt?: number;
  firstProgressAt?: number;
  idleAnchor?: number;
  pausedAt?: number;
  toolActive: boolean;
  unknownCount: number;
  unknownReported: boolean;
}

export function evaluateSdkWatchdog(
  state: Readonly<WatchdogState>,
  now: number,
  tool: string,
  config: ResolvedSdkWatchdogConfig
): 'no_first_progress' | 'progress_stalled' | 'unknown_activity' | undefined {
  if (
    config.mode === 'disabled' ||
    state.startedAt === undefined ||
    state.pausedAt !== undefined ||
    state.toolActive
  ) {
    return undefined;
  }
  if (state.firstProgressAt === undefined) {
    if (
      now - state.startedAt >= config.first_progress_timeout_ms &&
      now - (state.lastRawAt ?? state.startedAt) >= config.first_progress_timeout_ms
    ) {
      return 'no_first_progress';
    }
    if (
      !state.unknownReported &&
      state.unknownCount > 0 &&
      now - state.startedAt >= config.first_progress_timeout_ms
    ) {
      return 'unknown_activity';
    }
    return undefined;
  }
  if (
    tool === 'claude-code' &&
    config.claude_idle_timeout_ms !== null &&
    now - (state.idleAnchor ?? state.firstProgressAt) >= config.claude_idle_timeout_ms
  ) {
    if (now - (state.lastRawAt ?? state.firstProgressAt) >= config.claude_idle_timeout_ms) {
      return 'progress_stalled';
    }
    if (!state.unknownReported && state.unknownCount > 0) return 'unknown_activity';
  }
  return undefined;
}

export class SdkWatchdog {
  private state: WatchdogState = {
    toolActive: false,
    unknownCount: 0,
    unknownReported: false,
  };
  private timer?: ReturnType<typeof setTimeout>;
  private decided = false;

  constructor(
    private readonly options: {
      tool: string;
      config: ResolvedSdkWatchdogConfig;
      sdkVersion?: string;
      onDecision(evidence: WatchdogEvidence): void | Promise<void>;
      now?: () => number;
    }
  ) {}

  record(kind: ExecutorPulseKind, detail?: string): void {
    if (this.decided || this.options.config.mode === 'disabled') return;
    const now = this.now();
    if (kind === 'waiting') {
      if (this.state.startedAt !== undefined && this.state.pausedAt === undefined) {
        this.state.pausedAt = now;
      }
      this.schedule();
      return;
    }
    const pausedAt = this.state.pausedAt;
    const resumed = pausedAt !== undefined;
    if (pausedAt !== undefined) {
      const pausedFor = now - pausedAt;
      for (const key of ['startedAt', 'lastRawAt', 'firstProgressAt', 'idleAnchor'] as const) {
        if (this.state[key] !== undefined) this.state[key]! += pausedFor;
      }
      this.state.pausedAt = undefined;
    }
    this.state.startedAt ??= now;
    if (!(resumed && kind === 'sdk_started' && detail === 'permission.resolved')) {
      this.state.lastRawAt = now;
    }
    if (kind === 'unknown_activity') this.state.unknownCount++;
    if (kind === 'progress') {
      this.state.firstProgressAt ??= now;
      this.state.idleAnchor = now;
      if (detail === 'tool.start') this.state.toolActive = true;
      if (detail === 'tool.complete' || detail === 'tool.error') this.state.toolActive = false;
    }
    this.check();
  }

  stop(): void {
    this.decided = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private now(): number {
    return (this.options.now ?? performance.now.bind(performance))();
  }

  private check(): void {
    if (this.decided) return;
    const now = this.now();
    const reason = evaluateSdkWatchdog(this.state, now, this.options.tool, this.options.config);
    if (reason === 'unknown_activity') {
      this.state.unknownReported = true;
      void this.options.onDecision(this.evidence(reason, now, 'would_fire'));
      this.schedule();
      return;
    }
    if (reason) {
      this.stop();
      void this.options.onDecision(
        this.evidence(
          reason,
          now,
          this.options.config.mode === 'enforce' ? 'enforced' : 'would_fire'
        )
      );
      return;
    }
    this.schedule();
  }

  private evidence(
    reason: WatchdogEvidence['reason'],
    now: number,
    watchdog_action: NonNullable<WatchdogEvidence['watchdog_action']>
  ): WatchdogEvidence {
    return {
      reason,
      elapsed_ms: Math.max(0, Math.round(now - (this.state.startedAt ?? now))),
      watchdog_action,
      unknown_event_count: this.state.unknownCount,
      sdk_version: this.options.sdkVersion,
    };
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (
      this.decided ||
      this.state.pausedAt !== undefined ||
      this.state.startedAt === undefined ||
      this.state.toolActive
    ) {
      return;
    }
    const now = this.now();
    let deadline: number | undefined;
    if (this.state.firstProgressAt === undefined) {
      const firstDeadline = this.state.startedAt + this.options.config.first_progress_timeout_ms;
      const silenceDeadline =
        (this.state.lastRawAt ?? this.state.startedAt) +
        this.options.config.first_progress_timeout_ms;
      deadline =
        now < firstDeadline && !this.state.unknownReported ? firstDeadline : silenceDeadline;
    } else if (
      this.options.tool === 'claude-code' &&
      this.options.config.claude_idle_timeout_ms !== null
    ) {
      const idleDeadline =
        (this.state.idleAnchor ?? this.state.firstProgressAt) +
        this.options.config.claude_idle_timeout_ms;
      deadline =
        now < idleDeadline && !this.state.unknownReported
          ? idleDeadline
          : (this.state.lastRawAt ?? this.state.firstProgressAt) +
            this.options.config.claude_idle_timeout_ms;
    }
    if (deadline === undefined) return;
    this.timer = setTimeout(() => this.check(), Math.max(0, deadline - now));
    this.timer.unref?.();
  }
}
