import { expect } from 'vitest';
import type { BranchMaintenanceClaim, UserID } from '../../types';
import {
  BRANCH_WORKSPACE_OPERATION_BUDGET_MS,
  DEFAULT_BRANCH_CLEANUP_COMMAND,
  getBranchCleanupBlockReason,
  projectBranchWorkspaceOperation,
} from '../../types/branch-cleanup';
import { ownedDbTest as test } from '../test-helpers';
import { BranchMaintenanceRepository } from './branch-maintenance';
import { BranchWorkspaceOperationRepository } from './branch-workspace-operations';
import { BranchRepository } from './branches';
import { seedEnvironmentCommandBranch } from './environment-commands.test-support';
import { RepoRepository } from './repos';

test('cleanup settles once, fences edits, preserves prior errors during retry and clears them only on success', async ({
  db,
}) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const policy = { enabled: true, command: 'git clean -fdX', allow_branch_protection: true };
  const repo = await new RepoRepository(db).update(branch.repo_id, { cleanup_policy: policy });
  const maintenance = new BranchMaintenanceRepository(db);
  const cleanup = new BranchWorkspaceOperationRepository(db);
  const branches = new BranchRepository(db);
  const prepare = async (claim: BranchMaintenanceClaim) => {
    await cleanup.prepare(
      claim,
      {
        operation_id: claim.operation_id,
        action: 'clean',
        filesystem_action: 'cleaned',
        status: 'accepted',
        requested_by: user.user_id as UserID,
        requested_at: new Date().toISOString(),
        deadline_at: new Date(Date.now() + BRANCH_WORKSPACE_OPERATION_BUDGET_MS).toISOString(),
      },
      { repo_id: branch.repo_id, path: branch.path, repo_path: repo.local_path!, policy }
    );
    await expect(cleanup.archiveMetadata(claim)).rejects.toThrow('admitted archive');
    const execution = await maintenance.beginExecution(claim);
    await maintenance.claimExecution(claim, execution, (tx) => cleanup.validateLaunch(tx, claim));
    await cleanup.started(claim, execution);
    return execution;
  };
  const { claim } = await maintenance.claim(branch.branch_id, 'cleanup', user.user_id);
  const execution = await prepare(claim);
  expect(JSON.stringify(await branches.findById(branch.branch_id))).not.toContain(
    'workspace_snapshot'
  );
  await expect(branches.update(branch.branch_id, { notes: 'racing edit' })).rejects.toThrow(
    'maintenance'
  );
  await cleanup.finish(claim, execution, 'failed');
  expect((await branches.findById(branch.branch_id))?.cleanup_last_error?.operation_id).toBe(
    claim.operation_id
  );
  expect((await branches.findById(branch.branch_id))?.last_cleanup_succeeded_at).toBeUndefined();
  const retry = await maintenance.claim(branch.branch_id, 'cleanup', user.user_id);
  const second = await prepare(retry.claim);
  expect((await branches.findById(branch.branch_id))?.cleanup_last_error?.operation_id).toBe(
    claim.operation_id
  );
  await expect(cleanup.finish(claim, execution, 'succeeded')).rejects.toThrow('ownership changed');
  await cleanup.finish(retry.claim, second, 'succeeded');
  const result = await branches.findById(branch.branch_id);
  expect(result).toMatchObject({
    filesystem_status: 'ready',
    last_cleanup_operation_id: retry.claim.operation_id,
    workspace_operation: { status: 'succeeded' },
  });
  expect(result?.cleanup_last_error).toBeUndefined();
  await expect(cleanup.finish(retry.claim, second, 'succeeded')).rejects.toThrow(
    'ownership changed'
  );
  await expect(branches.update(branch.branch_id, { notes: 'settled' })).resolves.toBeDefined();
  await expect(
    branches.update(branch.branch_id, { workspace_operation: result!.workspace_operation })
  ).rejects.toThrow('server-managed');
});

