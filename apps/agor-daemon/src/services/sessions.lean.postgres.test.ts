import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  sql,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Session, TenantID } from '@agor/core/types';
import { SESSION_LIST_ROW_SHAPE, SessionStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionsService } from './sessions.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

const heavyContext = {
  teamName: 'Backend',
  scheduled_run: { rendered_prompt: 'x'.repeat(2_000), run_index: 1 },
  slash_commands: ['/review'],
  skills: ['pdf'],
};

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function dataOf(result: Awaited<ReturnType<SessionsService['find']>>): Session[] {
  return Array.isArray(result) ? result : result.data;
}

async function seedTenant(db: Database, label: string) {
  const user = await new UsersRepository(db).create({
    email: `${label}-${generateId()}@example.test`,
  });
  const repo = await new RepoRepository(db).create({
    slug: `${label}-${generateId()}`,
    name: label,
    repo_type: 'remote',
    remote_url: 'https://example.invalid/lean.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    name: `${label}-${generateId()}`,
    ref: 'main',
    branch_unique_id: Date.now() % 1_000_000_000,
    path: `/tmp/${generateId()}`,
    created_by: user.user_id,
  });
  const sessions = new SessionRepository(db);
  const base = {
    branch_id: branch.branch_id,
    created_by: user.user_id,
    agentic_tool: 'claude-code' as const,
    status: SessionStatus.IDLE,
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
  };
  const heavy = await sessions.create({ ...base, custom_context: heavyContext });
  const plain = await sessions.create(base);
  return { heavy: heavy.session_id, plain: plain.session_id };
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'SessionsService lean list rows (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL test requires PostgreSQL');
      const [role] = rowsOf(
        await executeRaw(
          rawDb,
          sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        )
      );
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('marks every lean row on the SQL-page and generic paths, within the tenant', async () => {
      const tenantA = `lean-a-${generateId()}` as TenantID;
      const tenantB = `lean-b-${generateId()}` as TenantID;
      const db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'sessions-lean-postgres-test',
      });
      const a = await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
        seedTenant(scoped, 'tenant-a')
      );
      const b = await runWithTenantDatabaseScope(db, tenantB, (scoped) =>
        seedTenant(scoped, 'tenant-b')
      );
      const service = new SessionsService(db, {} as unknown as Application);
      const params = { tenant: { tenant_id: tenantA, source: 'explicit' as const } };

      const queries = {
        // Recency-sorted bounded slice → SQL findPage.
        sqlPage: { archived: false, $limit: 10, $sort: { updated_at: -1 } },
        // Feathers operators → generic DrizzleService pipeline.
        generic: { session_id: { $in: [a.heavy, a.plain, b.heavy] }, $limit: 10 },
      };
      for (const [path, query] of Object.entries(queries)) {
        const [lean, full] = await runWithTenantDatabaseScope(db, tenantA, () =>
          Promise.all([
            service.find({ ...params, query: { ...query, lean: true } }),
            service.find({ ...params, query }),
          ])
        );
        const leanRows = dataOf(lean);
        expect(leanRows.map((s) => s.session_id).sort(), path).toEqual([a.heavy, a.plain].sort());
        for (const row of leanRows) {
          expect((row as { read_shape?: unknown }).read_shape, path).toBe(SESSION_LIST_ROW_SHAPE);
          expect(row.custom_context ?? {}, path).not.toHaveProperty('scheduled_run');
          expect(row.custom_context ?? {}, path).not.toHaveProperty('slash_commands');
          expect(row.custom_context ?? {}, path).not.toHaveProperty('skills');
        }
        expect(leanRows.find((s) => s.session_id === a.heavy)?.custom_context, path).toEqual({
          teamName: 'Backend',
        });
        for (const row of dataOf(full)) {
          expect(row, path).not.toHaveProperty('read_shape');
          // The lean copy keeps the hidden tenant_id the tenant after-hook reads.
          const leanRow = leanRows.find((s) => s.session_id === row.session_id);
          expect(Object.getOwnPropertyDescriptor(leanRow, 'tenant_id'), path).toEqual(
            Object.getOwnPropertyDescriptor(row, 'tenant_id')
          );
        }
      }

      const fetched = await runWithTenantDatabaseScope(db, tenantA, () =>
        service.get(a.heavy, params)
      );
      expect(fetched.custom_context).toEqual(heavyContext);
      expect(fetched).not.toHaveProperty('read_shape');
    }, 30_000);
  }
);
