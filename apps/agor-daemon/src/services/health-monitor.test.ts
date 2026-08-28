import { EventEmitter } from 'node:events';
import { ENVIRONMENT } from '@agor/core/config';
import { getCurrentTenantId, runWithTenantDatabaseScope } from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { Branch } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleService, type Repository } from '../adapters/drizzle.js';
import { HealthMonitor } from './health-monitor';

class BranchServiceMock extends EventEmitter {
  find = vi.fn(async () => []);
  get = vi.fn(async (branchId: string) =>
    makeBranch({ branch_id: branchId, environment_instance: { status: 'running' } })
  );
  checkHealth = vi.fn(
    async (branchId: string): Promise<Branch | undefined> =>
      makeBranch({ branch_id: branchId, environment_instance: { status: 'running' } })
  );
}

function makeBranch(overrides: Partial<Branch> & { tenant_id?: string } = {}): Branch {
  return {
    branch_id: 'branch-1',
    repo_id: 'repo-1',
    name: 'branch-1',
    path: '/tmp/branch-1',
    ref: 'branch-1',
    ref_type: 'branch',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'user-1',
    ...overrides,
  } as Branch;
}

function makeApp(branches: BranchServiceMock) {
  return {
    service: vi.fn((path: string) => {
      if (path === 'branches') return branches;
      throw new Error(`Unexpected service: ${path}`);
    }),
  };
}

