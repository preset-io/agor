import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from './config-manager';
import { resolveExecutorHeartbeatConfig } from './executor-heartbeat';

describe('resolveExecutorHeartbeatConfig', () => {
  it('defaults to enabled with a 10s interval and conservative stale threshold', () => {
    expect(resolveExecutorHeartbeatConfig()).toEqual({
      enabled: true,
      interval_ms: 10_000,
      stale_after_ms: 30_000,
      callback: { command_template: null, timeout_ms: 3_000 },
    });
  });

  it('defaults stale_after_ms to max(3 * interval_ms, 30000)', () => {
    expect(
      resolveExecutorHeartbeatConfig({ executor_heartbeat: { interval_ms: 20_000 } }).stale_after_ms
    ).toBe(60_000);
    expect(
      resolveExecutorHeartbeatConfig({ executor_heartbeat: { interval_ms: 1_000 } }).stale_after_ms
    ).toBe(30_000);
  });

  it('includes executor heartbeat defaults in getDefaultConfig', () => {
    expect(getDefaultConfig().execution?.executor_heartbeat).toEqual(
      resolveExecutorHeartbeatConfig()
    );
  });
});
