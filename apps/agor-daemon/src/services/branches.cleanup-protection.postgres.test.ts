import {
  BranchMaintenanceRepository,
  BranchRepository,
  BranchWorkspaceOperationRepository,
  createDatabase,
  type Database,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  branchCleanupCommandId,
  type EffectiveBranchAccess,
  type Params,
  type TenantID,
} from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../../packages/core/src/db/repositories/environment-commands.test-support';
import {
  EXECUTOR_COMMAND_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
} from '../auth/executor-session-token';
import { BranchCleanupStepsService } from './branch-cleanup-steps';
import { BranchesService } from './branches';
import { setupBranchEffectiveAccessService } from './groups';

const url = process.env.AGOR_TEST_POSTGRES_URL;
const app = { get: () => ({}) } as unknown as Application;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'cleanup protection tenant boundary',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
    });
    afterAll(async () => {
      if (db) await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });

    it('cannot claim or complete a foreign cleanup with a locally valid invocation-shaped credential', async () => {
      const tenantA = `cleanup-callback-a-${generateId()}`;
      const tenantB = `cleanup-callback-b-${generateId()}`;
      const fixture = await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        const { branch, user } = await seedEnvironmentCommandBranch(scoped);
        const policy = { enabled: true, command: 'git clean -fdX', allow_branch_protection: true };
        const repo = await new RepoRepository(scoped).update(branch.repo_id, {
          cleanup_policy: policy,
        });
        const maintenance = new BranchMaintenanceRepository(scoped);
        const { claim } = await maintenance.claim(branch.branch_id, 'cleanup', user.user_id);
        await new BranchWorkspaceOperationRepository(scoped).prepare(
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
        const execution = await maintenance.beginExecution(claim);
        return { branch, user, claim, execution };
      });
      const { branch, user, claim, execution } = fixture;
      const params = {
        provider: 'rest',
        user,
        tenant: { tenant_id: tenantA as TenantID, source: 'explicit' },
        authentication: {
          strategy: 'jwt',
          payload: {
            type: EXECUTOR_SESSION_TOKEN_TYPE,
            purpose: EXECUTOR_COMMAND_TOKEN_PURPOSE,
            tenant_id: tenantA,
            sub: user.user_id,
            session_id: branchCleanupCommandId(execution),
            branch_id: branch.branch_id,
          },
        },
      } as unknown as AuthenticatedParams;
      const input = {
        branch_id: branch.branch_id,
        operation_id: claim.operation_id,
        generation: claim.generation,
        execution_id: execution,
      };
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const service = new BranchCleanupStepsService(scoped, app);
        await expect(service.create({ ...input, action: 'claim' }, params)).rejects.toThrow(
          /not found/i
        );
        await expect(service.create({ ...input, action: 'succeeded' }, params)).rejects.toThrow(
          /not found/i
        );
      });
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        expect(
          (await new BranchRepository(scoped).findById(branch.branch_id))?.workspace_operation
            ?.status
        ).toBe('accepted');
        // Positive control: neither foreign request consumed the invocation.
        await new BranchMaintenanceRepository(scoped).claimExecution(claim, execution);
      });
    });

    it('refuses a foreign branch even with its owner identity, without changing protection', async () => {
      const tenantA = `cleanup-a-${generateId()}`;
      const tenantB = `cleanup-b-${generateId()}`;
      const { branch, user } = await runWithTenantDatabaseScope(db, tenantB, (scoped) =>
        seedEnvironmentCommandBranch(scoped)
      );
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        let accessService!: { find(params: Params): Promise<EffectiveBranchAccess> };
        setupBranchEffectiveAccessService(
          {
            use: (_path: string, service: typeof accessService) => {
              accessService = service;
            },
          } as unknown as Application,
          new BranchRepository(scoped),
          { allowSuperadmin: true }
        );
        await expect(
          accessService.find({
            route: { id: branch.branch_id },
            user: { ...user, role: 'superadmin' },
          } as Params)
        ).rejects.toThrow(/not found/i);
        const service = new BranchesService(scoped, app);
        await expect(
          service.patch(branch.branch_id, { cleanup_protected: true }, { user })
        ).rejects.toThrow(/not found/i);
        await expect(
          service.update(branch.branch_id, { cleanup_protected: true }, { user })
        ).rejects.toThrow(/not found/i);
        await expect(service.clean({ branchId: branch.branch_id }, { user })).rejects.toThrow(
          /not found/i
        );
        expect(await new BranchRepository(scoped).findById(branch.branch_id)).toBeNull();
      });
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        expect(
          (await new BranchRepository(scoped).findById(branch.branch_id))?.cleanup_protected
        ).toBe(false);
        await expect(
          new BranchesService(scoped, app).patch(
            branch.branch_id,
            { cleanup_protected: true },
            { user }
          )
        ).resolves.toMatchObject({ cleanup_protected: true });
      });
    });
  }
);
