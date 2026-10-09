import {
  BranchMaintenanceRepository,
  BranchRepository,
  BranchWorkspaceOperationRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  UsersRepository,
} from '@agor/core/db';
import type { BranchWorkspaceOperation, User } from '@agor/core/types';
import { expect } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { dbTest, setTestBranchUserRole } from '../../../../packages/core/src/db/test-helpers';
import { BranchWorkspaceNotificationService } from './branch-workspace-notification';

async function fixture(db: Database, outcome: 'failed' | 'succeeded' | 'unknown' = 'failed') {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'cleanup', user.user_id);
  const operations = new BranchWorkspaceOperationRepository(db);
  await operations.prepare(
    claim,
    {
      operation_id: claim.operation_id,
      action: 'clean',
      filesystem_action: 'cleaned',
      status: 'accepted',
      requested_by: user.user_id,
      requested_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    },
    { repo_id: branch.repo_id, path: branch.path, repo_path: '/tmp/environment-test' }
  );
  const execution = await maintenance.beginExecution(claim);
  await maintenance.claimExecution(claim, execution);
  await operations.finish(claim, execution, outcome);
  const service = new BranchWorkspaceNotificationService(
    createTenantScopedDatabaseProxy(db, { requireScope: true })
  );
  const dismiss = (actor: User = user, operationId = claim.operation_id) =>
    service.create({ operation_id: operationId }, { user: actor, route: { id: branch.branch_id } });
  return { branch, user, service, dismiss, claim, operations };
}

for (const outcome of ['failed', 'succeeded'] as const) {
  dbTest(
    `permanently forgets ${outcome} notification and stale error, preserving useful branch state`,
    async ({ db }) => {
      const { branch, dismiss } = await fixture(db, outcome);
      const before = await new BranchRepository(db).findById(branch.branch_id);
      const result = await dismiss();
      expect(result.workspace_operation).toBeUndefined();
      expect(result.cleanup_last_error).toBeUndefined();
      expect(result.filesystem_status).toBe('ready');
      expect(result.last_cleanup_succeeded_at).toBe(before?.last_cleanup_succeeded_at);
      expect(result.last_cleanup_operation_id).toBe(before?.last_cleanup_operation_id);
      // New repository/read simulates refresh and another client's view.
      expect(
        (await new BranchRepository(db).findById(branch.branch_id))?.workspace_operation
      ).toBeUndefined();
      expect((await dismiss()).workspace_operation).toBeUndefined();
    }
  );
}

dbTest(
  'requires current Manager authority, not filesystem access or a claimed owner',
  async ({ db }) => {
    const { branch, user, dismiss, service, claim } = await fixture(db);
    const member = await new UsersRepository(db).create({
      email: 'notification-member@example.test',
      role: 'member',
    });
    await setTestBranchUserRole(
      db,
      branch.branch_id,
      member.user_id,
      'collaborator',
      'write',
      user.user_id
    );
    await expect(dismiss(member)).rejects.toThrow('Branch Manager');
    await expect(
      service.create({ operation_id: claim.operation_id }, { route: { id: branch.branch_id } })
    ).rejects.toThrow('Authentication required');
    await expect(
      service.create(
        { operation_id: claim.operation_id, status: 'succeeded' },
        { user, route: { id: branch.branch_id } }
      )
    ).rejects.toThrow('operation_id');
    expect(
      (await new BranchRepository(db).findById(branch.branch_id))?.workspace_operation
    ).toBeDefined();
    await setTestBranchUserRole(
      db,
      branch.branch_id,
      member.user_id,
      'manager',
      'none',
      user.user_id
    );
    expect((await dismiss(member)).workspace_operation).toBeUndefined();
  }
);

dbTest('cannot dismiss unknown outcomes, even after their deadline', async ({ db }) => {
  const { branch, dismiss } = await fixture(db, 'unknown');
  await expect(dismiss()).rejects.toThrow('Resolve the branch operation');
  expect(
    (await new BranchRepository(db).findById(branch.branch_id))?.workspace_operation?.status
  ).toBe('unknown');
});

dbTest(
  'a new maintenance claim fences dismissal of the old terminal notification',
  async ({ db }) => {
    const { branch, user, dismiss } = await fixture(db);
    await new BranchMaintenanceRepository(db).claim(branch.branch_id, 'cleanup', user.user_id);
    await expect(dismiss()).rejects.toThrow('Resolve the branch operation');
  }
);

dbTest('a stale close cannot erase a newer outcome or an in-progress operation', async ({ db }) => {
  const { branch, user, dismiss, operations } = await fixture(db);
  const { claim } = await new BranchMaintenanceRepository(db).claim(
    branch.branch_id,
    'cleanup',
    user.user_id
  );
  const operation: BranchWorkspaceOperation = {
    operation_id: claim.operation_id,
    action: 'clean',
    filesystem_action: 'cleaned',
    status: 'accepted',
    requested_by: user.user_id,
    requested_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
  };
  await operations.prepare(claim, operation, {
    repo_id: branch.repo_id,
    path: branch.path,
    repo_path: '/tmp/environment-test',
  });
  await expect(dismiss()).rejects.toThrow('notification has changed');
  await expect(dismiss(user, claim.operation_id)).rejects.toThrow('Resolve the branch operation');
  await operations.failBeforeExecution(claim);
  await expect(dismiss()).rejects.toThrow('notification has changed');
  expect(
    (await new BranchRepository(db).findById(branch.branch_id))?.workspace_operation?.operation_id
  ).toBe(claim.operation_id);
  expect((await dismiss(user, claim.operation_id)).workspace_operation).toBeUndefined();
});

dbTest('cannot use a foreign/missing branch ID or fabricated operation ID', async ({ db }) => {
  const { branch, user, dismiss, service } = await fixture(db);
  await expect(dismiss(user, generateId())).rejects.toThrow('notification has changed');
  await expect(
    service.create({ operation_id: generateId() }, { user, route: { id: generateId() } })
  ).rejects.toThrow('Branch not found');
  expect(
    (await new BranchRepository(db).findById(branch.branch_id))?.workspace_operation
  ).toBeDefined();
});

dbTest(
  'does not erase a settled notification while the workspace still needs recovery',
  async ({ db }) => {
    const { branch, dismiss } = await fixture(db);
    await new BranchRepository(db).update(branch.branch_id, {
      filesystem_status: 'failed',
      error_message: 'Provisioning failed',
    });
    await expect(dismiss()).rejects.toThrow('recover its workspace');
    expect(await new BranchRepository(db).findById(branch.branch_id)).toMatchObject({
      filesystem_status: 'failed',
      error_message: 'Provisioning failed',
      workspace_operation: { status: 'failed' },
    });
  }
);
