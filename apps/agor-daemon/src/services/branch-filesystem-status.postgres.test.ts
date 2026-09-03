import {
  BranchRepository,
  createDatabase,
  type Database,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Branch, BranchID, User, UUID } from '@agor/core/types';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BranchFilesystemStatusService } from './branch-filesystem-status.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Branch filesystem status authorization (PostgreSQL RLS)',
  () => {
    let db: Database;
    let branch: Branch;
    let owner: User;
    let unauthorized: User;
    const tenantA = `branch-filesystem-a-${generateId()}`;
    const tenantB = `branch-filesystem-b-${generateId()}`;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const users = new UsersRepository(scoped);
        owner = await users.create({
          email: `branch-filesystem-owner-${generateId()}@example.com`,
          role: 'member',
        });
        unauthorized = await users.create({
          email: `branch-filesystem-other-${generateId()}@example.com`,
          role: 'member',
        });
        const repo = await new RepoRepository(scoped).create({
          slug: `branch-filesystem-${generateId()}`,
          name: 'Branch filesystem observation',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/branch-filesystem.git',
          local_path: `/tmp/branch-filesystem-${generateId()}`,
          default_branch: 'main',
        });
        const branches = new BranchRepository(scoped);
        branch = await branches.create({
          branch_id: generateId() as BranchID,
          repo_id: repo.repo_id,
          name: 'archived-observation',
          ref: 'archived-observation',
          path: `/tmp/branch-filesystem-${generateId()}`,
          branch_unique_id: Math.floor(Math.random() * 100_000),
          created_by: owner.user_id as UUID,
          permission_source: 'override',
          others_can: 'none',
        });
        branch = await branches.update(branch.branch_id, { archived: true });
      });
    });

    function subject() {
      const request = vi.fn().mockResolvedValue({
        success: true,
        data: { branchId: branch.branch_id, exists: false, kind: 'missing' },
      });
      const service = new BranchFilesystemStatusService(
        new BranchRepository(db),
        db as TenantScopeAwareDatabase,
        {
          get: vi.fn().mockReturnValue({ execution: { unix_user_mode: 'simple' } }),
        } as unknown as Application,
        {
          issueToken: vi.fn().mockResolvedValue('token'),
          request,
        }
      );
      const find = (tenantId: string, user: User) =>
        runWithTenantContext(tenantId, () =>
          service.find({ route: { id: branch.branch_id }, user } as never)
        );
      return { find, request };
    }

    it('observes an archived Branch for its owner in the active tenant', async () => {
      const { find, request } = subject();

      await expect(find(tenantA, owner)).resolves.toMatchObject({
        branch_id: branch.branch_id,
        exists: false,
        kind: 'missing',
      });
      expect(request).toHaveBeenCalledOnce();
    });

    it('rejects same-tenant and cross-tenant users before executor work', async () => {
      const sameTenant = subject();
      await expect(sameTenant.find(tenantA, unauthorized)).rejects.toMatchObject({ code: 403 });
      expect(sameTenant.request).not.toHaveBeenCalled();

      const crossTenant = subject();
      await expect(crossTenant.find(tenantB, owner)).rejects.toMatchObject({ code: 403 });
      expect(crossTenant.request).not.toHaveBeenCalled();
    });
  }
);
