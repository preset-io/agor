import { afterEach, expect, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import type { UserID } from '../../types';
import { lockBranchForAdmission } from '../branch-admission';
import { runDatabaseTransaction } from '../database-wrapper';
import { ownedDbTest } from '../test-helpers';
import {
  BranchMaintenanceDiscoveryRepository,
  BranchMaintenanceRepository,
} from './branch-maintenance';
import { BranchRepository } from './branches';
import { EnvironmentCommandRepository } from './environment-commands';
import { seedEnvironmentCommandBranch } from './environment-commands.test-support';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';

const test = ownedDbTest;
afterEach(() => vi.useRealTimers());

test('a stale deletion becomes visible as failed without releasing the original invocation', async ({
  db,
}) => {
  const { branch } = await seedEnvironmentCommandBranch(db);
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'delete');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
  const invocation = await maintenance.beginExecution(claim);
  await expect(maintenance.withExecution(claim, invocation, async () => true)).rejects.toThrow(
    'not claimed'
  );
  await maintenance.claimExecution(claim, invocation);
  await expect(maintenance.claimExecution(claim, invocation)).rejects.toThrow('already claimed');
  vi.setSystemTime(new Date('2026-09-15T00:01:00Z'));
  await maintenance.heartbeatExecution(claim, invocation);
  expect(await maintenance.markStaleDeletion(claim, 30_000)).toBe(false);
  vi.setSystemTime(new Date('2026-09-15T00:02:00Z'));
  expect(await maintenance.markStaleDeletion(claim, 30_000)).toBe(true);
  expect((await maintenance.claim(branch.branch_id, 'delete')).acquired).toBe(false);
  await expect(maintenance.beginExecution(claim)).rejects.toThrow('reconciliation');
  await maintenance.heartbeatExecution(claim, invocation);
  expect((await new BranchRepository(db).findById(branch.branch_id))?.deletion_status).toBe(
    'deletion_failed'
  );
  // The original claimed executor can still report verified progress; a late
  // heartbeat never starts a new invocation or hides the previous failure.
  expect(await maintenance.withExecution(claim, invocation, async () => true)).toBe(true);
});

test('an unacknowledged dispatch cannot start after reconciliation marks it failed', async ({
  db,
}) => {
  const { branch } = await seedEnvironmentCommandBranch(db);
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'delete');
  const invocation = await maintenance.beginExecution(claim);
  await maintenance.fail(claim, 'Dispatch outcome unknown');
  await expect(maintenance.claimExecution(claim, invocation)).rejects.toThrow('no longer active');
  await expect(maintenance.heartbeatExecution(claim, invocation)).rejects.toThrow('not claimed');
});

test('known unfinished tasks prevent claiming maintenance without changing branch state', async ({
  db,
}) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const session = await new SessionRepository(db).create({
    branch_id: branch.branch_id,
    agentic_tool: 'codex',
    created_by: user.user_id,
  });
  await new TaskRepository(db).create({
    session_id: session.session_id,
    created_by: user.user_id,
    status: 'queued',
  });
  await expect(
    new BranchMaintenanceRepository(db).claim(branch.branch_id, 'delete')
  ).rejects.toThrow('unfinished tasks');
  expect(
    (await new BranchRepository(db).findById(branch.branch_id))?.deletion_status
  ).toBeUndefined();
});

test('environment admission and maintenance exclude each other under the branch lock', async ({
  db,
}) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const maintenance = new BranchMaintenanceRepository(db);
  const commands = new EnvironmentCommandRepository(db);
  const input = { branch, userId: user.user_id, action: 'start' as const, attemptId: generateId() };
  const cleanup = await maintenance.claim(branch.branch_id, 'cleanup');
  await expect(commands.admit(input)).rejects.toThrow('maintenance');
  await maintenance.release(cleanup.claim);
  await commands.admit(input);
  await expect(maintenance.claim(branch.branch_id, 'delete')).rejects.toThrow(
    'environment is active'
  );
  await commands.dispatchFailed(branch.branch_id, input.attemptId);
  const deletion = await maintenance.claim(branch.branch_id, 'delete');
  await expect(commands.admit({ ...input, attemptId: generateId() })).rejects.toThrow('deletion');
  await maintenance.fail(deletion.claim, 'Fixture failure');
  await expect(commands.admit({ ...input, attemptId: generateId() })).rejects.toThrow('deletion');
});

