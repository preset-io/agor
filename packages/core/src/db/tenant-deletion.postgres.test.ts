/**
 * PostgreSQL integration for tenant deletion — exercises real RLS-scoped
 * deletion, cross-tenant isolation, idempotency, the frozen output contract, and
 * dry-run. Gated on an explicit test database, mirroring the repository
 * PostgreSQL suites (`*.postgres.test.ts`); skipped in the SQLite fast-lane CI.
 *
 * Run with, e.g.:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/tenant-deletion.postgres.test.ts
 */

import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { UUID } from '../types/id';
import { createDatabase, type Database } from './client';
import { executeRaw, insert, isPostgresDatabase, select } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { BranchRepository } from './repositories/branches';
import { RepoRepository } from './repositories/repos';
import { SessionRepository } from './repositories/sessions';
import { UsersRepository } from './repositories/users';
import * as pg from './schema.postgres';
import { deleteTenantData, TenantDeletionCatalogError } from './tenant-deletion';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const postgresAdminUrl = process.env.AGOR_TEST_POSTGRES_ADMIN_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

// int4 column; keep values small and monotonically unique across seeds.
let branchUniqueSeq = Date.now() % 1_000_000;

async function seedTenant(db: Database, tenantId: string): Promise<void> {
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const ownerId = generateId() as UUID;
    await new UsersRepository(scoped).create({
      user_id: ownerId,
      email: `tenant-deletion-${tenantId}-${generateId()}@example.invalid`,
      role: 'member',
    });
    const repoId = generateId();
    await new RepoRepository(scoped).create({
      repo_id: repoId,
      slug: `td-${tenantId}-${repoId}`,
      name: `repo ${tenantId}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/tenant-deletion.git',
      local_path: `/tmp/${repoId}`,
      default_branch: 'main',
    });
    const branchId = generateId();
    await new BranchRepository(scoped).create({
      branch_id: branchId,
      repo_id: repoId,
      name: `branch-${tenantId}`,
      ref: 'main',
      branch_unique_id: branchUniqueSeq++,
      path: `/tmp/${branchId}`,
      created_by: ownerId,
    });
    await new SessionRepository(scoped).create({
      session_id: generateId(),
      branch_id: branchId,
      agentic_tool: 'claude-code',
      created_by: ownerId,
    });
  });
}

async function countTenantSessions(db: Database, tenantId: string): Promise<number> {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const rows = (await select(scoped, { n: count() })
      .from(pg.sessions)
      .where(eq(pg.sessions.tenant_id, tenantId))
      .all()) as Array<{ n: number | string }>;
    return Number(rows[0]?.n ?? 0);
  });
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

async function closePostgresDatabase(db: Database): Promise<void> {
  await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
}

function errorChainMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current) {
    messages.push(current instanceof Error ? current.message : String(current));
    current =
      current && typeof current === 'object' && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return messages.join('\n');
}

async function ensureImperativeEmbeddingTable(db: Database): Promise<void> {
  // The stock PostgreSQL test image does not ship pgvector. A text-backed domain
  // lets this test use the runtime table DDL unchanged; deletion only depends on
  // the tenant discriminator, foreign keys, and RLS contract.
  await executeRaw(
    db,
    sql`
      DO $block$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_type t
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typname = 'vector'
        ) THEN
          CREATE DOMAIN public.vector AS text;
        END IF;
      END
      $block$
    `
  );
  await executeRaw(
    db,
    sql`
      CREATE TABLE IF NOT EXISTS public.kb_unit_embeddings (
        tenant_id text DEFAULT 'default' NOT NULL,
        unit_id varchar(36) NOT NULL
          REFERENCES public.kb_document_units(unit_id) ON DELETE cascade,
        embedding_space_id varchar(36) NOT NULL
          REFERENCES public.kb_embedding_spaces(embedding_space_id) ON DELETE cascade,
        content_sha256 text NOT NULL,
        embedding vector NOT NULL,
        token_count integer,
        created_at timestamp with time zone NOT NULL,
        updated_at timestamp with time zone NOT NULL,
        CONSTRAINT kb_unit_embeddings_unit_id_embedding_space_id_pk
          PRIMARY KEY(unit_id, embedding_space_id)
      )
    `
  );
  await executeRaw(db, sql`ALTER TABLE public.kb_unit_embeddings ENABLE ROW LEVEL SECURITY`);
  await executeRaw(db, sql`ALTER TABLE public.kb_unit_embeddings FORCE ROW LEVEL SECURITY`);
  await executeRaw(
    db,
    sql`DROP POLICY IF EXISTS tenant_isolation_kb_unit_embeddings ON public.kb_unit_embeddings`
  );
  await executeRaw(
    db,
    sql`
      CREATE POLICY tenant_isolation_kb_unit_embeddings ON public.kb_unit_embeddings
        USING (
          tenant_id = COALESCE(
            NULLIF(current_setting('agor.tenant_id', true), ''),
            'default'
          )
        )
        WITH CHECK (
          tenant_id = COALESCE(
            NULLIF(current_setting('agor.tenant_id', true), ''),
            'default'
          )
        )
    `
  );
}

async function seedEmbedding(db: Database, tenantId: string): Promise<void> {
  const namespaceId = generateId();
  const documentId = generateId();
  const versionId = generateId();
  const unitId = generateId();
  const embeddingSpaceId = generateId();
  const now = new Date();

  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    await insert(scoped, pg.kbNamespaces)
      .values({
        namespace_id: namespaceId,
        slug: `td-${namespaceId}`,
        display_name: `tenant deletion ${tenantId}`,
        created_at: now,
      })
      .run();
    await insert(scoped, pg.kbDocuments)
      .values({
        document_id: documentId,
        namespace_id: namespaceId,
        path: `${documentId}.md`,
        uri: `agor://knowledge/${namespaceId}/${documentId}.md`,
        title: `tenant deletion ${tenantId}`,
        created_at: now,
      })
      .run();
    await insert(scoped, pg.kbDocumentVersions)
      .values({
        version_id: versionId,
        document_id: documentId,
        version_number: 1,
        content_text: tenantId,
        content_sha256: `sha-${tenantId}`,
        created_at: now,
      })
      .run();
    await insert(scoped, pg.kbDocumentUnits)
      .values({
        unit_id: unitId,
        document_id: documentId,
        version_id: versionId,
        content_text: tenantId,
        created_at: now,
      })
      .run();
    await insert(scoped, pg.kbEmbeddingSpaces)
      .values({
        embedding_space_id: embeddingSpaceId,
        provider: 'test',
        model: 'test',
        dimensions: 3,
        created_at: now,
      })
      .run();
    await executeRaw(
      scoped,
      sql`
        INSERT INTO public.kb_unit_embeddings (
          tenant_id,
          unit_id,
          embedding_space_id,
          content_sha256,
          embedding,
          token_count,
          created_at,
          updated_at
        )
        VALUES (
          ${tenantId},
          ${unitId},
          ${embeddingSpaceId},
          ${`sha-${tenantId}`},
          '[0,0,0]'::vector,
          1,
          ${now.toISOString()},
          ${now.toISOString()}
        )
      `
    );
  });
}

