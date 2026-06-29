import { EventEmitter } from 'node:events';
import { ENVIRONMENT } from '@agor/core/config';
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

  it('uses branch tenant_id for event-driven background health checks', async () => {
    const branches = new BranchServiceMock();
    const monitor = new HealthMonitor(makeApp(branches) as never, {
      defaultParams: { tenant: { tenant_id: 'default', source: 'static' } },
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
});
