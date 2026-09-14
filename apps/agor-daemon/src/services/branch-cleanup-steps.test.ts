import {
  BranchMaintenanceRepository,
  BranchRepository,
  BranchWorkspaceOperationRepository,
  generateId,
  RepoRepository,
  runWithTenantContext,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { type AuthenticatedParams, branchCleanupCommandId, type TenantID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import { ownedDbTest as test } from '../../../../packages/core/src/db/test-helpers';
import {
  EXECUTOR_COMMAND_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
} from '../auth/executor-session-token';
import { BranchCleanupStepsService } from './branch-cleanup-steps';

test('cleanup callbacks require exact tenant, actor, invocation and a single durable winner', async ({
  db,
}) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const policy = { enabled: true, command: 'git clean -fdX', allow_branch_protection: true };
  const repo = await new RepoRepository(db).update(branch.repo_id, { cleanup_policy: policy });
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await maintenance.claim(branch.branch_id, 'cleanup', user.user_id);
  await new BranchWorkspaceOperationRepository(db).prepare(
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
    { repo_id: branch.repo_id, repo_path: repo.local_path!, path: branch.path, policy }
  );
  const execution = await maintenance.beginExecution(claim);
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
        session_id: branchCleanupCommandId(execution),
        branch_id: branch.branch_id,
      },
    },
  } as unknown as AuthenticatedParams;
  const app = {
    get: () => ({ execution: {} }),
    service: () => ({ emit: vi.fn() }),
  } as unknown as Application;
  const service = new BranchCleanupStepsService(db, app);
  const input = {
    branch_id: branch.branch_id,
    operation_id: claim.operation_id,
    generation: claim.generation,
    execution_id: execution,
    action: 'claim',
  };
  await runWithTenantContext(tenant, async () => {
    await expect(service.create(input, { ...params, authentication: undefined })).rejects.toThrow(
      'credential'
    );
    await expect(service.create({ ...input, execution_id: generateId() }, params)).rejects.toThrow(
      'credential'
    );
    await expect(
      service.create(input, {
        ...params,
        tenant: { tenant_id: 'foreign' as TenantID, source: 'explicit' },
      })
    ).rejects.toThrow('tenant');
    await expect(service.create({ ...input, command: 'arbitrary' }, params)).rejects.toThrow(
      'Invalid'
    );
    await service.create(input, params);
    await expect(service.create(input, params)).rejects.toThrow('already claimed');
    await service.create({ ...input, action: 'succeeded' }, params);
    expect(
      (await new BranchRepository(db).findById(branch.branch_id))?.workspace_operation?.status
    ).toBe('succeeded');
    await expect(service.create({ ...input, action: 'failed' }, params)).rejects.toThrow(
      'ownership changed'
    );
  });
});
