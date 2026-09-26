import { expect, vi } from 'vitest';
import { generateId } from '../lib/ids';
import type { TenantID, UploadMetadata, UploadRef } from '../types';
import { BoardRepository } from './repositories/boards';
import { BranchMaintenanceRepository } from './repositories/branch-maintenance';
import { BranchRepository } from './repositories/branches';
import { seedEnvironmentCommandBranch } from './repositories/environment-commands.test-support';
import { SessionRepository } from './repositories/sessions';
import { TaskRepository } from './repositories/tasks';
import { UploadRepository } from './repositories/uploads';
import { dbTest } from './test-helpers';

dbTest('a paused generic board rename cannot erase a new primary designation', async ({ db }) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const boards = new BoardRepository(db);
  const board = await boards.create({ name: 'Original', created_by: user.user_id });
  await new BranchRepository(db).update(branch.branch_id, {
    board_id: board.board_id,
    custom_context: { teammate: { kind: 'teammate', displayName: 'Fixture' } },
  });
  const read = boards.findById.bind(boards);
  // Deterministic interleaving: rename has read the old null pointer; another
  // repository commits the dedicated designation before rename writes.
  vi.spyOn(boards, 'findById').mockImplementationOnce(async (id) => {
    const stale = await read(id);
    await new BoardRepository(db).setPrimaryTeammate(board.board_id, branch.branch_id);
    return stale;
  });
  await boards.update(board.board_id, { name: 'Renamed' });
  expect(await boards.findById(board.board_id)).toMatchObject({
    name: 'Renamed',
    primary_teammate_id: branch.branch_id,
  });
  await expect(
    new BranchMaintenanceRepository(db).claim(branch.branch_id, 'cleanup')
  ).rejects.toThrow('Primary teammate is protected');
});

dbTest(
  'restore lineage fences failed retries and later nonready state even after successful recovery',
  async ({ db }) => {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const branches = new BranchRepository(db);
    const session = await new SessionRepository(db).create({
      branch_id: branch.branch_id,
      created_by: user.user_id,
      agentic_tool: 'codex',
    });
    const tasks = new TaskRepository(db);
    const attempt = () =>
      tasks.create({ session_id: session.session_id, created_by: user.user_id, status: 'queued' });
    const owner = {
      tenantId: 'default' as TenantID,
      sessionId: session.session_id,
      branchId: branch.branch_id,
      createdBy: user.user_id,
    };
    const metadata: UploadMetadata = {
      ref: String(generateId()) as UploadRef,
      name: 'fixture.txt',
      size: 1,
      mimeType: 'text/plain',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      provenance: 'browser',
    };
    const rejectProducers = async () => {
      await expect(attempt()).rejects.toThrow(/filesystem/);
      await expect(new UploadRepository(db).reserve(owner, metadata)).rejects.toThrow(/filesystem/);
    };
    await branches.update(branch.branch_id, { filesystem_status: 'cleaned' });
    await branches.claimForProvisioning(branch.branch_id, 'first', { restore: true });
    await rejectProducers();
    await branches.acknowledgeProvisioningAttempt(
      branch.branch_id,
      { filesystem_status: 'failed', error_message: 'Invalid linkage' },
      'first'
    );
    await rejectProducers();
    expect(
      (await branches.claimForProvisioning(branch.branch_id, 'retry', { restore: true })).claimed
    ).toBe(true);
    await rejectProducers();
    await branches.acknowledgeProvisioningAttempt(
      branch.branch_id,
      { filesystem_status: 'ready' },
      'retry'
    );
    expect(await attempt()).toMatchObject({ status: 'queued' });
    await new UploadRepository(db).reserve(owner, metadata);
    expect((await branches.findById(branch.branch_id))?.provisioning_operation).toBe('restore');
    // Readiness releases admission, not lineage. A subsequent Clean must not
    // turn a recovered branch back into an unfenced legacy workspace.
    await branches.update(branch.branch_id, { filesystem_status: 'cleaned' });
    await rejectProducers();
  }
);

for (const status of ['preserved', 'cleaned', 'failed'] as const) {
  dbTest(`legacy ${status} is not retroactively fenced as a recovery`, async ({ db }) => {
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const session = await new SessionRepository(db).create({
      branch_id: branch.branch_id,
      created_by: user.user_id,
      agentic_tool: 'codex',
    });
    await new BranchRepository(db).update(branch.branch_id, { filesystem_status: status });
    expect(
      await new TaskRepository(db).create({
        session_id: session.session_id,
        created_by: user.user_id,
        status: 'queued',
      })
    ).toMatchObject({ status: 'queued' });
  });
}
