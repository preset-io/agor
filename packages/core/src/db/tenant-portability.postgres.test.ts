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

import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { UUID } from '../types/id';
import type { MCPServerID } from '../types/mcp';
import { createDatabase, type Database } from './client';
import { executeRaw, insert, isPostgresDatabase, select, update } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { BoardRepository } from './repositories/boards';
import { BranchRepository } from './repositories/branches';
import { RepoRepository } from './repositories/repos';
import { SessionRepository } from './repositories/sessions';
import { UserMCPOAuthTokenRepository } from './repositories/user-mcp-oauth-tokens';
import { UsersRepository } from './repositories/users';
import * as pg from './schema.postgres';
import {
  canonicalJson,
  computeContentFingerprint,
  readManifest,
  sha256Hex,
  tableJsonlPath,
  writeManifest,
} from './tenant-archive';
import { deleteTenantData } from './tenant-deletion';
import { exportTenant } from './tenant-export';
import { importTenant } from './tenant-import';
import { inspectTenant } from './tenant-inspect';
import {
  tenantPortabilityForeignKeys,
  tenantPortabilityTableNames,
} from './tenant-portability-manifest';
import { runWithTenantDatabaseScope } from './tenant-scope';
import { verifyTenant } from './tenant-verify';
import {
  acquireTenantWriteGate,
  assertTenantWritable,
  releaseTenantWriteGate,
  TENANT_WRITE_GATE_NAMESPACE,
} from './tenant-write-gate';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

// int4 column; keep values small and monotonically unique across seeds.
let branchUniqueSeq = Date.now() % 1_000_000;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function sqlstateOf(error: unknown): string | undefined {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== 'object' || seen.has(current)) return undefined;
    seen.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && /^[0-9A-Z]{5}$/.test(record.code)) {
      return record.code;
    }
    current = record.cause;
  }
  return undefined;
}

async function seedTenant(db: Database, tenantId: string): Promise<void> {
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const ownerId = generateId() as UUID;
    await new UsersRepository(scoped).create({
      user_id: ownerId,
      email: `tenant-portability-${tenantId}-${generateId()}@example.invalid`,
      role: 'member',
    });
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

async function addSession(db: Database, tenantId: string): Promise<void> {
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const branch = await new BranchRepository(scoped).findAll();
    const branchId = branch[0]?.branch_id;
    if (!branchId) throw new Error('expected a seeded branch');
    const ownerId = branch[0]?.primary_owner_user_id;
    if (!ownerId) throw new Error('expected a seeded branch owner');
    await new SessionRepository(scoped).create({
      session_id: generateId(),
      branch_id: branchId,
      agentic_tool: 'claude-code',
      created_by: ownerId,
    });
  });
}

async function seedNonPortableExecutorAuthority(db: Database, tenantId: string): Promise<void> {
  const fingerprint = generateId().replaceAll('-', '').repeat(2);
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    await insert(scoped, pg.executorSessionTokenAuthorities)
      .values({
        tenant_id: tenantId,
        token_fingerprint: fingerprint,
        token_type: 'executor-session',
        purpose: 'executor-task',
        session_id: 'tenant-portability-non-portable-authority',
        user_id: generateId(),
        created_at: new Date(),
        expires_at: new Date(Date.now() + 60_000),
        max_uses: -1,
        use_count: 0,
      })
      .run();
  });
}

