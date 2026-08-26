import { getAgenticToolIntegration } from '@agor/agentic-tools';
import type { ResolvedSdkWatchdogConfig } from '@agor/core/config';
import type { AgenticToolName, ExecutorPulseKind, SdkHealthFailureInput } from '@agor/core/types';
import { ExecutorPulseDetail } from '@agor/core/types';
import { hasAgorAbortCause, markAgorAbortCause } from './termination-state.js';

export type SdkActivityAdapter = 'claude-code' | 'codex' | 'gemini' | 'copilot';
export type SdkActivityCallback = (kind: ExecutorPulseKind, detail?: string) => void;

export const SDK_ACTIVITY_VERSION_MANIFEST: Record<SdkActivityAdapter, string> = {
  'claude-code': '@anthropic-ai/claude-agent-sdk@0.3.197',
  codex: '@openai/codex-sdk@0.144.0',
  gemini: '@google/gemini-cli-core@0.40.1',
  copilot: '@github/copilot-sdk@0.2.2',
};

export function getSdkActivityVersion(tool: AgenticToolName): string | undefined {
  return (
    getAgenticToolIntegration(tool).sdkVersion ??
    SDK_ACTIVITY_VERSION_MANIFEST[tool as SdkActivityAdapter]
  );
}

const STARTED = new Set([
  'claude-code:system',
  'codex:thread.started',
  'codex:turn.started',
  'codex:event_msg.turn_context',
  'gemini:model_info',
  'copilot:assistant.turn_start',
]);
const WAITING = new Set([
  'claude-code:permission.request',
  'claude-code:user_input.request',
  'copilot:permission.request',
  'copilot:user_input.request',
  'gemini:tool_call_confirmation',
]);
const PROGRESS = new Set([
  'claude-code:assistant',
  'claude-code:stream_event',
  'claude-code:user',
  'claude-code:result',
  'codex:item.started',
  'codex:item.updated',
  'codex:item.completed',
  'codex:turn.completed',
  'codex:event_msg.agent_message',
  'codex:event_msg.task_complete',
  'codex:event_msg.turn_complete',
  'gemini:content',
  'gemini:thought',
  'gemini:tool_call_request',
  'gemini:tool_call_response',
  'gemini:finished',
  'copilot:assistant.message_delta',
  'copilot:assistant.reasoning_delta',
  'copilot:tool.execution_start',
  'copilot:tool.execution_complete',
  'copilot:subagent.started',
  'copilot:subagent.completed',
  'copilot:assistant.turn_end',
]);

/**
 * Coerce a detail into the bounded identifier the daemon accepts.
 *
 * `tasks.reportRuntimeTelemetry` rejects anything outside `[A-Za-z0-9._:/-]`
 * or over 128 bytes with a BadRequest, and the heartbeat re-sends the latest
 * pulse on every beat — so one unsanitized detail would fail every subsequent
 * heartbeat write, not just its own.
 */
export function boundedDetail(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'unknown';
}

/**
 * Which wait a pause belongs to.
 *
 * A pause has no clock of its own, so a pause with no matching resume disables
 * the watchdog for the rest of the query — every producer of a `waiting` pulse
 * owes a resume. Waits are keyed by source rather than pooled into one flag
 * because they overlap: with a single flag, a rate limit clearing would lift the
 * pause held by a permission prompt a human has not answered yet (the watchdog
 * then times out a healthy session, and aborts it under `enforce`), and
 * `permission.resolved` would lift a live multi-hour rate-limit block.
 *
 * `approval` is the catch-all for every pre-existing `waiting` producer —
 * permission prompts, user-input requests, tool-call confirmations — all of
 * which are lifted by `permission.resolved` today and keep that behaviour.
 */
type WaitSource = 'approval' | 'rate_limit';

function waitSource(detail?: string): WaitSource {
  return detail?.startsWith(ExecutorPulseDetail.RATE_LIMIT_PREFIX) ? 'rate_limit' : 'approval';
}

function resumedWaitSource(kind: ExecutorPulseKind, detail?: string): WaitSource | undefined {
  if (kind !== 'sdk_started') return undefined;
  if (detail === ExecutorPulseDetail.RATE_LIMIT_RESOLVED) return 'rate_limit';
  if (detail === ExecutorPulseDetail.PERMISSION_RESOLVED) return 'approval';
  return undefined;
}

export function mapSdkActivity(
  adapter: SdkActivityAdapter,
  discriminator: string
): { kind: ExecutorPulseKind; detail: string } | undefined {
  const detail = boundedDetail(discriminator);
  const key = `${adapter}:${detail}`;
  if (WAITING.has(key)) return { kind: 'waiting', detail };
  if (STARTED.has(key)) return { kind: 'sdk_started', detail };
  if (PROGRESS.has(key)) return { kind: 'progress', detail };
  return { kind: 'unknown_activity', detail };
}

export function reportSdkActivity(
  callback: SdkActivityCallback | undefined,
  adapter: SdkActivityAdapter,
  discriminator: string
): void {
  const pulse = mapSdkActivity(adapter, discriminator);
  if (pulse) callback?.(pulse.kind, pulse.detail);
}

type WatchdogEvidence = Omit<SdkHealthFailureInput, 'task_id'>;
export function markSdkHealthAbort(controller: AbortController): void {
  markAgorAbortCause(controller, 'sdk_health_failure');
  controller.abort();
}

