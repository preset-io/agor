/**
 * Production-shaped Socket.IO tenant-isolation coverage.
 *
 * The PostgreSQL lane supplies a disposable non-superuser, NOBYPASSRLS role.
 * This suite then uses two real Socket.IO clients, signed tenant claims, and
 * repository reads through PostgreSQL RLS. It deliberately keeps the service
 * surface small so failures identify the WebSocket boundary rather than daemon
 * startup dependencies.
 */

import type { Server as HttpServer } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import {
  BoardRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import {
  AuthenticationService,
  feathers,
  feathersExpress,
  type Params,
  socketio,
} from '@agor/core/feathers';
import type { Board, BoardID, TenantContext, User, UserID, UUID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RuntimeJWTStrategy } from '../auth/runtime-jwt-strategy.js';
import {
  issueRuntimeToken,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
} from '../auth/runtime-tokens.js';
import { terminalChannelName } from '../realtime/routing.js';
import { configureChannels, createSocketIOConfig } from './socketio.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const JWT_SECRET = 'disposable-postgres-socket-tenant-test-secret';

interface TenantParams extends Params {
  tenant?: TenantContext;
  user?: User & { tenant_id?: string };
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function waitForConnect(client: AgorClient): Promise<void> {
  if (client.io.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket.IO client did not connect')), 3_000);
    client.io.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    client.io.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function watchBoard(client: AgorClient, boardId: string): Promise<{ ok: boolean }> {
  return client.io.timeout(2_000).emitWithAck('presence:watch-board', boardId);
}

function subscribeBoardAssociations(
  client: AgorClient,
  boardIds: string[]
): Promise<{ ok: boolean }> {
  return client.io.timeout(2_000).emitWithAck('presence:subscribe-boards', { boardIds });
}

function delay(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tenantIdFromParams(params?: TenantParams): string | undefined {
  return params?.tenant?.tenant_id ?? params?.user?.tenant_id;
}

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'Socket.IO tenant isolation (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;
    let db: TenantScopeAwareDatabase;
    let server: HttpServer | undefined;
    const clients: AgorClient[] = [];

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
      db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'socketio-tenant-isolation-test',
      });
    }, 60_000);

    afterAll(async () => {
      for (const client of clients) client.io.close();
      if (server) {
        await new Promise<void>((resolve, reject) =>
          server?.close((error) => (error ? reject(error) : resolve()))
        );
      }
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('fails closed for cross-tenant IDs, private boards, forged tenant metadata, stale rooms, and reconnects', async () => {
      const tenantA = `socket-a-${generateId()}`;
      const tenantB = `socket-b-${generateId()}`;
      let viewerA!: User;
      let ownerA!: User;
      let adminA!: User;
      let superadminA!: User;
      let viewerB!: User;
      let sharedA!: Board;
      let privateA!: Board;
      let sharedB!: Board;

      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const users = new UsersRepository(scoped);
        const boards = new BoardRepository(scoped);
        ownerA = await users.create({
          email: `owner-a-${generateId()}@example.test`,
          role: 'member',
        });
        viewerA = await users.create({
          email: `viewer-a-${generateId()}@example.test`,
          role: 'member',
        });
        adminA = await users.create({
          email: `admin-a-${generateId()}@example.test`,
          role: 'admin',
        });
        superadminA = await users.create({
          email: `superadmin-a-${generateId()}@example.test`,
          role: 'superadmin',
        });
        sharedA = await boards.create({
          name: 'Tenant A shared board',
          created_by: ownerA.user_id as UUID,
          access_mode: 'shared',
        });
        privateA = await boards.create({
          name: 'Tenant A private board',
          created_by: ownerA.user_id as UUID,
          access_mode: 'private',
        });
      });
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        const users = new UsersRepository(scoped);
        const boards = new BoardRepository(scoped);
        viewerB = await users.create({
          email: `viewer-b-${generateId()}@example.test`,
          role: 'member',
        });
        sharedB = await boards.create({
          name: 'Tenant B shared board',
          created_by: viewerB.user_id as UUID,
          access_mode: 'shared',
        });
      });

      const app = feathersExpress(feathers());
      app.use('users', {
        async get(id: UserID, params?: TenantParams): Promise<User> {
          const tenantId = tenantIdFromParams(params);
          if (!tenantId) throw new Error('User unavailable');
          const user = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
            new UsersRepository(scoped).findById(id)
          );
          if (!user) throw new Error('User unavailable');
          return user;
        },
      });
      app.use('boards', {
        async get(id: BoardID, params?: TenantParams): Promise<Board> {
          const tenantId = tenantIdFromParams(params);
          const userId = params?.user?.user_id;
          if (!tenantId || !userId) throw new Error('Board unavailable');
          return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
            const boards = new BoardRepository(scoped);
            const board = await boards.findById(id);
            if (!board) throw new Error('Board unavailable');
            if (!(await boards.canView(board.board_id, userId as UUID))) {
              throw new Error('Board unavailable');
            }
            return board;
          });
        },
        async find(params?: TenantParams): Promise<Board[]> {
          const tenantId = tenantIdFromParams(params);
          const userId = params?.user?.user_id;
          const boardFilter = params?.query?.board_id as { $in?: string[] } | undefined;
          const requested = boardFilter?.$in ?? [];
          if (!tenantId || !userId) return [];
          return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
            const boards = new BoardRepository(scoped);
            const visible: Board[] = [];
            for (const boardId of requested) {
              const board = await boards.findById(boardId);
              if (
                board &&
                !board.archived &&
                (await boards.canView(board.board_id, userId as UUID))
              ) {
                visible.push(board);
              }
            }
            return visible;
          });
        },
      });
      app.use('terminals', {
        async find(): Promise<never[]> {
          return [];
        },
        matchesOwnedAttachment(): boolean {
          return false;
        },
      });

      const multiTenancy = {
        mode: 'required_from_auth',
        static_tenant_id: 'unused' as never,
        auth_claim: 'tenant_id',
        trusted_header: 'x-agor-tenant-id',
      } as const;
      app.set('authentication', {
        secret: JWT_SECRET,
        entity: 'user',
        entityId: 'user_id',
        service: 'users',
        authStrategies: ['jwt'],
        jwtOptions: {
          audience: RUNTIME_JWT_AUDIENCE,
          issuer: RUNTIME_JWT_ISSUER,
          algorithm: 'HS256',
        },
      });
      const authentication = new AuthenticationService(app);
      authentication.register('jwt', new RuntimeJWTStrategy({ multiTenancy }));
      app.use('authentication', authentication);

      const socketConfig = createSocketIOConfig(app as never, {
        corsOrigin: '*',
        credentialsAllowed: false,
        workIdentity: { instanceId: 'socket-test', bootId: 'socket-test-boot' },
        multiTenancy,
      });
      app.configure(socketio(socketConfig.serverOptions, socketConfig.callback));
      configureChannels(app as never);

      server = await new Promise<HttpServer>((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
      const url = `http://127.0.0.1:${address.port}`;

      const tokenA = issueRuntimeToken(
        { sub: viewerA.user_id as UserID, type: 'access', tenant_id: tenantA },
        JWT_SECRET,
        '5m'
      );
      const tokenB = issueRuntimeToken(
        { sub: viewerB.user_id as UserID, type: 'access', tenant_id: tenantB },
        JWT_SECRET,
        '5m'
      );
      const ownerTokenA = issueRuntimeToken(
        { sub: ownerA.user_id as UserID, type: 'access', tenant_id: tenantA },
        JWT_SECRET,
        '5m'
      );
      const adminTokenA = issueRuntimeToken(
        { sub: adminA.user_id as UserID, type: 'access', tenant_id: tenantA },
        JWT_SECRET,
        '5m'
      );
      const superadminTokenA = issueRuntimeToken(
        { sub: superadminA.user_id as UserID, type: 'access', tenant_id: tenantA },
        JWT_SECRET,
        '5m'
      );
      const clientA = createClient(url, false, { reconnectionAttempts: 0, ackTimeout: 2_000 });
      const ownerClientA = createClient(url, false, { reconnectionAttempts: 0, ackTimeout: 2_000 });
      const ownerPeerClientA = createClient(url, false, {
        reconnectionAttempts: 0,
        ackTimeout: 2_000,
      });
      const adminClientA = createClient(url, false, { reconnectionAttempts: 0, ackTimeout: 2_000 });
      const superadminClientA = createClient(url, false, {
        reconnectionAttempts: 0,
        ackTimeout: 2_000,
      });
      const clientB = createClient(url, false, { reconnectionAttempts: 0, ackTimeout: 2_000 });
      clients.push(
        clientA,
        ownerClientA,
        ownerPeerClientA,
        adminClientA,
        superadminClientA,
        clientB
      );
      clientA.io.auth = {
        token: tokenA,
        // Caller-controlled auth metadata must not override the signed claim.
        tenant_id: tenantB,
      };
      ownerClientA.io.auth = { token: ownerTokenA };
      ownerPeerClientA.io.auth = { token: ownerTokenA };
      adminClientA.io.auth = { token: adminTokenA };
      superadminClientA.io.auth = { token: superadminTokenA };
      clientB.io.auth = { token: tokenB };
      for (const client of clients) client.io.connect();
      await Promise.all(clients.map(waitForConnect));

      const receivedA: Array<{ event: string; payload: unknown }> = [];
      const receivedB: Array<{ event: string; payload: unknown }> = [];
      for (const [client, buffer] of [
        [clientA, receivedA],
        [clientB, receivedB],
      ] as const) {
        for (const event of ['cursor-moved', 'presence-updated', 'security-probe']) {
          client.io.on(event, (payload) => buffer.push({ event, payload }));
        }
      }

      const presenceByViewer: Array<{ boardId?: BoardID }> = [];
      const presenceByOwnerPeer: Array<{ boardId?: BoardID }> = [];
      const presenceByAdmin: Array<{ boardId?: BoardID }> = [];
      const presenceBySuperadmin: Array<{ boardId?: BoardID }> = [];
      const presenceByTenantB: Array<{ boardId?: BoardID }> = [];
      const cursorsByOwner: Array<{ boardId?: BoardID }> = [];
      clientA.io.on('presence-updated', (event) => presenceByViewer.push(event));
      ownerPeerClientA.io.on('presence-updated', (event) => presenceByOwnerPeer.push(event));
      adminClientA.io.on('presence-updated', (event) => presenceByAdmin.push(event));
      superadminClientA.io.on('presence-updated', (event) => presenceBySuperadmin.push(event));
      clientB.io.on('presence-updated', (event) => presenceByTenantB.push(event));
      ownerClientA.io.on('cursor-moved', (event) => cursorsByOwner.push(event));

      await expect(watchBoard(clientA, sharedA.board_id)).resolves.toEqual({ ok: true });
      await expect(watchBoard(ownerClientA, sharedA.board_id)).resolves.toEqual({ ok: true });
      await expect(watchBoard(clientB, sharedB.board_id)).resolves.toEqual({ ok: true });
      await expect(watchBoard(clientA, sharedB.board_id)).resolves.toEqual({ ok: false });
      await expect(watchBoard(clientA, privateA.board_id)).resolves.toEqual({ ok: false });
      await expect(watchBoard(clientA, generateId())).resolves.toEqual({ ok: false });

      const missingBoardId = generateId();
      for (const client of [clientA, adminClientA, superadminClientA]) {
        // Success is intentionally non-enumerating: private, missing, and
        // foreign IDs are silently omitted from the authorized room set.
        await expect(
          subscribeBoardAssociations(client, [
            sharedA.board_id,
            privateA.board_id,
            sharedB.board_id,
            missingBoardId,
          ])
        ).resolves.toEqual({ ok: true });
      }
      await expect(
        subscribeBoardAssociations(ownerClientA, [sharedA.board_id, privateA.board_id])
      ).resolves.toEqual({ ok: true });
      await expect(
        subscribeBoardAssociations(ownerPeerClientA, [sharedA.board_id, privateA.board_id])
      ).resolves.toEqual({ ok: true });
      await expect(subscribeBoardAssociations(clientB, [sharedB.board_id])).resolves.toEqual({
        ok: true,
      });

      ownerClientA.io.emit('presence:heartbeat', { boardId: sharedA.board_id });
      await delay();
      ownerClientA.io.emit('presence:heartbeat', { boardId: privateA.board_id });
      await delay();

      expect(presenceByViewer.some((event) => event.boardId === sharedA.board_id)).toBe(true);
      expect(presenceByOwnerPeer.some((event) => event.boardId === privateA.board_id)).toBe(true);
      for (const unauthorized of [
        presenceByViewer,
        presenceByAdmin,
        presenceBySuperadmin,
        presenceByTenantB,
      ]) {
        expect(unauthorized.some((event) => event.boardId === privateA.board_id)).toBe(false);
      }
      expect(presenceByTenantB).toEqual([]);

      const authorizedPrivateEvents = presenceByOwnerPeer.filter(
        (event) => event.boardId === privateA.board_id
      ).length;
      clientA.io.emit('presence:heartbeat', { boardId: privateA.board_id });
      await delay();
      expect(
        presenceByOwnerPeer.filter((event) => event.boardId === privateA.board_id)
      ).toHaveLength(authorizedPrivateEvents);

      const missingError = await clientA
        .service('boards')
        .get(generateId() as BoardID)
        .catch((error: Error & { code?: number }) => ({
          code: error.code,
          name: error.name,
          message: error.message,
        }));
      const foreignError = await clientA
        .service('boards')
        .get(sharedB.board_id)
        .catch((error: Error & { code?: number }) => ({
          code: error.code,
          name: error.name,
          message: error.message,
        }));
      expect(foreignError).toEqual(missingError);

      clientA.io.emit('cursor-move', {
        boardId: sharedA.board_id,
        x: 1,
        y: 2,
        timestamp: Date.now(),
      });
      clientA.io.emit('cursor-move', {
        boardId: sharedB.board_id,
        x: 3,
        y: 4,
        timestamp: Date.now(),
      });

      const foreignTerminalRoom = terminalChannelName(tenantB, viewerB.user_id, 'guessed-terminal');
      clientA.io.emit('join', foreignTerminalRoom);
      await delay();
      socketConfig.getSocketServer()?.to(foreignTerminalRoom).emit('security-probe', {
        tenant: tenantB,
      });
      await delay();

      // Assertions cover passive delivery buffers as well as acknowledgements:
      // tenant B receives neither A's authorized cursor nor A's forged cursor,
      // and A did not join B's guessed terminal channel.
      expect(receivedB).toEqual([]);
      expect(receivedA.filter(({ event }) => event !== 'presence-updated')).toEqual([]);
      expect(cursorsByOwner.filter((event) => event.boardId === sharedA.board_id)).toHaveLength(1);
      const serverSocketA = socketConfig.getSocketServer()?.sockets.sockets.get(clientA.io.id!);
      expect(serverSocketA?.rooms.has(foreignTerminalRoom)).toBe(false);

      // A tenant-scoped authorization change evicts only that tenant. The
      // client must reconnect with its signed token and re-authorize raw rooms.
      app.emit('realtime:authorization-invalidated', { tenantId: tenantA });
      await delay();
      expect(clientA.io.connected).toBe(false);
      expect(clientB.io.connected).toBe(true);

      clientA.io.connect();
      await waitForConnect(clientA);
      await expect(watchBoard(clientA, sharedA.board_id)).resolves.toEqual({ ok: true });
      await expect(watchBoard(clientA, sharedB.board_id)).resolves.toEqual({ ok: false });
    }, 30_000);
  }
);
