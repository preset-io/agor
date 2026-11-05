import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { BranchID } from '../../types';
import { createDatabase, type Database } from '../client';
import { executeRaw, isPostgresDatabase } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { KnowledgeNamespaceRepository } from './knowledge';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

const url = process.env.AGOR_TEST_POSTGRES_URL;
const enabled = Boolean(url) && process.env.AGOR_DB_DIALECT === 'postgresql';
let db: Database;

beforeAll(async () => {
  if (!enabled) return;
  db = createDatabase({ dialect: 'postgresql', url: url! });
  await initializeDatabase(db);
  if (!isPostgresDatabase(db)) throw new Error('Expected PostgreSQL');
});

afterAll(async () => {
  if (enabled) await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
});

it.skipIf(!enabled)(
  'grants branch-owner access only through a branch in the caller tenant',
  async () => {
    const tenantA = `kb-branch-owner-a-${generateId()}`;
    const tenantB = `kb-branch-owner-b-${generateId()}`;
    const seeded = await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      const owner = await new UsersRepository(scoped).create({
        email: `${generateId()}@example.invalid`,
      });
      const repo = await new RepoRepository(scoped).create({
        slug: `kb-branch-owner-${generateId()}`,
        name: 'KB branch owner',
        repo_type: 'remote',
        remote_url: 'https://github.com/test/repo.git',
        local_path: '/tmp/repo',
        default_branch: 'main',
      });
      const branch = await new BranchRepository(scoped).create({
        branch_id: generateId() as BranchID,
        repo_id: repo.repo_id,
        name: 'teammate',
        ref: 'teammate',
        branch_unique_id: 1,
        created_by: owner.user_id,
      });
      const namespace = await new KnowledgeNamespaceRepository(scoped).create({
        slug: `home-${generateId()}`,
        kind: 'branch',
        branch_id: branch.branch_id,
        others_can: 'none',
      });
      return { owner, branch, namespace };
    });

    await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      expect(
        await new KnowledgeNamespaceRepository(scoped).resolveNamespacePermission(
          seeded.namespace.namespace_id,
          seeded.owner.user_id
        )
      ).toBe('own');
    });

    await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
      await expect(
        new KnowledgeNamespaceRepository(scoped).create({
          slug: `foreign-${generateId()}`,
          kind: 'branch',
          branch_id: seeded.branch.branch_id,
        })
      ).rejects.toThrow(/Branch with ID .* not found/);
      // A row naming another tenant's branch (foreign keys ignore RLS) must not inherit its owner.
      const foreignId = generateId();
      await executeRaw(
        scoped,
        sql`INSERT INTO kb_namespaces (tenant_id, namespace_id, slug, display_name, kind, branch_id, visibility_default, others_can, created_at, updated_at, archived)
            VALUES (${tenantB}, ${foreignId}, ${`foreign-${foreignId}`}, 'Foreign', 'branch', ${seeded.branch.branch_id}, 'public', 'none', now(), now(), false)`
      );
      expect(
        await new KnowledgeNamespaceRepository(scoped).resolveNamespacePermission(
          foreignId,
          seeded.owner.user_id
        )
      ).toBe('none');
    });
  },
  60000
);
