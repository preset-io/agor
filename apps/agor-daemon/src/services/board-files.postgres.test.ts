import {
  ArtifactRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  initializeDatabase,
  KnowledgeDocumentRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  sql,
  UploadRepository,
  UsersRepository,
} from '@agor/core/db';
import type { BoardFilesPage, BoardID, TenantID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBoardFiles } from '../../test/board-files-fixture.js';
import { boardMetadataTestApp } from '../../test/board-metadata-app.js';
import type { RegisterHooksContext } from '../register-hooks.js';
import { setupBoardFilesService } from './board-files.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'boards/:id/files tenant boundary (PostgreSQL/RLS)',
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

    it('lists a board only inside its own tenant, even for another tenant’s administrator', async () => {
      const db = createTenantScopedDatabaseProxy(rawDb, { label: 'board-files-postgres-test' });
      const tenantA = 'board-files-tenant-a';
      const tenantB = 'board-files-tenant-b';
      const a = await runWithTenantDatabaseScope(db, tenantA, (scoped) =>
        seedBoardFiles(scoped, tenantA, 'tenant-a')
      );
      const bAdmin = await runWithTenantDatabaseScope(db, tenantB, (scoped) =>
        new UsersRepository(scoped).create({ email: 'admin-b@example.test', role: 'admin' })
      );
      const server = await boardMetadataTestApp(
        db,
        {
          database: { dialect: 'postgresql' },
          multi_tenancy: {
            mode: 'required_from_auth',
            auth_claim: 'tenant_id',
            filesystem_isolation_enabled: true,
          },
          execution: {},
        } as RegisterHooksContext['config'],
        false,
        false,
        false,
        async (app) => setupBoardFilesService(app, db, { allowSuperadmin: false })
      );
      const resource = `${server.url}/boards/${a.board.board_id}/files`;
      try {
        const own = await fetch(resource, { headers: server.headers(a.viewer.user_id, tenantA) });
        expect(own.status, await own.clone().text()).toBe(200);
        const page = (await own.json()) as BoardFilesPage;
        expect(page.total).toBe(7);
        expect(page.data.map((item) => item.id)).toContain(a.uploads.orderForm.ref);

        const work = `${resource}?session_id=${a.kickoff.session_id}&include_archived=true`;
        const ownWork = await fetch(work, { headers: server.headers(a.owner.user_id, tenantA) });
        expect(((await ownWork.json()) as BoardFilesPage).total).toBe(5);

        for (const headers of [
          server.headers(bAdmin.user_id, tenantB),
          server.headers(a.owner.user_id, tenantB),
        ]) {
          for (const url of [resource, work]) {
            const denied = await fetch(url, { headers });
            expect([400, 401, 403, 404]).toContain(denied.status);
            const body = await denied.text();
            expect(body).not.toContain(a.artifacts.dashboard.name);
            expect(body).not.toContain(a.docs.talkingPoints.title);
            expect(body).not.toContain(a.uploads.orderForm.ref);
          }
        }

        // The new board-scoped reads return nothing for the same board id in another tenant.
        await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
          const boardId = a.board.board_id as BoardID;
          expect(
            await new UploadRepository(scoped).listForBoard(tenantB as TenantID, boardId)
          ).toEqual([]);
          const documents = new KnowledgeDocumentRepository(scoped);
          for (const scope of [{ boardId }, { sessionId: a.kickoff.session_id }]) {
            expect(await documents.findForBoard(scope, { read: { as_admin: true } })).toEqual([]);
          }
          expect(
            await new ArtifactRepository(scoped).findAll({
              source_session_id: a.kickoff.session_id,
            })
          ).toEqual([]);
          expect(
            await new SessionRepository(scoped).findAll({ sessionIds: [a.kickoff.session_id] })
          ).toEqual([]);
        });
      } finally {
        await server.close();
      }
    });
  }
);
