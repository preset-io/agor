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
import { createDatabase, type Database, type SystemDatabase } from '../client';
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
const TX_PREFIX = `test.tx-${suffix}`;
const CONCURRENT_SEED = `test.concurrent-seed-${suffix}/mcp`;
const INTERLEAVED_SOURCES = `test.interleaved-sources-${suffix}/mcp`;
const INTERLEAVED_REGISTRY = `test.interleaved-registry-${suffix}/mcp`;
const INTERLEAVED_PROBE = `test.interleaved-probe-${suffix}/mcp`;
const INTERLEAVED_RETIREMENT = `test.interleaved-retirement-${suffix}/mcp`;

async function waitForBlockedCatalogRowLock(db: Database): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = (await executeRaw(
      db,
      sql`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%mcp_catalog_entries%'
          AND query ILIKE '%FOR UPDATE%'
      `
    )) as Array<{ count: number }>;
    if ((row?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the catalog writer to block on its row lock');
}

/**
 * Hold a catalog row in one capability transaction, start a second writer, and
 * release only after PostgreSQL proves that writer reached the row lock.
 */
async function interleaveCatalogWriters<HeldResult, BlockedResult>(
  db: Database,
  name: string,
  holdingWork: (scoped: SystemDatabase) => Promise<HeldResult>,
  blockedWork: () => Promise<BlockedResult>
): Promise<[HeldResult, BlockedResult]> {
  let reportLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    reportLocked = resolve;
  });
  let releaseLock!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  const holder = runWithSystemDatabaseScope(
    db,
    'hold catalog row for forced writer interleaving',
    async (scoped) => {
      await executeRaw(
        scoped as never,
        sql`SELECT 1 FROM mcp_catalog_entries WHERE name = ${name} FOR UPDATE`
      );
      reportLocked();
      await release;
      return holdingWork(scoped);
    },
    { capability: 'mcp_catalog_ingestion' }
  );

  await locked;
  const blocked = blockedWork();
  try {
    await waitForBlockedCatalogRowLock(db);
  } finally {
    releaseLock();
  }
  return Promise.all([holder, blocked]);
}

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

  it('lets two daemons seed the same curated natural key concurrently', async () => {
    const seedFromDaemon = () =>
      runWithSystemDatabaseScope(
        db,
        'concurrent mcp catalog seed test',
        (scoped) =>
          new MCPCatalogRepository(scoped as never).upsertCuration({
            name: CONCURRENT_SEED,
            category: 'dev-tools',
            capabilities: ['code-repos'],
            benefit: 'Benefit',
            starter_prompt: 'Prompt',
            permission_disclosure: 'Disclosure',
            verified: true,
          }),
        { capability: 'mcp_catalog_ingestion' }
      );

    await expect(Promise.all([seedFromDaemon(), seedFromDaemon()])).resolves.toEqual(
      expect.arrayContaining(['created', 'updated'])
    );
    expect(await repository.findByName(CONCURRENT_SEED)).toMatchObject({
      name: CONCURRENT_SEED,
      curated: true,
      category: 'dev-tools',
    });
    expect(await repository.count({ names: [CONCURRENT_SEED] })).toBe(1);
  });

  it('reloads the registry half after a stale curation writer acquires the row lock', async () => {
    await runWithSystemDatabaseScope(
      db,
      'seed interleaved catalog source test',
      (scoped) =>
        new MCPCatalogRepository(scoped as never).upsertRegistryEntry({
          name: INTERLEAVED_SOURCES,
          title: 'Old registry title',
          version: '1',
          registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
        }),
      { capability: 'mcp_catalog_ingestion' }
    );

    await interleaveCatalogWriters(
      db,
      INTERLEAVED_SOURCES,
      (scoped) =>
        new MCPCatalogRepository(scoped as never).upsertRegistryEntry({
          name: INTERLEAVED_SOURCES,
          title: 'Fresh registry title',
          version: '2',
          registry_updated_at: new Date('2026-02-01T00:00:00.000Z'),
        }),
      () =>
        runWithSystemDatabaseScope(
          db,
          'interleaved stale curation writer',
          (scoped) =>
            new MCPCatalogRepository(scoped as never).upsertCuration({
              name: INTERLEAVED_SOURCES,
              category: 'dev-tools',
              capabilities: ['code-repos'],
              description: 'Curated description',
              benefit: 'Benefit',
              starter_prompt: 'Prompt',
              permission_disclosure: 'Disclosure',
              verified: true,
            }),
          { capability: 'mcp_catalog_ingestion' }
        )
    );

    expect(await repository.findByName(INTERLEAVED_SOURCES)).toMatchObject({
      title: 'Fresh registry title',
      description: 'Curated description',
      version: '2',
      curated: true,
    });
  });

  it('does not let a stale registry publication overwrite a newer one', async () => {
    await runWithSystemDatabaseScope(
      db,
      'seed interleaved registry test',
      (scoped) =>
        new MCPCatalogRepository(scoped as never).upsertRegistryEntry({
          name: INTERLEAVED_REGISTRY,
          title: 'Initial registry title',
          version: '1',
          registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
        }),
      { capability: 'mcp_catalog_ingestion' }
    );

    const outcomes = await interleaveCatalogWriters(
      db,
      INTERLEAVED_REGISTRY,
      (scoped) =>
        new MCPCatalogRepository(scoped as never).upsertRegistryEntry({
          name: INTERLEAVED_REGISTRY,
          title: 'Newest registry title',
          version: '3',
          registry_updated_at: new Date('2026-03-01T00:00:00.000Z'),
        }),
      () =>
        runWithSystemDatabaseScope(
          db,
          'interleaved stale registry publication',
          (scoped) =>
            new MCPCatalogRepository(scoped as never).upsertRegistryEntry({
              name: INTERLEAVED_REGISTRY,
              title: 'Stale registry title',
              version: '2',
              registry_updated_at: new Date('2026-02-01T00:00:00.000Z'),
            }),
          { capability: 'mcp_catalog_ingestion' }
        )
    );
    expect(outcomes).toEqual(['updated', 'unchanged']);

    expect(await repository.findByName(INTERLEAVED_REGISTRY)).toMatchObject({
      title: 'Newest registry title',
      version: '3',
    });
  });

  it('discards a stale probe result after a concurrent endpoint move', async () => {
    const oldUrl = 'https://old.example.test/mcp';
    const newUrl = 'https://new.example.test/mcp';
    await runWithSystemDatabaseScope(
      db,
      'seed interleaved probe test',
      (scoped) =>
        new MCPCatalogRepository(scoped as never).upsertRegistryEntry({
          name: INTERLEAVED_PROBE,
          remote_url: oldUrl,
          registry_updated_at: new Date('2026-01-01T00:00:00.000Z'),
        }),
      { capability: 'mcp_catalog_ingestion' }
    );

    await interleaveCatalogWriters(
      db,
      INTERLEAVED_PROBE,
      (scoped) =>
        new MCPCatalogRepository(scoped as never).upsertRegistryEntry({
          name: INTERLEAVED_PROBE,
          remote_url: newUrl,
          registry_updated_at: new Date('2026-02-01T00:00:00.000Z'),
        }),
      () =>
        runWithSystemDatabaseScope(
          db,
          'interleaved stale probe writer',
          (scoped) =>
            new MCPCatalogRepository(scoped as never).recordProbeResult(INTERLEAVED_PROBE, {
              probed_auth_type: 'none',
              probed_at: new Date('2026-01-15T00:00:00.000Z'),
              probed_url: oldUrl,
            }),
          { capability: 'mcp_catalog_ingestion' }
        )
    );

    expect(await repository.findByName(INTERLEAVED_PROBE)).toMatchObject({
      remote_url: newUrl,
      probed_auth_type: 'unknown',
    });
  });

  it('treats a concurrent retirement deletion as already absent', async () => {
    await runWithSystemDatabaseScope(
      db,
      'seed interleaved retirement test',
      (scoped) =>
        new MCPCatalogRepository(scoped as never).upsertCuration({
          name: INTERLEAVED_RETIREMENT,
          category: 'dev-tools',
          capabilities: ['code-repos'],
          benefit: 'Benefit',
          starter_prompt: 'Prompt',
          permission_disclosure: 'Disclosure',
          verified: true,
        }),
      { capability: 'mcp_catalog_ingestion' }
    );

    const outcomes = await interleaveCatalogWriters(
      db,
      INTERLEAVED_RETIREMENT,
      (scoped) => new MCPCatalogRepository(scoped as never).retireCuration(INTERLEAVED_RETIREMENT),
      () =>
        runWithSystemDatabaseScope(
          db,
          'interleaved duplicate curation retirement',
          (scoped) =>
            new MCPCatalogRepository(scoped as never).retireCuration(INTERLEAVED_RETIREMENT),
          { capability: 'mcp_catalog_ingestion' }
        )
    );

    expect(outcomes).toEqual(['deleted', 'absent']);
    expect(await repository.findByName(INTERLEAVED_RETIREMENT)).toBeNull();
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

  it('isolates a failing row so its neighbours still commit', async () => {
    // The reason ingestion opens one database unit per entry. On Postgres a
    // failed statement aborts the enclosing transaction: sharing a unit across
    // a page would make every later row fail with 25P02 and would roll back the
    // rows already written, while the counters still reported them as created.
    // SQLite has no such behaviour, so no SQLite test can catch a regression.
    //
    // The poison statement must run on the SCOPED handle. Issued on the outer
    // pool it would fail harmlessly on another connection and prove nothing.
    const poison = (scoped: unknown) =>
      executeRaw(
        scoped as Database,
        sql`INSERT INTO mcp_catalog_entries (catalog_entry_id) VALUES (NULL)`
      );

    const perEntry = [`${TX_PREFIX}-first`, `${TX_PREFIX}-poison`, `${TX_PREFIX}-last`];
    const outcomes: string[] = [];
    for (const name of perEntry) {
      try {
        await runWithSystemDatabaseScope(
          db,
          'mcp catalog per-entry isolation test',
          async (scoped) => {
            if (name.endsWith('-poison')) await poison(scoped);
            await new MCPCatalogRepository(scoped as never).upsertRegistryEntry({
              name,
              version: '1',
            });
          },
          { capability: 'mcp_catalog_ingestion' }
        );
        outcomes.push('ok');
      } catch {
        outcomes.push('failed');
      }
    }

    expect(outcomes).toEqual(['ok', 'failed', 'ok']);
    expect(await repository.findByName(perEntry[0])).not.toBeNull();
    expect(await repository.findByName(perEntry[1])).toBeNull();
    expect(await repository.findByName(perEntry[2])).not.toBeNull();

    // The counterfactual, so the assertions above are not vacuous: the same
    // writes sharing ONE unit lose the row committed before the failure.
    const shared = [`${TX_PREFIX}-shared-first`, `${TX_PREFIX}-shared-last`];
    await expect(
      runWithSystemDatabaseScope(
        db,
        'mcp catalog shared-unit counterfactual',
        async (scoped) => {
          const repo = new MCPCatalogRepository(scoped as never);
          await repo.upsertRegistryEntry({ name: shared[0], version: '1' });
          await poison(scoped).catch(() => {});
          // Postgres has aborted the transaction; nothing else can succeed.
          await repo.upsertRegistryEntry({ name: shared[1], version: '1' });
        },
        { capability: 'mcp_catalog_ingestion' }
      )
    ).rejects.toThrow();

    expect(await repository.findByName(shared[0])).toBeNull();
    expect(await repository.findByName(shared[1])).toBeNull();
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
