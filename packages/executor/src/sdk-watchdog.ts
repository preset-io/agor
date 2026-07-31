import { getAgenticToolIntegration } from '@agor/agentic-tools';
import type { ResolvedSdkWatchdogConfig } from '@agor/core/config';
import type { AgenticToolName, ExecutorPulseKind, SdkHealthFailureInput } from '@agor/core/types';
import { isSdkHealthFailureAbort, markSdkHealthFailureAbort } from './termination-state.js';

export type SdkActivityAdapter =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'copilot'
  | 'opencode'
  | 'cursor';

export type RuntimeActivity =
  | { type: 'sdk_started'; detail?: string }
  | { type: 'progress'; detail?: string }
  | { type: 'unknown_activity'; detail: string }
  | {
      type: 'operation_started';
      id: string;
      kind: string;
      quietTimeoutMs?: number;
      absoluteTimeoutMs?: number;
    }
  | { type: 'operation_progress'; id: string }
  | { type: 'operation_finished'; id: string; outcome?: string }
  | { type: 'waiting_started'; id: string; reason: string; absoluteTimeoutMs: number }
  | { type: 'waiting_finished'; id: string; outcome?: string };

export type SdkActivityCallback = (activity: RuntimeActivity) => void;

export const SDK_ACTIVITY_VERSION_MANIFEST: Record<SdkActivityAdapter, string> = {
  'claude-code': '@anthropic-ai/claude-agent-sdk@0.3.197',
  codex: '@openai/codex-sdk@0.144.0',
  gemini: '@google/gemini-cli-core@0.40.1',
  copilot: '@github/copilot-sdk@0.2.2',
  opencode: '@opencode-ai/sdk@1.14.33',
  cursor: '@cursor/sdk@1.0.23',
};

export function getSdkActivityVersion(tool: AgenticToolName): string | undefined {
  return (
    getAgenticToolIntegration(tool).sdkVersion ??
    SDK_ACTIVITY_VERSION_MANIFEST[tool as SdkActivityAdapter]
  );
}

function boundedDetail(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'unknown';
}

export function activityToPulse(activity: RuntimeActivity): {
  kind: ExecutorPulseKind;
  detail?: string;
} {
  switch (activity.type) {
    case 'sdk_started':
      return {
        kind: 'sdk_started',
        ...(activity.detail ? { detail: boundedDetail(activity.detail) } : {}),
      };
    case 'progress':
      return {
        kind: 'progress',
        ...(activity.detail ? { detail: boundedDetail(activity.detail) } : {}),
      };
    case 'unknown_activity':
      return { kind: 'unknown_activity', detail: boundedDetail(activity.detail) };
    case 'waiting_started':
      return { kind: 'waiting', detail: boundedDetail(activity.reason) };
    case 'waiting_finished':
      return { kind: 'sdk_started', detail: 'waiting.finished' };
    case 'operation_started':
      return { kind: 'progress', detail: boundedDetail(`${activity.kind}.started`) };
    case 'operation_progress':
      return { kind: 'progress', detail: 'operation.progress' };
    case 'operation_finished':
      return { kind: 'progress', detail: 'operation.finished' };
  }
}

type WatchdogEvidence = Omit<SdkHealthFailureInput, 'task_id'>;

export function markSdkHealthAbort(controller: AbortController): void {
  markSdkHealthFailureAbort(controller);
  controller.abort();
}

export function isSdkHealthAbort(controller: AbortController): boolean {
  return isSdkHealthFailureAbort(controller);
}

interface ActiveOperation {
  id: string;
  kind: string;
  startedAt: number;
  lastProgressAt: number;
  quietTimeoutMs: number;
  absoluteTimeoutMs: number;
}

interface ActiveWait {
  id: string;
  startedAt: number;
  absoluteTimeoutMs: number;
}

interface WatchdogState {
  startedAt?: number;
  firstProgressAt?: number;
  idleAnchor?: number;
  pausedAt?: number;
  unknownCount: number;
  unknownReported: boolean;
  operations: Map<string, ActiveOperation>;
  waits: Map<string, ActiveWait>;
}

