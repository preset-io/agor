import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  initializeDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import type { Repo, TenantID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'clone claims across replicas and RLS tenants',
  () => {
    let dbA: Database;
    let dbB: Database;
    beforeAll(async () => {
      dbA = createDatabase({ dialect: 'postgresql', url: url! });
      dbB = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(dbA);
    });
    afterAll(async () => {
      await Promise.all(
        [dbA, dbB].map((db) =>
          (db as Database & { $client: { end: () => Promise<void> } }).$client.end()
        )
      );
    });
    it('one first-run/retry claim wins; tenant B cannot read or complete A even with its ID/generation', async () => {
      const tenantA = `bootstrap-a-${generateId()}` as TenantID;
      const tenantB = `bootstrap-b-${generateId()}` as TenantID;
      const a = createTenantScopedDatabaseProxy(dbA, { requireScope: true });
      const b = createTenantScopedDatabaseProxy(dbB, { requireScope: true });
      const data: Partial<Repo> = {
        slug: 'synthetic/shared-slug',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/synthetic/shared.git',
        local_path: '/tmp/synthetic/a',
        default_branch: 'main',
      };
      const claims = await Promise.all(
        [a, b].map((db) =>
          runWithTenantDatabaseScope(db, tenantA, () => new RepoRepository(db).claimClone(data))
        )
      );
      expect(claims.filter((c) => c.acquired)).toHaveLength(1);
      expect(claims[0].repo.repo_id).toBe(claims[1].repo.repo_id);
      const first = claims[0].repo;
      await runWithTenantDatabaseScope(a, tenantA, () =>
        new RepoRepository(a).update(first.repo_id, {
          clone_status: 'failed',
          clone_generation: first.clone_generation,
        })
      );
      const retries = await Promise.all(
        [a, b].map((db) =>
          runWithTenantDatabaseScope(db, tenantA, () => new RepoRepository(db).claimClone(data))
        )
      );
      expect(retries.filter((c) => c.acquired)).toHaveLength(1);
      expect(retries[0].repo).toMatchObject({ repo_id: first.repo_id, clone_generation: 2 });
      await runWithTenantDatabaseScope(b, tenantB, async () => {
        const repository = new RepoRepository(b);
        expect(await repository.findById(first.repo_id)).toBeNull();
        await expect(
          repository.update(first.repo_id, { clone_status: 'ready', clone_generation: 2 })
        ).rejects.toThrow();
        const own = await repository.claimClone({ ...data, local_path: '/tmp/synthetic/b' });
        expect(own.acquired).toBe(true);
        expect(own.repo.repo_id).not.toBe(first.repo_id);
      });
      await runWithTenantDatabaseScope(a, tenantA, async () => {
        expect(await new RepoRepository(a).findById(first.repo_id)).toMatchObject({
          clone_status: 'cloning',
          clone_generation: 2,
          local_path: '/tmp/synthetic/a',
        });
      });
    });
  }
);
