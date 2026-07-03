import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from './config-manager';
import { resolveExecutorHeartbeatConfig } from './executor-heartbeat';

describe('resolveExecutorHeartbeatConfig', () => {
  it('defaults to enabled with a 10s interval and forgiving stale threshold', () => {
    expect(resolveExecutorHeartbeatConfig()).toEqual({
      enabled: true,
      interval_ms: 10_000,
      stale_after_ms: 90_000,
      callback: { command_template: null, timeout_ms: 3_000 },
    });
  });

  it('defaults stale_after_ms to max(3 * interval_ms, 90000)', () => {
    // Below the 90s floor: clamped up.
    expect(
      resolveExecutorHeartbeatConfig({ executor_heartbeat: { interval_ms: 20_000 } }).stale_after_ms
    ).toBe(90_000);
    expect(
      resolveExecutorHeartbeatConfig({ executor_heartbeat: { interval_ms: 1_000 } }).stale_after_ms
    ).toBe(90_000);
    // Above the floor: 3 * interval wins.
    expect(
      resolveExecutorHeartbeatConfig({ executor_heartbeat: { interval_ms: 40_000 } }).stale_after_ms
    ).toBe(120_000);
  });

  it('honors an explicit stale_after_ms override', () => {
    expect(
      resolveExecutorHeartbeatConfig({ executor_heartbeat: { stale_after_ms: 15_000 } })
        .stale_after_ms
    ).toBe(15_000);
  });

  it('includes executor heartbeat defaults in getDefaultConfig', () => {
    expect(getDefaultConfig().execution?.executor_heartbeat).toEqual(
      resolveExecutorHeartbeatConfig()
    );
  });
});
