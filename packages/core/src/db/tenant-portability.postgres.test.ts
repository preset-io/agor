/**
 * PostgreSQL + filesystem integration for tenant portability — exercises the
 * full inspect → export → verify → import → delete cycle against a real
 * RLS-scoped database and real temp directories, plus cross-tenant isolation and
 * idempotency. Gated on an explicit test database, mirroring the repository
 * PostgreSQL suites (`*.postgres.test.ts`); skipped in the SQLite fast-lane CI.
 *
 * Run with, e.g.:
 *   AGOR_DB_DIALECT=postgresql \
 *   AGOR_TEST_POSTGRES_URL=postgresql://user:pw@host:5432/db \
 *   pnpm --filter @agor/core exec vitest run src/db/tenant-portability.postgres.test.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { UUID } from '../types/id';
import { createDatabase, type Database } from './client';
import { isPostgresDatabase } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { BranchRepository } from './repositories/branches';
import { RepoRepository } from './repositories/repos';
import { SessionRepository } from './repositories/sessions';
import { deleteTenantData } from './tenant-deletion';
import { exportTenant } from './tenant-export';
import { importTenant } from './tenant-import';
import { inspectTenant } from './tenant-inspect';
import { runWithTenantDatabaseScope } from './tenant-scope';
import { verifyTenant } from './tenant-verify';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

// int4 column; keep values small and monotonically unique across seeds.
let branchUniqueSeq = Date.now() % 1_000_000;

async function seedTenant(db: Database, tenantId: string): Promise<void> {
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const repoId = generateId();
    await new RepoRepository(scoped).create({
      repo_id: repoId,
      slug: `tp-${tenantId}-${repoId}`,
      name: `repo ${tenantId}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/tenant-portability.git',
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
      created_by: 'tenant-portability-test-user' as UUID,
    });
    await new SessionRepository(scoped).create({
      session_id: generateId(),
      branch_id: branchId,
      agentic_tool: 'claude-code',
      created_by: 'tenant-portability-test-user',
    });
  });
}

async function addSession(db: Database, tenantId: string): Promise<void> {
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const branch = await new BranchRepository(scoped).findAll();
    const branchId = branch[0]?.branch_id;
    if (!branchId) throw new Error('expected a seeded branch');
    await new SessionRepository(scoped).create({
      session_id: generateId(),
      branch_id: branchId,
      agentic_tool: 'claude-code',
      created_by: 'tenant-portability-test-user',
    });
  });
}

async function closePostgresDatabase(db: Database): Promise<void> {
  await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
}

async function seedFilesystem(root: string): Promise<void> {
  await mkdir(join(root, 'repos', 'org'), { recursive: true });
  await writeFile(join(root, 'repos', 'org', 'file-a.txt'), 'alpha');
  await mkdir(join(root, 'uploads'), { recursive: true });
  await writeFile(join(root, 'uploads', 'note.md'), '# note');
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)('tenant portability (PostgreSQL)', () => {
  let db: Database;
  let scratch: string;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    scratch = await mkdtemp(join(tmpdir(), 'agor-tenant-portability-'));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
    await closePostgresDatabase(db);
  });

  it('inspect reports only the target tenant', async () => {
    const tenantA = `tpa-${generateId()}`;
    const tenantB = `tpb-${generateId()}`;
    await seedTenant(db, tenantA);
    await seedTenant(db, tenantB);

    const inspection = await inspectTenant(db, tenantA);
    expect(inspection.database.dialect).toBe('postgresql');
    const sessions = inspection.database.tables.find((t) => t.name === 'sessions');
    expect(sessions?.rowCount).toBe(1);
    // Cross-tenant isolation: A's inventory counts only A's rows.
    expect(inspection.database.totalRows).toBeGreaterThan(0);

    await deleteTenantData(db, tenantA);
    await deleteTenantData(db, tenantB);
  });

  it('round-trips a tenant through export → delete → import → verify', async () => {
    const tenantA = `tpr-${generateId()}`;
    const tenantB = `tpo-${generateId()}`;
    await seedTenant(db, tenantA);
    await seedTenant(db, tenantB);

    const fsRoot = join(scratch, `${tenantA}-fs`);
    await seedFilesystem(fsRoot);

    const archive = join(scratch, `${tenantA}-archive`);
    const exported = await exportTenant(db, tenantA, {
      archivePath: archive,
      filesystemRoot: fsRoot,
    });
    expect(exported.database.totalRows).toBeGreaterThan(0);
    expect(exported.filesystem.fileCount).toBe(2);

    // A saved proof matches the live tenant.
    const verifyBefore = await verifyTenant(db, { archivePath: archive, filesystemRoot: fsRoot });
    expect(verifyBefore.match).toBe(true);

    // Mutating the tenant makes verification fail.
    await addSession(db, tenantA);
    const verifyMutated = await verifyTenant(db, { archivePath: archive, filesystemRoot: fsRoot });
    expect(verifyMutated.match).toBe(false);
    expect(verifyMutated.database.matched).toBe(false);

    // Erase the tenant (database + filesystem) and restore from the archive.
    await deleteTenantData(db, tenantA);
    await rm(fsRoot, { recursive: true, force: true });

    const imported = await importTenant(db, { archivePath: archive, filesystemRoot: fsRoot });
    expect(imported.alreadyApplied).toBe(false);
    expect(imported.database.restored).toBe(true);
    expect(imported.filesystem.restored).toBe(true);

    // The restored tenant matches the proof again, and files are byte-identical.
    const verifyAfter = await verifyTenant(db, { archivePath: archive, filesystemRoot: fsRoot });
    expect(verifyAfter.match).toBe(true);
    expect(await readFile(join(fsRoot, 'repos', 'org', 'file-a.txt'), 'utf8')).toBe('alpha');

    // Re-running the import is idempotent (no changes, no error).
    const importedAgain = await importTenant(db, { archivePath: archive, filesystemRoot: fsRoot });
    expect(importedAgain.alreadyApplied).toBe(true);
    expect(importedAgain.database.restored).toBe(false);

    // The unrelated tenant was never touched.
    const inspectionB = await inspectTenant(db, tenantB);
    expect(inspectionB.database.totalRows).toBeGreaterThan(0);

    await deleteTenantData(db, tenantA);
    await deleteTenantData(db, tenantB);
    await rm(fsRoot, { recursive: true, force: true });
  });

  it('refuses to import into a non-empty, non-matching destination', async () => {
    const tenant = `tpc-${generateId()}`;
    await seedTenant(db, tenant);
    const archive = join(scratch, `${tenant}-archive`);
    await exportTenant(db, tenant, { archivePath: archive });

    // Destination still holds the original rows, which differ from the archive
    // only if mutated — mutate so it is a genuine conflict.
    await addSession(db, tenant);
    await expect(importTenant(db, { archivePath: archive })).rejects.toThrow(
      /destination database is not empty/i
    );

    await deleteTenantData(db, tenant);
  });
});
