import { getAgenticToolIntegration } from '@agor/agentic-tools';
import type { ResolvedSdkWatchdogConfig } from '@agor/core/config';
import type { AgenticToolName, ExecutorPulseKind, SdkHealthFailureInput } from '@agor/core/types';

export type SdkActivityAdapter = AgenticToolName;

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
  | {
      type: 'waiting_started';
      id: string;
      reason: string;
      absoluteTimeoutMs: number;
      deadlineOwner?: 'adapter' | 'watchdog';
    }
  | { type: 'waiting_finished'; id: string; outcome?: string };

export type SdkActivityCallback = (activity: RuntimeActivity) => void;

export type AdapterConformanceMode = 'enforce' | 'observe-only' | 'blocked';

export interface SdkActivityConformance {
  version: string;
  mode: AdapterConformanceMode;
  nativeDeadline?: 'observable' | 'configured';
}

export const SDK_ACTIVITY_VERSION_MANIFEST: Record<SdkActivityAdapter, string> = {
  'claude-code': '@anthropic-ai/claude-agent-sdk@0.3.197',
  codex: '@openai/codex-sdk@0.144.0',
  gemini: '@google/gemini-cli-core@0.40.1',
  copilot: '@github/copilot-sdk@0.2.2',
  opencode: '@opencode-ai/sdk@1.14.33',
  cursor: '@cursor/sdk@1.0.23',
};

type SdkActivityConformancePolicy = Omit<SdkActivityConformance, 'version'>;

const SDK_ACTIVITY_CONFORMANCE_POLICY: Record<
  SdkActivityAdapter,
  SdkActivityConformancePolicy
> = {
  'claude-code': {
    mode: 'enforce',
    nativeDeadline: 'observable',
  },
  codex: { mode: 'enforce' },
  gemini: { mode: 'enforce' },
  copilot: {
    mode: 'enforce',
    nativeDeadline: 'configured',
  },
  opencode: { mode: 'enforce' },
  cursor: { mode: 'enforce' },
};

export function getSdkActivityVersion(tool: AgenticToolName): string | undefined {
  return getAgenticToolIntegration(tool).sdkVersion ?? SDK_ACTIVITY_VERSION_MANIFEST[tool];
}

export function getSdkActivityConformance(adapter: string): SdkActivityConformance | undefined {
  const policy = SDK_ACTIVITY_CONFORMANCE_POLICY[adapter as SdkActivityAdapter];
  if (!policy) return undefined;
  const version = getSdkActivityVersion(adapter as AgenticToolName);
  if (!version) return undefined;
  return { version, ...policy };
}

export function applyAdapterConformanceMode(
  requested: ResolvedSdkWatchdogConfig['mode'],
  conformance: AdapterConformanceMode
): ResolvedSdkWatchdogConfig['mode'] {
  if (conformance === 'blocked') throw new Error('Agentic-tool adapter is not runtime-conformant');
  return requested === 'enforce' && conformance === 'observe-only' ? 'observe' : requested;
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
  deadlineOwner: 'adapter' | 'watchdog';
}

interface WatchdogState {
  startedAt?: number;
  firstProgressAt?: number;
  idleAnchor?: number;
  pausedAt?: number;
  unknownCount: number;
  lastUnknownAt?: number;
  unknownReported: boolean;
  operations: Map<string, ActiveOperation>;
  waits: Map<string, ActiveWait>;
}

type WatchdogReason = Exclude<WatchdogEvidence['reason'], undefined>;

