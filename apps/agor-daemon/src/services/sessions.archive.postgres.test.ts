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
import type { SessionID, TenantID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionsService } from './sessions.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

async function createTree(db: Database, label: string) {
  const user = await new UsersRepository(db).create({
    email: `${label}-${generateId()}@example.test`,
  });
  const repo = await new RepoRepository(db).create({
    slug: `${label}-${generateId()}`,
    name: label,
    repo_type: 'remote',
    remote_url: 'https://example.invalid/archive.git',
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
  const root = await sessions.create({
    branch_id: branch.branch_id,
    created_by: user.user_id,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
  });
  const child = await sessions.create({
    branch_id: branch.branch_id,
    created_by: user.user_id,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    tasks: [],
    contextFiles: [],
    genealogy: { parent_session_id: root.session_id, children: [] },
  });
  return { root, child };
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'SessionsService archive lifecycle (PostgreSQL/RLS)',
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

    it('mutates only the active tenant and rejects missing tenant scope', async () => {
      const tenantA = `archive-a-${generateId()}` as TenantID;
      const tenantB = `archive-b-${generateId()}` as TenantID;
      const db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'sessions-archive-postgres-test',
      });
      const treeA = await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
        createTree(scoped, 'tenant-a')
      );
      await runWithTenantDatabaseScope(db, tenantB, (scoped) => createTree(scoped, 'tenant-b'));
      const events: SessionID[] = [];
      const app = {
        get: () => ({ execution: { branch_rbac: false } }),
        service: () => ({
          emit: (_event: string, data: { session_id: SessionID }) => events.push(data.session_id),
        }),
      } as unknown as Application;
      const service = new SessionsService(db, app);

      const result = await runWithTenantDatabaseScope(db, tenantA, () =>
        service.archive(treeA.root.session_id, undefined, {
          tenant: { tenant_id: tenantA, source: 'explicit' },
        })
      );
      expect(result.count).toBe(2);
      expect(events).toEqual([treeA.root.session_id, treeA.child.session_id]);

      await expect(
        runWithTenantDatabaseScope(db, tenantB, () =>
          service.archive(treeA.root.session_id, undefined, {
            tenant: { tenant_id: tenantB, source: 'explicit' },
          })
        )
      ).rejects.toMatchObject({ code: 404 });

      const tenantAState = await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
        new SessionRepository(scoped).findAll()
      );
      expect(tenantAState).toHaveLength(2);
      expect(tenantAState.every((session) => session.archived)).toBe(true);

      await expect(service.archive(treeA.root.session_id)).rejects.toThrow(/tenant.*scope/i);
    }, 30_000);
  }
);
