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
    const firstExpired = now - state.startedAt >= config.first_progress_timeout_ms;
    if (
      firstExpired &&
      now - (state.lastRawAt ?? state.startedAt) >= config.first_progress_timeout_ms
    ) {
      return 'no_first_progress';
    }
    if (firstExpired && !state.unknownReported && state.unknownCount > 0) {
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
  }

  private now(): number {
    return (this.options.now ?? performance.now.bind(performance))();
  }

  private check(): void {
    if (this.decided) return;
    const now = this.now();
    const reason = evaluateSdkWatchdog(this.state, now, this.options.tool, this.options.config);
    if (!reason) {
      this.schedule();
      return;
    }
    const action =
      reason === 'unknown_activity' || this.options.config.mode !== 'enforce'
        ? 'would_fire'
        : 'enforced';
    const evidence: WatchdogEvidence = {
      reason,
      elapsed_ms: Math.max(0, Math.round(now - (this.state.startedAt ?? now))),
      watchdog_action: action,
      unknown_event_count: this.state.unknownCount,
      sdk_version: this.options.sdkVersion,
    };
    if (reason === 'unknown_activity') {
      this.state.unknownReported = true;
      void this.options.onDecision(evidence);
      this.schedule();
      return;
    }
    this.stop();
    void this.options.onDecision(evidence);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const { state } = this;
    const { config, tool } = this.options;
    if (
      this.decided ||
      state.pausedAt !== undefined ||
      state.startedAt === undefined ||
      state.toolActive
    ) {
      return;
    }
    const now = this.now();
    let deadline: number | undefined;
    if (state.firstProgressAt === undefined) {
      const firstDeadline = state.startedAt + config.first_progress_timeout_ms;
      const silenceDeadline =
        (state.lastRawAt ?? state.startedAt) + config.first_progress_timeout_ms;
      deadline = now < firstDeadline && !state.unknownReported ? firstDeadline : silenceDeadline;
    } else if (tool === 'claude-code' && config.claude_idle_timeout_ms !== null) {
      const idleDeadline =
        (state.idleAnchor ?? state.firstProgressAt) + config.claude_idle_timeout_ms;
      deadline =
        now < idleDeadline && !state.unknownReported
          ? idleDeadline
          : (state.lastRawAt ?? state.firstProgressAt) + config.claude_idle_timeout_ms;
    }
    if (deadline === undefined) return;
    this.timer = setTimeout(() => this.check(), Math.max(0, deadline - now));
    this.timer.unref?.();
  }
}
