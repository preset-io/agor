import {
  BoardRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  initializeDatabase,
  runWithTenantDatabaseScope,
  sql,
  UsersRepository,
} from '@agor/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardMetadataTestApp } from '../test/board-metadata-app.js';
import type { RegisterHooksContext } from './register-hooks.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'board metadata tenant boundary (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;
    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      const result = await executeRaw(
        rawDb,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    }, 60_000);
    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('denies foreign-tenant projections and metadata writes, even for an administrator', async () => {
      const db = createTenantScopedDatabaseProxy(rawDb, { label: 'board-metadata-postgres-test' });
      const tenantA = 'board-metadata-tenant-a';
      const tenantB = 'board-metadata-tenant-b';
      const seed = (tenantId: string, role: 'member' | 'admin') =>
        runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          const owner = await new UsersRepository(scoped).create({
            email: `${role}@example.test`,
            role,
          });
          const board = await new BoardRepository(scoped).create({
            name: 'Private board',
            created_by: owner.user_id,
          });
          return { owner, board };
        });
      const a = await seed(tenantA, 'member');
      const b = await seed(tenantB, 'admin');
      const server = await boardMetadataTestApp(db, {
        database: { dialect: 'postgresql' },
        multi_tenancy: {
          mode: 'required_from_auth',
          auth_claim: 'tenant_id',
          filesystem_isolation_enabled: true,
        },
        execution: {},
      } as RegisterHooksContext['config']);
      const resource = `${server.url}/boards/${a.board.board_id}`;
      const metadata = {
        name: 'Tenant A renamed',
        icon: '🍊',
        description: 'Tenant A description',
      };
      try {
        const ownAccess = await fetch(`${resource}/effective-access`, {
          headers: server.headers(a.owner.user_id, tenantA),
        });
        expect(ownAccess.status, await ownAccess.clone().text()).toBe(200);
        await expect(ownAccess.json()).resolves.toMatchObject({
          is_primary_owner: true,
          capabilities: expect.arrayContaining(['board.edit']),
        });
        for (const headers of [
          server.headers(b.owner.user_id, tenantB),
          server.headers(a.owner.user_id, tenantB),
        ]) {
          const foreignAccess = await fetch(`${resource}/effective-access`, { headers });
          expect([400, 401, 403, 404]).toContain(foreignAccess.status);
          for (const method of ['PATCH', 'PUT']) {
            const denied = await fetch(resource, {
              method,
              headers,
              body: JSON.stringify({ ...metadata, tenant_id: tenantA }),
            });
            expect([400, 401, 403, 404]).toContain(denied.status);
          }
        }
        await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
          expect(await new BoardRepository(scoped).findById(a.board.board_id)).toEqual(a.board);
        });
        const saved = await fetch(resource, {
          method: 'PATCH',
          headers: server.headers(a.owner.user_id, tenantA),
          body: JSON.stringify(metadata),
        });
        expect(saved.status, await saved.clone().text()).toBe(200);
        await expect(saved.json()).resolves.toMatchObject(metadata);
        await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
          expect(await new BoardRepository(scoped).findById(b.board.board_id)).toEqual(b.board);
          expect(await new BoardRepository(scoped).findById(a.board.board_id)).toBeNull();
        });
      } finally {
        await server.close();
      }
    });
  }
);