describe('HealthMonitor tenant context', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses startup tenant params for the initial background scan', async () => {
    const branches = new BranchServiceMock();
    const defaultParams = { tenant: { tenant_id: 'default', source: 'static' as const } };
    const monitor = new HealthMonitor(makeApp(branches) as never, { defaultParams });

    await monitor.initialize();

    expect(branches.find).toHaveBeenCalledWith({
      ...defaultParams,
      query: { $limit: 1000 },
      paginate: false,
    });
    await monitor.cleanup();
  });

  it('discovers active environments by tenant metadata on startup', async () => {
    const branches = new BranchServiceMock();
    branches.get.mockImplementation(async (branchId: string) =>
      makeBranch({
        branch_id: branchId,
        tenant_id: branchId === 'branch-tenant-a' ? 'tenant-a' : 'tenant-b',
        environment_instance: { status: 'running' },
      })
    );
    const monitor = new HealthMonitor(makeApp(branches) as never, {
      requireTenantParams: true,
      discoverActiveEnvironmentRefs: async () => [
        { branchId: 'branch-tenant-a' as never, tenantId: 'tenant-a' },
        { branchId: 'branch-tenant-b' as never, tenantId: 'tenant-b' },
      ],
    });

    await monitor.initialize();

    expect(branches.find).not.toHaveBeenCalled();
    expect(branches.get).toHaveBeenCalledWith('branch-tenant-a', {
      tenant: { tenant_id: 'tenant-a', source: 'explicit' },
    });
    expect(branches.get).toHaveBeenCalledWith('branch-tenant-b', {
      tenant: { tenant_id: 'tenant-b', source: 'explicit' },
    });

    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);

    await vi.waitFor(() => expect(branches.checkHealth).toHaveBeenCalledTimes(2));
    expect(branches.checkHealth).toHaveBeenCalledWith(
      'branch-tenant-a',
      { tenant: { tenant_id: 'tenant-a', source: 'auth_claim' } },
      { signal: expect.any(AbortSignal), intent: 'automatic' }
    );
    expect(branches.checkHealth).toHaveBeenCalledWith(
      'branch-tenant-b',
      { tenant: { tenant_id: 'tenant-b', source: 'auth_claim' } },
      { signal: expect.any(AbortSignal), intent: 'automatic' }
    );
    await monitor.cleanup();
  });

  it('uses the configured static tenant for startup discovery refs without tenant metadata', async () => {
    const branches = new BranchServiceMock();
    const monitor = new HealthMonitor(makeApp(branches) as never, {
      tenantId: 'default',
      discoverActiveEnvironmentRefs: async () => [{ branchId: 'branch-static' as never }],
    });

    await monitor.initialize();

    expect(branches.get).toHaveBeenCalledWith('branch-static', {
      tenant: { tenant_id: 'default', source: 'static' },
    });
    await monitor.cleanup();
  });

  it('revalidates startup discovery refs and excludes an archived active row', async () => {
    const branches = new BranchServiceMock();
    branches.get.mockResolvedValue(
      makeBranch({ archived: true, environment_instance: { status: 'running' } })
    );
    const monitor = new HealthMonitor(makeApp(branches) as never, {
      tenantId: 'default',
      discoverActiveEnvironmentRefs: async () => [{ branchId: 'branch-archived' as never }],
    });

    await monitor.initialize();
    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);

    expect(monitor.getStatus().monitoringCount).toBe(0);
    expect(branches.checkHealth).not.toHaveBeenCalled();
    await monitor.cleanup();
  });

  it('fails closed when required tenant metadata is missing for event-driven monitoring', async () => {
    const branches = new BranchServiceMock();
    const monitor = new HealthMonitor(makeApp(branches) as never, {
      requireTenantParams: true,
    });

    branches.emit(
      'patched',
      makeBranch({
        branch_id: 'branch-without-tenant',
        environment_instance: { status: 'running' },
      })
    );

    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);

    expect(branches.get).not.toHaveBeenCalled();
    expect(branches.checkHealth).not.toHaveBeenCalled();
    await monitor.cleanup();
  });

  it('uses branch tenant_id for event-driven background health checks', async () => {
    const branches = new BranchServiceMock();
    const monitor = new HealthMonitor(makeApp(branches) as never, {
      defaultParams: { tenant: { tenant_id: 'default', source: 'static' } },
      db: { run: vi.fn() } as never,
    });

    branches.emit(
      'patched',
      makeBranch({
        branch_id: 'branch-tenant-a',
        tenant_id: 'tenant-a',
        environment_instance: { status: 'running' },
      })
    );

    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);

    expect(branches.get).not.toHaveBeenCalled();
    expect(branches.checkHealth).toHaveBeenCalledWith(
      'branch-tenant-a',
      { tenant: { tenant_id: 'tenant-a', source: 'auth_claim' } },
      { signal: expect.any(AbortSignal), intent: 'automatic' }
    );
    await monitor.cleanup();
  });

  it('enters the branch tenant DB scope instead of inheriting stale timer scope', async () => {
    const branches = new BranchServiceMock();
    const ambientTenantIds: Array<string | undefined> = [];
    branches.checkHealth.mockImplementation(async (branchId: string) => {
      ambientTenantIds.push(getCurrentTenantId());
      return makeBranch({
        branch_id: branchId,
        tenant_id: 'tenant-a',
        environment_instance: { status: 'running' },
      });
    });

    const monitor = new HealthMonitor(makeApp(branches) as never, {
      defaultParams: { tenant: { tenant_id: 'default', source: 'static' } },
      db: { run: vi.fn() } as never,
    });

    await runWithTenantDatabaseScope({ run: vi.fn() } as never, 'stale-transaction', async () => {
      branches.emit(
        'patched',
        makeBranch({
          branch_id: 'branch-tenant-a',
          tenant_id: 'tenant-a',
          environment_instance: { status: 'running' },
        })
      );
    });

    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);
    await vi.waitFor(() => expect(branches.checkHealth).toHaveBeenCalledTimes(1));

    expect(ambientTenantIds).toEqual(['tenant-a']);
    await monitor.cleanup();
  });

  it('deduplicates repeated lifecycle patches during the startup grace period', async () => {
    const branches = new BranchServiceMock();
    const monitor = new HealthMonitor(makeApp(branches) as never);
    const branch = makeBranch({ environment_instance: { status: 'running' } });

    branches.emit('patched', branch);
    branches.emit('patched', branch);
    branches.emit('patched', branch);

    expect(monitor.getStatus()).toMatchObject({
      monitoringCount: 1,
      monitoredBranches: [branch.branch_id],
    });

    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);
    await vi.waitFor(() => expect(branches.checkHealth).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(ENVIRONMENT.HEALTH_CHECK_INTERVAL_MS * 2);
    await vi.waitFor(() => expect(branches.checkHealth).toHaveBeenCalledTimes(3));
    expect(branches.get).not.toHaveBeenCalled();
    await monitor.cleanup();
  });

  it('performs no Feathers branch point reads during an hour of steady polling', async () => {
    const branches = new BranchServiceMock();
    const monitor = new HealthMonitor(makeApp(branches) as never);

    branches.emit(
      'patched',
      makeBranch({ branch_id: 'steady-branch', environment_instance: { status: 'running' } })
    );
    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    // One immediate observation after the grace period plus 720 five-second
    // interval observations. Before this fix the monitor also issued exactly
    // 721 branches.get calls, each duplicating checkHealth's canonical load.
    expect(branches.checkHealth).toHaveBeenCalledTimes(721);
    expect(branches.get).not.toHaveBeenCalled();
    await monitor.cleanup();
  });

  it('stops polling from the canonical checkHealth result when a lifecycle hint is missed', async () => {
    const branches = new BranchServiceMock();
    branches.checkHealth
      .mockResolvedValueOnce(
        makeBranch({ branch_id: 'stopping-branch', environment_instance: { status: 'stopped' } })
      )
      .mockResolvedValue(
        makeBranch({ branch_id: 'stopping-branch', environment_instance: { status: 'running' } })
      );
    const monitor = new HealthMonitor(makeApp(branches) as never);

    branches.emit(
      'patched',
      makeBranch({ branch_id: 'stopping-branch', environment_instance: { status: 'running' } })
    );
    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);
    await vi.waitFor(() => expect(branches.checkHealth).toHaveBeenCalledOnce());
    expect(monitor.getStatus().monitoringCount).toBe(0);

    await vi.advanceTimersByTimeAsync(ENVIRONMENT.HEALTH_CHECK_INTERVAL_MS * 2);
    expect(branches.checkHealth).toHaveBeenCalledOnce();
    expect(branches.get).not.toHaveBeenCalled();
    await monitor.cleanup();
  });

  it('cancels a pending grace check when the environment stops', async () => {
    const branches = new BranchServiceMock();
    const monitor = new HealthMonitor(makeApp(branches) as never);
    const branch = makeBranch({ environment_instance: { status: 'starting' } });

    branches.emit('patched', branch);
    branches.emit(
      'patched',
      makeBranch({
        branch_id: branch.branch_id,
        environment_instance: { status: 'stopped' },
      })
    );

    expect(monitor.getStatus().monitoringCount).toBe(0);
    await vi.advanceTimersByTimeAsync(
      ENVIRONMENT.STARTUP_GRACE_PERIOD_MS + ENVIRONMENT.HEALTH_CHECK_INTERVAL_MS
    );
    expect(branches.checkHealth).not.toHaveBeenCalled();
    await monitor.cleanup();
  });

  it('cancels a pending grace check when an active environment is archived', async () => {
    const branches = new BranchServiceMock();
    const monitor = new HealthMonitor(makeApp(branches) as never);
    const branch = makeBranch({ environment_instance: { status: 'starting' } });

    branches.emit('patched', branch);
    branches.emit('patched', makeBranch({ ...branch, archived: true }));

    expect(monitor.getStatus().monitoringCount).toBe(0);
    await vi.advanceTimersByTimeAsync(
      ENVIRONMENT.STARTUP_GRACE_PERIOD_MS + ENVIRONMENT.HEALTH_CHECK_INTERVAL_MS
    );
    expect(branches.checkHealth).not.toHaveBeenCalled();
    await monitor.cleanup();
  });

  it('cancels a pending grace check when the branch is deleted', async () => {
    const branches = new BranchServiceMock();
    const monitor = new HealthMonitor(makeApp(branches) as never);
    const branch = makeBranch({ environment_instance: { status: 'running' } });

    branches.emit('patched', branch);
    branches.emit('removed', branch);

    await vi.advanceTimersByTimeAsync(
      ENVIRONMENT.STARTUP_GRACE_PERIOD_MS + ENVIRONMENT.HEALTH_CHECK_INTERVAL_MS
    );
    expect(monitor.getStatus().monitoringCount).toBe(0);
    expect(branches.checkHealth).not.toHaveBeenCalled();
    await monitor.cleanup();
  });

  it('stops monitoring when the canonical health check misses a deleted branch', async () => {
    const repository: Repository<Branch> = {
      create: vi.fn(),
      findById: vi.fn(async () => null),
      findAll: vi.fn(async () => []),
      update: vi.fn(),
      delete: vi.fn(),
    };
    const branchAdapter = new DrizzleService<Branch>(repository, {
      id: 'branch_id',
      resourceType: 'Branch',
    });
    Object.assign(branchAdapter, {
      checkHealth: vi.fn(async (branchId: string) => branchAdapter.get(branchId)),
    });
    const app = feathers();
    app.use('branches', branchAdapter as never);
    const branches = app.service('branches') as unknown as BranchServiceMock;
    const monitor = new HealthMonitor(app as never);

    branches.emit(
      'patched',
      makeBranch({ branch_id: 'branch-1', environment_instance: { status: 'running' } })
    );
    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);
    await vi.waitFor(() => expect(repository.findById).toHaveBeenCalledOnce());

    expect(monitor.getStatus().monitoringCount).toBe(0);
    expect(branches.checkHealth).toHaveBeenCalledOnce();
    await monitor.cleanup();
  });

  it.each(['stopped', 'stopping', 'error'] as const)(
    'does not monitor an environment in %s state',
    async (status) => {
      const branches = new BranchServiceMock();
      const monitor = new HealthMonitor(makeApp(branches) as never);

      branches.emit('patched', makeBranch({ environment_instance: { status } }));
      await vi.advanceTimersByTimeAsync(
        ENVIRONMENT.STARTUP_GRACE_PERIOD_MS + ENVIRONMENT.HEALTH_CHECK_INTERVAL_MS
      );

      expect(monitor.getStatus().monitoringCount).toBe(0);
      expect(branches.checkHealth).not.toHaveBeenCalled();
      await monitor.cleanup();
    }
  );

  it.each(['starting', 'running'] as const)(
    'monitors an environment in %s state',
    async (status) => {
      const branches = new BranchServiceMock();
      branches.get.mockResolvedValue(makeBranch({ environment_instance: { status } }));
      const monitor = new HealthMonitor(makeApp(branches) as never);

      branches.emit('patched', makeBranch({ environment_instance: { status } }));
      await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);

      await vi.waitFor(() => expect(branches.checkHealth).toHaveBeenCalledOnce());
      await monitor.cleanup();
    }
  );

  it('does not overlap slow health checks for the same branch', async () => {
    const branches = new BranchServiceMock();
    let releaseCheck: (() => void) | undefined;
    branches.checkHealth.mockImplementation(
      () =>
        new Promise<Branch>((resolve) => {
          releaseCheck = () => resolve(makeBranch({ environment_instance: { status: 'running' } }));
        })
    );
    const monitor = new HealthMonitor(makeApp(branches) as never);

    branches.emit('patched', makeBranch({ environment_instance: { status: 'running' } }));
    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);
    await vi.waitFor(() => expect(branches.checkHealth).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(ENVIRONMENT.HEALTH_CHECK_INTERVAL_MS * 3);
    expect(branches.checkHealth).toHaveBeenCalledTimes(1);

    releaseCheck?.();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(ENVIRONMENT.HEALTH_CHECK_INTERVAL_MS);
    await vi.waitFor(() => expect(branches.checkHealth).toHaveBeenCalledTimes(2));
    releaseCheck?.();
    await vi.runAllTicks();
    await monitor.cleanup();
  });

  it('cleanup cancels pending grace timers', async () => {
    const branches = new BranchServiceMock();
    const monitor = new HealthMonitor(makeApp(branches) as never);

    branches.emit('patched', makeBranch({ environment_instance: { status: 'running' } }));
    await monitor.cleanup();

    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);
    expect(branches.checkHealth).not.toHaveBeenCalled();
    expect(monitor.getStatus().monitoringCount).toBe(0);
  });

  it('stop aborts an in-flight check and cleanup unregisters lifecycle listeners', async () => {
    const branches = new BranchServiceMock();
    let signal: AbortSignal | undefined;
    branches.checkHealth.mockImplementation(
      async (_id: string, _params: unknown, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
      }
    );
    const monitor = new HealthMonitor(makeApp(branches) as never);
    const running = makeBranch({ environment_instance: { status: 'running' } });

    branches.emit('patched', running);
    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);
    await vi.waitFor(() => expect(branches.checkHealth).toHaveBeenCalledOnce());

    branches.emit(
      'patched',
      makeBranch({ branch_id: running.branch_id, environment_instance: { status: 'stopped' } })
    );
    expect(signal?.aborted).toBe(true);
    expect(monitor.getStatus().monitoringCount).toBe(0);

    await monitor.cleanup();
    branches.emit('patched', running);
    expect(monitor.getStatus().monitoringCount).toBe(0);
  });

  it('cleanup aborts and drains an in-flight check', async () => {
    const branches = new BranchServiceMock();
    let signal: AbortSignal | undefined;
    let releaseCheck: (() => void) | undefined;
    branches.checkHealth.mockImplementation(
      async (_id: string, _params: unknown, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        await new Promise<void>((resolve) => {
          releaseCheck = resolve;
        });
      }
    );
    const monitor = new HealthMonitor(makeApp(branches) as never);

    branches.emit('patched', makeBranch({ environment_instance: { status: 'running' } }));
    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);
    await vi.waitFor(() => expect(branches.checkHealth).toHaveBeenCalledOnce());

    let cleanupSettled = false;
    const cleanup = monitor.cleanup().then(() => {
      cleanupSettled = true;
    });

    expect(signal?.aborted).toBe(true);
    expect(monitor.getStatus().monitoringCount).toBe(0);
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    releaseCheck?.();
    await cleanup;
    expect(cleanupSettled).toBe(true);
  });

  it('bounds cleanup draining when in-flight work ignores cancellation', async () => {
    const branches = new BranchServiceMock();
    let signal: AbortSignal | undefined;
    branches.checkHealth.mockImplementation(
      async (_id: string, _params: unknown, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        await new Promise<void>(() => undefined);
      }
    );
    const monitor = new HealthMonitor(makeApp(branches) as never, {
      shutdownDrainTimeoutMs: 100,
    });

    branches.emit('patched', makeBranch({ environment_instance: { status: 'running' } }));
    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);
    await vi.waitFor(() => expect(branches.checkHealth).toHaveBeenCalledOnce());

    let cleanupSettled = false;
    const cleanup = monitor.cleanup().then(() => {
      cleanupSettled = true;
    });
    expect(signal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(99);
    expect(cleanupSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await cleanup;
    expect(cleanupSettled).toBe(true);
  });
});
