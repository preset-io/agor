import type { ExecutorPulseKind, SdkHealthFailureInput } from '@agor/core/types';
import { hasAgorAbortCause, markAgorAbortCause } from './termination-state.js';

export type SdkActivityAdapter = 'claude-code' | 'gemini' | 'copilot' | 'opencode' | 'cursor';
type SdkVersionAdapter = SdkActivityAdapter | 'codex';
export type SdkActivityCallback = (kind: ExecutorPulseKind, detail?: string) => void;

export const SDK_ACTIVITY_VERSION_MANIFEST: Record<SdkVersionAdapter, string> = {
  'claude-code': '@anthropic-ai/claude-agent-sdk@0.3.197',
  codex: '@openai/codex-sdk@0.144.0',
  gemini: '@google/gemini-cli-core@0.31.0',
  copilot: '@github/copilot-sdk@0.2.2',
  opencode: '@opencode-ai/sdk@1.14.33',
  cursor: '@cursor/sdk@1.0.23',
};

export function getSdkActivityVersion(adapter: string): string | undefined {
  return SDK_ACTIVITY_VERSION_MANIFEST[adapter as SdkVersionAdapter];
}

const STARTED = new Set([
  'claude-code:system',
  'gemini:model_info',
  'copilot:assistant.turn_start',
]);
const WAITING = new Set([
  'claude-code:permission.request',
  'claude-code:user_input.request',
  'copilot:permission.request',
  'copilot:user_input.request',
  'gemini:tool_call_confirmation',
  'opencode:permission.asked',
  'opencode:permission.updated',
]);
const PROGRESS = new Set([
  'claude-code:assistant',
  'claude-code:stream_event',
  'claude-code:user',
  'claude-code:result',
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
  'opencode:message.updated',
  'opencode:message.part.updated',
  'opencode:session.status',
  'cursor:assistant',
  'cursor:thinking',
  'cursor:tool_call',
  'cursor:status',
  'cursor:system',
  'cursor:request',
  'cursor:task',
  'cursor:user',
]);

function boundedDetail(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'unknown';
}

export function mapSdkActivity(
  adapter: SdkActivityAdapter,
  discriminator: string
): { kind: ExecutorPulseKind; detail: string } | undefined {
  if (adapter === 'opencode' && discriminator === 'server.heartbeat') return undefined;

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
  pausedAt?: number;
  unknownCount: number;
  unknownReported: boolean;
}

type WatchdogReason = 'no_first_progress' | 'progress_stalled' | 'unknown_activity';

function inspectSdkWatchdog(
  state: Readonly<WatchdogState>,
  now: number,
  mode: 'disabled' | 'observe' | 'enforce',
  firstProgressTimeoutMs: number,
  idleTimeoutMs: number | null
): { reason?: WatchdogReason; nextCheckAt?: number } {
  if (mode === 'disabled' || state.startedAt === undefined || state.pausedAt !== undefined) {
    return {};
  }
  if (state.firstProgressAt === undefined) {
    const firstDeadline = state.startedAt + firstProgressTimeoutMs;
    const silenceDeadline = (state.lastRawAt ?? state.startedAt) + firstProgressTimeoutMs;
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

  if (idleTimeoutMs !== null) {
    const idleDeadline = (state.idleAnchor ?? state.firstProgressAt) + idleTimeoutMs;
    const silenceDeadline = (state.lastRawAt ?? state.firstProgressAt) + idleTimeoutMs;
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
    unknownCount: 0,
    unknownReported: false,
  };
  private timer?: ReturnType<typeof setTimeout>;
  private decided = false;

  constructor(
    private readonly options: {
      mode: 'disabled' | 'observe' | 'enforce';
      firstProgressTimeoutMs: number;
      idleTimeoutMs: number | null;
      sdkVersion?: string;
      onDecision(evidence: WatchdogEvidence): void | Promise<void>;
      now?: () => number;
    }
  ) {}

  record(kind: ExecutorPulseKind, detail?: string): void {
    if (this.decided || this.options.mode === 'disabled') return;
    const now = this.now();
    if (kind === 'waiting') {
      if (this.state.startedAt !== undefined && this.state.pausedAt === undefined) {
        this.state.pausedAt = now;
      }
      this.schedule();
      return;
    }
    const pausedAt = this.state.pausedAt;
    const resumed =
      pausedAt !== undefined &&
      kind === 'sdk_started' &&
      (detail === 'permission.resolved' || detail === 'permission.timeout');
    if (pausedAt !== undefined && !resumed) return;
    if (pausedAt !== undefined) {
      const pausedFor = now - pausedAt;
      for (const key of ['startedAt', 'lastRawAt', 'firstProgressAt', 'idleAnchor'] as const) {
        if (this.state[key] !== undefined) this.state[key]! += pausedFor;
      }
      this.state.pausedAt = undefined;
    }
    this.state.startedAt ??= now;
    if (!resumed) this.state.lastRawAt = now;
    if (kind === 'unknown_activity') this.state.unknownCount++;
    if (kind === 'progress') {
      this.state.firstProgressAt ??= now;
      this.state.idleAnchor = now;
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
    const { reason } = inspectSdkWatchdog(
      this.state,
      now,
      this.options.mode,
      this.options.firstProgressTimeoutMs,
      this.options.idleTimeoutMs
    );
    if (!reason) {
      this.schedule();
      return;
    }
    const action =
      reason === 'unknown_activity' || this.options.mode !== 'enforce' ? 'would_fire' : 'enforced';
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
      this.options.mode,
      this.options.firstProgressTimeoutMs,
      this.options.idleTimeoutMs
    );
    if (nextCheckAt === undefined) return;
    this.timer = setTimeout(() => this.check(), Math.max(0, nextCheckAt - now));
    this.timer.unref?.();
  }
}
