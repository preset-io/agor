import type { ResolvedSdkWatchdogConfig } from '@agor/core/config';
import type { AgenticToolName } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activityToPulse,
  applyAdapterConformanceMode,
  getSdkActivityConformance,
  getSdkActivityVersion,
  isSdkHealthAbort,
  markSdkHealthAbort,
  SdkWatchdog,
} from './sdk-watchdog.js';

const config = {
  mode: 'enforce',
  first_progress_timeout_ms: 100,
  abort_grace_ms: 25,
  operation_absolute_timeout_ms: 10_000,
  claude_idle_timeout_ms: 100,
  codex_idle_timeout_ms: 100,
} as unknown as ResolvedSdkWatchdogConfig;

describe('adapter conformance', () => {
  it('covers every shipped adapter and cannot enforce observe-only traces', () => {
    for (const tool of ['claude-code', 'codex', 'gemini', 'copilot', 'opencode', 'cursor']) {
      expect(getSdkActivityConformance(tool)).toBeDefined();
    }
    expect(applyAdapterConformanceMode('enforce', 'observe-only')).toBe('observe');
    expect(() => applyAdapterConformanceMode('enforce', 'blocked')).toThrow(
      /not runtime-conformant/
    );
    expect(getSdkActivityConformance('claude-code')?.nativeDeadline).toBe('observable');
    expect(getSdkActivityConformance('copilot')?.nativeDeadline).toBe('configured');
  });

  it('matches the exact SDK versions installed by the runtime packages', () => {
    const tools: AgenticToolName[] = [
      'claude-code',
      'codex',
      'gemini',
      'copilot',
      'opencode',
      'cursor',
    ];
    for (const tool of tools) {
      expect(getSdkActivityConformance(tool)?.version).toBe(getSdkActivityVersion(tool));
    }
  });
});

