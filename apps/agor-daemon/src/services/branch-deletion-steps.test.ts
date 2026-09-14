import {
  BranchMaintenanceRepository,
  BranchRepository,
  generateId,
  runWithTenantContext,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { type AuthenticatedParams, branchDeletionCommandId, type TenantID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { ownedDbTest as test } from '../../../../packages/core/src/db/test-helpers';
import {
  EXECUTOR_COMMAND_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
} from '../auth/executor-session-token';
import { BranchDeletionStepsService } from './branch-deletion-steps';

test('deletion steps require exact authenticated command, tenant and invocation, and reject ordinary users', async ({
  db,
}) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'delete', user.user_id);
  const invocation = await maintenance.beginExecution(claim);
  const emit = vi.fn();
  const generateCommandToken = vi.fn().mockResolvedValue('renewed-invocation-token');
  const app = {
    sessionTokenService: { generateCommandToken },
    get: () => ({ execution: {} }),
    service: () => ({ emit }),
  } as unknown as Application;
  const service = new BranchDeletionStepsService(db, app);
  const tenant = 'default' as TenantID;
  const params = {
    provider: 'rest',
    user,
    tenant: { tenant_id: tenant, source: 'explicit' },
    authentication: {
      strategy: 'jwt',
      payload: {
        type: EXECUTOR_SESSION_TOKEN_TYPE,
        purpose: EXECUTOR_COMMAND_TOKEN_PURPOSE,
        tenant_id: tenant,
        sub: user.user_id,
        session_id: branchDeletionCommandId(invocation),
        branch_id: branch.branch_id,
      },
    },
  } as unknown as AuthenticatedParams;
  const input = {
    branch_id: branch.branch_id,
    operation_id: claim.operation_id,
    generation: claim.generation,
    execution_id: invocation,
    action: 'claim',
  };
  await runWithTenantContext(tenant, async () => {
    await expect(service.create(input, { ...params, authentication: undefined })).rejects.toThrow(
      'executor credential'
    );
    await expect(service.create({ ...input, execution_id: generateId() }, params)).rejects.toThrow(
      'executor credential'
    );
    await expect(
      service.create(input, {
        ...params,
        tenant: { tenant_id: 'foreign' as TenantID, source: 'explicit' },
      })
    ).rejects.toThrow('tenant');
    await service.create(input, params);
    await expect(service.create(input, params)).rejects.toThrow('already claimed');
    await service.create({ ...input, action: 'heartbeat' }, params);
    expect(generateCommandToken).not.toHaveBeenCalled();
    const expiring = {
      ...params,
      authentication: {
        ...params.authentication!,
        payload: {
          ...params.authentication!.payload,
          exp: Math.floor(Date.now() / 1000) + 120,
        },
      },
    };
    expect(await service.create({ ...input, action: 'heartbeat' }, expiring)).toEqual({
      ok: true,
      sessionToken: 'renewed-invocation-token',
    });
    expect(generateCommandToken).toHaveBeenCalledWith(
      branchDeletionCommandId(invocation),
      user.user_id,
      branch.branch_id
    );
    await expect(
      service.create({ ...input, action: 'heartbeat', generation: claim.generation + 1 }, expiring)
    ).rejects.toThrow();
    expect(generateCommandToken).toHaveBeenCalledTimes(1);
    await expect(service.create({ ...input, action: 'data' }, params)).rejects.toThrow('storage');
    await expect(
      service.create({ ...input, action: 'storage', generation: claim.generation + 1 }, params)
    ).rejects.toThrow();
    expect((await new BranchRepository(db).findById(branch.branch_id))?.deletion_status).toBe(
      'deleting'
    );
    expect(emit.mock.calls.some((call) => call[0] === 'removed')).toBe(false);
    await service.create({ ...input, action: 'storage' }, params); // fixture has no real storage
    for (let page = 0; ; page++) {
      expect(page).toBeLessThan(30);
      const result = await service.create({ ...input, action: 'data' }, params);
      if (!('remaining' in result) || !result.remaining) break;
    }
    await service.create({ ...input, action: 'finalize' }, params);
    expect(await new BranchRepository(db).findById(branch.branch_id)).toBeNull();
    expect(emit.mock.calls.filter((call) => call[0] === 'removed')).toHaveLength(1);
  });
});
