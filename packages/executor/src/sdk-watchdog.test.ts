import type { SdkHealthFailureInput } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isSdkHealthAbort,
  mapSdkActivity,
  markSdkHealthAbort,
  SdkWatchdog,
} from './sdk-watchdog.js';

const baseConfig: {
  mode: 'disabled' | 'observe' | 'enforce';
  firstProgressTimeoutMs: number;
  idleTimeoutMs: number | null;
} = {
  mode: 'observe',
  firstProgressTimeoutMs: 1_000,
  idleTimeoutMs: 2_000,
};

type Evidence = Omit<SdkHealthFailureInput, 'task_id'>;

function harness(overrides: Partial<typeof baseConfig> = {}) {
  const decisions: Evidence[] = [];
  const watchdog = new SdkWatchdog({
    ...baseConfig,
    ...overrides,
    sdkVersion: 'sdk@1.0.0',
    now: Date.now,
    onDecision: (evidence) => decisions.push(evidence),
  });
  return { watchdog, decisions };
}

describe('SdkWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => vi.useRealTimers());

  it.each([
    'observe',
    'enforce',
  ] as const)('uses the same first-progress decision in %s mode', (mode) => {
    const { watchdog, decisions } = harness({ mode });
    watchdog.record('sdk_started');
    vi.advanceTimersByTime(1_000);
    expect(decisions).toMatchObject([
      {
        reason: 'no_first_progress',
        watchdog_action: mode === 'enforce' ? 'enforced' : 'would_fire',
      },
    ]);
    vi.advanceTimersByTime(5_000);
    expect(decisions).toHaveLength(1);
  });

  it('does not rearm observe mode after late progress', () => {
    const { watchdog, decisions } = harness();
    watchdog.record('sdk_started');
    vi.advanceTimersByTime(1_000);
    expect(decisions).toHaveLength(1);
    watchdog.record('progress');
    vi.advanceTimersByTime(10_000);
    expect(decisions.map(({ reason }) => reason)).toEqual(['no_first_progress']);
  });

  it('disarms first-progress policy after meaningful progress when idle supervision is off', () => {
    const { watchdog, decisions } = harness({ idleTimeoutMs: null });
    watchdog.record('sdk_started');
    vi.advanceTimersByTime(999);
    watchdog.record('progress');
    vi.advanceTimersByTime(10_000);
    expect(decisions).toEqual([]);
  });

  it.each([
    ['observe', 'would_fire'],
    ['enforce', 'enforced'],
  ] as const)('detects post-progress silence exactly once in %s mode', (mode, watchdogAction) => {
    const { watchdog, decisions } = harness({ mode });
    watchdog.record('sdk_started');
    watchdog.record('progress');

    vi.advanceTimersByTime(1_999);
    expect(decisions).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(decisions).toMatchObject([
      {
        reason: 'progress_stalled',
        watchdog_action: watchdogAction,
      },
    ]);

    vi.advanceTimersByTime(10_000);
    expect(decisions).toHaveLength(1);
  });

  it('resets the post-progress deadline only for later SDK progress', () => {
    const { watchdog, decisions } = harness();
    watchdog.record('sdk_started');
    watchdog.record('progress');
    vi.advanceTimersByTime(1_500);
    watchdog.record('progress');

    vi.advanceTimersByTime(1_999);
    expect(decisions).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(decisions[0]?.reason).toBe('progress_stalled');
  });

  it('preserves the remaining post-progress timeout across an explicit wait', () => {
    const { watchdog, decisions } = harness();
    watchdog.record('sdk_started');
    watchdog.record('progress');
    vi.advanceTimersByTime(800);
    watchdog.record('waiting', 'permission.request');
    vi.advanceTimersByTime(10_000);
    expect(decisions).toEqual([]);

    watchdog.record('sdk_started', 'permission.resolved');
    vi.advanceTimersByTime(1_199);
    expect(decisions).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(decisions[0]?.reason).toBe('progress_stalled');
  });

  it('keeps enforced post-progress supervision fail-open while unknown activity continues', () => {
    const { watchdog, decisions } = harness({ mode: 'enforce' });
    watchdog.record('sdk_started');
    watchdog.record('progress');
    vi.advanceTimersByTime(1_500);
    watchdog.record('unknown_activity');
    vi.advanceTimersByTime(500);
    expect(decisions).toMatchObject([
      { reason: 'unknown_activity', watchdog_action: 'would_fire' },
    ]);

    watchdog.record('unknown_activity');
    for (let index = 0; index < 3; index++) {
      vi.advanceTimersByTime(1_999);
      watchdog.record('unknown_activity');
    }
    expect(decisions).toHaveLength(1);
  });

  it.each([
    'operation.start',
    'tool.start',
    'background_task.start',
  ])('does not let a missing completion for %s suspend supervision', (detail) => {
    const { watchdog, decisions } = harness();
    watchdog.record('sdk_started');
    watchdog.record('progress', detail);
    vi.advanceTimersByTime(1_999);
    expect(decisions).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(decisions[0]?.reason).toBe('progress_stalled');
  });

  it('fails open while unknown vocabulary remains active, then fires after silence', () => {
    const { watchdog, decisions } = harness({ mode: 'enforce' });
    watchdog.record('sdk_started');
    vi.advanceTimersByTime(500);
    watchdog.record('unknown_activity', 'future.event');
    vi.advanceTimersByTime(500);
    expect(decisions).toMatchObject([
      { reason: 'unknown_activity', watchdog_action: 'would_fire' },
    ]);
    watchdog.record('unknown_activity', 'future.event');
    vi.advanceTimersByTime(999);
    expect(decisions).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(decisions[1]).toMatchObject({
      reason: 'no_first_progress',
      watchdog_action: 'enforced',
    });
  });

  it('preserves the remaining first-progress timeout across a permission wait', () => {
    const { watchdog, decisions } = harness();
    watchdog.record('sdk_started');
    vi.advanceTimersByTime(400);
    watchdog.record('waiting');
    vi.advanceTimersByTime(5_000);
    expect(decisions).toEqual([]);
    watchdog.record('progress', 'unrelated');
    vi.advanceTimersByTime(5_000);
    expect(decisions).toEqual([]);
    watchdog.record('sdk_started', 'permission.resolved');
    vi.advanceTimersByTime(599);
    expect(decisions).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(decisions[0]?.reason).toBe('no_first_progress');
  });

  it('keeps an OpenCode permission update paused until the matching reply', () => {
    const { watchdog, decisions } = harness();
    watchdog.record('sdk_started');
    vi.advanceTimersByTime(400);
    watchdog.record('waiting', 'permission.asked');
    vi.advanceTimersByTime(5_000);

    const updated = mapSdkActivity('opencode', 'permission.updated');
    expect(updated).toEqual({ kind: 'waiting', detail: 'permission.updated' });
    if (updated) watchdog.record(updated.kind, updated.detail);
    vi.advanceTimersByTime(5_000);
    expect(decisions).toEqual([]);

    const genericReply = mapSdkActivity('opencode', 'permission.replied');
    expect(genericReply).toEqual({ kind: 'unknown_activity', detail: 'permission.replied' });
    watchdog.record('sdk_started', 'permission.resolved');

    vi.advanceTimersByTime(599);
    expect(decisions).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(decisions[0]?.reason).toBe('no_first_progress');
  });

  it('resumes supervision after a permission timeout', () => {
    const { watchdog, decisions } = harness();
    watchdog.record('sdk_started');
    watchdog.record('waiting', 'permission.request');
    vi.advanceTimersByTime(5_000);
    watchdog.record('sdk_started', 'permission.timeout');
    vi.advanceTimersByTime(1_000);
    expect(decisions[0]?.reason).toBe('no_first_progress');
  });

  it('does nothing when disabled or stopped', () => {
    const disabled = harness({ mode: 'disabled' });
    disabled.watchdog.record('sdk_started');
    vi.advanceTimersByTime(10_000);
    expect(disabled.decisions).toEqual([]);

    const stopped = harness();
    stopped.watchdog.record('sdk_started');
    stopped.watchdog.stop();
    vi.advanceTimersByTime(10_000);
    expect(stopped.decisions).toEqual([]);
  });

  it('marks coordinator-owned aborts distinctly from user Stop', () => {
    const controller = new AbortController();
    expect(isSdkHealthAbort(controller)).toBe(false);
    markSdkHealthAbort(controller);
    expect(controller.signal.aborted).toBe(true);
    expect(isSdkHealthAbort(controller)).toBe(true);
  });
});
