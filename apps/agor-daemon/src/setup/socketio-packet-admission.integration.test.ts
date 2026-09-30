/**
 * Real Socket.IO server coverage for per-packet tenant admission: arrival
 * order, which packets read restriction state, and restricted refusal.
 */

import type { Server as HttpServer } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import {
  AuthenticationService,
  Forbidden,
  feathers,
  feathersExpress,
  socketio,
  Unavailable,
} from '@agor/core/feathers';
import { TENANT_RESTRICTED_ERROR_CODE, type UserID } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeJWTStrategy } from '../auth/runtime-jwt-strategy.js';
import {
  issueRuntimeToken,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
} from '../auth/runtime-tokens.js';
import { configureChannels, createSocketIOConfig } from './socketio.js';

const JWT_SECRET = 'socket-packet-admission-test-secret';
const TENANT = 'packet-tenant';
const USER = '018f0000-0000-7000-8000-00000000aaaa' as UserID;
const multiTenancy = {
  mode: 'required_from_auth',
  static_tenant_id: 'unused' as never,
  auth_claim: 'tenant_id',
  trusted_header: 'x-agor-tenant-id',
} as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Socket.IO per-packet tenant admission', () => {
  let server: HttpServer | undefined;
  let client: AgorClient | undefined;

  afterEach(async () => {
    client?.io.close();
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve()))
      );
    }
    server = undefined;
    client = undefined;
  });

  async function start() {
    const arrivals: string[] = [];
    const closed = new Set<string>();
    const reads = { admission: 0, monitor: 0 };
    const database = { down: false };
    const app = feathersExpress(feathers());
    app.use('users', {
      async get(id: string) {
        return {
          user_id: id,
          email: 'packet@example.test',
          role: 'member',
          credential_generation: 0,
        };
      },
    });
    app.use('probe', {
      async create(data: { i: number }) {
        arrivals.push(`service:${data.i}`);
        return data;
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
      // Randomized read latency: an async gate that dispatches on read completion reorders packets.
      assertTenantAccess: async (tenantId) => {
        reads.admission++;
        await sleep(Math.floor(Math.random() * 12));
        if (database.down) throw new Unavailable('Tenant access cannot be verified');
        if (closed.has(tenantId)) {
          throw new Forbidden('Tenant access is restricted', {
            code: TENANT_RESTRICTED_ERROR_CODE,
          });
        }
      },
      readTenantRestriction: async (tenantId) => {
        reads.monitor++;
        if (database.down) throw new Error('unreadable');
        return { records: [], closed: closed.has(tenantId) };
      },
      corsOrigin: '*',
      credentialsAllowed: false,
      webTerminalEnabled: true,
      workIdentity: { instanceId: 'packet-test', bootId: 'packet-test-boot' },
      multiTenancy,
    });
    app.configure(
      socketio(socketConfig.serverOptions, (io) => {
        socketConfig.callback(io);
        io.on('connection', (socket) => {
          socket.on('test:raw', (i: number) => arrivals.push(`raw:${i}`));
        });
      })
    );
    configureChannels(app as never);
    server = await new Promise<HttpServer>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
    client = createClient(`http://127.0.0.1:${address.port}`, false, {
      reconnectionAttempts: 0,
      ackTimeout: 2_000,
    });
    client.io.auth = {
      token: issueRuntimeToken({ sub: USER, type: 'access', tenant_id: TENANT }, JWT_SECRET, '5m'),
    };
    const connected = new Promise<void>((resolve, reject) => {
      client?.io.once('connect', () => resolve());
      client?.io.once('connect_error', reject);
    });
    client.io.connect();
    await connected;
    return { arrivals, closed, reads, database, wire: client.io };
  }

  it('dispatches service-call and raw packets in send order; raw packets never read', async () => {
    const { arrivals, reads, wire } = await start();
    reads.admission = 0;
    const expected: string[] = [];
    const acks: Promise<unknown>[] = [];
    for (let i = 0; i < 60; i++) {
      if (i % 3 === 0) {
        expected.push(`service:${i}`);
        acks.push(wire.timeout(2_000).emitWithAck('create', 'probe', { i }));
      } else {
        expected.push(`raw:${i}`);
        wire.emit('test:raw', i);
      }
    }
    await Promise.all(acks);
    await expect.poll(() => arrivals.length).toBe(expected.length);
    expect(arrivals).toEqual(expected);
    expect(reads.admission).toBe(20);

    // Terminal and presence traffic do no restriction read at all.
    for (let i = 0; i < 20; i++) {
      wire.emit('terminal:input', { userId: USER, terminalId: 'none', input: 'x' });
      wire.emit('presence:heartbeat', {});
    }
    wire.emit('test:raw', 'last');
    await expect.poll(() => arrivals.at(-1)).toBe('raw:last');
    expect(reads.admission).toBe(20);
  });

  it('refuses a restricted tenant service call and retires its raw traffic within a monitor tick', async () => {
    const { arrivals, closed, wire } = await start();
    closed.add(TENANT);
    await expect(
      wire.timeout(2_000).emitWithAck('create', 'probe', { i: 1 })
    ).resolves.toMatchObject({ name: 'Forbidden' });
    expect(arrivals).toEqual([]);
    const restrictedAt = Date.now();
    await expect.poll(() => wire.connected, { timeout: 2_500, interval: 50 }).toBe(false);
    expect(Date.now() - restrictedAt).toBeLessThan(2_000);
  });

  it("gates an unreadable tenant's raw traffic without disconnecting it until a read succeeds", async () => {
    const { arrivals, database, reads, wire } = await start();
    const disconnects: string[] = [];
    wire.on('disconnect', (reason) => disconnects.push(reason));
    let probe = 0;
    const delivered = async () => {
      const label = probe++;
      wire.emit('test:raw', label);
      await sleep(300);
      return arrivals.includes(`raw:${label}`);
    };
    expect(await delivered()).toBe(true);
    database.down = true;
    // Ten failed monitor ticks mark the tenant; its raw packets then need an admission read.
    await expect.poll(delivered, { timeout: 25_000, interval: 0 }).toBe(false);
    expect(await delivered()).toBe(false);
    // A burst of raw packets shares the read already in flight instead of one read each.
    const before = reads.admission;
    for (let i = 0; i < 20; i++) wire.emit('test:raw', `burst:${i}`);
    await sleep(300);
    expect(reads.admission - before).toBeGreaterThan(0);
    expect(reads.admission - before).toBeLessThan(20);
    database.down = false;
    await expect.poll(delivered, { timeout: 5_000, interval: 0 }).toBe(true);
    expect(wire.connected).toBe(true);
    expect(disconnects).toEqual([]);
  }, 40_000);
});
