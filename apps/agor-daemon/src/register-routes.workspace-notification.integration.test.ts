import {
  BranchMaintenanceRepository,
  BranchRepository,
  BranchWorkspaceOperationRepository,
  createTenantScopedDatabaseProxy,
  runWithTenantDatabaseScope,
  shortId,
} from '@agor/core/db';
import { BRANCH_WORKSPACE_NOTIFICATION_DISMISS_SERVICE, type TenantID } from '@agor/core/types';
import { expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../packages/core/src/db/repositories/environment-commands.test-support';
import { dbTest } from '../../../packages/core/src/db/test-helpers';
// This harness registers production branch routes through the retirement route,
// including notification acknowledgement, with unrelated services inert.
import { retirementRouteApp } from '../test/retirement-route-app';
import { REALTIME_PUBLISH_POLICY } from './utils/realtime-publish-policy';
import { tenantServiceClassificationFor } from './utils/tenant-service-classification';

dbTest(
  'registered dismissal is tenant scoped and publishes the cleared branch for every authorized client',
  async ({ db: raw }) => {
    const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
    const tenantId = 'notification-route' as TenantID;
    const scoped = <T>(work: () => Promise<T>) => runWithTenantDatabaseScope(db, tenantId, work);
    const { branch, user, claim } = await scoped(async () => {
      const { branch, user } = await seedEnvironmentCommandBranch(db);
      const { claim } = await new BranchMaintenanceRepository(db).claim(
        branch.branch_id,
        'cleanup',
        user.user_id
      );
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
      await operations.failBeforeExecution(claim);
      return { branch, user, claim };
    });
    const app = await retirementRouteApp(db, {
      multi_tenancy: { mode: 'static', static_tenant_id: tenantId },
      execution: {},
    });
    const path = BRANCH_WORKSPACE_NOTIFICATION_DISMISS_SERVICE;
    expect(tenantServiceClassificationFor(path)?.scopeClass).toBe('scoped');
    expect(REALTIME_PUBLISH_POLICY[path].audience).toBe('none');
    const patched = vi.fn();
    app.service('branches').on('patched', patched);
    const params = {
      user,
      route: { id: shortId(branch.branch_id) },
      tenant: { tenant_id: tenantId, source: 'explicit' as const },
    };
    const foreignParams = {
      ...params,
      tenant: { ...params.tenant, tenant_id: 'foreign' as TenantID },
    };
    await expect(
      app.service(path).create({ operation_id: claim.operation_id }, foreignParams)
    ).rejects.toThrow();
    expect(patched).not.toHaveBeenCalled();
    const result = await app.service(path).create({ operation_id: claim.operation_id }, params);
    expect(result.workspace_operation).toBeUndefined();
    expect(patched).toHaveBeenCalledTimes(1);
    expect(patched.mock.calls[0][0].branch_id).toBe(branch.branch_id);
    expect(patched.mock.calls[0][0].workspace_operation).toBeUndefined();
    expect(patched.mock.calls[0][1]).toMatchObject({
      path: 'branches',
      event: 'patched',
      params: { tenant: { tenant_id: tenantId } },
    });
    expect(
      (await scoped(() => new BranchRepository(db).findById(branch.branch_id)))?.workspace_operation
    ).toBeUndefined();
  }
);