type WatchdogReason = Exclude<WatchdogEvidence['reason'], undefined>;

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export class SdkWatchdog {
  private readonly state: WatchdogState = {
    unknownCount: 0,
    unknownReported: false,
    operations: new Map(),
    waits: new Map(),
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

  record(activity: RuntimeActivity): RuntimeActivity {
    if (this.decided || this.options.config.mode === 'disabled') return activity;
    const now = this.now();

    if (activity.type === 'waiting_started') {
      this.state.startedAt ??= now;
      if (!this.state.waits.has(activity.id)) {
        this.state.waits.set(activity.id, {
          id: activity.id,
          startedAt: now,
          absoluteTimeoutMs: positiveTimeout(activity.absoluteTimeoutMs, 1),
        });
      }
      this.state.pausedAt ??= now;
      this.check();
      return activity;
    }

    if (activity.type === 'waiting_finished') {
      if (!this.state.waits.has(activity.id)) {
        const unknown = this.recordUnknown(`waiting_finished:${activity.id}`, now);
        this.check();
        return unknown;
      }
      this.state.waits.delete(activity.id);
      if (this.state.waits.size === 0 && this.state.pausedAt !== undefined) {
        const pausedFor = now - this.state.pausedAt;
        for (const key of ['startedAt', 'firstProgressAt', 'idleAnchor'] as const) {
          if (this.state[key] !== undefined) this.state[key]! += pausedFor;
        }
        for (const operation of this.state.operations.values()) {
          operation.lastProgressAt += pausedFor;
        }
        this.state.pausedAt = undefined;
      }
      this.check();
      return activity;
    }

    this.state.startedAt ??= now;
    switch (activity.type) {
      case 'sdk_started':
        break;
      case 'unknown_activity':
        this.recordUnknown(activity.detail, now);
        break;
      case 'progress':
        this.recordProgress(now);
        break;
      case 'operation_started': {
        this.recordProgress(now);
        const existing = this.state.operations.get(activity.id);
        if (existing) {
          existing.lastProgressAt = now;
          break;
        }
        const quietTimeoutMs = positiveTimeout(
          activity.quietTimeoutMs,
          this.defaultOperationQuietTimeoutMs()
        );
        const absoluteTimeoutMs = positiveTimeout(
          activity.absoluteTimeoutMs,
          this.options.config.operation_absolute_timeout_ms
        );
        this.state.operations.set(activity.id, {
          id: activity.id,
          kind: activity.kind,
          startedAt: now,
          lastProgressAt: now,
          quietTimeoutMs,
          absoluteTimeoutMs,
        });
        break;
      }
      case 'operation_progress': {
        const operation = this.state.operations.get(activity.id);
        if (!operation) {
          const unknown = this.recordUnknown(`operation_progress:${activity.id}`, now);
          this.check();
          return unknown;
        }
        operation.lastProgressAt = now;
        this.recordProgress(now);
        break;
      }
      case 'operation_finished':
        if (!this.state.operations.has(activity.id)) {
          const unknown = this.recordUnknown(`operation_finished:${activity.id}`, now);
          this.check();
          return unknown;
        }
        this.state.operations.delete(activity.id);
        this.recordProgress(now);
        break;
    }
    this.check();
    return activity;
  }

  stop(): void {
    this.decided = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private recordProgress(now: number): void {
    this.state.firstProgressAt ??= now;
    this.state.idleAnchor = now;
  }

  private recordUnknown(detail: string, now: number): RuntimeActivity {
    this.state.unknownCount += 1;
    if (!this.state.unknownReported) {
      this.state.unknownReported = true;
      this.emitDecision('unknown_activity', now, false);
    }
    return { type: 'unknown_activity', detail };
  }

  private defaultOperationQuietTimeoutMs(): number {
    if (this.options.tool === 'claude-code') {
      return (
        this.options.config.claude_idle_timeout_ms ??
        this.options.config.operation_absolute_timeout_ms
      );
    }
    if (this.options.tool === 'codex') {
      return (
        this.options.config.codex_idle_timeout_ms ??
        this.options.config.operation_absolute_timeout_ms
      );
    }
    return this.options.config.operation_absolute_timeout_ms;
  }

  private now(): number {
    return (this.options.now ?? performance.now.bind(performance))();
  }

  private check(): void {
    if (this.decided) return;
    const now = this.now();
    let reason: WatchdogReason | undefined;
    let nextCheckAt: number | undefined;

    for (const wait of this.state.waits.values()) {
      const deadline = wait.startedAt + wait.absoluteTimeoutMs;
      if (now >= deadline) reason = 'wait_timed_out';
      nextCheckAt = Math.min(nextCheckAt ?? deadline, deadline);
    }
    for (const operation of this.state.operations.values()) {
      const absoluteDeadline = operation.startedAt + operation.absoluteTimeoutMs;
      const quietDeadline = operation.lastProgressAt + operation.quietTimeoutMs;
      if (now >= absoluteDeadline) reason = 'operation_timed_out';
      else if (this.state.waits.size === 0 && now >= quietDeadline) reason = 'operation_stalled';
      nextCheckAt = Math.min(nextCheckAt ?? absoluteDeadline, absoluteDeadline);
      if (this.state.waits.size === 0) nextCheckAt = Math.min(nextCheckAt, quietDeadline);
    }

    if (!reason && this.state.waits.size === 0 && this.state.operations.size === 0) {
      if (this.state.startedAt !== undefined && this.state.firstProgressAt === undefined) {
        const deadline = this.state.startedAt + this.options.config.first_progress_timeout_ms;
        if (now >= deadline) reason = 'no_first_progress';
        nextCheckAt = Math.min(nextCheckAt ?? deadline, deadline);
      } else if (this.state.firstProgressAt !== undefined) {
        const idleTimeout =
          this.options.tool === 'claude-code'
            ? this.options.config.claude_idle_timeout_ms
            : this.options.tool === 'codex'
              ? this.options.config.codex_idle_timeout_ms
              : null;
        if (idleTimeout !== null) {
          const deadline = (this.state.idleAnchor ?? this.state.firstProgressAt) + idleTimeout;
          if (now >= deadline) reason = 'progress_stalled';
          nextCheckAt = Math.min(nextCheckAt ?? deadline, deadline);
        }
      }
    }

    if (reason) {
      this.emitDecision(reason, now, true);
      return;
    }
    this.schedule(nextCheckAt);
  }

  private emitDecision(reason: WatchdogReason, now: number, terminalDecision: boolean): void {
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
    if (terminalDecision) this.stop();
    queueMicrotask(() => void this.options.onDecision(evidence));
  }

  private schedule(nextCheckAt: number | undefined): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.decided || nextCheckAt === undefined) return;
    this.timer = setTimeout(() => this.check(), Math.max(0, nextCheckAt - this.now()));
    this.timer.unref?.();
  }
}
