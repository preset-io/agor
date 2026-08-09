import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DistributedHealthMonitor,
  type DistributedHealthMonitorOptions,
} from './distributed-health-monitor.js';

function options(
  overrides: Partial<DistributedHealthMonitorOptions> = {}
): DistributedHealthMonitorOptions {
  return {
    workIdentity: { instanceId: 'daemon-a', bootId: 'boot-a' },
    scanIntervalMs: 5_000,
    maxIdleIntervalMs: 30_000,
    startupOffsetMaxMs: 3_000,
    scanBatchSize: 32,
    maxInFlight: 8,
    httpTimeoutMs: 1_000,
    claimLeaseMs: 15_000,
    shutdownDrainTimeoutMs: 5_000,
    random: () => 0,
    ...overrides,
  };
}

function makeApp() {
  const branches = new EventEmitter();
  return {
    branches,
    app: { service: vi.fn(() => branches) },
  };
}

describe('DistributedHealthMonitor loop contract', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('validates the lease timeout margin and concurrency bounds', () => {
    const { app } = makeApp();
    expect(
      () =>
        new DistributedHealthMonitor(app as never, {} as never, options({ claimLeaseMs: 5_999 }))
    ).toThrow('leave at least 5000ms');
    expect(
      () => new DistributedHealthMonitor(app as never, {} as never, options({ maxInFlight: 33 }))
    ).toThrow('cannot exceed scan batch size');
  });

  it('treats branch events as wake hints and removes listeners/timers on shutdown', async () => {
    const { app, branches } = makeApp();
    const discover = vi.fn(async () => []);
    const monitor = new DistributedHealthMonitor(app as never, {} as never, options({ discover }));
    const checkOnce = vi.spyOn(monitor, 'checkOnce').mockResolvedValue({
      candidates: 0,
      claimed: 0,
      committed: 0,
      failures: 0,
      saturated: false,
    });

    await monitor.initialize();
    expect(monitor.isReady()).toBe(true);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(checkOnce).not.toHaveBeenCalled();
    expect(branches.listenerCount('patched')).toBe(1);

    branches.emit('patched', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(checkOnce).toHaveBeenCalledTimes(1);

    await monitor.cleanup();
    expect(monitor.isReady()).toBe(false);
    expect(branches.listenerCount('created')).toBe(0);
    expect(branches.listenerCount('patched')).toBe(0);
    expect(branches.listenerCount('removed')).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkOnce).toHaveBeenCalledTimes(1);
  });

  it('fails readiness on coordination failure and recovers after a successful bounded scan', async () => {
    const { app } = makeApp();
    const discover = vi
      .fn<() => Promise<[]>>()
      .mockRejectedValueOnce(new Error('coordination unavailable'))
      .mockResolvedValue([]);
    const monitor = new DistributedHealthMonitor(app as never, {} as never, options({ discover }));

    await monitor.initialize();
    expect(monitor.isReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.isReady()).toBe(true);
    expect(discover).toHaveBeenCalledTimes(2);
    await monitor.cleanup();
  });
});