async function countTenantEmbeddings(db: Database, tenantId: string): Promise<number> {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const result = await executeRaw(
      scoped,
      sql`SELECT count(*) AS n FROM public.kb_unit_embeddings WHERE tenant_id = ${tenantId}`
    );
    return Number(rowsOf(result)[0]?.n ?? 0);
  });
}

async function installCanonicalTenantPolicy(db: Database, tableName: string): Promise<void> {
  const table = sql`${sql.identifier('public')}.${sql.identifier(tableName)}`;
  const policy = sql.identifier(`tenant_isolation_${tableName}`);
  await executeRaw(db, sql`DROP POLICY IF EXISTS ${policy} ON ${table}`);
  await executeRaw(
    db,
    sql`
      CREATE POLICY ${policy} ON ${table}
        AS PERMISSIVE
        FOR ALL
        TO PUBLIC
        USING (
          tenant_id = COALESCE(
            NULLIF(current_setting('agor.tenant_id', true), ''),
            'default'
          )
        )
        WITH CHECK (
          tenant_id = COALESCE(
            NULLIF(current_setting('agor.tenant_id', true), ''),
            'default'
          )
        )
    `
  );
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)('deleteTenantData (PostgreSQL)', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
  });

  afterAll(async () => {
    await closePostgresDatabase(db);
  });

  it('deletes one tenant, leaves others intact, and is idempotent', async () => {
    const tenantA = `tda-${generateId()}`;
    const tenantB = `tdb-${generateId()}`;
    await seedTenant(db, tenantA);
    await seedTenant(db, tenantB);

    expect(await countTenantSessions(db, tenantA)).toBe(1);
    expect(await countTenantSessions(db, tenantB)).toBe(1);

    const result = await deleteTenantData(db, tenantA);

    // Frozen output contract: exactly these keys, all values numbers/strings/bools.
    expect(Object.keys(result).sort()).toEqual(['rowCounts', 'schemaVersion', 'tenantDataDeleted']);
    expect(result.tenantDataDeleted).toBe(true);
    expect(typeof result.schemaVersion).toBe('string');
    expect(result.schemaVersion.length).toBeGreaterThan(0);
    expect(result.rowCounts.sessions).toBeGreaterThanOrEqual(1);
    expect(result.rowCounts.repos).toBeGreaterThanOrEqual(1);
    expect(result.rowCounts.branches).toBeGreaterThanOrEqual(1);
    for (const value of Object.values(result.rowCounts)) {
      expect(typeof value).toBe('number');
    }

    // Tenant A erased, tenant B untouched.
    expect(await countTenantSessions(db, tenantA)).toBe(0);
    expect(await countTenantSessions(db, tenantB)).toBe(1);

    // Second run deletes nothing yet still reports success.
    const second = await deleteTenantData(db, tenantA);
    expect(second.tenantDataDeleted).toBe(true);
    const secondTotal = Object.values(second.rowCounts).reduce((sum, value) => sum + value, 0);
    expect(secondTotal).toBe(0);

    await deleteTenantData(db, tenantB);
    expect(await countTenantSessions(db, tenantB)).toBe(0);
  });

  it('dry-run reports counts without deleting', async () => {
    const tenantC = `tdc-${generateId()}`;
    await seedTenant(db, tenantC);

    const dry = await deleteTenantData(db, tenantC, { dryRun: true });
    expect(dry.tenantDataDeleted).toBe(false);
    expect('dryRun' in dry && dry.dryRun).toBe(true);
    expect(dry.rowCounts.sessions).toBeGreaterThanOrEqual(1);

    // Nothing was actually deleted.
    expect(await countTenantSessions(db, tenantC)).toBe(1);

    await deleteTenantData(db, tenantC);
    expect(await countTenantSessions(db, tenantC)).toBe(0);
  });

  it('deletes and verifies the imperative embeddings table without touching another tenant', async () => {
    await ensureImperativeEmbeddingTable(db);
    const tenantA = `tde-a-${generateId()}`;
    const tenantB = `tde-b-${generateId()}`;
    await seedEmbedding(db, tenantA);
    await seedEmbedding(db, tenantB);

    expect(await countTenantEmbeddings(db, tenantA)).toBe(1);
    expect(await countTenantEmbeddings(db, tenantB)).toBe(1);

    const result = await deleteTenantData(db, tenantA);
    expect(result.rowCounts.kb_unit_embeddings).toBe(1);
    expect(await countTenantEmbeddings(db, tenantA)).toBe(0);
    expect(await countTenantEmbeddings(db, tenantB)).toBe(1);

    await deleteTenantData(db, tenantB);
    expect(await countTenantEmbeddings(db, tenantB)).toBe(0);
  });

  it('uses audited public relations when temporary tables shadow catalog and plan names', async () => {
    const tenantId = `td-shadow-${generateId()}`;
    await seedTenant(db, tenantId);
    const shadowDb = createDatabase({
      dialect: 'postgresql',
      url: postgresUrl!,
      pool: { max: 1 },
    });

    try {
      await executeRaw(shadowDb, sql`CREATE TEMPORARY TABLE pg_class (marker text)`);
      await executeRaw(
        shadowDb,
        sql`CREATE TEMPORARY TABLE sessions (tenant_id text NOT NULL, marker text NOT NULL)`
      );
      await executeRaw(
        shadowDb,
        sql`INSERT INTO sessions (tenant_id, marker) VALUES (${tenantId}, 'temporary-shadow')`
      );
      await executeRaw(shadowDb, sql`SET search_path TO pg_temp, public, pg_catalog`);

      const result = await deleteTenantData(shadowDb, tenantId);

      expect(result.rowCounts.sessions).toBeGreaterThanOrEqual(1);
      expect(await countTenantSessions(db, tenantId)).toBe(0);
      const temporaryRows = await executeRaw(
        shadowDb,
        sql`SELECT pg_catalog.count(*) AS n FROM sessions WHERE tenant_id = ${tenantId}`
      );
      expect(Number(rowsOf(temporaryRows)[0]?.n ?? 0)).toBe(1);
    } finally {
      await closePostgresDatabase(shadowDb);
      if ((await countTenantSessions(db, tenantId)) > 0) {
        await deleteTenantData(db, tenantId);
      }
    }
  });

  it('rejects an unexpected restrictive policy that could hide tenant rows', async () => {
    await executeRaw(
      db,
      sql`
        CREATE POLICY tenant_delete_restrictive_test ON public.sessions
          AS RESTRICTIVE
          FOR ALL
          TO PUBLIC
          USING (false)
          WITH CHECK (false)
      `
    );

    try {
      await expect(
        deleteTenantData(db, `td-restrictive-${generateId()}`, { dryRun: true })
      ).rejects.toThrow(/restrictive.*tenant_delete_restrictive_test/i);
    } finally {
      await executeRaw(
        db,
        sql`DROP POLICY IF EXISTS tenant_delete_restrictive_test ON public.sessions`
      );
    }
  });

  it('rejects an inverted tenant isolation predicate', async () => {
    await executeRaw(db, sql`DROP POLICY tenant_isolation_sessions ON public.sessions`);
    await executeRaw(
      db,
      sql`
        CREATE POLICY tenant_isolation_sessions ON public.sessions
          AS PERMISSIVE
          FOR ALL
          TO PUBLIC
          USING (
            tenant_id <> COALESCE(
              NULLIF(current_setting('agor.tenant_id', true), ''),
              'default'
            )
          )
          WITH CHECK (
            tenant_id <> COALESCE(
              NULLIF(current_setting('agor.tenant_id', true), ''),
              'default'
            )
          )
      `
    );

    try {
      await expect(
        deleteTenantData(db, `td-inverted-${generateId()}`, { dryRun: true })
      ).rejects.toThrow(/canonical tenant_id equality/i);
    } finally {
      await installCanonicalTenantPolicy(db, 'sessions');
    }
  });

  it('fails closed when the live catalog contains an unplanned tenant table', async () => {
    await executeRaw(db, sql`DROP TABLE IF EXISTS public.tenant_delete_unknown`);
    await executeRaw(
      db,
      sql`
        CREATE TABLE public.tenant_delete_unknown (
          tenant_id text NOT NULL,
          value text NOT NULL
        )
      `
    );
    await executeRaw(db, sql`ALTER TABLE public.tenant_delete_unknown ENABLE ROW LEVEL SECURITY`);
    await executeRaw(db, sql`ALTER TABLE public.tenant_delete_unknown FORCE ROW LEVEL SECURITY`);
    await executeRaw(
      db,
      sql`
        CREATE POLICY tenant_isolation_tenant_delete_unknown
          ON public.tenant_delete_unknown
          USING (
            tenant_id = COALESCE(
              NULLIF(current_setting('agor.tenant_id', true), ''),
              'default'
            )
          )
          WITH CHECK (
            tenant_id = COALESCE(
              NULLIF(current_setting('agor.tenant_id', true), ''),
              'default'
            )
          )
      `
    );

    try {
      await expect(
        deleteTenantData(db, `td-unknown-${generateId()}`, { dryRun: true })
      ).rejects.toThrow(/tenant_delete_unknown/);
    } finally {
      await executeRaw(db, sql`DROP TABLE IF EXISTS public.tenant_delete_unknown`);
    }
  });

  it('fails closed when a tenant table appears after phase-one reconciliation', async () => {
    const tenantId = `td-late-${generateId()}`;
    await seedTenant(db, tenantId);
    await executeRaw(db, sql`DROP TABLE IF EXISTS public.tenant_delete_late`);
    await executeRaw(
      db,
      sql`
        CREATE OR REPLACE FUNCTION public.tenant_delete_create_late_table()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          IF pg_catalog.to_regclass('public.tenant_delete_late') IS NULL THEN
            CREATE TABLE public.tenant_delete_late (
              tenant_id text NOT NULL,
              value text NOT NULL
            );
            ALTER TABLE public.tenant_delete_late ENABLE ROW LEVEL SECURITY;
            ALTER TABLE public.tenant_delete_late FORCE ROW LEVEL SECURITY;
            CREATE POLICY tenant_isolation_tenant_delete_late
              ON public.tenant_delete_late
              AS PERMISSIVE
              FOR ALL
              TO PUBLIC
              USING (
                tenant_id = COALESCE(
                  NULLIF(current_setting('agor.tenant_id', true), ''),
                  'default'
                )
              )
              WITH CHECK (
                tenant_id = COALESCE(
                  NULLIF(current_setting('agor.tenant_id', true), ''),
                  'default'
                )
              );
            INSERT INTO public.tenant_delete_late (tenant_id, value)
            VALUES (OLD.tenant_id, 'created after phase-one reconciliation');
          END IF;
          RETURN OLD;
        END
        $function$
      `
    );
    await executeRaw(
      db,
      sql`
        DROP TRIGGER IF EXISTS tenant_delete_create_late_table ON public.repos
      `
    );
    await executeRaw(
      db,
      sql`
        CREATE TRIGGER tenant_delete_create_late_table
        BEFORE DELETE ON public.repos
        FOR EACH ROW
        EXECUTE FUNCTION public.tenant_delete_create_late_table()
      `
    );

    try {
      let deletionError: unknown;
      try {
        await deleteTenantData(db, tenantId);
      } catch (error) {
        deletionError = error;
      }
      expect(deletionError).toBeInstanceOf(TenantDeletionCatalogError);
      expect(errorChainMessage(deletionError)).toMatch(/tenant_delete_late/);
      expect(await countTenantSessions(db, tenantId)).toBe(0);
      const lateRows = await runWithTenantDatabaseScope(db, tenantId, async (scoped) =>
        executeRaw(
          scoped,
          sql`SELECT pg_catalog.count(*) AS n FROM public.tenant_delete_late WHERE tenant_id = ${tenantId}`
        )
      );
      expect(Number(rowsOf(lateRows)[0]?.n ?? 0)).toBe(1);
    } finally {
      await executeRaw(
        db,
        sql`DROP TRIGGER IF EXISTS tenant_delete_create_late_table ON public.repos`
      );
      await executeRaw(db, sql`DROP FUNCTION IF EXISTS public.tenant_delete_create_late_table()`);
      await executeRaw(db, sql`DROP TABLE IF EXISTS public.tenant_delete_late`);
      if ((await countTenantSessions(db, tenantId)) > 0) {
        await deleteTenantData(db, tenantId);
      }
    }
  });

  it('plans a deletion covering every table in the live catalogue', async () => {
    // Nothing is declared global, so the audit has to reach the end with every
    // discovered tenant-contract table in the plan. The guards for a table that
    // is declared global are driven directly in
    // `tenant-deletion-global-fk.test.ts`, which is the only place that shape
    // can be built while GLOBAL_TABLES is empty.
    const plan = await deleteTenantData(db, `td-global-${generateId()}`, { dryRun: true });

    expect(plan.rowCounts.sessions).toBe(0);
    expect(Object.keys(plan.rowCounts).length).toBeGreaterThan(0);
  });

  it.skipIf(!postgresAdminUrl)('fails closed when live-catalog discovery is empty', async () => {
    const databaseName = `tdel_empty_${generateId().replaceAll('-', '').slice(0, 20)}`;
    const databaseUrl = new URL(postgresUrl!);
    databaseUrl.pathname = `/${databaseName}`;
    const adminDb = createDatabase({ dialect: 'postgresql', url: postgresAdminUrl! });
    let emptyDb: Database | undefined;

    try {
      const watermarkResult = await executeRaw(
        db,
        sql`SELECT max(created_at) AS max_ts FROM drizzle.__drizzle_migrations`
      );
      const watermark = rowsOf(watermarkResult)[0]?.max_ts;
      if (watermark === undefined || watermark === null) {
        throw new Error('Expected an applied migration watermark');
      }

      await executeRaw(
        adminDb,
        sql`CREATE DATABASE ${sql.identifier(databaseName)} OWNER agor_app`
      );
      emptyDb = createDatabase({ dialect: 'postgresql', url: databaseUrl.toString() });
      await executeRaw(emptyDb, sql`CREATE SCHEMA drizzle`);
      await executeRaw(
        emptyDb,
        sql`
          CREATE TABLE drizzle.__drizzle_migrations (
            id serial PRIMARY KEY,
            hash text NOT NULL,
            created_at bigint
          )
        `
      );
      await executeRaw(
        emptyDb,
        sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES ('empty-catalog-test', ${watermark})
        `
      );

      await expect(
        deleteTenantData(emptyDb, `td-empty-${generateId()}`, { dryRun: true })
      ).rejects.toThrow(/zero tenant-contract tables/);
    } finally {
      if (emptyDb) await closePostgresDatabase(emptyDb);
      await executeRaw(
        adminDb,
        sql`SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = ${databaseName}`
      );
      await executeRaw(adminDb, sql`DROP DATABASE IF EXISTS ${sql.identifier(databaseName)}`);
      await closePostgresDatabase(adminDb);
    }
  });

  it('rolls back earlier table deletes when a later delete fails', async () => {
    const tenantId = `td-rollback-${generateId()}`;
    await seedTenant(db, tenantId);
    await executeRaw(
      db,
      sql`
        CREATE OR REPLACE FUNCTION public.tenant_delete_force_rollback()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          RAISE EXCEPTION 'forced tenant deletion rollback';
        END
        $function$
      `
    );
    await executeRaw(db, sql`DROP TRIGGER IF EXISTS tenant_delete_force_rollback ON public.repos`);
    await executeRaw(
      db,
      sql`
        CREATE TRIGGER tenant_delete_force_rollback
        BEFORE DELETE ON public.repos
        FOR EACH ROW
        EXECUTE FUNCTION public.tenant_delete_force_rollback()
      `
    );

    try {
      let deletionError: unknown;
      try {
        await deleteTenantData(db, tenantId);
      } catch (error) {
        deletionError = error;
      }
      expect(errorChainMessage(deletionError)).toMatch(/forced tenant deletion rollback/);
      expect(await countTenantSessions(db, tenantId)).toBe(1);
    } finally {
      await executeRaw(
        db,
        sql`DROP TRIGGER IF EXISTS tenant_delete_force_rollback ON public.repos`
      );
      await executeRaw(db, sql`DROP FUNCTION IF EXISTS public.tenant_delete_force_rollback()`);
      await deleteTenantData(db, tenantId);
    }
  });
});
