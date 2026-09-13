import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type {
  BranchDeletionOperationRef,
  BranchDeletionResourceIdentity,
  BranchID,
  TenantID,
  UserID,
} from '../../types';
import type { Database } from '../client';
import { deleteFrom, insert } from '../database-wrapper';
import { branches, repos } from '../schema';
import { runWithTenantContext } from '../tenant-context';
import { dbTest, ensureTestUser } from '../test-helpers';
import { BranchDeletionRepository } from './branch-deletions';

const tenantA = 'ledger-tenant-a' as TenantID;
const tenantB = 'ledger-tenant-b' as TenantID;
const actor = generateId() as UserID;

async function seed(db: Database) {
  await ensureTestUser(db, actor);
  const branchId = generateId() as BranchID;
  const repoId = generateId();
  await insert(db, repos)
    .values({
      repo_id: repoId,
      slug: 'fixture/repo',
      created_at: new Date(),
      data: {
        name: 'Fixture',
        remote_url: 'https://example.invalid/repo',
        local_path: '/disposable/not-materialized',
        default_branch: 'main',
      },
    })
    .run();
  await insert(db, branches)
    .values({
      branch_id: branchId,
      repo_id: repoId,
      created_at: new Date(),
      created_by: actor,
      primary_owner_user_id: actor,
      name: 'fixture',
      ref: 'fixture',
      branch_unique_id: 1,
      data: {
        path: '/disposable/not-materialized/fixture',
        new_branch: true,
        last_used: new Date().toISOString(),
      },
    })
    .run();
  const repository = new BranchDeletionRepository(db);
  const request = await repository.recordRequest(branchId, actor);
  const ref: BranchDeletionOperationRef = {
    tenant_id: tenantA,
    branch_id: branchId,
    operation_id: request.operation_id,
  };
  return { repository, ref, request };
}

function resource(id: string): BranchDeletionResourceIdentity {
  return {
    resource_id: id,
    kind: 'upload',
    owner: 'fixture-byte-store',
    locator: `opaque-${id}`,
    version: 'generation-1',
  };
}

describe('branch deletion checkpoint storage (not lifecycle admission)', () => {
  dbTest(
    'joins repeat requests and keeps the receipt after the subject is removed',
    async ({ db }) =>
      runWithTenantContext(tenantA, async () => {
        const { repository, ref, request } = await seed(db);
        expect(await repository.recordRequest(ref.branch_id, generateId() as UserID)).toEqual(
          request
        );
        await repository.inventory(ref, [resource('one')]);
        // Only the disposable fixture row is deleted, never a workspace or live branch.
        await deleteFrom(db, branches).where(eq(branches.branch_id, ref.branch_id)).run();
        expect(await new BranchDeletionRepository(db).get(ref)).toMatchObject({
          operation_id: ref.operation_id,
          status: 'pending',
        });
        expect(await repository.listResources(ref)).toHaveLength(1);
        expect(request).not.toHaveProperty('locator');
      })
  );

  dbTest(
    'rolls back a conflicting inventory page without erasing prior checkpoints',
    async ({ db }) =>
      runWithTenantContext(tenantA, async () => {
        const { repository, ref } = await seed(db);
        await repository.inventory(ref, [resource('b')]);
        await expect(
          repository.inventory(ref, [resource('a'), { ...resource('b'), version: 'replacement' }])
        ).rejects.toThrow('inventory requires reconciliation');
        expect((await repository.listResources(ref)).map((row) => row.resource_id)).toEqual(['b']);
        await repository.inventory(ref, [resource('b')]);
        await repository.sealInventory(ref);
        await expect(repository.inventory(ref, [resource('c')])).rejects.toThrow('sealed');
      })
  );

  dbTest(
    'does not redispatch unknown effects after restart and rejects stale confirmations',
    async ({ db }) =>
      runWithTenantContext(tenantA, async () => {
        const { repository, ref } = await seed(db);
        await repository.inventory(ref, [resource('one')]);
        const invocationId = generateId();
        await expect(repository.beginInvocation(ref, 'one', invocationId)).rejects.toThrow(
          'not sealed'
        );
        await repository.sealInventory(ref);
        await repository.beginInvocation(ref, 'one', invocationId);
        const restarted = new BranchDeletionRepository(db);
        await expect(restarted.beginInvocation(ref, 'one', invocationId)).rejects.toThrow(
          'has not settled'
        );
        await expect(restarted.beginInvocation(ref, 'one', generateId())).rejects.toThrow(
          'has not settled'
        );
        await expect(restarted.confirmRemoval(ref, 'one', generateId())).rejects.toThrow(
          'has not settled'
        );
        await restarted.confirmRemoval(ref, 'one', invocationId);
        await restarted.confirmRemoval(ref, 'one', invocationId);
        expect(await restarted.listResources(ref)).toMatchObject([
          { state: 'removed', invocation_id: invocationId, version: 'generation-1' },
        ]);
        // Storage acknowledgement alone is never a completed branch deletion.
        expect(await restarted.get(ref)).toMatchObject({ status: 'pending' });
      })
  );

  dbTest('binds reads, inventory and callbacks to tenant, branch and operation', async ({ db }) => {
    const fixture = await runWithTenantContext(tenantA, () => seed(db));
    const { repository, ref } = fixture;
    await expect(repository.get(ref)).rejects.toThrow('tenant context');
    await runWithTenantContext(tenantB, async () => {
      await expect(repository.get(ref)).rejects.toThrow('trusted context');
    });
    await runWithTenantContext(tenantA, async () => {
      const forgedBranch = { ...ref, branch_id: generateId() as BranchID };
      expect(await repository.get(forgedBranch)).toBeNull();
      await expect(repository.inventory(forgedBranch, [resource('foreign')])).rejects.toThrow(
        'unavailable'
      );
      expect(await repository.listResources(ref)).toEqual([]);
    });
  });

  dbTest('bounds inventory writes and keyset pages without using offsets', async ({ db }) =>
    runWithTenantContext(tenantA, async () => {
      const { repository, ref } = await seed(db);
      const page = Array.from({ length: 200 }, (_, i) => resource(String(i).padStart(3, '0')));
      await repository.inventory(ref, page);
      await repository.inventory(ref, [resource('200')]);
      await expect(repository.inventory(ref, [...page, resource('overflow')])).rejects.toThrow(
        'page size'
      );
      await expect(repository.listResources(ref, { limit: 201 })).rejects.toThrow('page size');
      expect(await repository.listResources(ref)).toHaveLength(200);
      expect(
        (await repository.listResources(ref, { after: '199' })).map((row) => row.resource_id)
      ).toEqual(['200']);
    })
  );
});
