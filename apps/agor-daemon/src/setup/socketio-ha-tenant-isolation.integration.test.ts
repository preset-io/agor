/**
 * Real two-replica Socket.IO/Redis tenant-isolation coverage.
 *
 * Run with AGOR_TEST_REDIS_URL pointed at a disposable Redis instance. Local
 * unit runs may omit Redis and skip this suite; required PR CI provisions one
 * and runs this file explicitly so the real adapter path remains gated.
 */

import type { Server as HttpServer } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import { AuthenticationService, feathers, feathersExpress, socketio } from '@agor/core/feathers';
import {
  type AuthenticationUser,
  type Board,
  type BoardID,
  PRESENCE_SOCKET_EVENTS,
  type TenantContext,
  type User,
  type UserID,
} from '@agor/core/types';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeJWTStrategy } from '../auth/runtime-jwt-strategy.js';
import {
  issueRuntimeToken,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
} from '../auth/runtime-tokens.js';
import {
  bindRealtimeAccessCacheInvalidation,
  RealtimeAccessCache,
} from '../utils/realtime-access-cache.js';
import { configureChannels, createSocketIOConfig, type SocketIOOptions } from './socketio.js';

const redisUrl = process.env.AGOR_TEST_REDIS_URL;
const JWT_SECRET = 'disposable-redis-socket-tenant-test-secret';
const TENANT_A = 'redis-socket-tenant-a';
const TENANT_B = 'redis-socket-tenant-b';
const USER_A = '018f0000-0000-7000-8000-0000000000a1' as UserID;
const USER_B = '018f0000-0000-7000-8000-0000000000b1' as UserID;
const BOARD_A = '018f0000-0000-7000-8000-0000000000a2' as BoardID;
const BOARD_B = '018f0000-0000-7000-8000-0000000000b2' as BoardID;

interface TestParams {
  tenant?: TenantContext;
  user?: User & { tenant_id?: string };
  query?: { board_id?: { $in?: BoardID[] } };
}

interface Replica {
  app: ReturnType<typeof feathersExpress>;
  server: HttpServer;
  url: string;
  redis: [Redis, Redis];
  accessCache: RealtimeAccessCache;
}

