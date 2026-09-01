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
    expect(
      () =>
        new DistributedHealthMonitor(app as never, {} as never, options({ scanBatchSize: 1_001 }))
    ).toThrow('cannot exceed 1000');
    expect(
      () =>
        new DistributedHealthMonitor(
          app as never,
          {} as never,
          options({
            scanIntervalMs: 300_000,
            maxIdleIntervalMs: 300_000,
            claimLeaseMs: 6_000,
          })
        )
    ).not.toThrow();
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
      traversalCompleted: false,
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

  it('visits multi-tenant discovery pages once without re-probing earlier pages', async () => {
    const { app } = makeApp();
    const pages = [
      [
        { tenant_id: 'tenant-a', branch_id: 'branch-a' },
        { tenant_id: 'tenant-b', branch_id: 'branch-b' },
      ],
      [
        { tenant_id: 'tenant-c', branch_id: 'branch-c' },
        { tenant_id: 'tenant-d', branch_id: 'branch-d' },
      ],
      [],
    ];
    const discover = vi.fn(async () => pages.shift() ?? []);
    const monitor = new DistributedHealthMonitor(
      app as never,
      {} as never,
      options({ scanBatchSize: 2, maxInFlight: 1, discover: discover as never })
    );
    const observed: string[] = [];
    vi.spyOn(
      monitor as unknown as {
        observeClaim: (
          tenantId: string,
          branchId: string
        ) => Promise<{
          claimed: number;
          committed: number;
          failed: number;
        }>;
      },
      'observeClaim'
    ).mockImplementation(async (tenantId, branchId) => {
      observed.push(`${tenantId}/${branchId}`);
      return { claimed: 1, committed: 1, failed: 0 };
    });

    await monitor.checkOnce();
    await monitor.checkOnce();
    await monitor.checkOnce();

    expect(observed).toEqual([
      'tenant-a/branch-a',
      'tenant-b/branch-b',
      'tenant-c/branch-c',
      'tenant-d/branch-d',
    ]);
  });

  it('awaits sibling observations and isolates a candidate failure', async () => {
    const { app } = makeApp();
    let finishSibling: (() => void) | undefined;
    const monitor = new DistributedHealthMonitor(
      app as never,
      {} as never,
      options({
        scanBatchSize: 2,
        maxInFlight: 2,
        discover: async () => [
          { tenant_id: 'tenant-a' as never, branch_id: 'branch-a' as never },
          { tenant_id: 'tenant-b' as never, branch_id: 'branch-b' as never },
        ],
      })
    );
    vi.spyOn(
      monitor as unknown as {
        observeClaim: (
          tenantId: string,
          branchId: string
        ) => Promise<{
          claimed: number;
          committed: number;
          failed: number;
        }>;
      },
      'observeClaim'
    ).mockImplementation(async (_tenantId, branchId) => {
      if (branchId === 'branch-a') throw new Error('candidate failed');
      await new Promise<void>((resolve) => {
        finishSibling = resolve;
      });
      return { claimed: 1, committed: 1, failed: 0 };
    });

    const scan = monitor.checkOnce();
    await vi.waitFor(() => expect(finishSibling).toBeTypeOf('function'));
    let settled = false;
    void scan.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishSibling?.();

    await expect(scan).resolves.toMatchObject({ committed: 1, failures: 1 });
  });
});

describe('DistributedHealthMonitor remote environment probe resolution', () => {
  /**
   * A remote environment (a Codespace) has no frozen `health_check_url` — the
   * reachable address does not exist until it starts, so the lifecycle command
   * reports it as a `health` fact. Without the fact fallback here every remote
   * environment is permanently "not observable" under HA and can never leave
   * `starting`, which is the entire codespaces variant.
   */
  const CS_HEALTH = 'https://cs-abc-8088.app.github.dev/health';

  const observe = async (
    branch: Record<string, unknown>,
    fetchHealth: typeof fetch,
    fetchDynamicHealth: typeof fetch
  ) => {
    const { app } = makeApp();
    const monitor = new DistributedHealthMonitor(
      app as never,
      {} as never,
      options({ fetchHealth, fetchDynamicHealth })
    );
    return (
      monitor as unknown as {
        fetchObservation(b: unknown, c: AbortController): Promise<Record<string, unknown> | null>;
      }
    ).fetchObservation(branch, new AbortController());
  };

  it('probes the `health` fact when no health_check_url is configured', async () => {
    const fetchHealth = vi.fn();
    const fetchDynamicHealth = vi.fn(
      async () => ({ ok: true, status: 200, statusText: 'OK' }) as Response
    );

    const observation = await observe(
      { environment_instance: { status: 'starting', facts: { health: CS_HEALTH } } },
      fetchHealth as never,
      fetchDynamicHealth as never
    );

    expect(fetchDynamicHealth).toHaveBeenCalledWith(CS_HEALTH, expect.anything());
    expect(fetchHealth).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ status: 'healthy', message: 'HTTP 200' });
  });

  it('prefers an operator-configured health_check_url over the fact', async () => {
    const fetchHealth = vi.fn(
      async () => ({ ok: true, status: 200, statusText: 'OK' }) as Response
    );
    const fetchDynamicHealth = vi.fn();

    await observe(
      {
        health_check_url: 'https://configured.example.com/health',
        environment_instance: { facts: { health: CS_HEALTH } },
      },
      fetchHealth as never,
      fetchDynamicHealth as never
    );

    expect(fetchHealth).toHaveBeenCalledWith(
      'https://configured.example.com/health',
      expect.anything()
    );
    expect(fetchDynamicHealth).not.toHaveBeenCalled();
  });

  it('refuses a fact pointing at an internal destination and does not probe it', async () => {
    const fetchHealth = vi.fn(
      async () => ({ ok: true, status: 200, statusText: 'OK' }) as Response
    );
    const fetchDynamicHealth = vi.fn();

    // Facts are command output — untrusted input, so SSRF targets must not be
    // probed just because a lifecycle command emitted them.
    const observation = await observe(
      { environment_instance: { facts: { health: 'http://169.254.169.254/latest/meta-data' } } },
      fetchHealth as never,
      fetchDynamicHealth as never
    );

    expect(fetchHealth).not.toHaveBeenCalled();
    expect(fetchDynamicHealth).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ status: 'unknown' });
    expect(String((observation as { message: string }).message)).toContain('disallowed');
  });

  it('still reports unobservable when there is no URL and no fact', async () => {
    const fetchHealth = vi.fn();
    const fetchDynamicHealth = vi.fn();

    const observation = await observe(
      { environment_instance: { status: 'starting' } },
      fetchHealth as never,
      fetchDynamicHealth as never
    );

    expect(fetchHealth).not.toHaveBeenCalled();
    expect(fetchDynamicHealth).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ status: 'unknown' });
  });
});
