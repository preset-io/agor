import type { ResolvedSdkWatchdogConfig } from '@agor/core/config';
import type { SdkHealthFailureInput } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSdkHealthAbort, markSdkHealthAbort, SdkWatchdog } from './sdk-watchdog.js';

const baseConfig: ResolvedSdkWatchdogConfig = {
  mode: 'observe',
  first_progress_timeout_ms: 1_000,
  abort_grace_ms: 100,
  claude_idle_timeout_ms: 2_000,
};

type Evidence = Omit<SdkHealthFailureInput, 'task_id'>;

function harness(overrides: Partial<ResolvedSdkWatchdogConfig> = {}, tool = 'codex') {
  const decisions: Evidence[] = [];
  const watchdog = new SdkWatchdog({
    tool,
    config: { ...baseConfig, ...overrides },
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

  it('disarms first-progress policy after meaningful progress', () => {
    const { watchdog, decisions } = harness();
    watchdog.record('sdk_started');
    vi.advanceTimersByTime(999);
    watchdog.record('progress', 'item.started');
    vi.advanceTimersByTime(10_000);
    expect(decisions).toEqual([]);
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

  it('preserves the remaining timeout across a permission wait', () => {
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

  it('pauses Claude idle policy while a known tool is active', () => {
    const { watchdog, decisions } = harness({}, 'claude-code');
    watchdog.record('sdk_started');
    watchdog.record('progress', 'assistant');
    vi.advanceTimersByTime(1_000);
    watchdog.record('progress', 'tool.start');
    vi.advanceTimersByTime(10_000);
    expect(decisions).toEqual([]);
    watchdog.record('progress', 'tool.complete');
    vi.advanceTimersByTime(1_999);
    expect(decisions).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(decisions[0]?.reason).toBe('progress_stalled');
  });

  it('keeps Claude idle policy paused until every parallel tool completes', () => {
    const { watchdog, decisions } = harness({}, 'claude-code');
    watchdog.record('sdk_started');
    watchdog.record('progress', 'assistant');
    watchdog.record('progress', 'tool.start');
    watchdog.record('progress', 'tool.start');
    watchdog.record('progress', 'tool.complete');
    vi.advanceTimersByTime(10_000);
    expect(decisions).toEqual([]);
    watchdog.record('progress', 'tool.complete');
    vi.advanceTimersByTime(2_000);
    expect(decisions[0]?.reason).toBe('progress_stalled');
  });

  it('does not enforce Claude idle while unknown SDK activity continues', () => {
    const { watchdog, decisions } = harness({ mode: 'enforce' }, 'claude-code');
    watchdog.record('sdk_started');
    watchdog.record('progress', 'assistant');
    vi.advanceTimersByTime(1_500);
    watchdog.record('unknown_activity', 'future.delta');
    vi.advanceTimersByTime(500);
    expect(decisions).toMatchObject([
      { reason: 'unknown_activity', watchdog_action: 'would_fire' },
    ]);
    watchdog.record('unknown_activity', 'future.delta');
    vi.advanceTimersByTime(1_999);
    expect(decisions).toHaveLength(1);
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
