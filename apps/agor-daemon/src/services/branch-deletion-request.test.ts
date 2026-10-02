import type { AgorConfig } from '@agor/core/config';
import {
  BranchDeletionRepository,
  BranchMaintenanceRepository,
  BranchRepository,
  createTenantScopedDatabaseProxy,
  runWithTenantContext,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, TenantID, UUID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import {
  setTestBranchUserRole,
  ownedDbTest as test,
} from '../../../../packages/core/src/db/test-helpers';
import { spawnExecutor, substituteTemplateVariables } from '../utils/spawn-executor';
import { BranchesService } from './branches';

vi.mock('../utils/spawn-executor', async (original) => ({
  ...(await original<object>()),
  spawnExecutor: vi.fn(),
}));

test.for(['simple', 'sandbox'] as const)('local %s deletion', async (mode, { db }) => {
  vi.mocked(spawnExecutor).mockClear();
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const emit = vi.fn();
  const app = {
    get: () => ({ execution: { unix_user_mode: mode } }),
    emit: vi.fn(),
    sessionTokenService: { generateCommandToken: vi.fn(async () => 'fixture-command-token') },
    service: () => ({ emit }),
  } as unknown as Application;
  const service = new BranchesService(
    createTenantScopedDatabaseProxy(db, { requireScope: true }),
    app
  );
  vi.spyOn(
    service as unknown as { resolveEnvironmentExecutorContext(): Promise<unknown> },
    'resolveEnvironmentExecutorContext'
  ).mockResolvedValue({
    env: {},
    branchFsAccess: 'write',
    sandboxMounts: {},
  } as never);
  const params = {
    provider: 'rest',
    user,
    tenant: { tenant_id: 'default' as TenantID, source: 'explicit' },
  } as AuthenticatedParams;
  await runWithTenantContext('default', async () => {
    await expect(
      service.remove(branch.branch_id, { ...params, query: { deleteFromFilesystem: false } })
    ).rejects.toThrow('Permanent deletion');
    expect(spawnExecutor).not.toHaveBeenCalled();
    expect((await service.remove(branch.branch_id, params)).deletion_status).toBe('deleting');
    expect((await service.remove(branch.branch_id, params)).deletion_status).toBe('deleting');
    expect(spawnExecutor).toHaveBeenCalledOnce();
    const payload = vi.mocked(spawnExecutor).mock.calls[0]![0];
    expect(payload).toMatchObject({
      command: 'branch.delete',
      params: {
        branchId: branch.branch_id,
        branchPath: branch.path,
        generation: 1,
        verifyDelegatedStorageMounts: false,
      },
    });
    expect(await new BranchRepository(db).findById(branch.branch_id)).not.toBeNull();
    expect(emit.mock.calls.some((call) => call[0] === 'removed')).toBe(false);
    const maintenance = new BranchMaintenanceRepository(db);
    const { claim } = await maintenance.claim(branch.branch_id, 'delete');
    const execution = (payload.params as { executionId: UUID }).executionId;
    await maintenance.claimExecution(claim, execution);
    await maintenance.fail(claim, 'Fixture unknown outcome');
    await expect(service.remove(branch.branch_id, params)).rejects.toThrow('recovery is blocked');
    expect(spawnExecutor).toHaveBeenCalledOnce();
    const outsider = await new UsersRepository(db).create({
      email: 'outsider@example.invalid',
      role: 'member',
    });
    await expect(service.remove(branch.branch_id, { ...params, user: outsider })).rejects.toThrow();
    expect(spawnExecutor).toHaveBeenCalledOnce();
    // Worker attestation plus the actual transaction barrier makes retry usable.
    await new BranchDeletionRepository(db).failSettled(
      claim,
      execution,
      'Stopped; retry available'
    );
    const prefetched = {
      ...params,
      _agorPrefetchedRecord: {
        id: branch.branch_id,
        idField: 'branch_id',
        record: await new BranchRepository(db).findById(branch.branch_id),
      },
    };
    const retries = await Promise.all([
      service.remove(branch.branch_id, prefetched),
      service.remove(branch.branch_id, prefetched),
    ]);
    expect(retries.every((item) => item.deletion_status === 'deleting')).toBe(true);
    expect(spawnExecutor).toHaveBeenCalledTimes(2);
    await expect(maintenance.claimExecution(claim, execution)).rejects.toThrow('ownership changed');
    // A never-claimed replacement can also recover, with no process-exit inference.
    const pending = await maintenance.claim(branch.branch_id, 'delete');
    await maintenance.fail(pending.claim, 'Dispatch never connected');
    expect((await service.remove(branch.branch_id, params)).deletion_status).toBe('deleting');
    expect(spawnExecutor).toHaveBeenCalledTimes(3);
  });
});

test('capability-gated delegated deletion dispatches with mount verification', async ({ db }) => {
  vi.mocked(spawnExecutor).mockClear();
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  await new UsersRepository(db).update(user.user_id, { unix_username: 'owner-home' });
  const manager = await new UsersRepository(db).create({
    email: 'deletion-manager@example.invalid',
    role: 'member',
    unix_username: 'manager-home',
  });
  const app = {
    get: () => ({
      execution: {
        unix_user_mode: 'delegated',
        executor_command_template: 'launcher',
        delegated_branch_deletion: true,
      },
    }),
    emit: vi.fn(),
    sessionTokenService: { generateCommandToken: vi.fn(async () => 'fixture-command-token') },
    service: () => ({ emit: vi.fn() }),
  } as unknown as Application;
  const service = new BranchesService(
    createTenantScopedDatabaseProxy(db, { requireScope: true }),
    app
  );
  const params = {
    provider: 'rest',
    user: manager,
    tenant: { tenant_id: 'default' as TenantID, source: 'explicit' },
  } as AuthenticatedParams;
  await runWithTenantContext('default', async () => {
    for (const [role, access] of [
      ['collaborator', 'write'],
      ['manager', 'read'],
    ] as const) {
      await setTestBranchUserRole(
        db,
        branch.branch_id,
        manager.user_id,
        role,
        access,
        user.user_id
      );
      await expect(service.remove(branch.branch_id, params)).rejects.toThrow('Forbidden');
      expect(spawnExecutor).not.toHaveBeenCalled();
      expect(
        (await new BranchRepository(db).findById(branch.branch_id))?.deletion_status
      ).toBeUndefined();
    }
    await setTestBranchUserRole(
      db,
      branch.branch_id,
      manager.user_id,
      'manager',
      'write',
      user.user_id
    );
    expect((await service.remove(branch.branch_id, params)).deletion_status).toBe('deleting');
    expect(spawnExecutor).toHaveBeenCalledOnce();
    expect(vi.mocked(spawnExecutor).mock.calls[0]![0]).toMatchObject({
      command: 'branch.delete',
      params: { branchId: branch.branch_id, verifyDelegatedStorageMounts: true },
    });
    const options = vi.mocked(spawnExecutor).mock.calls[0]![1]!;
    expect(options).toMatchObject({
      delegatedHomeKey: 'manager-home',
      templateVariables: {
        user_id: manager.user_id,
        branch_id: branch.branch_id,
        branch_fs_access: 'write',
      },
    });
    expect(
      substituteTemplateVariables('launcher --unix-user {unix_user} --user-id {user_id}', {
        ...options.templateVariables,
        unix_user: options.delegatedHomeKey ?? undefined,
      })
    ).toBe(`launcher --unix-user manager-home --user-id ${manager.user_id}`);
  });
});

test.for<AgorConfig>([
  { execution: { unix_user_mode: 'delegated', executor_command_template: 'launcher' } },
  { execution: { unix_user_mode: 'simple', executor_command_template: 'launcher' } },
  { deployment: { mode: 'ha', ha: { execution_topology: 'external' } } },
])(
  'external deletion without a storage capability leaves the branch unchanged: %j',
  async (config, { db }) => {
    vi.mocked(spawnExecutor).mockClear();
    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const app = {
      get: () => config,
    } as unknown as Application;
    const service = new BranchesService(
      createTenantScopedDatabaseProxy(db, { requireScope: true }),
      app
    );
    const params = {
      provider: 'rest',
      user,
      tenant: { tenant_id: 'default' as TenantID, source: 'explicit' },
    } as AuthenticatedParams;
    await runWithTenantContext('default', async () => {
      await expect(service.remove(branch.branch_id, params)).rejects.toThrow(
        'execution.delegated_branch_deletion. No deletion was started.'
      );
      expect(
        (await new BranchRepository(db).findById(branch.branch_id))?.deletion_status
      ).toBeUndefined();
      expect(spawnExecutor).not.toHaveBeenCalled();
    });
  }
);
