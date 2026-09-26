import { expect } from 'vitest';
import { BoardRepository } from './repositories/boards';
import { BranchMaintenanceRepository } from './repositories/branch-maintenance';
import { BranchRepository } from './repositories/branches';
import { seedEnvironmentCommandBranch } from './repositories/environment-commands.test-support';
import { UserPrimaryTeammateRepository } from './repositories/user-primary-teammate';
import { dbTest } from './test-helpers';

dbTest(
  'canonical primary designations block cleanup/archive/deletion until intentional retirement',
  async ({ db }) => {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const boards = new BoardRepository(db);
    const branches = new BranchRepository(db);
    const users = new UserPrimaryTeammateRepository(db);
    const board = await boards.create({ name: 'Fixture', created_by: user.user_id });
    await branches.update(branch.branch_id, {
      board_id: board.board_id,
      custom_context: { teammate: { kind: 'teammate', displayName: 'Fixture' } },
    });
    const maintenance = new BranchMaintenanceRepository(db);
    for (const designation of ['user', 'board']) {
      if (designation === 'user')
        await users.setPrimaryTeammate(user.user_id, branch.branch_id, { source: 'explicit' });
      else await boards.setPrimaryTeammate(board.board_id, branch.branch_id);
      for (const kind of ['cleanup', 'delete'] as const) {
        await expect(maintenance.claim(branch.branch_id, kind, user.user_id)).rejects.toThrow(
          'Primary teammate is protected'
        );
      }
      await expect(branches.update(branch.branch_id, { archived: true })).rejects.toThrow(
        'Primary teammate is protected'
      );
      if (designation === 'user') await users.clearPrimaryTeammate(user.user_id);
      else await boards.clearPrimaryTeammate(board.board_id);
    }
    // Retirement uses existing designation APIs; no new force flag or parallel state.
    const { claim } = await maintenance.claim(branch.branch_id, 'cleanup', user.user_id);
    await expect(
      users.setPrimaryTeammate(user.user_id, branch.branch_id, { source: 'explicit' })
    ).rejects.toThrow('maintenance');
    await expect(
      users.setPrimaryTeammateIfUnset(user.user_id, branch.branch_id, { source: 'default' })
    ).rejects.toThrow('maintenance');
    await expect(boards.setPrimaryTeammate(board.board_id, branch.branch_id)).rejects.toThrow(
      'maintenance'
    );
    expect(
      (await branches.claimForProvisioning(branch.branch_id, 'restore', { restore: true })).claimed
    ).toBe(false);
    await maintenance.release(claim);
    await branches.update(branch.branch_id, { archived: true });
    expect((await branches.findById(branch.branch_id))?.archived).toBe(true);
  }
);