async function seedNonPortableOAuthGrant(
  db: Database,
  tenantId: string,
  masterSecret: string
): Promise<string> {
  const serverId = generateId();
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    await insert(scoped, pg.mcpServers)
      .values({
        tenant_id: tenantId,
        mcp_server_id: serverId,
        name: `oauth portability ${tenantId}`,
        transport: 'http',
        scope: 'global',
        enabled: true,
        source: 'catalog',
        catalog_entry_name: 'com.example/portable-oauth',
        data: {
          url: 'https://mcp.example.test',
          catalog_entry_name: 'com.example/portable-oauth',
          config_version: 42,
          auth: { type: 'oauth' },
        },
        created_at: new Date(),
      })
      .run();
    await new UserMCPOAuthTokenRepository(scoped, masterSecret).saveToken(
      null,
      serverId as MCPServerID,
      {
        accessToken: 'source-deployment-access-token',
        refreshToken: 'source-deployment-refresh-token',
        clientId: 'source-client',
        clientSecret: 'source-client-secret',
        expiresAt: new Date(Date.now() + 60_000),
        grantBinding: {
          generation: 1,
          version: 1,
          fingerprint: 'a'.repeat(64),
          metadataUri: 'https://mcp.example.test/.well-known/oauth-protected-resource',
          resourceUri: 'https://mcp.example.test/',
          issuer: 'https://issuer.example.test/',
          authorizationEndpoint: 'https://issuer.example.test/authorize',
          tokenEndpoint: 'https://issuer.example.test/token',
          redirectUri: 'https://agor.example.test/oauth/callback',
        },
      }
    );
  });
  return serverId;
}

async function seedNonPortableGitHubInstallState(db: Database, tenantId: string): Promise<void> {
  const stateHash = generateId().replaceAll('-', '').repeat(2);
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    await insert(scoped, pg.githubInstallStates)
      .values({
        tenant_id: tenantId,
        state_hash: stateHash,
        user_id: generateId(),
        intent: 'github-app-install',
        created_at: new Date(),
        expires_at: new Date(Date.now() + 60_000),
      })
      .run();
  });
}