export function isSdkHealthAbort(controller: AbortController): boolean {
  return hasAgorAbortCause(controller, 'sdk_health_failure');
}

interface WatchdogState {
  startedAt?: number;
  lastRawAt?: number;
  firstProgressAt?: number;
  idleAnchor?: number;
  /** When the first still-unlifted wait began; time here is credited back. */
  pausedAt?: number;
  /** Waits currently holding the pause. The policy resumes only when empty. */
  pausedBy: Set<WaitSource>;
  /** Foreground tool calls in flight — these fully suspend the policy. */
  activeToolCount: number;
  /** SDK background tasks in flight — these only relax it (see below). */
  activeBackgroundTaskCount: number;
  unknownCount: number;
  unknownReported: boolean;
}

type WatchdogReason = 'no_first_progress' | 'progress_stalled' | 'unknown_activity';

function inspectSdkWatchdog(
  state: Readonly<WatchdogState>,
  now: number,
  tool: string,
  config: ResolvedSdkWatchdogConfig
): { reason?: WatchdogReason; nextCheckAt?: number } {
  if (
    config.mode === 'disabled' ||
    state.startedAt === undefined ||
    state.pausedAt !== undefined ||
    state.activeToolCount > 0
  ) {
    return {};
  }
  if (state.firstProgressAt === undefined) {
    const firstDeadline = state.startedAt + config.first_progress_timeout_ms;
    const silenceDeadline = (state.lastRawAt ?? state.startedAt) + config.first_progress_timeout_ms;
    if (now >= firstDeadline) {
      if (now >= silenceDeadline) return { reason: 'no_first_progress' };
      if (!state.unknownReported && state.unknownCount > 0) {
        return { reason: 'unknown_activity' };
      }
    }
    return {
      nextCheckAt: now < firstDeadline && !state.unknownReported ? firstDeadline : silenceDeadline,
    };
  }

  if (tool === 'claude-code' && config.claude_idle_timeout_ms !== null) {
    const silenceDeadline =
      (state.lastRawAt ?? state.firstProgressAt) + config.claude_idle_timeout_ms;
    // A background task relaxes the idle policy down to plain SDK silence
    // instead of suspending it: task_progress and forwarded subagent traffic
    // keep a healthy background task alive, while a task ID that leaked (no
    // terminal signal, so it is never accounted as complete) can no longer
    // disarm the one check that would notice the resulting hang.
    const idleDeadline =
      state.activeBackgroundTaskCount > 0
        ? silenceDeadline
        : (state.idleAnchor ?? state.firstProgressAt) + config.claude_idle_timeout_ms;
    if (now >= idleDeadline) {
      if (now >= silenceDeadline) return { reason: 'progress_stalled' };
      if (!state.unknownReported && state.unknownCount > 0) {
        return { reason: 'unknown_activity' };
      }
    }
    return {
      nextCheckAt: now < idleDeadline && !state.unknownReported ? idleDeadline : silenceDeadline,
    };
  }
  return {};
}

export class SdkWatchdog {
  private state: WatchdogState = {
    pausedBy: new Set(),
    activeToolCount: 0,
    activeBackgroundTaskCount: 0,
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
      if (this.state.startedAt !== undefined) {
        this.state.pausedBy.add(waitSource(detail));
        this.state.pausedAt ??= now;
      }
      this.schedule();
      return;
    }
    const pausedAt = this.state.pausedAt;
    if (pausedAt !== undefined) {
      const lifted = resumedWaitSource(kind, detail);
      // Anything that is not this pause's own resume stays suppressed, and a
      // resume for one wait never lifts another's.
      if (lifted === undefined || !this.state.pausedBy.delete(lifted)) return;
      if (this.state.pausedBy.size > 0) {
        this.schedule();
        return;
      }
    }
    const resumed = pausedAt !== undefined;
    if (pausedAt !== undefined) {
      const pausedFor = now - pausedAt;
      for (const key of ['startedAt', 'lastRawAt', 'firstProgressAt', 'idleAnchor'] as const) {
        if (this.state[key] !== undefined) this.state[key]! += pausedFor;
      }
      this.state.pausedAt = undefined;
    }
    this.state.startedAt ??= now;
    if (!resumed) {
      this.state.lastRawAt = now;
    }
    if (kind === 'unknown_activity') this.state.unknownCount++;
    if (kind === 'progress') {
      this.state.firstProgressAt ??= now;
      this.state.idleAnchor = now;
      if (detail === 'tool.start') this.state.activeToolCount++;
      if (detail === 'tool.complete') {
        this.state.activeToolCount = Math.max(0, this.state.activeToolCount - 1);
      }
      if (detail === 'background_task.start') this.state.activeBackgroundTaskCount++;
      if (detail === 'background_task.complete') {
        this.state.activeBackgroundTaskCount = Math.max(
          0,
          this.state.activeBackgroundTaskCount - 1
        );
      }
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
    const { reason } = inspectSdkWatchdog(this.state, now, this.options.tool, this.options.config);
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
    if (this.decided) return;
    const now = this.now();
    const { nextCheckAt } = inspectSdkWatchdog(
      this.state,
      now,
      this.options.tool,
      this.options.config
    );
    if (nextCheckAt === undefined) return;
    this.timer = setTimeout(() => this.check(), Math.max(0, nextCheckAt - now));
    this.timer.unref?.();
  }
}