describe('SdkWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => vi.useRealTimers());

  function setup(overrides: Partial<typeof config> = {}) {
    const decisions: Array<Record<string, unknown>> = [];
    const watchdog = new SdkWatchdog({
      tool: 'codex',
      config: { ...config, ...overrides } as ResolvedSdkWatchdogConfig,
      now: () => Date.now(),
      onDecision: (evidence) => decisions.push(evidence),
    });
    return { watchdog, decisions };
  }

  it('enforces a bounded first-progress deadline', async () => {
    const { watchdog, decisions } = setup();
    watchdog.record({ type: 'sdk_started' });

    await vi.advanceTimersByTimeAsync(100);

    expect(decisions).toEqual([
      expect.objectContaining({ reason: 'no_first_progress', watchdog_action: 'enforced' }),
    ]);
  });

  it('enforces the Codex post-progress quiet deadline', async () => {
    const { watchdog, decisions } = setup();
    watchdog.record({ type: 'progress' });

    await vi.advanceTimersByTimeAsync(99);
    expect(decisions).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(decisions).toEqual([
      expect.objectContaining({ reason: 'progress_stalled', watchdog_action: 'enforced' }),
    ]);

    watchdog.record({ type: 'progress' });
    await vi.advanceTimersByTimeAsync(500);
    expect(decisions).toHaveLength(1);
  });

  it('lets meaningful Codex progress extend the quiet deadline', async () => {
    const { watchdog, decisions } = setup();
    watchdog.record({ type: 'progress' });
    await vi.advanceTimersByTimeAsync(80);
    watchdog.record({ type: 'progress' });

    await vi.advanceTimersByTimeAsync(99);
    expect(decisions).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(decisions).toEqual([expect.objectContaining({ reason: 'progress_stalled' })]);
  });

  it('enforces the absolute turn deadline despite ongoing progress', async () => {
    const { watchdog, decisions } = setup({
      codex_idle_timeout_ms: null,
      operation_absolute_timeout_ms: 120,
    });
    watchdog.record({ type: 'progress' });
    await vi.advanceTimersByTimeAsync(50);
    watchdog.record({ type: 'progress' });
    await vi.advanceTimersByTimeAsync(50);
    watchdog.record({ type: 'progress' });
    await vi.advanceTimersByTimeAsync(20);

    expect(decisions).toEqual([expect.objectContaining({ reason: 'turn_timed_out' })]);
  });

  it('pauses the Codex post-progress deadline during a known wait', async () => {
    const { watchdog, decisions } = setup();
    watchdog.record({ type: 'progress' });
    await vi.advanceTimersByTimeAsync(80);
    watchdog.record({
      type: 'waiting_started',
      id: 'permission-1',
      reason: 'permission',
      absoluteTimeoutMs: 200,
    });
    await vi.advanceTimersByTimeAsync(100);
    watchdog.record({ type: 'waiting_finished', id: 'permission-1' });

    await vi.advanceTimersByTimeAsync(19);
    expect(decisions).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(decisions).toEqual([expect.objectContaining({ reason: 'progress_stalled' })]);
  });

  it('keeps explicit null as the Codex post-progress opt-out', async () => {
    const { watchdog, decisions } = setup({ codex_idle_timeout_ms: null });
    watchdog.record({ type: 'progress' });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(decisions).toEqual([]);
  });

  it('records rather than enforces the Codex deadline in observe mode', async () => {
    const { watchdog, decisions } = setup({ mode: 'observe' });
    watchdog.record({ type: 'progress' });

    await vi.advanceTimersByTimeAsync(100);

    expect(decisions).toEqual([
      expect.objectContaining({ reason: 'progress_stalled', watchdog_action: 'would_fire' }),
    ]);
  });

  it('rearms an observe-mode stall only after meaningful progress', async () => {
    const { watchdog, decisions } = setup({ mode: 'observe' });
    watchdog.record({ type: 'progress' });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(500);
    expect(decisions).toHaveLength(1);

    watchdog.record({ type: 'unknown_activity', detail: 'future.event' });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(decisions.filter(({ reason }) => reason === 'progress_stalled')).toHaveLength(1);

    watchdog.record({ type: 'progress' });
    await vi.advanceTimersByTimeAsync(99);
    expect(decisions.filter(({ reason }) => reason === 'progress_stalled')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(decisions.filter(({ reason }) => reason === 'progress_stalled')).toHaveLength(2);
  });

  it('tracks parallel operations independently by ID', async () => {
    const { watchdog, decisions } = setup();
    watchdog.record({
      type: 'operation_started',
      id: 'a',
      kind: 'command',
      quietTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(50);
    watchdog.record({
      type: 'operation_started',
      id: 'b',
      kind: 'command',
      quietTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(10);
    watchdog.record({ type: 'operation_finished', id: 'a' });

    await vi.advanceTimersByTimeAsync(89);
    expect(decisions).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(decisions).toEqual([expect.objectContaining({ reason: 'operation_stalled' })]);
  });

  it('enforces an absolute operation deadline despite ongoing progress', async () => {
    const { watchdog, decisions } = setup();
    watchdog.record({
      type: 'operation_started',
      id: 'long',
      kind: 'command',
      quietTimeoutMs: 100,
      absoluteTimeoutMs: 120,
    });
    await vi.advanceTimersByTimeAsync(50);
    watchdog.record({ type: 'operation_progress', id: 'long' });
    await vi.advanceTimersByTimeAsync(50);
    watchdog.record({ type: 'operation_progress', id: 'long' });
    await vi.advanceTimersByTimeAsync(20);

    expect(decisions).toEqual([expect.objectContaining({ reason: 'operation_timed_out' })]);
  });

  it('pauses quiet supervision during an identified wait but bounds the wait itself', async () => {
    const { watchdog, decisions } = setup();
    watchdog.record({
      type: 'operation_started',
      id: 'command',
      kind: 'command',
      quietTimeoutMs: 60,
    });
    await vi.advanceTimersByTimeAsync(40);
    watchdog.record({
      type: 'waiting_started',
      id: 'permission-1',
      reason: 'permission',
      absoluteTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(decisions).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(decisions).toEqual([expect.objectContaining({ reason: 'wait_timed_out' })]);
  });

  it('leaves adapter-owned wait expiry to the adapter', async () => {
    const { watchdog, decisions } = setup();
    watchdog.record({
      type: 'waiting_started',
      id: 'permission-1',
      reason: 'permission',
      absoluteTimeoutMs: 100,
      deadlineOwner: 'adapter',
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(decisions).toEqual([]);
  });

  it('resumes quiet supervision after the matching wait finishes', async () => {
    const { watchdog, decisions } = setup();
    watchdog.record({
      type: 'operation_started',
      id: 'command',
      kind: 'command',
      quietTimeoutMs: 60,
    });
    await vi.advanceTimersByTimeAsync(40);
    watchdog.record({
      type: 'waiting_started',
      id: 'permission-1',
      reason: 'permission',
      absoluteTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(50);
    watchdog.record({ type: 'waiting_finished', id: 'permission-1' });
    await vi.advanceTimersByTimeAsync(19);
    expect(decisions).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(decisions).toEqual([expect.objectContaining({ reason: 'operation_stalled' })]);
  });

  it('diagnoses unknown activity without treating it as meaningful progress', async () => {
    const { watchdog, decisions } = setup();
    watchdog.record({ type: 'sdk_started' });
    await vi.advanceTimersByTimeAsync(50);
    watchdog.record({ type: 'unknown_activity', detail: 'future.event' });
    await Promise.resolve();

    expect(decisions).toEqual([
      expect.objectContaining({ reason: 'unknown_activity', watchdog_action: 'would_fire' }),
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(decisions).toEqual([
      expect.objectContaining({ reason: 'unknown_activity' }),
      expect.objectContaining({ reason: 'adapter_incompatible', watchdog_action: 'enforced' }),
    ]);
  });

  it('diagnoses an unmatched operation event without refreshing progress', async () => {
    const { watchdog, decisions } = setup();
    watchdog.record({ type: 'sdk_started' });
    await vi.advanceTimersByTimeAsync(50);
    expect(watchdog.record({ type: 'operation_finished', id: 'missing' })).toEqual({
      type: 'unknown_activity',
      detail: 'operation_finished:missing',
    });
    await Promise.resolve();
    expect(decisions).toEqual([
      expect.objectContaining({ reason: 'unknown_activity' }),
      expect.objectContaining({ reason: 'adapter_incompatible', watchdog_action: 'enforced' }),
    ]);

    await vi.advanceTimersByTimeAsync(50);
    expect(decisions.at(-1)).toEqual(expect.objectContaining({ reason: 'adapter_incompatible' }));
  });

  it('does not let a duplicate operation start move its absolute deadline', async () => {
    const { watchdog, decisions } = setup();
    watchdog.record({
      type: 'operation_started',
      id: 'command',
      kind: 'command',
      quietTimeoutMs: 100,
      absoluteTimeoutMs: 120,
    });
    await vi.advanceTimersByTimeAsync(80);
    watchdog.record({
      type: 'operation_started',
      id: 'command',
      kind: 'command',
      quietTimeoutMs: 100,
      absoluteTimeoutMs: 120,
    });
    await vi.advanceTimersByTimeAsync(40);

    expect(decisions).toEqual([expect.objectContaining({ reason: 'operation_timed_out' })]);
  });

  it('marks coordinator-owned aborts distinctly from user Stop', () => {
    const controller = new AbortController();
    expect(isSdkHealthAbort(controller)).toBe(false);
    markSdkHealthAbort(controller);
    expect(controller.signal.aborted).toBe(true);
    expect(isSdkHealthAbort(controller)).toBe(true);
  });
});

describe('activityToPulse', () => {
  it('persists only bounded semantic telemetry', () => {
    expect(
      activityToPulse({
        type: 'operation_started',
        id: 'secret-operation-id',
        kind: `command ${'x'.repeat(200)}`,
      })
    ).toEqual({ kind: 'progress', detail: `command_${'x'.repeat(120)}` });
    expect(
      activityToPulse({
        type: 'waiting_started',
        id: 'permission-1',
        reason: 'permission',
        absoluteTimeoutMs: 100,
      })
    ).toEqual({ kind: 'waiting', detail: 'permission' });
  });
});
