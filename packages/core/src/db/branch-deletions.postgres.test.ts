import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { BranchDeletionOperationRef, BranchID, TenantID, UserID } from '../types';
import { createDatabase } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import { runMigrations } from './migrate';
import { BranchDeletionRepository } from './repositories/branch-deletions';
import { BranchRepository } from './repositories/branches';
import { RepoRepository } from './repositories/repos';
import { UsersRepository } from './repositories/users';
import { runWithTenantDatabaseScope } from './tenant-scope';
import { acquireTenantWriteGate, releaseTenantWriteGate } from './tenant-write-gate';

const url = process.env.AGOR_TEST_POSTGRES_URL;

it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'binds deletion checkpoints and callbacks under FORCE RLS, including composite resource ownership',
  async () => {
    // The PostgreSQL suite runner supplies a fresh disposable database per file.
    const db = createDatabase({ dialect: 'postgresql', url: url! });
    if (!isPostgresDatabase(db)) throw new Error('Expected PostgreSQL fixture');
    try {
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
          )
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await runMigrations(db, { allowOfflineCutover: true });
      const tenantA = `deletion-a-${generateId()}` as TenantID;
      const tenantB = `deletion-b-${generateId()}` as TenantID;
      const ref = await runWithTenantDatabaseScope(
        db,
        tenantA,
        async (scoped): Promise<BranchDeletionOperationRef> => {
          const actor = generateId() as UserID;
          await new UsersRepository(scoped).create({
            user_id: actor,
            email: `${actor}@example.invalid`,
            role: 'member',
          });
          const repo = await new RepoRepository(scoped).create({
            repo_id: generateId(),
            slug: 'deletion-fixture',
            name: 'Fixture',
            repo_type: 'remote',
            remote_url: 'https://example.invalid/repo',
            local_path: '/disposable/not-materialized',
            default_branch: 'main',
          });
          const branch = await new BranchRepository(scoped).create({
            branch_id: generateId() as BranchID,
            repo_id: repo.repo_id,
            name: 'fixture',
            ref: 'fixture',
            branch_unique_id: 1,
            path: '/disposable/not-materialized/fixture',
            created_by: actor,
          });
          const repository = new BranchDeletionRepository(scoped);
          const receipt = await repository.recordRequest(branch.branch_id, actor);
          const ref = {
            tenant_id: tenantA,
            branch_id: branch.branch_id,
            operation_id: receipt.operation_id,
          };
          await repository.inventory(ref, [
            {
              resource_id: 'fixture',
              kind: 'upload',
              owner: 'fixture',
              locator: 'opaque',
              version: 'one',
            },
          ]);
          await repository.sealInventory(ref);
          return ref;
        }
      );
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        const foreign = { ...ref, tenant_id: tenantB };
        const repository = new BranchDeletionRepository(scoped);
        expect(await repository.get(foreign)).toBeNull();
        await expect(
          repository.recordRequest(ref.branch_id, generateId() as UserID)
        ).rejects.toThrow('not found');
        await expect(repository.beginInvocation(foreign, 'fixture', generateId())).rejects.toThrow(
          'unavailable'
        );
        expect(
          rawRows(
            await executeRaw(
              scoped,
              sql`SELECT * FROM branch_deletion_resources WHERE operation_id = ${ref.operation_id}`
            )
          )
        ).toEqual([]);
      });
      // A same-tenant INSERT cannot bind a resource to the other tenant's operation.
      await expect(
        runWithTenantDatabaseScope(db, tenantB, (scoped) =>
          executeRaw(
            scoped,
            sql`
        INSERT INTO branch_deletion_resources
          (tenant_id, operation_id, resource_id, kind, owner, locator, version, state)
        VALUES (${tenantB}, ${ref.operation_id}, 'forged', 'upload', 'fixture', 'opaque', 'one', 'pending')
      `
          )
        )
      ).rejects.toThrow();
      // Nor can raw SQL bypass the tenant policy by naming the foreign tenant.
      await expect(
        runWithTenantDatabaseScope(db, tenantB, (scoped) =>
          executeRaw(
            scoped,
            sql`
        INSERT INTO branch_deletion_resources
          (tenant_id, operation_id, resource_id, kind, owner, locator, version, state)
        VALUES (${tenantA}, ${ref.operation_id}, 'forged', 'upload', 'fixture', 'opaque', 'one', 'pending')
      `
          )
        )
      ).rejects.toThrow();
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        expect(await new BranchDeletionRepository(scoped).listResources(ref)).toMatchObject([
          { resource_id: 'fixture', state: 'pending' },
        ]);
      });
      const gate = await acquireTenantWriteGate(db, tenantA, {
        reason: 'disposable deletion fixture',
      });
      try {
        await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
          await expect(
            new BranchDeletionRepository(scoped).beginInvocation(ref, 'fixture', generateId())
          ).rejects.toThrow();
          expect(await new BranchDeletionRepository(scoped).get(ref)).not.toBeNull();
        });
      } finally {
        await releaseTenantWriteGate(db, tenantA, { generation: gate.generation });
      }
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('branch_deletion_operations', 'branch_deletion_resources')
      `
          )
        )
      ).toEqual([
        { relrowsecurity: true, relforcerowsecurity: true },
        { relrowsecurity: true, relforcerowsecurity: true },
      ]);
    } finally {
      await (db as typeof db & { $client: { end(): Promise<void> } }).$client.end();
    }
  },
  60_000
);