function tenantFrom(params?: TestParams): string | undefined {
  return params?.tenant?.tenant_id ?? params?.user?.tenant_id;
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

function watchBoard(client: AgorClient, boardId: BoardID): Promise<{ ok: boolean }> {
  return client.io.timeout(2_000).emitWithAck(PRESENCE_SOCKET_EVENTS.watchBoardCursors, boardId);
}

function subscribeBoardAssociations(
  client: AgorClient,
  boardIds: BoardID[]
): Promise<{ ok: boolean }> {
  return client.io
    .timeout(2_000)
    .emitWithAck(PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations, { boardIds });
}

function delay(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startReplica(adapterKey: string, instanceId: string): Promise<Replica> {
  const pub = new Redis(redisUrl!, { lazyConnect: true });
  const sub = new Redis(redisUrl!, { lazyConnect: true });
  await Promise.all([pub.connect(), sub.connect()]);
  const app = feathersExpress(feathers());
  const accessCache = new RealtimeAccessCache({
    branchRepository: {
      async findRealtimeVisibilityBranch(branchId) {
        return branchId === 'branch-a'
          ? { branch_id: 'branch-a' as never, others_can: 'none' }
          : null;
      },
      async findRealtimeViewUserIds() {
        return replicaVisibilityUsers;
      },
    },
    sessionsRepository: {
      async findBranchIdBySessionId() {
        return null;
      },
      async findCreatedByBySessionId() {
        return null;
      },
    },
  });
  bindRealtimeAccessCacheInvalidation(app, accessCache);
  app.use('users', {
    async get(id: UserID, params?: TestParams): Promise<AuthenticationUser> {
      const tenantId = tenantFrom(params);
      if (id === USER_A && tenantId === TENANT_A) {
        return {
          user_id: USER_A,
          email: 'a@example.test',
          role: 'member',
          credential_generation: 0,
        } as AuthenticationUser;
      }
      if (id === USER_B && tenantId === TENANT_B) {
        return {
          user_id: USER_B,
          email: 'b@example.test',
          role: 'member',
          credential_generation: 0,
        } as AuthenticationUser;
      }
      throw new Error('User unavailable');
    },
  });
  app.use('boards', {
    async get(id: BoardID, params?: TestParams) {
      const tenantId = tenantFrom(params);
      if (id === BOARD_A && tenantId === TENANT_A) {
        const visibility = await accessCache.getBranchVisibility('branch-a');
        if (
          visibility?.mode === 'explicitUsers' &&
          params?.user?.user_id &&
          visibility.userIds.has(params.user.user_id)
        ) {
          return { board_id: id };
        }
      }
      if (id === BOARD_B && tenantId === TENANT_B) return { board_id: id };
      throw new Error('Board unavailable');
    },
    async find(params?: TestParams) {
      const requested = params?.query?.board_id?.$in ?? [];
      const tenantId = tenantFrom(params);
      const userId = params?.user?.user_id;
      const visible: Board[] = [];
      for (const boardId of requested) {
        if (boardId === BOARD_A && tenantId === TENANT_A && userId) {
          const visibility = await accessCache.getBranchVisibility('branch-a');
          if (visibility?.mode === 'explicitUsers' && visibility.userIds.has(userId)) {
            visible.push({ board_id: boardId } as Board);
          }
        } else if (boardId === BOARD_B && tenantId === TENANT_B) {
          visible.push({ board_id: boardId } as Board);
        }
      }
      return visible;
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

  const options: SocketIOOptions = {
    corsOrigin: '*',
    credentialsAllowed: false,
    adapter: createAdapter(pub, sub, { key: adapterKey }),
    workIdentity: { instanceId, bootId: `${instanceId}-boot` },
    multiTenancy,
  };
  const config = createSocketIOConfig(app as never, options);
  app.configure(socketio(config.serverOptions, config.callback));
  configureChannels(app as never);
  const server = await new Promise<HttpServer>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
  return {
    app,
    server,
    url: `http://127.0.0.1:${address.port}`,
    redis: [pub, sub],
    accessCache,
  };
}

let replicaVisibilityUsers: UserID[] = [USER_A];

describe.skipIf(!redisUrl)('Socket.IO tenant isolation (two replicas/Redis)', () => {
  const replicas: Replica[] = [];
  const clients: AgorClient[] = [];

  afterEach(async () => {
    for (const client of clients) client.io.close();
    clients.length = 0;
    for (const replica of replicas) {
      await new Promise<void>((resolve) => replica.server.close(() => resolve()));
      await Promise.all(replica.redis.map((client) => client.quit().catch(() => undefined)));
    }
    replicas.length = 0;
    replicaVisibilityUsers = [USER_A];
  });

  it('clears a remote replica cache for additive grants without disconnecting sockets', async () => {
    const adapterKey = `agor-socket-cache-refresh-${Date.now()}-${Math.random()}`;
    replicaVisibilityUsers = [];
    const [replicaA, replicaB] = await Promise.all([
      startReplica(adapterKey, 'replica-a'),
      startReplica(adapterKey, 'replica-b'),
    ]);
    replicas.push(replicaA, replicaB);

    const tokenA = issueRuntimeToken(
      { sub: USER_A, type: 'access', tenant_id: TENANT_A },
      JWT_SECRET,
      '5m'
    );
    const senderA = createClient(replicaA.url, false, { reconnectionAttempts: 0 });
    const peerA = createClient(replicaB.url, false, { reconnectionAttempts: 0 });
    clients.push(senderA, peerA);
    senderA.io.auth = { token: tokenA };
    peerA.io.auth = { token: tokenA };
    for (const client of clients) client.io.connect();
    await Promise.all(clients.map(waitForConnect));

    await expect(replicaB.accessCache.getBranchVisibility('branch-a')).resolves.toEqual({
      mode: 'explicitUsers',
      userIds: new Set(),
    });
    await expect(watchBoard(peerA, BOARD_A)).resolves.toEqual({ ok: false });

    replicaVisibilityUsers = [USER_A];
    replicaA.app.emit('realtime:authorization-invalidated', {
      tenantId: TENANT_A,
      disconnectSockets: false,
    });
    await delay(200);

    expect(senderA.io.connected).toBe(true);
    expect(peerA.io.connected).toBe(true);
    await expect(replicaB.accessCache.getBranchVisibility('branch-a')).resolves.toEqual({
      mode: 'explicitUsers',
      userIds: new Set([USER_A]),
    });
    await expect(watchBoard(peerA, BOARD_A)).resolves.toEqual({ ok: true });
  });

  it('delivers an authorized event across replicas once and evicts stale tenant rooms on every replica', async () => {
    const adapterKey = `agor-socket-isolation-${Date.now()}-${Math.random()}`;
    const [replicaA, replicaB] = await Promise.all([
      startReplica(adapterKey, 'replica-a'),
      startReplica(adapterKey, 'replica-b'),
    ]);
    replicas.push(replicaA, replicaB);

    const tokenA = issueRuntimeToken(
      { sub: USER_A, type: 'access', tenant_id: TENANT_A },
      JWT_SECRET,
      '5m'
    );
    const tokenB = issueRuntimeToken(
      { sub: USER_B, type: 'access', tenant_id: TENANT_B },
      JWT_SECRET,
      '5m'
    );
    const senderA = createClient(replicaA.url, false, { reconnectionAttempts: 0 });
    const peerA = createClient(replicaB.url, false, { reconnectionAttempts: 0 });
    const observerB = createClient(replicaB.url, false, { reconnectionAttempts: 0 });
    clients.push(senderA, peerA, observerB);
    senderA.io.auth = { token: tokenA };
    peerA.io.auth = { token: tokenA };
    observerB.io.auth = { token: tokenB };
    for (const client of clients) client.io.connect();
    await Promise.all(clients.map(waitForConnect));

    await expect(watchBoard(senderA, BOARD_A)).resolves.toEqual({ ok: true });
    await expect(watchBoard(peerA, BOARD_A)).resolves.toEqual({ ok: true });
    await expect(watchBoard(observerB, BOARD_B)).resolves.toEqual({ ok: true });
    await expect(watchBoard(senderA, BOARD_B)).resolves.toEqual({ ok: false });
    await expect(subscribeBoardAssociations(peerA, [BOARD_A])).resolves.toEqual({ ok: true });
    await expect(subscribeBoardAssociations(observerB, [BOARD_B])).resolves.toEqual({ ok: true });

    const peerEvents: unknown[] = [];
    const foreignEvents: unknown[] = [];
    const peerPresence: Array<{ boardId?: BoardID }> = [];
    const foreignPresence: Array<{ boardId?: BoardID }> = [];
    peerA.io.on(PRESENCE_SOCKET_EVENTS.cursorMoved, (event) => peerEvents.push(event));
    observerB.io.on(PRESENCE_SOCKET_EVENTS.cursorMoved, (event) => foreignEvents.push(event));
    peerA.io.on(PRESENCE_SOCKET_EVENTS.updated, (event) => peerPresence.push(event));
    observerB.io.on(PRESENCE_SOCKET_EVENTS.updated, (event) => foreignPresence.push(event));
    senderA.io.emit(PRESENCE_SOCKET_EVENTS.cursorMove, {
      boardId: BOARD_A,
      x: 10,
      y: 20,
    });
    await delay(200);

    expect(peerEvents).toHaveLength(1);
    expect(foreignEvents).toEqual([]);
    // Cursor/get authorization is independent from navbar/find authorization:
    // an old cursor-only client refreshes tenant liveness but publishes no board.
    expect(peerPresence.filter((event) => event.boardId === BOARD_A)).toHaveLength(0);
    expect(peerPresence.some((event) => event.boardId === undefined)).toBe(true);
    expect(foreignPresence).toEqual([]);

    await expect(subscribeBoardAssociations(senderA, [BOARD_A])).resolves.toEqual({ ok: true });
    senderA.io.emit(PRESENCE_SOCKET_EVENTS.heartbeat, { boardId: BOARD_A });
    await delay(120);
    expect(peerPresence.filter((event) => event.boardId === BOARD_A)).toHaveLength(1);

    // Warm replica B's five-minute ACL cache before revocation. The shared
    // backing state then changes as though replica A committed an ACL delete.
    await expect(replicaB.accessCache.getBranchVisibility('branch-a')).resolves.toEqual({
      mode: 'explicitUsers',
      userIds: new Set([USER_A]),
    });
    replicaVisibilityUsers = [];

    replicaA.app.emit('realtime:authorization-invalidated', { tenantId: TENANT_A });
    await delay(200);
    expect(senderA.io.connected).toBe(false);
    expect(peerA.io.connected).toBe(false);
    expect(observerB.io.connected).toBe(true);
    // The Redis receiver clears authorization state before socket eviction, so
    // an immediate reconnect to replica B cannot reuse the warmed grant.
    await expect(replicaB.accessCache.getBranchVisibility('branch-a')).resolves.toEqual({
      mode: 'explicitUsers',
      userIds: new Set(),
    });
    peerA.io.connect();
    await waitForConnect(peerA);
    await expect(watchBoard(peerA, BOARD_A)).resolves.toEqual({ ok: false });
    // Subscription acknowledgement is deliberately non-enumerating, but the
    // revoked board is omitted and a forged heartbeat cannot publish it.
    await expect(subscribeBoardAssociations(peerA, [BOARD_A])).resolves.toEqual({ ok: true });
    peerA.io.emit(PRESENCE_SOCKET_EVENTS.cursorMove, {
      boardId: BOARD_A,
      x: 30,
      y: 40,
    });
    await delay(120);
    expect(foreignEvents).toEqual([]);
  });
});
