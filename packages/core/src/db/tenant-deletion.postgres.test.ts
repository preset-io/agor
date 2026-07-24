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

import { count, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { UUID } from '../types/id';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase, select } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { BranchRepository } from './repositories/branches';
import { RepoRepository } from './repositories/repos';
import { SessionRepository } from './repositories/sessions';
import * as pg from './schema.postgres';
import { deleteTenantData } from './tenant-deletion';
import { runWithTenantDatabaseScope } from './tenant-scope';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

// int4 column; keep values small and monotonically unique across seeds.
let branchUniqueSeq = Date.now() % 1_000_000;

async function seedTenant(db: Database, tenantId: string): Promise<void> {
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
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
      created_by: 'tenant-deletion-test-user' as UUID,
    });
    await new SessionRepository(scoped).create({
      session_id: generateId(),
      branch_id: branchId,
      agentic_tool: 'claude-code',
      created_by: 'tenant-deletion-test-user',
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

describe.skipIf(!postgresUrl || !usesPostgresSchema)('deleteTenantData (PostgreSQL)', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
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
});
