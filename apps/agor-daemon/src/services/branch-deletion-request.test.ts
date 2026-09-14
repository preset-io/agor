import { BranchRepository, runWithTenantContext } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, TenantID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { ownedDbTest as test } from '../../../../packages/core/src/db/test-helpers';
import { spawnExecutor } from '../utils/spawn-executor';
import { BranchesService } from './branches';

vi.mock('../utils/spawn-executor', async (original) => ({
  ...(await original<object>()),
  spawnExecutor: vi.fn(),
}));

test('public deletion durably admits exactly one full executor and returns deleting, never an immediate tombstone', async ({
  db,
}) => {
  vi.mocked(spawnExecutor).mockClear();
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const emit = vi.fn();
  const app = {
    get: () => ({ execution: {} }),
    emit: vi.fn(),
    sessionTokenService: { generateCommandToken: vi.fn(async () => 'fixture-command-token') },
    service: () => ({ emit }),
  } as unknown as Application;
  const service = new BranchesService(db, app);
  vi.spyOn(service, 'get').mockImplementation(
    async () => (await new BranchRepository(db).findById(branch.branch_id))! as never
  );
  vi.spyOn(service as never, 'resolveEnvironmentExecutorContext').mockResolvedValue({
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
      params: { branchId: branch.branch_id, branchPath: branch.path, generation: 1 },
    });
    expect(await new BranchRepository(db).findById(branch.branch_id)).not.toBeNull();
    expect(emit.mock.calls.some((call) => call[0] === 'removed')).toBe(false);
  });
});
