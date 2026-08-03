import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from './config-manager';
import {
  resolveDispatchConnectTimeoutMs,
  resolveExecutorHeartbeatConfig,
  resolvePermissionTimeoutMs,
  resolveSdkWatchdogConfig,
} from './executor-heartbeat';

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

  it('resolves the independent local dispatch connection deadline', () => {
    expect(resolveDispatchConnectTimeoutMs()).toBe(5 * 60_000);
    expect(resolveDispatchConnectTimeoutMs({ dispatch_connect_timeout_ms: null })).toBe(5 * 60_000);
    expect(resolveDispatchConnectTimeoutMs({ dispatch_connect_timeout_ms: 42_000 })).toBe(42_000);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid dispatch timeout %s instead of changing policy',
    (dispatch_connect_timeout_ms) => {
      expect(() => resolveDispatchConnectTimeoutMs({ dispatch_connect_timeout_ms })).toThrow(
        'positive safe integer'
      );
    }
  );
});

describe('resolvePermissionTimeoutMs', () => {
  it('uses the shared ten-minute default and preserves a configured timeout', () => {
    expect(resolvePermissionTimeoutMs()).toBe(600_000);
    expect(resolvePermissionTimeoutMs({ permission_timeout_ms: 42_000 })).toBe(42_000);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid permission timeout %s',
    (permission_timeout_ms) => {
      expect(() => resolvePermissionTimeoutMs({ permission_timeout_ms })).toThrow(
        'execution.permission_timeout_ms must be a positive safe integer'
      );
    }
  );
});

describe('resolveSdkWatchdogConfig', () => {
  it('defaults to enforced supervision', () => {
    expect(resolveSdkWatchdogConfig()).toEqual({
      mode: 'enforce',
      first_progress_timeout_ms: 180_000,
      operation_absolute_timeout_ms: 14_400_000,
      abort_grace_ms: 15_000,
      claude_idle_timeout_ms: 3_600_000,
      codex_idle_timeout_ms: 3_600_000,
    });
  });

  it.each(['observe', 'disabled'] as const)('preserves explicit %s policy', (mode) => {
    expect(resolveSdkWatchdogConfig({ sdk_watchdog: { mode } }).mode).toBe(mode);
  });

  it('supports disabling Claude idle without disabling first progress', () => {
    expect(
      resolveSdkWatchdogConfig({ sdk_watchdog: { claude_idle_timeout_ms: null } })
        .claude_idle_timeout_ms
    ).toBeNull();
  });

  it('supports disabling Codex idle without disabling first progress', () => {
    expect(
      resolveSdkWatchdogConfig({ sdk_watchdog: { codex_idle_timeout_ms: null } })
        .codex_idle_timeout_ms
    ).toBeNull();
  });

  it('supports a custom Codex post-progress deadline', () => {
    expect(
      resolveSdkWatchdogConfig({ sdk_watchdog: { codex_idle_timeout_ms: 7_200_000 } })
        .codex_idle_timeout_ms
    ).toBe(7_200_000);
  });

  it.each([
    'first_progress_timeout_ms',
    'abort_grace_ms',
    'claude_idle_timeout_ms',
    'codex_idle_timeout_ms',
  ] as const)('rejects invalid %s rather than silently changing policy', (key) => {
    expect(() => resolveSdkWatchdogConfig({ sdk_watchdog: { [key]: 0 } })).toThrow(
      'positive safe integer'
    );
  });

  it('rejects an invalid runtime mode', () => {
    expect(() =>
      resolveSdkWatchdogConfig({ sdk_watchdog: { mode: 'broken' as 'observe' } })
    ).toThrow('must be disabled, observe, or enforce');
  });
});
