import { getCurrentTenantId } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  refs: [] as Array<{ task_id: string; tenant_id?: string; cursor: unknown }>,
  restricted: vi.fn<() => Promise<string[]>>(),
  pageTenants: [] as Array<readonly string[] | undefined>,
  active: vi.fn<(tenantId: string | undefined) => Promise<boolean>>(),
  begin: vi.fn(async () => ({})),
}));

vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  isPostgresDatabaseHandle: () => true,
  runWithSystemDatabaseScope: (_db: unknown, _label: string, work: (scoped: unknown) => unknown) =>
    work({}),
  listRestrictedTenantIds: () => fixture.restricted(),
  TaskRepository: class {
    findRestrictionRuntimeRefs = async (_options: unknown, tenantIds?: readonly string[]) => {
      fixture.pageTenants.push(tenantIds);
      return fixture.refs;
    };
  },
}));
vi.mock('../auth/tenant-access.js', async () => {
  const { getCurrentTenantId: current } = await import('@agor/core/db');
  return {
    TENANT_RESTRICTION_OBSERVATION_MS: 1000,
    isCurrentTenantRuntimeActive: () => fixture.active(current()),
  };
});
vi.mock('../termination-coordinator.js', () => ({ beginExecutorTermination: fixture.begin }));

import { TenantRestrictionReconciler } from './tenant-restriction-reconciler.js';

describe('TenantRestrictionReconciler pass', () => {
  beforeEach(() => {
    fixture.refs = [];
    fixture.pageTenants = [];
    fixture.restricted.mockReset();
    fixture.active.mockReset();
    fixture.begin.mockClear();
  });

  it('pages no tasks and reads no tenant when nothing is restricted', async () => {
    fixture.restricted.mockResolvedValue([]);
    const reconciler = new TenantRestrictionReconciler({} as never, {} as never);

    expect(await reconciler.checkOnce()).toEqual({ candidates: 0, stopping: 0, failures: 0 });
    expect(fixture.pageTenants).toEqual([]);
    expect(fixture.active).not.toHaveBeenCalled();
  });

  it('checks the static tenant once and pages nothing while it is open', async () => {
    fixture.active.mockResolvedValue(true);
    const reconciler = new TenantRestrictionReconciler({} as never, {} as never, 'static');

    expect(await reconciler.checkOnce()).toEqual({ candidates: 0, stopping: 0, failures: 0 });
    expect(fixture.active.mock.calls).toEqual([['static']]);
    expect(fixture.pageTenants).toEqual([]);
    expect(fixture.restricted).not.toHaveBeenCalled();
  });

  it('pages only restricted tenants and reads each tenant once per pass', async () => {
    fixture.restricted.mockResolvedValue(['restricted', 'unreadable', 'open']);
    fixture.refs = [
      { task_id: 'a-1', tenant_id: 'restricted', cursor: 1 },
      { task_id: 'b-1', tenant_id: 'unreadable', cursor: 2 },
      { task_id: 'a-2', tenant_id: 'restricted', cursor: 3 },
      { task_id: 'c-1', tenant_id: 'open', cursor: 4 },
      { task_id: 'b-2', tenant_id: 'unreadable', cursor: 5 },
    ];
    fixture.active.mockImplementation(async (tenantId) => {
      if (tenantId === 'unreadable') throw new Error('restriction read failed');
      return tenantId === 'open';
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const reconciler = new TenantRestrictionReconciler({} as never, {} as never);

      expect(await reconciler.checkOnce()).toEqual({ candidates: 5, stopping: 2, failures: 2 });
      expect(fixture.pageTenants).toEqual([['restricted', 'unreadable', 'open']]);
      expect(fixture.active.mock.calls.map(([tenantId]) => tenantId)).toEqual([
        'restricted',
        'unreadable',
        'open',
      ]);
      expect(
        fixture.begin.mock.calls.map(([input]) => (input as { taskId: string }).taskId)
      ).toEqual(['a-1', 'a-2']);
      // The memoized observation only nominates; each claim re-checks closure under the fence.
      for (const [input] of fixture.begin.mock.calls) {
        expect(input).toMatchObject({ cause: 'tenant_suspension', requireTenantClosed: true });
      }
      // Two failed stops in one pass log one warning.
      expect(warn).toHaveBeenCalledTimes(1);

      // An unsaturated page ends the pass; the memo never outlives it.
      await reconciler.checkOnce();
      expect(fixture.restricted).toHaveBeenCalledTimes(2);
      expect(fixture.active).toHaveBeenCalledTimes(6);
      expect(getCurrentTenantId()).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('shares one discovery and tenant read across saturated pages within a tick', async () => {
    let now = 0;
    fixture.restricted.mockResolvedValue(['restricted']);
    fixture.active.mockResolvedValue(false);
    fixture.refs = Array.from({ length: 50 }, (_, index) => ({
      task_id: `t-${index}`,
      tenant_id: 'restricted',
      cursor: index,
    }));
    const reconciler = new TenantRestrictionReconciler(
      {} as never,
      {} as never,
      undefined,
      () => now
    );

    await reconciler.checkOnce();
    now = 500;
    await reconciler.checkOnce();
    expect(fixture.restricted).toHaveBeenCalledTimes(1);
    expect(fixture.active).toHaveBeenCalledTimes(1);

    now = 1000;
    await reconciler.checkOnce();
    expect(fixture.restricted).toHaveBeenCalledTimes(2);
    expect(fixture.active).toHaveBeenCalledTimes(2);
  });

  it('isolates a candidate without tenant routing instead of aborting the page', async () => {
    fixture.restricted.mockResolvedValue(['restricted']);
    fixture.active.mockResolvedValue(false);
    fixture.refs = [
      { task_id: 'no-tenant', cursor: 1 },
      { task_id: 'a-1', tenant_id: 'restricted', cursor: 2 },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const reconciler = new TenantRestrictionReconciler({} as never, {} as never);
      expect(await reconciler.checkOnce()).toEqual({ candidates: 2, stopping: 1, failures: 1 });
      expect(
        fixture.begin.mock.calls.map(([input]) => (input as { taskId: string }).taskId)
      ).toEqual(['a-1']);
    } finally {
      warn.mockRestore();
    }
  });
});
