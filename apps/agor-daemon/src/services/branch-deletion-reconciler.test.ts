import { BranchMaintenanceRepository, BranchRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { ownedDbTest as test } from '../../../../packages/core/src/db/test-helpers';
import { BranchDeletionReconciler } from './branch-deletion-reconciler';

test('existing-loop observer marks stale deletion failed but cannot dispatch or release an unknown invocation', async ({
  db,
}) => {
  const { branch } = await seedEnvironmentCommandBranch(db);
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'delete');
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    const invocation = await maintenance.beginExecution(claim);
    await maintenance.claimExecution(claim, invocation);
    const emit = vi.fn();
    const observer = new BranchDeletionReconciler(
      db,
      { service: () => ({ emit }) } as unknown as Application,
      'default'
    );
    await observer.checkOnce();
    expect((await new BranchRepository(db).findById(branch.branch_id))?.deletion_status).toBe(
      'deleting'
    );
    vi.setSystemTime(new Date('2026-09-15T00:03:00Z'));
    await observer.checkOnce();
    expect((await new BranchRepository(db).findById(branch.branch_id))?.deletion_status).toBe(
      'deletion_failed'
    );
    expect((await maintenance.claim(branch.branch_id, 'delete')).acquired).toBe(false);
    await expect(maintenance.beginExecution(claim)).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
});
