import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { BranchID, TenantID, UUID } from '../../types';
import type { WorkspaceState } from '../../workspaces/types';
import { runWithTenantContext } from '../tenant-context';
import { ownedDbTest } from '../test-helpers';
import { BranchWorkspaceRepository } from './branch-workspaces';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';

describe('SQL branch workspace authority', () => {
  ownedDbTest('persists state, rolls back failure and enforces tenant identity', async ({ db }) => {
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: 'workspace',
      name: 'workspace',
      repo_type: 'remote',
      remote_url: 'https://example.com/repo',
      local_path: '/tmp/repo',
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: 'main',
      created_by: 'test-user' as UUID,
      ref: 'main',
      path: '/tmp/repo',
      branch_unique_id: 1,
    });
    const scope = { tenantId: 'tenant-a' as TenantID, branchId: branch.branch_id };
    const store = new BranchWorkspaceRepository(db, scope);
    await expect(store.read()).rejects.toThrow('tenant context');
    await runWithTenantContext(scope.tenantId, async () => {
      expect((await store.read()).state).toBeNull();
      await store.mutate((_s, now) => {
        const state: WorkspaceState = {
          schema: 1,
          scope,
          revision: 0,
          epoch: 1,
          host: 'worker',
          leaseUntil: now + 10000,
          tree: {},
          versions: {},
          active: {},
          receipts: {},
          updatedAt: now,
        };
        return { state, result: undefined };
      });
      await expect(
        store.mutate((s) => {
          s!.revision = 999;
          throw new Error('crash');
        })
      ).rejects.toThrow('crash');
      expect((await store.read()).state?.revision).toBe(0);
      for (let i = 0; i < 4; i++)
        await store.mutate((s) => {
          s!.revision++;
          return { state: s!, result: s!.revision };
        });
      expect((await new BranchWorkspaceRepository(db, scope).read()).state?.revision).toBe(4);
      expect(await new BranchRepository(db).findById(branch.branch_id)).not.toHaveProperty(
        'workspace_state'
      );
    });
    await runWithTenantContext('tenant-b', async () => {
      await expect(store.read()).rejects.toThrow('tenant context');
    });
  });
});