interface WatchdogDeadline {
  reason: WatchdogReason;
  key: string;
  at: number;
  quietAnchor?: number;
}

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
  private activityRevision = 0;
  private pendingEnforcedDecision?: { key: string; activityRevision: number };
  private readonly observeLatches = new Set<string>();

  constructor(
    private readonly options: {
      tool: string;
      config: ResolvedSdkWatchdogConfig;
      sdkVersion?: string;
      pulseSequenceAtDetection?: () => number | undefined;
      onDecision(evidence: WatchdogEvidence): boolean | undefined | Promise<boolean | undefined>;
      now?: () => number;
    }
  ) {}

  record(activity: RuntimeActivity): RuntimeActivity {
    if (this.decided || this.options.config.mode === 'disabled') return activity;
    if (activity.type !== 'sdk_started') this.activityRevision += 1;
    const now = this.now();

    if (activity.type === 'waiting_started') {
      this.state.startedAt ??= now;
      if (!this.state.waits.has(activity.id)) {
        this.state.waits.set(activity.id, {
          id: activity.id,
          startedAt: now,
          absoluteTimeoutMs: positiveTimeout(activity.absoluteTimeoutMs, 1),
          deadlineOwner: activity.deadlineOwner ?? 'watchdog',
        });
      }
      this.state.pausedAt ??= now;
      this.check();
      return activity;
    }

    if (activity.type === 'waiting_finished') {
      if (!this.state.waits.has(activity.id)) {
        const unknown = this.recordProtocolError(`waiting_finished:${activity.id}`, now);
        this.check();
        return unknown;
      }
      this.state.waits.delete(activity.id);
      this.observeLatches.delete(`wait_timed_out:${activity.id}`);
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
          this.observeLatches.delete(`operation_stalled:${activity.id}`);
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
          const unknown = this.recordProtocolError(`operation_progress:${activity.id}`, now);
          this.check();
          return unknown;
        }
        operation.lastProgressAt = now;
        this.observeLatches.delete(`operation_stalled:${activity.id}`);
        this.recordProgress(now);
        break;
      }
      case 'operation_finished':
        if (!this.state.operations.has(activity.id)) {
          const unknown = this.recordProtocolError(`operation_finished:${activity.id}`, now);
          this.check();
          return unknown;
        }
        this.state.operations.delete(activity.id);
        this.observeLatches.delete(`operation_stalled:${activity.id}`);
        this.observeLatches.delete(`operation_timed_out:${activity.id}`);
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
    this.observeLatches.delete('no_first_progress');
    this.observeLatches.delete('progress_stalled');
  }

  private recordUnknown(detail: string, now: number): RuntimeActivity {
    this.state.unknownCount += 1;
    this.state.lastUnknownAt = now;
    if (!this.state.unknownReported) {
      this.state.unknownReported = true;
      this.emitDecision('unknown_activity', now, false);
    }
    return { type: 'unknown_activity', detail };
  }

  private recordProtocolError(detail: string, now: number): RuntimeActivity {
    const unknown = this.recordUnknown(detail, now);
    this.emitDecision('adapter_incompatible', now, true, `adapter_incompatible:${detail}`);
    return unknown;
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
    const deadlines: WatchdogDeadline[] = [];

    if (this.state.startedAt !== undefined) {
      deadlines.push({
        reason: 'turn_timed_out',
        key: 'turn_timed_out',
        at: this.state.startedAt + this.options.config.operation_absolute_timeout_ms,
      });
    }
    for (const wait of this.state.waits.values()) {
      if (wait.deadlineOwner === 'adapter') continue;
      const deadline = wait.startedAt + wait.absoluteTimeoutMs;
      deadlines.push({ reason: 'wait_timed_out', key: `wait_timed_out:${wait.id}`, at: deadline });
    }
    for (const operation of this.state.operations.values()) {
      const absoluteDeadline = operation.startedAt + operation.absoluteTimeoutMs;
      const quietDeadline = operation.lastProgressAt + operation.quietTimeoutMs;
      deadlines.push({
        reason: 'operation_timed_out',
        key: `operation_timed_out:${operation.id}`,
        at: absoluteDeadline,
      });
      if (this.state.waits.size === 0 && now < absoluteDeadline) {
        deadlines.push({
          reason: 'operation_stalled',
          key: `operation_stalled:${operation.id}`,
          at: quietDeadline,
          quietAnchor: operation.lastProgressAt,
        });
      }
    }

    if (this.state.waits.size === 0 && this.state.operations.size === 0) {
      if (this.state.startedAt !== undefined && this.state.firstProgressAt === undefined) {
        const deadline = this.state.startedAt + this.options.config.first_progress_timeout_ms;
        deadlines.push({
          reason: 'no_first_progress',
          key: 'no_first_progress',
          at: deadline,
          quietAnchor: this.state.startedAt,
        });
      } else if (this.state.firstProgressAt !== undefined) {
        const idleTimeout =
          this.options.tool === 'claude-code'
            ? this.options.config.claude_idle_timeout_ms
            : this.options.tool === 'codex'
              ? this.options.config.codex_idle_timeout_ms
              : null;
        if (idleTimeout !== null) {
          const deadline = (this.state.idleAnchor ?? this.state.firstProgressAt) + idleTimeout;
          deadlines.push({
            reason: 'progress_stalled',
            key: 'progress_stalled',
            at: deadline,
            quietAnchor: this.state.idleAnchor ?? this.state.firstProgressAt,
          });
        }
      }
    }

    const interpretedDeadlines = deadlines.map((deadline) => {
      const lastUnknownAt = this.state.lastUnknownAt;
      if (
        deadline.quietAnchor === undefined ||
        lastUnknownAt === undefined ||
        lastUnknownAt <= deadline.quietAnchor
      ) {
        return deadline;
      }
      return {
        reason: 'adapter_incompatible' as const,
        key: `adapter_incompatible:${deadline.key}`,
        at: lastUnknownAt + (deadline.at - deadline.quietAnchor),
      };
    });

    // Keep recording activity, but do not start a second decision or spin an
    // already-expired timer while daemon authorization is in flight. The
    // decision continuation calls check() again against the updated state.
    if (this.pendingEnforcedDecision) {
      this.schedule(undefined);
      return;
    }

    const decision = interpretedDeadlines.find(
      (deadline) => now >= deadline.at && !this.observeLatches.has(deadline.key)
    );
    if (decision) {
      this.emitDecision(decision.reason, now, true, decision.key);
      if (this.decided) return;
    }

    const nextCheckAt = interpretedDeadlines
      .filter((deadline) => !this.observeLatches.has(deadline.key))
      .reduce<number | undefined>(
        (earliest, deadline) => Math.min(earliest ?? deadline.at, deadline.at),
        undefined
      );
    this.schedule(nextCheckAt);
  }

  private emitDecision(
    reason: WatchdogReason,
    now: number,
    terminalDecision: boolean,
    observeKey?: string
  ): void {
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
      pulse_sequence_at_detection: this.options.pulseSequenceAtDetection?.(),
    };
    if (terminalDecision && action !== 'enforced' && observeKey) {
      this.observeLatches.add(observeKey);
    }
    if (terminalDecision && action === 'enforced') {
      const key = observeKey ?? reason;
      if (this.pendingEnforcedDecision) return;
      const pending = { key, activityRevision: this.activityRevision };
      this.pendingEnforcedDecision = pending;
      queueMicrotask(async () => {
        let authorized = false;
        try {
          authorized = (await this.options.onDecision(evidence)) === true;
        } catch {
          authorized = false;
        }
        if (this.pendingEnforcedDecision !== pending) return;
        this.pendingEnforcedDecision = undefined;
        if (authorized) {
          this.stop();
          return;
        }
        // A report can be superseded by activity observed while it was in
        // flight. Recompute from that state. Without new activity, latch the
        // expired deadline so a transport failure cannot create a hot loop.
        if (this.activityRevision === pending.activityRevision) {
          this.observeLatches.add(key);
        }
        this.check();
      });
      return;
    }
    queueMicrotask(() => void this.options.onDecision(evidence));
  }

  private schedule(nextCheckAt: number | undefined): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.decided || nextCheckAt === undefined) return;
    this.timer = setTimeout(() => this.check(), Math.max(0, nextCheckAt - this.now()));
    this.timer.unref?.();
  }
}