test('retains failure on the branch, fences new work and rejects stale generations', async ({
  db,
}) => {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: 'maintenance-fixture',
    name: 'Fixture',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/repo',
    local_path: '/disposable/not-created',
    default_branch: 'main',
  });
  const branches = new BranchRepository(db);
  const branch = await branches.create({
    repo_id: repo.repo_id,
    name: 'fixture',
    ref: 'fixture',
    branch_unique_id: 1,
    path: '/disposable/not-created/fixture',
    created_by: 'test-user' as UserID,
  });
  const maintenance = new BranchMaintenanceRepository(db);
  const first = await maintenance.claim(branch.branch_id, 'delete');
  expect(first.acquired).toBe(true);
  expect((await maintenance.claim(branch.branch_id, 'delete')).acquired).toBe(false);
  expect(await branches.findById(branch.branch_id)).toMatchObject({ deletion_status: 'deleting' });
  expect(await branches.findById(branch.branch_id)).not.toHaveProperty('maintenance');
  await expect(
    runDatabaseTransaction(db, (tx) => lockBranchForAdmission(tx, branch.branch_id))
  ).rejects.toThrow('deletion');
  await expect(
    new SessionRepository(db).create({
      branch_id: branch.branch_id,
      agentic_tool: 'codex',
      created_by: branch.created_by,
    })
  ).rejects.toThrow('deletion');
  await maintenance.fail(first.claim, 'Workspace removal failed; check permissions and retry.');
  expect(await branches.findById(branch.branch_id)).toMatchObject({
    deletion_status: 'deletion_failed',
    deletion_error: 'Workspace removal failed; check permissions and retry.',
  });
  await expect(
    branches.update(branch.branch_id, { archived: false, deletion_status: undefined })
  ).rejects.toThrow('irreversible');
  await expect(maintenance.claim(branch.branch_id, 'cleanup')).rejects.toThrow('cancelled');
  const retry = await maintenance.claim(branch.branch_id, 'delete');
  expect(retry.claim.generation).toBe(first.claim.generation + 1);
  await expect(maintenance.fail(first.claim, 'stale')).rejects.toThrow('ownership changed');
  expect((await branches.findById(branch.branch_id))?.deletion_error).toBeUndefined();
  const executionId = await maintenance.beginExecution(retry.claim);
  await maintenance.claimExecution(retry.claim, executionId);
  expect(await maintenance.withExecution(retry.claim, executionId, async () => 'accepted')).toBe(
    'accepted'
  );
  await expect(
    maintenance.withExecution(retry.claim, generateId(), async () => {
      throw new Error('Stale invocation reached database work');
    })
  ).rejects.toThrow('Executor invocation changed');
  await expect(maintenance.beginExecution(retry.claim)).rejects.toThrow('reconciliation');
  await maintenance.fail(
    retry.claim,
    'Executor outcome is unknown; containment reconciliation is required.'
  );
  expect((await maintenance.claim(branch.branch_id, 'delete')).acquired).toBe(false);
  await expect(maintenance.settleExecution(retry.claim, generateId())).rejects.toThrow(
    'invocation changed'
  );
  await maintenance.settleExecution(retry.claim, executionId);
  await expect(
    maintenance.withExecution(retry.claim, executionId, async () => {
      throw new Error('Settled invocation reached database work');
    })
  ).rejects.toThrow('Executor invocation changed');
  const nextExecution = await maintenance.beginExecution(retry.claim);
  await expect(maintenance.settleExecution(retry.claim, executionId)).rejects.toThrow(
    'invocation changed'
  );
  await maintenance.settleExecution(retry.claim, nextExecution);
  await maintenance.fail(retry.claim, 'Retry after verified containment.');
  expect((await maintenance.claim(branch.branch_id, 'delete')).acquired).toBe(true);
});

test('a claim interrupted before invocation admission becomes retryable without admitting a late executor', async ({
  db,
}) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
  const { branch } = await seedEnvironmentCommandBranch(db);
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'delete');
  expect(await maintenance.markStaleDeletion(claim, 30_000)).toBe(false);
  vi.setSystemTime(new Date('2026-09-15T00:01:00Z'));
  expect(await maintenance.markStaleDeletion(claim, 30_000)).toBe(true);
  await expect(maintenance.beginExecution(claim)).rejects.toThrow();
  const retry = await maintenance.claim(branch.branch_id, 'delete');
  expect(retry.acquired).toBe(true);
  expect(retry.claim.generation).toBe(claim.generation + 1);
});

test('materialization and taskless writes exclude permanent deletion through the shared Branch fence', async ({
  db,
}) => {
  const { branch } = await seedEnvironmentCommandBranch(db);
  const branches = new BranchRepository(db);
  const maintenance = new BranchMaintenanceRepository(db);
  await branches.update(branch.branch_id, { filesystem_status: 'creating' });
  await expect(maintenance.claim(branch.branch_id, 'delete')).rejects.toThrow('materialization');
  await branches.update(branch.branch_id, { filesystem_status: 'ready' });
  const { claim } = await maintenance.claim(branch.branch_id, 'workspace_write');
  await expect(maintenance.claim(branch.branch_id, 'delete')).rejects.toThrow();
  await expect(
    branches.update(branch.branch_id, { filesystem_status: 'creating' })
  ).rejects.toThrow();
  const invocation = await maintenance.beginExecution(claim);
  await expect(maintenance.release(claim)).rejects.toThrow();
  await maintenance.settleExecution(claim, invocation);
  await maintenance.release(claim);
  expect((await maintenance.claim(branch.branch_id, 'delete')).acquired).toBe(true);
});

test('maintenance discovery returns only deleting routing identities and honors its cursor', async ({
  db,
}) => {
  const { branch } = await seedEnvironmentCommandBranch(db);
  const discovery = new BranchMaintenanceDiscoveryRepository(db);
  expect(await discovery.findDeletingRefs({ tenantId: 'default' })).toEqual([]);
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'delete');
  const refs = await discovery.findDeletingRefs({ tenantId: 'default' });
  expect(refs).toEqual([{ tenant_id: 'default', branch_id: branch.branch_id }]);
  expect(await discovery.findDeletingRefs({ tenantId: 'default', after: refs[0] })).toEqual([]);
  await maintenance.fail(claim, 'Fixture settled before dispatch');
  expect(await discovery.findDeletingRefs({ tenantId: 'default' })).toEqual([]);
  await expect(discovery.findDeletingRefs({})).rejects.toThrow('PostgreSQL');
});
