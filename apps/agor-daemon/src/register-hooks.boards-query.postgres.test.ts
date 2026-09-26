import { createClient, createRestClient } from '@agor/core/api';
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
import { PRESENCE_SOCKET_EVENTS } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardMetadataTestApp } from '../test/board-metadata-app.js';
import { boardPresenceAssociationRoomName } from './realtime/routing.js';
import type { RegisterHooksContext } from './register-hooks.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'registered board set queries (PostgreSQL/RLS)',
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
    }, 60000);
    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('filters foreign IDs from REST/Socket.IO lists and native presence rooms, including for an admin', async () => {
      const db = createTenantScopedDatabaseProxy(rawDb);
      const tenantA = 'board-query-tenant-a';
      const tenantB = 'board-query-tenant-b';
      const seed = (tenantId: string, role: 'member' | 'admin') =>
        runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          const user = await new UsersRepository(scoped).create({
            email: `${role}@example.test`,
            role,
          });
          const board = await new BoardRepository(scoped).create({
            name: 'Owned board',
            created_by: user.user_id,
            access_mode: 'private',
          });
          return { user, board };
        });
      const a = await seed(tenantA, 'member');
      const b = await seed(tenantB, 'admin');
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
        true
      );
      const clients: ReturnType<typeof createClient>[] = [];
      try {
        const ids = [a.board.board_id, b.board.board_id];
        for (const [fixture, tenantId, foreign] of [
          [a, tenantA, b],
          [b, tenantB, a],
        ] as const) {
          const accessToken = server.headers(fixture.user.user_id, tenantId).authorization.slice(7);
          const socket = createClient(server.url, true, {
            socketAuthentication: { accessToken },
            ackTimeout: 2000,
          });
          clients.push(socket);
          const rest = await createRestClient(server.url);
          await rest.authenticate({ strategy: 'jwt', accessToken });
          for (const client of [rest, socket]) {
            expect(
              await client.service('boards').findAll({
                query: { board_id: { $in: ids }, lean: true, archived: false, $limit: 1 },
              })
            ).toMatchObject([{ board_id: fixture.board.board_id }]);
            expect(
              await client
                .service('boards')
                .findAll({ query: { board_id: { $in: [foreign.board.board_id] } } })
            ).toEqual([]);
          }
          expect(
            await socket.io
              .timeout(2000)
              .emitWithAck(PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations, { boardIds: ids })
          ).toEqual({ ok: true });
          const rooms = server.app.io.sockets.sockets.get(socket.io.id!)!.rooms;
          expect(
            rooms.has(boardPresenceAssociationRoomName(tenantId, fixture.board.board_id))
          ).toBe(true);
          expect(
            rooms.has(boardPresenceAssociationRoomName(tenantId, foreign.board.board_id))
          ).toBe(false);
          expect(
            rooms.has(
              boardPresenceAssociationRoomName(
                tenantId === tenantA ? tenantB : tenantA,
                foreign.board.board_id
              )
            )
          ).toBe(false);
        }
        const conflict = await fetch(`${server.url}/boards?lean=true`, {
          headers: server.headers(a.user.user_id, tenantB),
        });
        // The tenant-scoped user lookup may intentionally be non-enumerating.
        expect([401, 403, 404]).toContain(conflict.status);
        expect((await fetch(`${server.url}/boards`)).status).toBe(401);
      } finally {
        for (const client of clients) client.io.disconnect();
        await server.close();
      }
    });
  }
);