test('unknown reports and expired read projections never release maintenance', async ({ db }) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const maintenance = new BranchMaintenanceRepository(db);
  const cleanup = new BranchWorkspaceOperationRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'cleanup', user.user_id);
  await cleanup.prepare(
    claim,
    {
      operation_id: claim.operation_id,
      action: 'archive',
      filesystem_action: 'preserved',
      status: 'accepted',
      requested_by: user.user_id,
      requested_at: new Date().toISOString(),
      deadline_at: new Date(0).toISOString(),
    },
    { repo_id: branch.repo_id, path: branch.path, repo_path: '/fixture' }
  );
  await cleanup.archiveMetadata(claim);
  expect(await new BranchRepository(db).findById(branch.branch_id)).toMatchObject({
    archived: true,
    archived_by: user.user_id,
    filesystem_status: 'ready',
  });
  const operation = (await new BranchRepository(db).findById(branch.branch_id))!
    .workspace_operation;
  expect(projectBranchWorkspaceOperation(operation)?.status).toBe('unknown');
  const execution = await maintenance.beginExecution(claim);
  await maintenance.claimExecution(claim, execution);
  await cleanup.finish(claim, execution, 'unknown');
  await expect(cleanup.archiveMetadata(claim)).rejects.toThrow('must settle');
  await expect(maintenance.release(claim)).rejects.toThrow('containment');
  await expect(maintenance.beginExecution(claim)).rejects.toThrow('reconciliation');
});

test('a policy change before the invocation claim invalidates the snapshot without executing', async ({
  db,
}) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const repos = new RepoRepository(db);
  const policy = {
    enabled: true,
    command: DEFAULT_BRANCH_CLEANUP_COMMAND,
    allow_branch_protection: true,
  };
  const repo = await repos.update(branch.repo_id, { cleanup_policy: policy });
  const maintenance = new BranchMaintenanceRepository(db);
  const cleanup = new BranchWorkspaceOperationRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'cleanup', user.user_id);
  await cleanup.prepare(
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
    { repo_id: branch.repo_id, path: branch.path, repo_path: repo.local_path!, policy }
  );
  expect(branch.cleanup_protected).toBe(false);
  await expect(
    maintenance.withClaim(claim, (tx) => cleanup.validateLaunch(tx, claim))
  ).resolves.toBeUndefined();
  const execution = await maintenance.beginExecution(claim);
  const changedPolicy = { ...policy, allow_branch_protection: false };
  expect(getBranchCleanupBlockReason(changedPolicy, false)).toBeUndefined();
  await repos.update(branch.repo_id, { cleanup_policy: changedPolicy });
  await expect(
    maintenance.claimExecution(claim, execution, (tx) => cleanup.validateLaunch(tx, claim))
  ).rejects.toThrow('policy changed');
  expect(
    (await new BranchRepository(db).findById(branch.branch_id))?.last_cleanup_succeeded_at
  ).toBeUndefined();
  await expect(maintenance.beginExecution(claim)).rejects.toThrow('reconciliation');
});

test('pre-dispatch failures settle visibly, but cannot release an invocation', async ({ db }) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const maintenance = new BranchMaintenanceRepository(db);
  const cleanup = new BranchWorkspaceOperationRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'cleanup', user.user_id);
  await cleanup.prepare(
    claim,
    {
      operation_id: claim.operation_id,
      action: 'archive',
      filesystem_action: 'cleaned',
      status: 'accepted',
      requested_by: user.user_id,
      requested_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
    },
    { repo_id: branch.repo_id, path: branch.path, repo_path: '/fixture' }
  );
  await cleanup.failBeforeExecution(claim);
  expect(
    (await new BranchRepository(db).findById(branch.branch_id))?.workspace_operation?.status
  ).toBe('failed');
  const next = await maintenance.claim(branch.branch_id, 'cleanup', user.user_id);
  await maintenance.beginExecution(next.claim);
  await expect(cleanup.failBeforeExecution(next.claim)).rejects.toThrow('must settle');
  await expect(maintenance.release(next.claim)).rejects.toThrow('containment');
});
