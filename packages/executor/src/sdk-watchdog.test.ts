import type { ResolvedSdkWatchdogConfig } from '@agor/core/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activityToPulse,
  getSdkActivityVersion,
  isSdkHealthAbort,
  markSdkHealthAbort,
  SdkWatchdog,
} from './sdk-watchdog.js';

const config = {
  mode: 'enforce',
  first_progress_timeout_ms: 100,
  abort_grace_ms: 25,
  operation_absolute_timeout_ms: 300,
  claude_idle_timeout_ms: 100,
  codex_idle_timeout_ms: 100,
} as unknown as ResolvedSdkWatchdogConfig;

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

  it('includes the package-owned OpenCode SDK version in watchdog evidence', async () => {
    const decisions: Array<Record<string, unknown>> = [];
    const watchdog = new SdkWatchdog({
      tool: 'opencode',
      config,
      sdkVersion: getSdkActivityVersion('opencode'),
      now: () => Date.now(),
      onDecision: (evidence) => decisions.push(evidence),
    });
    watchdog.record({ type: 'sdk_started' });

    await vi.advanceTimersByTimeAsync(100);

    expect(decisions[0]?.sdk_version).toBe('@opencode-ai/sdk@1.14.33');
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
    await vi.advanceTimersByTimeAsync(50);
    expect(decisions).toEqual([
      expect.objectContaining({ reason: 'unknown_activity' }),
      expect.objectContaining({ reason: 'no_first_progress', watchdog_action: 'enforced' }),
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
    expect(decisions).toEqual([expect.objectContaining({ reason: 'unknown_activity' })]);

    await vi.advanceTimersByTimeAsync(50);
    expect(decisions.at(-1)).toEqual(expect.objectContaining({ reason: 'no_first_progress' }));
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
