/** PostgreSQL concurrency coverage for normalized capability-policy revisions. */

import type { BoardID, BranchID, RepoID, TenantID, UserID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { CapabilityPolicyRepository } from './capability-policies';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'capability policy optimistic concurrency (PostgreSQL)',
  () => {
    let dbA: Database;
    let dbB: Database;

    beforeAll(async () => {
      dbA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      dbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(dbA);
    });

    afterAll(async () => {
      await Promise.all([
        (dbA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (dbB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    async function seed(tenantId: TenantID, permissionSource: 'board' | 'override' = 'override') {
      return runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const owner = await new UsersRepository(scoped).create({
          email: `policy-owner-${generateId()}@example.test`,
          role: 'member',
        });
        const board = await new BoardRepository(scoped).create({
          name: `Policy board ${generateId()}`,
          created_by: owner.user_id,
          access_mode: 'private',
        });
        const repo = await new RepoRepository(scoped).create({
          slug: `policy-race-${generateId()}`,
          name: 'Policy race',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/policy-race.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId() as BranchID,
          repo_id: repo.repo_id,
          name: `policy-race-${generateId()}`,
          ref: 'main',
          branch_unique_id: Date.now() % 1_000_000,
          path: `/tmp/${generateId()}`,
          created_by: owner.user_id,
          board_id: board.board_id,
          permission_source: permissionSource,
        });
        return {
          ownerId: owner.user_id as UserID,
          boardId: board.board_id as BoardID,
          repoId: repo.repo_id as RepoID,
          branchId: branch.branch_id as BranchID,
        };
      });
    }

    it('allows exactly one board writer for one expected revision', async () => {
      const tenantId = `policy-board-race-${generateId()}` as TenantID;
      const value = await seed(tenantId);
      const current = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new CapabilityPolicyRepository(scoped).getBoardPolicies(value.boardId)
      );
      const left = structuredClone(current);
      left.board_access.sharing_mode = 'shared';
      left.board_access.others = {
        preset: 'viewer',
        capabilities: ['board.view'],
        fs_access: 'none',
      };
      const right = structuredClone(current);
      right.board_access.sharing_mode = 'shared';
      right.board_access.others = {
        preset: 'editor',
        capabilities: ['board.view', 'board.edit', 'board.attach_branch'],
        fs_access: 'none',
      };

      const results = await Promise.allSettled(
        [
          [dbA, left],
          [dbB, right],
        ].map(([db, draft]) =>
          runWithTenantDatabaseScope(db as Database, tenantId, (scoped) =>
            new CapabilityPolicyRepository(scoped).replaceBoardPolicies(
              value.boardId,
              draft as typeof left,
              value.ownerId
            )
          )
        )
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(
        String(
          (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason
        )
      ).toMatch(/reload before saving/);
    });

    it('allows exactly one branch writer for one expected revision', async () => {
      const tenantId = `policy-branch-race-${generateId()}` as TenantID;
      const value = await seed(tenantId);
      const current = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new CapabilityPolicyRepository(scoped).getBranchPolicy(value.branchId)
      );
      const left = structuredClone(current);
      left.override_config!.access.sharing_mode = 'shared';
      left.override_config!.access.others = {
        preset: 'viewer',
        capabilities: ['branch.view'],
        fs_access: 'none',
      };
      const right = structuredClone(current);
      right.override_config!.access.sharing_mode = 'shared';
      right.override_config!.access.others = {
        preset: 'collaborator',
        capabilities: ['branch.view', 'sessions.create', 'sessions.prompt_own', 'terminal.open'],
        fs_access: 'read',
      };

      const results = await Promise.allSettled(
        [
          [dbA, left],
          [dbB, right],
        ].map(([db, draft]) =>
          runWithTenantDatabaseScope(db as Database, tenantId, (scoped) =>
            new CapabilityPolicyRepository(scoped).replaceBranchPolicy(
              value.branchId,
              draft as typeof left,
              value.ownerId
            )
          )
        )
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(
        String(
          (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason
        )
      ).toMatch(/reload before saving/);
    });

    it('materializes the latest committed template when board deletion races a template edit', async () => {
      const tenantId = `policy-board-delete-template-${generateId()}` as TenantID;
      const value = await seed(tenantId, 'board');
      const current = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new CapabilityPolicyRepository(scoped).getBoardPolicies(value.boardId)
      );
      const edited = structuredClone(current);
      edited.branch_template.access.sharing_mode = 'shared';
      edited.branch_template.access.others = {
        preset: 'viewer',
        capabilities: ['branch.view'],
        fs_access: 'none',
      };

      const [editResult, deleteResult] = await Promise.allSettled([
        runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new CapabilityPolicyRepository(scoped).replaceBoardPolicies(
            value.boardId,
            edited,
            value.ownerId
          )
        ),
        runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
          new BoardRepository(scoped).delete(value.boardId)
        ),
      ]);

      expect(deleteResult.status).toBe('fulfilled');
      const branchPolicy = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new CapabilityPolicyRepository(scoped).getBranchPolicy(value.branchId)
      );
      expect(branchPolicy.binding_mode).toBe('override');
      expect(branchPolicy.inherited_from_board_id).toBeUndefined();
      expect(branchPolicy.override_config?.access.others.preset).toBe(
        editResult.status === 'fulfilled' ? 'viewer' : 'none'
      );
    });

    it('never leaves an inherited orphan when branch creation races board deletion', async () => {
      const tenantId = `policy-board-delete-create-${generateId()}` as TenantID;
      const value = await seed(tenantId);
      const racingBranchId = generateId() as BranchID;

      const [createResult, deleteResult] = await Promise.allSettled([
        runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new BranchRepository(scoped).create({
            branch_id: racingBranchId,
            repo_id: value.repoId,
            name: `policy-delete-race-${generateId()}`,
            ref: 'main',
            branch_unique_id: Math.floor(Math.random() * 1_000_000_000),
            path: `/tmp/${generateId()}`,
            created_by: value.ownerId,
            board_id: value.boardId,
            permission_source: 'board',
          })
        ),
        runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
          new BoardRepository(scoped).delete(value.boardId)
        ),
      ]);

      expect(deleteResult.status).toBe('fulfilled');
      if (createResult.status === 'fulfilled') {
        const branchPolicy = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new CapabilityPolicyRepository(scoped).getBranchPolicy(racingBranchId)
        );
        expect(branchPolicy.binding_mode).toBe('override');
        expect(branchPolicy.inherited_from_board_id).toBeUndefined();
      } else {
        const branch = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new BranchRepository(scoped).findById(racingBranchId)
        );
        expect(branch).toBeNull();
      }
    });

    it('conflicts instead of combining a board move with stale inheritance state', async () => {
      const tenantId = `policy-board-move-binding-${generateId()}` as TenantID;
      const value = await seed(tenantId);
      const destination = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new BoardRepository(scoped).create({
          name: `Destination ${generateId()}`,
          created_by: value.ownerId,
          access_mode: 'private',
        })
      );
      const sourcePolicy = await runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
        new CapabilityPolicyRepository(scoped).getBranchPolicy(value.branchId)
      );
      const inheritSource = {
        ...sourcePolicy,
        binding_mode: 'inherit' as const,
        override_config: undefined,
      };

      await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
        new CapabilityPolicyRepository(scoped).replaceBranchPolicy(
          value.branchId,
          inheritSource,
          value.ownerId
        )
      );
      await expect(
        runWithTenantDatabaseScope(dbA, tenantId, (scoped) =>
          new BranchRepository(scoped).update(value.branchId, {
            board_id: destination.board_id,
          })
        )
      ).rejects.toThrow(/explicit permission override/);

      const inverseTenantId = `policy-board-move-binding-inverse-${generateId()}` as TenantID;
      const inverse = await seed(inverseTenantId);
      const inverseDestination = await runWithTenantDatabaseScope(dbA, inverseTenantId, (scoped) =>
        new BoardRepository(scoped).create({
          name: `Inverse destination ${generateId()}`,
          created_by: inverse.ownerId,
          access_mode: 'private',
        })
      );
      const staleSourcePolicy = await runWithTenantDatabaseScope(dbA, inverseTenantId, (scoped) =>
        new CapabilityPolicyRepository(scoped).getBranchPolicy(inverse.branchId)
      );
      await runWithTenantDatabaseScope(dbB, inverseTenantId, (scoped) =>
        new BranchRepository(scoped).update(inverse.branchId, {
          board_id: inverseDestination.board_id,
        })
      );
      await expect(
        runWithTenantDatabaseScope(dbA, inverseTenantId, (scoped) =>
          new CapabilityPolicyRepository(scoped).replaceBranchPolicy(
            inverse.branchId,
            {
              ...staleSourcePolicy,
              binding_mode: 'inherit',
              override_config: undefined,
            },
            inverse.ownerId
          )
        )
      ).rejects.toThrow(/Branch board changed/);
      await expect(
        runWithTenantDatabaseScope(dbA, inverseTenantId, (scoped) =>
          new CapabilityPolicyRepository(scoped).getBranchPolicy(inverse.branchId)
        )
      ).resolves.toMatchObject({ binding_mode: 'override' });
    });
  }
);
