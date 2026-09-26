import { expect, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import { ownedDbTest as test } from '../test-helpers';
import { BranchDeletionRepository } from './branch-deletion';
import { BranchMaintenanceRepository } from './branch-maintenance';
import { BranchRepository } from './branches';
import { seedEnvironmentCommandBranch } from './environment-commands.test-support';

test('finalization requires verified storage and drained data, and deletes branch only after final callback', async ({
  db,
}) => {
  const { branch } = await seedEnvironmentCommandBranch(db);
  const { branch: neighbor } = await seedEnvironmentCommandBranch(db);
  await new BranchRepository(db).update(neighbor.branch_id, { path: '/tmp/neighbor-fixture' });
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'delete');
  const invocation = await maintenance.beginExecution(claim);
  await maintenance.claimExecution(claim, invocation);
  const deletion = new BranchDeletionRepository(db);
  await expect(deletion.verifyStorage(claim, generateId())).rejects.toThrow();
  await expect(deletion.deleteDataPage(claim, invocation)).rejects.toThrow('storage');
  const beforeRemove = vi.fn(async () => {});
  await expect(deletion.finalize(claim, invocation, beforeRemove)).rejects.toThrow('steps');
  expect(beforeRemove).not.toHaveBeenCalled();
  await deletion.verifyStorage(claim, invocation);
  for (let i = 0; ; i++) {
    expect(i).toBeLessThan(30);
    const page = await deletion.deleteDataPage(claim, invocation);
    expect(await new BranchRepository(db).findById(branch.branch_id)).not.toBeNull();
    if (!page.remaining) break;
  }
  await expect(
    deletion.finalize(claim, invocation, async () => {
      throw new Error('fixture visibility failure');
    })
  ).rejects.toThrow('fixture visibility');
  expect(await new BranchRepository(db).findById(branch.branch_id)).not.toBeNull();
  await deletion.finalize(claim, invocation, beforeRemove);
  expect(beforeRemove).toHaveBeenCalledOnce();
  expect(await new BranchRepository(db).findById(branch.branch_id)).toBeNull();
  expect(await new BranchRepository(db).findById(neighbor.branch_id)).not.toBeNull();
});

test('a settled failure keeps the branch fenced and rejects stale callbacks after retry', async ({
  db,
}) => {
  const { branch } = await seedEnvironmentCommandBranch(db);
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'delete');
  const invocation = await maintenance.beginExecution(claim);
  await maintenance.claimExecution(claim, invocation);
  const deletion = new BranchDeletionRepository(db);
  await deletion.failSettled(claim, invocation, 'Required storage removal failed');
  const failed = await new BranchRepository(db).findById(branch.branch_id);
  expect(failed?.deletion_status).toBe('deletion_failed');
  expect(failed?.deletion_error).toBe('Required storage removal failed');
  const retry = await maintenance.claim(branch.branch_id, 'delete');
  expect(retry.acquired).toBe(true);
  await expect(deletion.verifyStorage(claim, invocation)).rejects.toThrow();
  await expect(new BranchRepository(db).delete(branch.branch_id)).rejects.toThrow('Metadata-only');
});