async function seedBoardBranchCycle(
  db: Database,
  tenantId: string
): Promise<{ boardId: string; branchId: string }> {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const ownerId = generateId() as UUID;
    await new UsersRepository(scoped).create({
      user_id: ownerId,
      email: `tenant-portability-cycle-${tenantId}-${generateId()}@example.invalid`,
      role: 'member',
    });
    const repoId = generateId();
    await new RepoRepository(scoped).create({
      repo_id: repoId,
      slug: `tpc-cycle-${tenantId}-${repoId}`,
      name: `cycle repo ${tenantId}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/tenant-portability-cycle.git',
      local_path: `/tmp/${repoId}`,
      default_branch: 'main',
    });

    const boardId = generateId();
    await new BoardRepository(scoped).create({
      board_id: boardId,
      name: `cycle board ${tenantId}`,
      created_by: ownerId,
    });
    const branchId = generateId();
    await new BranchRepository(scoped).create({
      branch_id: branchId,
      repo_id: repoId,
      board_id: boardId,
      name: `cycle-branch-${tenantId}`,
      ref: 'main',
      branch_unique_id: branchUniqueSeq++,
      path: `/tmp/${branchId}`,
      created_by: ownerId,
    });
    await update(scoped, pg.boards)
      .set({ primary_teammate_id: branchId })
      .where(eq(pg.boards.board_id, boardId))
      .run();
    return { boardId, branchId };
  });
}

async function readBoardBranchCycle(
  db: Database,
  tenantId: string,
  boardId: string,
  branchId: string
): Promise<{ primaryTeammateId: string | null; boardId: string | null }> {
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const board = (await select(scoped, { primaryTeammateId: pg.boards.primary_teammate_id })
      .from(pg.boards)
      .where(eq(pg.boards.board_id, boardId))
      .one()) as { primaryTeammateId: string | null } | null;
    const branch = (await select(scoped, { boardId: pg.branches.board_id })
      .from(pg.branches)
      .where(eq(pg.branches.branch_id, branchId))
      .one()) as { boardId: string | null } | null;
    if (!board || !branch) throw new Error('expected imported board and branch rows');
    return { primaryTeammateId: board.primaryTeammateId, boardId: branch.boardId };
  });
}

async function replaceArchivedBoardReference(
  archive: string,
  primaryTeammateId: string
): Promise<void> {
  const manifest = await readManifest(archive);
  const boardTable = manifest.database.tables.find((table) => table.name === 'boards');
  if (!boardTable) throw new Error('expected boards in portability manifest');
  const path = tableJsonlPath(archive, 'boards');
  const rows = (await readFile(path, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  if (!rows[0]) throw new Error('expected an archived board row');
  rows[0].primary_teammate_id = primaryTeammateId;
  const jsonl = `${rows.map(canonicalJson).join('\n')}\n`;
  const bytes = Buffer.from(jsonl, 'utf8');
  await writeFile(path, bytes);
  boardTable.bytes = bytes.byteLength;
  boardTable.rowCount = rows.length;
  boardTable.sha256 = sha256Hex(bytes);
  manifest.contentFingerprint = computeContentFingerprint(manifest);
  await writeManifest(archive, manifest);
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
    scratch = await mkdtemp(join(tmpdir(), 'agor-tenant-portability-'));
    await initializeDatabase(db);
    if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
    await closePostgresDatabase(db);
  });

  it('keeps exactly every manifest-to-manifest FK deferrable and initially immediate', async () => {
    const result = await executeRaw(
      db,
      sql`
        SELECT
          constraint_row.conname AS name,
          child.relname AS child_table,
          ARRAY(
            SELECT attribute.attname
            FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
            JOIN pg_attribute attribute
              ON attribute.attrelid = constraint_row.conrelid
             AND attribute.attnum = key.attnum
            ORDER BY key.position
          ) AS child_columns,
          parent.relname AS parent_table,
          ARRAY(
            SELECT attribute.attname
            FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, position)
            JOIN pg_attribute attribute
              ON attribute.attrelid = constraint_row.confrelid
             AND attribute.attnum = key.attnum
            ORDER BY key.position
          ) AS parent_columns,
          constraint_row.confupdtype AS on_update,
          constraint_row.confdeltype AS on_delete,
          constraint_row.condeferrable AS is_deferrable,
          constraint_row.condeferred AS is_initially_deferred
        FROM pg_constraint constraint_row
        JOIN pg_class child ON child.oid = constraint_row.conrelid
        JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
        JOIN pg_class parent ON parent.oid = constraint_row.confrelid
        JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
        WHERE constraint_row.contype = 'f'
          AND child_namespace.nspname = 'public'
          AND parent_namespace.nspname = 'public'
        ORDER BY constraint_row.conname
      `
    );
    const movable = new Set(tenantPortabilityTableNames());
    const actionName: Record<string, string> = {
      a: 'no action',
      r: 'restrict',
      c: 'cascade',
      n: 'set null',
      d: 'set default',
    };
    const actual = rowsOf(result)
      .filter(
        (row) => movable.has(String(row.child_table)) && movable.has(String(row.parent_table))
      )
      .map((row) => {
        expect(row.is_deferrable).toBe(true);
        expect(row.is_initially_deferred).toBe(false);
        return {
          childTable: String(row.child_table),
          childColumns: (row.child_columns as unknown[]).map(String),
          parentTable: String(row.parent_table),
          parentColumns: (row.parent_columns as unknown[]).map(String),
          onUpdate: actionName[String(row.on_update)],
          onDelete: actionName[String(row.on_delete)],
        };
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const expected = tenantPortabilityForeignKeys()
      .map((foreignKey) => ({
        childTable: foreignKey.childTable,
        childColumns: [...foreignKey.childColumns],
        parentTable: foreignKey.parentTable,
        parentColumns: [...foreignKey.parentColumns],
        onUpdate: foreignKey.onUpdate,
        onDelete: foreignKey.onDelete,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    // Exact equality makes a newly added, removed, or action-changed movable FK
    // fail until the schema-derived migration contract is updated deliberately.
    expect(actual).toEqual(expected);
  });

  it('keeps the migrated capability-policy checks named and structurally aligned', async () => {
    const result = await executeRaw(
      db,
      sql`
        SELECT constraint_row.conname AS name,
               pg_get_constraintdef(constraint_row.oid, true) AS definition
        FROM pg_constraint constraint_row
        JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
        JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
        WHERE constraint_row.contype = 'c'
          AND namespace_row.nspname = 'public'
          AND table_row.relname IN (
            'branches','board_access_policies','board_access_entries','branch_permission_configs',
            'branch_permission_entries'
          )
      `
    );
    const checks = new Map(rowsOf(result).map((row) => [String(row.name), String(row.definition)]));
    const expected = [
      ['branches_permission_binding_check', /inherit.*override/i],
      ['board_access_policies_sharing_mode_check', /private.*shared/i],
      ['board_access_policies_others_role_check', /none.*viewer.*editor.*manager/i],
      ['board_access_entries_role_check', /none.*viewer.*editor.*manager/i],
      ['board_access_entries_principal_check', /user_id.*group_id/i],
      ['branch_permission_configs_sharing_mode_check', /private.*shared/i],
      ['branch_permission_configs_others_role_check', /none.*viewer.*collaborator.*manager/i],
      ['branch_permission_configs_others_fs_access_check', /none.*read.*write/i],
      ['branch_permission_configs_target_check', /board_id.*branch_id/i],
      ['branch_permission_entries_role_check', /none.*viewer.*collaborator.*manager/i],
      ['branch_permission_entries_fs_access_check', /none.*read.*write/i],
      ['branch_permission_entries_principal_check', /user_id.*group_id/i],
    ] as const;
    for (const [name, expression] of expected) {
      expect(checks.get(name), name).toMatch(expression);
    }
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

  it('round-trips a genuine boards ↔ branches reference cycle through commit', async () => {
    const tenant = `tpy-${generateId()}`;
    const { boardId, branchId } = await seedBoardBranchCycle(db, tenant);
    const archive = join(scratch, `${tenant}-cycle-archive`);
    await exportTenant(db, tenant, { archivePath: archive });
    await deleteTenantData(db, tenant);

    const imported = await importTenant(db, { archivePath: archive });
    expect(imported.database.restored).toBe(true);
    await expect(readBoardBranchCycle(db, tenant, boardId, branchId)).resolves.toEqual({
      primaryTeammateId: branchId,
      boardId,
    });

    await deleteTenantData(db, tenant);
  });

  it('rolls back every imported row when a deferred cyclic reference is invalid', async () => {
    const tenant = `tpz-${generateId()}`;
    await seedBoardBranchCycle(db, tenant);
    const archive = join(scratch, `${tenant}-invalid-cycle-archive`);
    await exportTenant(db, tenant, { archivePath: archive });
    await deleteTenantData(db, tenant);
    await replaceArchivedBoardReference(archive, generateId());

    let failure: unknown;
    try {
      await importTenant(db, { archivePath: archive });
    } catch (error) {
      failure = error;
    }
    expect(sqlstateOf(failure)).toBe('23503');
    const inspection = await inspectTenant(db, tenant);
    expect(inspection.database.totalRows).toBe(0);
    expect(inspection.database.tables.every((table) => table.rowCount === 0)).toBe(true);
  });

  it('excludes the reserved write-gate row from the archive and leaves an import writable', async () => {
    const tenant = `tpw-${generateId()}`;
    await seedTenant(db, tenant);

    // Freeze the tenant, then export while the gate is held.
    const { generation } = await acquireTenantWriteGate(db, tenant, { reason: 'export' });
    const archive = join(scratch, `${tenant}-archive`);
    await exportTenant(db, tenant, { archivePath: archive });

    // The archived app_variables payload must not contain the reserved gate row
    // (its wall-clock/generation state is orchestration, not tenant data).
    const appVars = await readFile(join(archive, 'database', 'app_variables.jsonl'), 'utf8').catch(
      () => ''
    );
    expect(appVars).not.toContain(TENANT_WRITE_GATE_NAMESPACE);

    // Release, erase, and restore into the now-empty destination.
    await releaseTenantWriteGate(db, tenant, { generation });
    await deleteTenantData(db, tenant);
    const imported = await importTenant(db, { archivePath: archive });
    expect(imported.database.restored).toBe(true);

    // Because no gate row was carried over, the restored tenant is writable.
    await expect(assertTenantWritable(db, tenant)).resolves.toBeUndefined();

    await deleteTenantData(db, tenant);
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

  it('completes the filesystem on retry after a re-home database commit then FS-tail failure', async () => {
    // Re-home a tenant: export the source, delete it (freeing its globally-unique
    // ids), then import under a NEW tenant id. The database commits first; force
    // the filesystem tail to fail AFTER that commit and prove the retry finishes
    // the filesystem without re-inserting the (already-committed) re-homed rows.
    const source = `tprh-src-${generateId()}`;
    const rehomed = `tprh-dst-${generateId()}`;
    await seedTenant(db, source);
    const sourceFs = join(scratch, `${source}-fs`);
    await seedFilesystem(sourceFs);

    const archive = join(scratch, `${source}-archive`);
    const exported = await exportTenant(db, source, {
      archivePath: archive,
      filesystemRoot: sourceFs,
    });
    const expectedRows = exported.database.totalRows;
    expect(expectedRows).toBeGreaterThan(0);

    // Free the source's ids so the re-home does not collide in this one runtime.
    await deleteTenantData(db, source);
    await rm(sourceFs, { recursive: true, force: true });

    // Remove one already-verified filesystem payload from the archive while the
    // database restore is in flight. Staging runs only after that transaction
    // commits, so the missing file deterministically faults the filesystem tail.
    const archivedPayloadPath = join(archive, 'files', 'repos', 'org', 'file-a.txt');
    const archivedPayload = await readFile(archivedPayloadPath);
    let faultInjected = false;
    const goodFsRoot = join(scratch, `${rehomed}-fs`);
    await expect(
      importTenant(db, {
        archivePath: archive,
        tenantId: rehomed,
        filesystemRoot: goodFsRoot,
        log: () => {
          if (faultInjected) return;
          faultInjected = true;
          rmSync(archivedPayloadPath);
        },
      })
    ).rejects.toThrow();
    await writeFile(archivedPayloadPath, archivedPayload);

    // The re-homed database committed despite the filesystem-tail failure.
    const afterFailure = await inspectTenant(db, rehomed);
    expect(afterFailure.database.totalRows).toBe(expectedRows);

    // Retry against a healthy destination root: the database is recognised as
    // already applied (no re-insert) and only the filesystem portion completes.
    const retried = await importTenant(db, {
      archivePath: archive,
      tenantId: rehomed,
      filesystemRoot: goodFsRoot,
    });
    expect(retried.alreadyApplied).toBe(false);
    expect(retried.database.restored).toBe(false);
    expect(retried.database.totalRows).toBe(expectedRows);
    expect(retried.filesystem.restored).toBe(true);
    expect(await readFile(join(goodFsRoot, 'repos', 'org', 'file-a.txt'), 'utf8')).toBe('alpha');

    // The database was not doubled by the retry.
    const afterRetry = await inspectTenant(db, rehomed);
    expect(afterRetry.database.totalRows).toBe(expectedRows);

    await deleteTenantData(db, rehomed);
    await rm(goodFsRoot, { recursive: true, force: true });
  });

  it('re-runs a fully-applied re-home as an idempotent no-op', async () => {
    const source = `tprn-src-${generateId()}`;
    const rehomed = `tprn-dst-${generateId()}`;
    await seedTenant(db, source);
    const sourceFs = join(scratch, `${source}-fs`);
    await seedFilesystem(sourceFs);
    const archive = join(scratch, `${source}-archive`);
    await exportTenant(db, source, { archivePath: archive, filesystemRoot: sourceFs });
    await deleteTenantData(db, source);
    await rm(sourceFs, { recursive: true, force: true });

    const destFs = join(scratch, `${rehomed}-fs`);
    const first = await importTenant(db, {
      archivePath: archive,
      tenantId: rehomed,
      filesystemRoot: destFs,
    });
    expect(first.alreadyApplied).toBe(false);
    expect(first.database.restored).toBe(true);
    expect(first.filesystem.restored).toBe(true);

    // A second run against the fully-applied re-home changes nothing.
    const again = await importTenant(db, {
      archivePath: archive,
      tenantId: rehomed,
      filesystemRoot: destFs,
    });
    expect(again.alreadyApplied).toBe(true);
    expect(again.database.restored).toBe(false);
    expect(again.filesystem.restored).toBe(false);

    await deleteTenantData(db, rehomed);
    await rm(destFs, { recursive: true, force: true });
  });

  it('refuses a re-home whose destination database was altered after restore', async () => {
    const source = `tpra-src-${generateId()}`;
    const rehomed = `tpra-dst-${generateId()}`;
    await seedTenant(db, source);
    const archive = join(scratch, `${source}-archive`);
    await exportTenant(db, source, { archivePath: archive });
    await deleteTenantData(db, source);

    const first = await importTenant(db, { archivePath: archive, tenantId: rehomed });
    expect(first.database.restored).toBe(true);

    // Mutating the re-homed destination makes it diverge from the archive-derived
    // expected snapshot — a fail-closed conflict, never a false match.
    await addSession(db, rehomed);
    await expect(importTenant(db, { archivePath: archive, tenantId: rehomed })).rejects.toThrow(
      /destination database is not empty/i
    );

    await deleteTenantData(db, rehomed);
  });

  it('never accepts a foreign tenant already living in the re-home destination', async () => {
    // The re-home destination id already holds its OWN, unrelated data. The
    // archive-derived expected snapshot is bound to that id, so the live foreign
    // rows must never be mistaken for an already-applied re-home.
    const source = `tprx-src-${generateId()}`;
    const occupied = `tprx-dst-${generateId()}`;
    await seedTenant(db, source);
    await seedTenant(db, occupied);
    const archive = join(scratch, `${source}-archive`);
    await exportTenant(db, source, { archivePath: archive });

    await expect(importTenant(db, { archivePath: archive, tenantId: occupied })).rejects.toThrow(
      /destination database is not empty/i
    );

    // The occupied tenant was left untouched by the refused re-home.
    const inspection = await inspectTenant(db, occupied);
    expect(inspection.database.totalRows).toBeGreaterThan(0);

    await deleteTenantData(db, source);
    await deleteTenantData(db, occupied);
  });

  it('models non-portable transient authorities explicitly and treats them as destination occupancy', async () => {
    const source = `tpnp-src-${generateId()}`;
    const occupied = `tpnp-dst-${generateId()}`;
    await seedTenant(db, source);
    const archive = join(scratch, `${source}-archive`);
    await exportTenant(db, source, { archivePath: archive });

    const manifest = await readManifest(archive);
    expect(manifest.database.identity.nonPortableTenantTables).toEqual([
      'claude_oauth_attempts',
      'codex_device_auth_attempts',
      'executor_session_token_authorities',
      'github_install_states',
      'mcp_oauth_client_registrations',
      'mcp_oauth_pending_flows',
      'user_mcp_oauth_tokens',
    ]);
    expect(manifest.database.identity.tenantTables).not.toContain('codex_device_auth_attempts');
    expect(manifest.database.identity.tenantTables).not.toContain('claude_oauth_attempts');
    expect(manifest.database.identity.tenantTables).not.toContain(
      'executor_session_token_authorities'
    );
    expect(manifest.database.identity.tenantTables).not.toContain('mcp_oauth_pending_flows');
    expect(manifest.database.identity.tenantTables).not.toContain('mcp_oauth_client_registrations');
    expect(manifest.database.identity.tenantTables).not.toContain('user_mcp_oauth_tokens');
    expect(manifest.database.tables.map((table) => table.name)).not.toContain(
      'executor_session_token_authorities'
    );
    expect(manifest.database.tables.map((table) => table.name)).not.toContain(
      'codex_device_auth_attempts'
    );
    expect(manifest.database.tables.map((table) => table.name)).not.toContain(
      'claude_oauth_attempts'
    );
    expect(manifest.database.tables.map((table) => table.name)).not.toContain(
      'mcp_oauth_pending_flows'
    );
    expect(manifest.database.tables.map((table) => table.name)).not.toContain(
      'mcp_oauth_client_registrations'
    );
    expect(manifest.database.tables.map((table) => table.name)).not.toContain(
      'user_mcp_oauth_tokens'
    );
    expect(manifest.database.identity.tenantTables).not.toContain('github_install_states');
    expect(manifest.database.tables.map((table) => table.name)).not.toContain(
      'github_install_states'
    );

    // A destination containing only non-portable authority is not empty. An
    // import must never retain that bearer policy beside newly restored rows.
    await seedNonPortableExecutorAuthority(db, occupied);
    await seedNonPortableGitHubInstallState(db, occupied);
    await expect(importTenant(db, { archivePath: archive, tenantId: occupied })).rejects.toThrow(
      /destination database is not empty/i
    );

    await deleteTenantData(db, source);
    await deleteTenantData(db, occupied);
  });

  it('re-homes OAuth server configuration but omits grants across master secrets', async () => {
    const source = `tpog-src-${generateId()}`;
    const rehomed = `tpog-dst-${generateId()}`;
    await seedTenant(db, source);
    const serverId = await seedNonPortableOAuthGrant(
      db,
      source,
      'source-master-secret-for-portability-test'
    );
    const archive = join(scratch, `${source}-oauth-grant-archive`);
    await exportTenant(db, source, { archivePath: archive });

    const manifest = await readManifest(archive);
    expect(manifest.database.tables.map((table) => table.name)).toContain('mcp_servers');
    expect(manifest.database.tables.map((table) => table.name)).not.toContain(
      'user_mcp_oauth_tokens'
    );
    const serverArchive = await readFile(tableJsonlPath(archive, 'mcp_servers'), 'utf8');
    expect(serverArchive).not.toContain('source-deployment-access-token');
    expect(serverArchive).not.toContain('source-deployment-refresh-token');
    expect(serverArchive).not.toContain('source-client-secret');

    await deleteTenantData(db, source);
    await importTenant(db, { archivePath: archive, tenantId: rehomed });

    await runWithTenantDatabaseScope(db, rehomed, async (scoped) => {
      const servers = await select(scoped)
        .from(pg.mcpServers)
        .where(eq(pg.mcpServers.mcp_server_id, serverId))
        .all();
      expect(servers).toHaveLength(1);
      expect(servers[0]?.source).toBe('imported');
      expect(servers[0]?.catalog_entry_name).toBeNull();
      expect(
        (servers[0]?.data as { catalog_entry_name?: string } | undefined)?.catalog_entry_name
      ).toBeUndefined();
      expect((servers[0]?.data as { config_version?: number } | undefined)?.config_version).toBe(1);
      await expect(
        new UserMCPOAuthTokenRepository(
          scoped,
          'different-destination-master-secret-for-portability-test'
        ).getToken(null, serverId as MCPServerID)
      ).resolves.toBeNull();
    });

    await deleteTenantData(db, rehomed);
  });

  it('preserves JSON/numeric precision beyond 2^53 through export → verify → import', async () => {
    // Values that a JavaScript Number cannot hold exactly. If any hop parsed the
    // persisted JSON through JS, these would be silently rounded; the lossless
    // server-text path must carry the exact digits end to end — including the
    // re-home derivation that classifies an already-applied restore.
    const bigInt = '9007199254740993'; // 2^53 + 1
    const bigNumeric = '123456789012345678901234567890';
    const readSessionBig = (tenantId: string): Promise<{ big: string; nested: string }> =>
      runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const result = await executeRaw(
          scoped,
          sql`SELECT data->>'big' AS big, data->'nested'->>'n' AS nested
              FROM public.sessions WHERE tenant_id = ${tenantId} LIMIT 1`
        );
        const row = rowsOf(result)[0] ?? {};
        return { big: String(row.big), nested: String(row.nested) };
      });

    const source = `tpp-src-${generateId()}`;
    const rehomed = `tpp-dst-${generateId()}`;
    await seedTenant(db, source);
    await runWithTenantDatabaseScope(db, source, async (scoped) => {
      await executeRaw(
        scoped,
        sql`UPDATE public.sessions
            SET data = ${`{"big":${bigInt},"nested":{"n":${bigNumeric}}}`}::jsonb
            WHERE tenant_id = ${source}`
      );
    });

    const archive = join(scratch, `${source}-precision`);
    await exportTenant(db, source, { archivePath: archive });

    // The archived text carries the exact digits — nothing rounded through a JS Number.
    const sessionsJsonl = await readFile(join(archive, 'database', 'sessions.jsonl'), 'utf8');
    expect(sessionsJsonl).toContain(bigInt);
    expect(sessionsJsonl).toContain(bigNumeric);

    // The saved proof still matches the live tenant (re-derives the same bytes).
    expect((await verifyTenant(db, { archivePath: archive })).match).toBe(true);

    // Same-tenant restore keeps the values byte-exact.
    await deleteTenantData(db, source);
    await importTenant(db, { archivePath: archive });
    expect(await readSessionBig(source)).toEqual({ big: bigInt, nested: bigNumeric });

    // Re-home into a fresh tenant id: values survive, and a second run is an
    // idempotent no-op — which only holds if the archive-derived expected snapshot
    // is exactly as lossless as the live re-export it is compared against.
    await deleteTenantData(db, source);
    const rehomedImport = await importTenant(db, { archivePath: archive, tenantId: rehomed });
    expect(rehomedImport.database.restored).toBe(true);
    expect(await readSessionBig(rehomed)).toEqual({ big: bigInt, nested: bigNumeric });
    const again = await importTenant(db, { archivePath: archive, tenantId: rehomed });
    expect(again.alreadyApplied).toBe(true);
    expect(again.database.restored).toBe(false);

    await deleteTenantData(db, rehomed);
  });

  it('verifies a full archive under database-only scope and stays fail-closed without a root', async () => {
    const tenant = `tpv-${generateId()}`;
    await seedTenant(db, tenant);
    const fsRoot = join(scratch, `${tenant}-fs`);
    await seedFilesystem(fsRoot);
    const archive = join(scratch, `${tenant}-scope`);
    await exportTenant(db, tenant, { archivePath: archive, filesystemRoot: fsRoot });

    // database scope: the filesystem is skipped by request, so a full archive
    // matches on the database alone (the bug: it used to always mismatch).
    const dbOnly = await verifyTenant(db, { archivePath: archive, scope: 'database' });
    expect(dbOnly.scope).toBe('database');
    expect(dbOnly.match).toBe(true);
    expect(dbOnly.filesystem.requested).toBe(false);
    expect(dbOnly.filesystem.checked).toBe(false);

    // full scope with the root: full match, filesystem checked.
    const full = await verifyTenant(db, {
      archivePath: archive,
      scope: 'full',
      filesystemRoot: fsRoot,
    });
    expect(full.match).toBe(true);
    expect(full.filesystem.requested).toBe(true);
    expect(full.filesystem.checked).toBe(true);

    // full scope (default) without a root for a filesystem archive: fail-closed.
    const missingRoot = await verifyTenant(db, { archivePath: archive });
    expect(missingRoot.database.matched).toBe(true);
    expect(missingRoot.filesystem.requested).toBe(true);
    expect(missingRoot.filesystem.checked).toBe(false);
    expect(missingRoot.match).toBe(false);

    await deleteTenantData(db, tenant);
    await rm(fsRoot, { recursive: true, force: true });
  });
});
