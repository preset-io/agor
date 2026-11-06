/**
 * A self-hosted SQLite install must export archives a PostgreSQL runtime
 * imports to the same rows. Seeds a tenant in PostgreSQL, copies its rows into
 * a migrated SQLite file, deletes the PostgreSQL tenant, exports the SQLite
 * file, imports it back, and compares PostgreSQL's own canonical exports.
 *
 *   AGOR_DB_DIALECT=postgresql AGOR_TEST_POSTGRES_URL=… \
 *     pnpm --filter @agor/core exec vitest run src/db/tenant-sqlite-export.postgres.test.ts
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import type { UserID } from '../types/id';
import { createDatabase, type Database } from './client';
import { executeRaw } from './database-wrapper';
import { decryptApiKey, encryptApiKey } from './encryption';
import { runMigrations } from './migrate';
import { BoardRepository } from './repositories/boards';
import { BranchRepository } from './repositories/branches';
import { MessagesRepository } from './repositories/messages';
import { RepoRepository } from './repositories/repos';
import { ScheduleRepository } from './repositories/schedules';
import { SessionRepository } from './repositories/sessions';
import { TaskRepository } from './repositories/tasks';
import { UsersRepository } from './repositories/users';
import * as pg from './schema.postgres';
import { exportTenantTableRows } from './tenant-database-io';
import { deleteTenant } from './tenant-delete';
import { exportTenant } from './tenant-export';
import { importTenant } from './tenant-import';
import { buildTenantInsertOrder } from './tenant-portability-manifest';
import { runWithTenantDatabaseScope } from './tenant-scope';
import { rewrapTenantSecrets } from './tenant-secret-rewrap';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const TENANT = `jsonl-${randomUUID().slice(0, 8)}`;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function pgTable(name: string): PgTable {
  const table = Object.values(pg).find(
    (value) => is(value, PgTable) && getTableConfig(value).name === name
  );
  if (!table) throw new Error(`No PostgreSQL table ${name}`);
  return table as PgTable;
}

/** PostgreSQL driver value → what the SQLite schema stores for it. */
function toSqliteValue(value: unknown, columnType: string): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (columnType === 'PgTimestamp' && typeof value === 'string') {
    // Raw driver rows render timestamptz as text: `YYYY-MM-DD HH:MM:SS.fff+00`.
    return Date.parse(value.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (Buffer.isBuffer(value)) return value;
  if (columnType === 'PgJsonb' || columnType === 'PgJson' || typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)('SQLite export → PostgreSQL import', () => {
  let pgDb: Database;
  let sqliteDb: Database;
  let scratch: string;

  beforeAll(async () => {
    pgDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await runMigrations(pgDb);
    scratch = await mkdtemp(join(tmpdir(), 'agor-sqlite-export-'));
    sqliteDb = createDatabase({ dialect: 'sqlite', url: `file:${join(scratch, 'agor.db')}` });
    await runMigrations(sqliteDb);
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('imports every movable table to the rows PostgreSQL held', async () => {
    await runWithTenantDatabaseScope(pgDb, TENANT, async (scoped) => {
      const owner = await new UsersRepository(scoped).create({
        user_id: generateId() as UserID,
        email: `${TENANT}@example.invalid`,
        name: 'Ünïcode "quoted" \\ name',
        role: 'member',
      });
      const board = await new BoardRepository(scoped).create({
        name: 'Board',
        created_by: owner.user_id,
        objects: {
          'zone-1': { type: 'zone', x: 1.5, y: -2, width: 300, height: 200, label: 'Doing\nnow' },
        } as never,
        custom_context: { nested: { b: [1, 2, { z: true }], a: null, longer_key: 'x' } },
      });
      const repo = await new RepoRepository(scoped).create({
        slug: `jsonl/${TENANT}`,
        name: 'repo',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/r.git',
        local_path: `/tmp/${TENANT}`,
        default_branch: 'main',
      });
      const branch = await new BranchRepository(scoped).create({
        branch_id: generateId() as never,
        repo_id: repo.repo_id,
        board_id: board.board_id,
        name: 'ada',
        ref: 'main',
        branch_unique_id: Date.now() % 1_000_000,
        path: `/tmp/${TENANT}/ada`,
        created_by: owner.user_id,
        custom_context: { teammate: { kind: 'teammate', displayName: 'Ada', emoji: '🦊' } },
      });
      const session = await new SessionRepository(scoped).create({
        branch_id: branch.branch_id,
        agentic_tool: 'claude-code',
        created_by: owner.user_id,
        title: 'tab\there',
        archived: true,
        archived_reason: 'imported',
      });
      const task = await new TaskRepository(scoped).create({
        session_id: session.session_id,
        created_by: owner.user_id,
        full_prompt: 'emoji 🚀 and \u0001 control',
        status: 'completed',
      });
      await new MessagesRepository(scoped).create({
        session_id: session.session_id,
        task_id: task.task_id,
        type: 'assistant',
        role: 'assistant',
        index: 0,
        timestamp: new Date(Date.UTC(2026, 10, 4, 10, 0, 0, 120)).toISOString(),
        content_preview: 'hi',
        content: [{ type: 'text', text: 'hi' }],
      } as never);
      await new ScheduleRepository(scoped).create({
        branch_id: branch.branch_id,
        name: 'Daily',
        cron_expression: '0 9 * * *',
        timezone_mode: 'utc',
        prompt: 'go',
        agentic_tool_config: { agentic_tool: 'claude-code' },
        enabled: false,
        next_run_at: 4_102_444_800_000,
        created_by: owner.user_id,
      } as never);
      await executeRaw(
        scoped,
        sql`INSERT INTO app_variables (tenant_id, variable_id, namespace, key, value_text, value_encrypted, is_encrypted, metadata, updated_by, created_at, updated_at)
            VALUES (${TENANT}, ${generateId()}, 'tenant.secrets', 'TOKEN', NULL, ${encryptApiKey('xoxb-secret', 'k')}, true, '{"b": [1, null], "a": "x"}'::jsonb, NULL, '2026-11-04T10:00:00.123Z', '2026-11-04T10:00:00.123Z')`
      );
    });

    // Copy the PostgreSQL tenant rows into SQLite (FK order differs by dialect).
    await executeRaw(sqliteDb, sql`PRAGMA foreign_keys = OFF`);
    // SQLite migrations seed built-in namespaces that this PostgreSQL tenant lacks.
    await executeRaw(sqliteDb, sql`DELETE FROM kb_namespaces`);
    for (const table of buildTenantInsertOrder()) {
      const rows = rowsOf(
        await runWithTenantDatabaseScope(pgDb, TENANT, (scoped) =>
          executeRaw(
            scoped,
            sql`SELECT * FROM ${sql.identifier(table.name)} WHERE tenant_id = ${TENANT}`
          )
        )
      );
      const columns = getTableConfig(pgTable(table.name)).columns.filter(
        (c) => c.name !== 'tenant_id'
      );
      for (const row of rows) {
        await executeRaw(
          sqliteDb,
          sql`INSERT INTO ${sql.identifier(table.name)} (${sql.join(
            columns.map((column) => sql.identifier(column.name)),
            sql`, `
          )}) VALUES (${sql.join(
            columns.map((column) => sql`${toSqliteValue(row[column.name], column.columnType)}`),
            sql`, `
          )})`
        );
      }
    }

    const exportAll = () =>
      runWithTenantDatabaseScope(pgDb, TENANT, async (scoped) => {
        const out: Record<string, string> = {};
        for (const table of buildTenantInsertOrder()) {
          out[table.name] = (await exportTenantTableRows(scoped, table.name, TENANT)).jsonl;
        }
        return out;
      });
    const before = await exportAll();
    await deleteTenant(pgDb, TENANT, { databaseOnly: true });

    const archive = join(scratch, 'roundtrip');
    await exportTenant(sqliteDb, TENANT, { archivePath: archive, agorRelease: 'test' });
    const result = await importTenant(pgDb, { archivePath: archive });
    expect(result.database.totalRows).toBeGreaterThan(6);
    expect(await exportAll()).toEqual(before);
  });

  it('moves a SQLite install into PostgreSQL with resealed secrets and a clone layout', async () => {
    const sourceKey = 'source-master-secret-for-test';
    const transferKey = 'one-time-transfer-key-for-test';
    const destinationKey = 'destination-cell-key-for-test';
    const sealed = encryptApiKey('xoxb-real-token', sourceKey);
    // A fresh SQLite install of its own (ids must not exist in PostgreSQL yet).
    const install = createDatabase({
      dialect: 'sqlite',
      url: `file:${join(scratch, 'install.db')}`,
    });
    await runMigrations(install);
    const now = Date.now();
    const userId = generateId();
    const repoId = generateId();
    await executeRaw(
      install,
      sql`INSERT INTO users (user_id, created_at, updated_at, email, password, role, data)
          VALUES (${userId}, ${now}, ${now}, 'self@example.invalid', '', 'admin', '{}')`
    );
    await executeRaw(
      install,
      sql`INSERT INTO repos (repo_id, created_at, updated_at, slug, repo_type, data)
          VALUES (${repoId}, ${now}, ${now}, 'acme/app', 'remote',
                  ${JSON.stringify({ name: 'app', remote_url: 'https://example.invalid/app.git', local_path: '/home/me/.agor/repos/acme/app', clone_status: 'ready' })})`
    );
    await executeRaw(
      install,
      sql`INSERT INTO branches (branch_id, repo_id, created_at, updated_at, created_by, primary_owner_user_id, name, ref, branch_unique_id, filesystem_status, storage_mode, data)
          VALUES (${generateId()}, ${repoId}, ${now}, ${now}, ${userId}, ${userId}, 'feature', 'feature', 1, 'ready', 'worktree',
                  ${JSON.stringify({ path: '/home/me/.agor/worktrees/acme/app/feature' })})`
    );
    await executeRaw(
      install,
      sql`INSERT INTO app_variables (variable_id, namespace, key, value_encrypted, is_encrypted, created_at, updated_at)
          VALUES (${generateId()}, 'tenant.secrets', 'SLACK_TOKEN', ${sealed}, 1, ${now}, ${now})`
    );
    const archive = join(scratch, 'archive');
    const moved = `moved-${randomUUID().slice(0, 8)}`;
    const exported = await exportTenant(install, moved, {
      archivePath: archive,
      agorRelease: 'test',
      transferKey: { fromKey: sourceKey, toKey: transferKey },
    });
    expect(exported.secrets?.rewrappedValues).toBe(1);

    const result = await importTenant(pgDb, {
      archivePath: archive,
      targetLayout: {
        kind: 'clone',
        paths: {
          branchPath: (slug, name) => `/cell/${moved}/worktrees/${slug}/${name}`,
          repoPath: (slug) => `/cell/${moved}/repos/${slug}`,
        },
      },
    });
    expect(result.database.restored).toBe(true);
    // Re-running is recognised as already applied (the layout rewrite is deterministic).
    expect(
      (
        await importTenant(pgDb, {
          archivePath: archive,
          targetLayout: {
            kind: 'clone',
            paths: {
              branchPath: (slug, name) => `/cell/${moved}/worktrees/${slug}/${name}`,
              repoPath: (slug) => `/cell/${moved}/repos/${slug}`,
            },
          },
        })
      ).alreadyApplied
    ).toBe(true);

    const proof = await rewrapTenantSecrets(pgDb, {
      tenantId: moved,
      fromKey: transferKey,
      toKey: destinationKey,
    });
    expect(proof).toMatchObject({ rewrappedValues: 1, sourceKeyResidual: 0 });
    await runWithTenantDatabaseScope(pgDb, moved, async (scoped) => {
      const secret = rowsOf(
        await executeRaw(
          scoped,
          sql`SELECT value_encrypted FROM app_variables WHERE tenant_id = ${moved} AND key = 'SLACK_TOKEN'`
        )
      )[0];
      expect(decryptApiKey(String(secret?.value_encrypted), destinationKey)).toBe(
        'xoxb-real-token'
      );
      const branch = rowsOf(
        await executeRaw(
          scoped,
          sql`SELECT storage_mode, filesystem_status, data FROM branches WHERE tenant_id = ${moved}`
        )
      )[0] as {
        storage_mode: string;
        filesystem_status: string;
        data: { path: string };
      };
      expect(branch).toMatchObject({ storage_mode: 'clone', filesystem_status: 'deleted' });
      expect(branch.data.path).toBe(`/cell/${moved}/worktrees/acme/app/feature`);
    });
  });
});
