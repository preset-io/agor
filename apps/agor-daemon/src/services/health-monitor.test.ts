import { EventEmitter } from 'node:events';
import { ENVIRONMENT } from '@agor/core/config';
import { getCurrentTenantId, runWithTenantDatabaseScope } from '@agor/core/db';
import type { Branch } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthMonitor } from './health-monitor';

class BranchServiceMock extends EventEmitter {
  find = vi.fn(async () => []);
  get = vi.fn(async (branchId: string) =>
    makeBranch({ branch_id: branchId, environment_instance: { status: 'running' } })
  );
  checkHealth = vi.fn(async () => undefined);
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
    monitor.cleanup();
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
    expect(branches.checkHealth).toHaveBeenCalledWith('branch-tenant-a', {
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
    });
    expect(branches.checkHealth).toHaveBeenCalledWith('branch-tenant-b', {
      tenant: { tenant_id: 'tenant-b', source: 'auth_claim' },
    });
    monitor.cleanup();
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
    monitor.cleanup();
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
    monitor.cleanup();
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

    await vi.waitFor(() => expect(branches.get).toHaveBeenCalled());
    expect(branches.get).toHaveBeenCalledWith('branch-tenant-a', {
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
    });
    expect(branches.checkHealth).toHaveBeenCalledWith('branch-tenant-a', {
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
    });
    monitor.cleanup();
  });

  it('enters the branch tenant DB scope instead of inheriting stale timer scope', async () => {
    const branches = new BranchServiceMock();
    const ambientTenantIds: Array<string | undefined> = [];
    branches.get.mockImplementation(async (branchId: string) => {
      ambientTenantIds.push(getCurrentTenantId());
      return makeBranch({
        branch_id: branchId,
        tenant_id: 'tenant-a',
        environment_instance: { status: 'running' },
      });
    });
    branches.checkHealth.mockImplementation(async () => {
      ambientTenantIds.push(getCurrentTenantId());
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

    expect(ambientTenantIds).toEqual(['tenant-a', 'tenant-a']);
    monitor.cleanup();
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
    monitor.cleanup();
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
    monitor.cleanup();
  });

  it('does not overlap slow health checks for the same branch', async () => {
    const branches = new BranchServiceMock();
    let releaseCheck: (() => void) | undefined;
    branches.checkHealth.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseCheck = resolve;
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
    monitor.cleanup();
  });

  it('cleanup cancels pending grace timers', async () => {
    const branches = new BranchServiceMock();
    const monitor = new HealthMonitor(makeApp(branches) as never);

    branches.emit('patched', makeBranch({ environment_instance: { status: 'running' } }));
    monitor.cleanup();

    await vi.advanceTimersByTimeAsync(ENVIRONMENT.STARTUP_GRACE_PERIOD_MS);
    expect(branches.checkHealth).not.toHaveBeenCalled();
    expect(monitor.getStatus().monitoringCount).toBe(0);
  });
});
