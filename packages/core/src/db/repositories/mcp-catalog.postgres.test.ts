/**
 * PostgreSQL integration for the shared MCP catalog.
 *
 * `mcp_catalog_entries` is the only table with no `tenant_id`, so its isolation
 * story is entirely in RLS: reads open to every tenant, writes confined to the
 * `mcp_catalog_ingestion` system capability. That contract cannot be exercised
 * on SQLite, which has no row-level security, so it is asserted here.
 *
 * The connecting role must NOT be a superuser or carry BYPASSRLS — either
 * bypasses row-level security entirely and would make these assertions vacuous.
 * The suite checks that up front and fails loudly rather than passing silently.
 * Such a role usually cannot run migrations either, so point it at a database
 * that has already been migrated; the suite only bootstraps the schema when it
 * is missing and the role happens to be allowed to.
 *
 * Run with, e.g.:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://appuser:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/repositories/mcp-catalog.postgres.test.ts
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../client';
import { executeRaw } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from '../tenant-scope';
import { MCPCatalogRepository } from './mcp-catalog';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const describePostgres = postgresUrl && usesPostgresSchema ? describe : describe.skip;

/** Distinct per run so repeated runs against one database do not collide. */
const suffix = `${process.pid}-${Math.trunc(performance.now())}`;
const CAPABILITY_WRITE = `test.capability-${suffix}/mcp`;
const UNSCOPED_WRITE = `test.unscoped-${suffix}/mcp`;
const TENANT_WRITE = `test.tenant-${suffix}/mcp`;

describePostgres('mcp_catalog_entries row-level security', () => {
  let db: Database;
  let repository: MCPCatalogRepository;

  beforeAll(async () => {
    db = createDatabase({ url: postgresUrl as string, dialect: 'postgresql' });
    repository = new MCPCatalogRepository(db);

    const catalogExists = async (): Promise<boolean> => {
      const [row] = (await executeRaw(
        db,
        sql`SELECT to_regclass('public.mcp_catalog_entries') IS NOT NULL AS present`
      )) as Array<{ present: boolean }>;
      return Boolean(row?.present);
    };

    if (!(await catalogExists())) {
      await initializeDatabase(db);
      if (!(await catalogExists())) {
        throw new Error('mcp_catalog_entries is missing; migrate the test database first.');
      }
    }

    const [role] = (await executeRaw(
      db,
      sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    )) as Array<{ rolsuper: boolean; rolbypassrls: boolean }>;
    if (role?.rolsuper || role?.rolbypassrls) {
      throw new Error(
        'AGOR_TEST_POSTGRES_URL must connect as a role without SUPERUSER or BYPASSRLS; ' +
          'either one skips RLS and would make these assertions vacuous.'
      );
    }
  });

  it('enables and forces row-level security on the shared catalog', async () => {
    const [flags] = (await executeRaw(
      db,
      sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'mcp_catalog_entries'`
    )) as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;

    expect(flags.relrowsecurity).toBe(true);
    expect(flags.relforcerowsecurity).toBe(true);
  });

  it('accepts a write made under the ingestion capability', async () => {
    await runWithSystemDatabaseScope(
      db,
      'mcp catalog rls test',
      async (scoped) => {
        const scopedRepo = new MCPCatalogRepository(scoped as never);
        expect(await scopedRepo.upsertRegistryEntry({ name: CAPABILITY_WRITE, version: '1' })).toBe(
          'created'
        );
      },
      { capability: 'mcp_catalog_ingestion' }
    );

    expect(await repository.findByName(CAPABILITY_WRITE)).not.toBeNull();
  });

  it('refuses a write made without any system capability', async () => {
    await expect(
      repository.upsertRegistryEntry({ name: UNSCOPED_WRITE, version: '1' })
    ).rejects.toThrow();
    expect(await repository.findByName(UNSCOPED_WRITE)).toBeNull();
  });

  it('refuses a write made from a tenant-scoped request path', async () => {
    // This is the isolation that matters: a tenant-owned service reaching the
    // shared catalog must not be able to mutate what every other tenant reads.
    await expect(
      runWithTenantDatabaseScope(db, 'tenant-a', (scoped) =>
        new MCPCatalogRepository(scoped as never).upsertRegistryEntry({
          name: TENANT_WRITE,
          version: '1',
        })
      )
    ).rejects.toThrow();

    expect(await repository.findByName(TENANT_WRITE)).toBeNull();
  });

  it('serves the same catalog to every tenant scope', async () => {
    const readAs = (tenantId: string) =>
      runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new MCPCatalogRepository(scoped as never).findByName(CAPABILITY_WRITE)
      );

    expect(await readAs('tenant-a')).not.toBeNull();
    expect(await readAs('tenant-b')).not.toBeNull();
    // And with no tenant scope at all, since the catalog belongs to no tenant.
    expect(await repository.findByName(CAPABILITY_WRITE)).not.toBeNull();
  });

  it('pushes filters into Postgres, not just SQLite', async () => {
    await runWithSystemDatabaseScope(
      db,
      'mcp catalog rls test',
      async (scoped) => {
        await new MCPCatalogRepository(scoped as never).upsertCuration({
          name: CAPABILITY_WRITE,
          category: 'observability',
          capabilities: ['traces', 'metrics'],
          benefit: 'Benefit',
          starter_prompt: 'Prompt',
          permission_disclosure: 'Disclosure',
          verified: true,
        });
      },
      { capability: 'mcp_catalog_ingestion' }
    );

    // Postgres LIKE is case-sensitive; the repository lowercases both sides.
    const found = await repository.findAll({
      search: CAPABILITY_WRITE.toUpperCase(),
      category: 'observability',
      capability: 'traces',
      verified: true,
      limit: 5,
    });

    expect(found.map((entry) => entry.name)).toEqual([CAPABILITY_WRITE]);
    expect(await repository.count({ capability: 'metrics', names: [CAPABILITY_WRITE] })).toBe(1);
  });
});
