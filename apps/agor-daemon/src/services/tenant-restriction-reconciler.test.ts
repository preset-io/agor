import { getCurrentTenantId } from '@agor/core/db';
import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  refs: [] as Array<{ task_id: string; tenant_id: string; cursor: unknown }>,
  active: vi.fn<(tenantId: string | undefined) => Promise<boolean>>(),
  begin: vi.fn(async () => ({})),
}));

vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  isPostgresDatabaseHandle: () => true,
  runWithSystemDatabaseScope: (_db: unknown, _label: string, work: (scoped: unknown) => unknown) =>
    work({}),
  TaskRepository: class {
    findRestrictionRuntimeRefs = async () => fixture.refs;
  },
}));
vi.mock('../auth/tenant-access.js', async () => {
  const { getCurrentTenantId: current } = await import('@agor/core/db');
  return { isCurrentTenantRuntimeActive: () => fixture.active(current()) };
});
vi.mock('../termination-coordinator.js', () => ({ beginExecutorTermination: fixture.begin }));

import { TenantRestrictionReconciler } from './tenant-restriction-reconciler.js';

describe('TenantRestrictionReconciler pass', () => {
  it('reads each tenant once per pass and counts a failed read against every task of that tenant', async () => {
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
      expect(fixture.active.mock.calls.map(([tenantId]) => tenantId)).toEqual([
        'restricted',
        'unreadable',
        'open',
      ]);
      expect(
        fixture.begin.mock.calls.map(([input]) => (input as { taskId: string }).taskId)
      ).toEqual(['a-1', 'a-2']);

      // The memo never outlives its pass.
      await reconciler.checkOnce();
      expect(fixture.active).toHaveBeenCalledTimes(6);
      expect(getCurrentTenantId()).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});
