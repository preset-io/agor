/**
 * Executor streaming relays over a real Socket.IO server: per-chunk packets share one
 * per-tenant restriction read per tick, while other executor RPCs still read per call.
 */

import type { Server as HttpServer } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import { runWithTenantContext, type TenantRestrictionState } from '@agor/core/db';
import { AuthenticationService, feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { type HookContext, ROLES } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOrCreateExecutorConnectionRevocationFence } from '../auth/executor-connection-admission.js';
import { createTenantRestrictedAuthHook } from '../auth/require-auth.js';
import { RuntimeJWTStrategy } from '../auth/runtime-jwt-strategy.js';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';
import {
  assertRuntimeTenantAccess,
  assertRuntimeTenantRequestAccess,
  readRequestTenantRestriction,
  TENANT_RESTRICTION_OBSERVATION_MS,
} from '../auth/tenant-access.js';
import { SessionTokenService } from '../services/session-token-service.js';
import { configureChannels, createSocketIOConfig } from './socketio.js';

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@agor/core/db', async (original) => ({
  ...(await original<typeof import('@agor/core/db')>()),
  readTenantRestrictionState: read,
  isPostgresDatabaseHandle: () => true,
}));

const JWT_SECRET = 'streaming-relay-admission-secret';
const TENANT = 'relay-tenant';
const USER_ID = '018f0000-0000-7000-8000-0000000000b1';
const SESSION_ID = '018f0000-0000-7000-8000-0000000000b2';
const TASK_ID = '018f0000-0000-7000-8000-0000000000b3';
const MULTI_TENANCY = {
  mode: 'required_from_auth',
  static_tenant_id: 'unused' as never,
  auth_claim: 'tenant_id',
} as const;
const db = {} as never;

describe('executor streaming relay admission', () => {
  let server: HttpServer | undefined;
  let client: AgorClient | undefined;
  let sessionTokens: SessionTokenService | undefined;

  afterEach(async () => {
    client?.io.close();
    sessionTokens?.close();
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    client = undefined;
    read.mockReset();
  });

  it('shares one read per tenant per tick across chunks, reads per call elsewhere, and refuses a closed tenant', async () => {
    const tenant = { closed: false };
    read.mockImplementation(
      async (): Promise<TenantRestrictionState> => ({ records: [], closed: tenant.closed })
    );
    const relayed: number[] = [];
    const written: number[] = [];
    const app = feathersExpress(feathers());
    app.use('users', {
      async get(id: string) {
        return { user_id: id, email: 'relay@example.test', role: ROLES.MEMBER };
      },
    });
    app.use('messages/streaming', {
      async create(data: { i: number }) {
        relayed.push(data.i);
        return { success: true };
      },
    });
    app.use('messages', {
      async create(data: { i: number }) {
        written.push(data.i);
        return data;
      },
    });
    // Production-shaped hook: it reuses the packet's read scope, as requireAuth does.
    const admission = createTenantRestrictedAuthHook(
      async (context) => context,
      MULTI_TENANCY,
      (tenantId, context) => assertRuntimeTenantRequestAccess(db, tenantId, context)
    );
    for (const path of ['messages/streaming', 'messages']) {
      app.service(path).hooks({ before: { create: [admission as (c: HookContext) => never] } });
    }
    sessionTokens = new SessionTokenService(
      { expiration_ms: 60_000, max_uses: -1 },
      {
        startCleanupTimer: false,
        authorityStore: {
          async issue() {},
          async validateAndConsume(input) {
            return {
              session_id: input.sessionId,
              ...(input.taskId ? { task_id: input.taskId } : {}),
              user_id: input.userId,
            };
          },
          async isCurrent() {
            return true;
          },
          async revoke() {
            return true;
          },
          async revokeByTask() {
            return [];
          },
          async purgeRetained() {
            return 0;
          },
        },
      }
    );
    sessionTokens.setJwtSecret(JWT_SECRET);
    const token = await runWithTenantContext(TENANT, () =>
      sessionTokens!.generateToken(SESSION_ID, USER_ID, { taskId: TASK_ID })
    );
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
    authentication.register(
      'jwt',
      new RuntimeJWTStrategy({
        sessionTokenService: sessionTokens,
        executorRevocationFence: getOrCreateExecutorConnectionRevocationFence(app),
        multiTenancy: MULTI_TENANCY,
      })
    );
    app.use('authentication', authentication);
    const socketConfig = createSocketIOConfig(app as never, {
      assertTenantAccess: (tenantId, payload) =>
        assertRuntimeTenantAccess(db, tenantId, { payload }, readRequestTenantRestriction),
      readTenantRestriction: (tenantId) => read(db, tenantId),
      corsOrigin: '*',
      credentialsAllowed: false,
      multiTenancy: MULTI_TENANCY,
    });
    app.configure(socketio(socketConfig.serverOptions, socketConfig.callback));
    configureChannels(app as never);
    server = await new Promise<HttpServer>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
    client = createClient(`http://127.0.0.1:${address.port}`, false, {
      reconnectionAttempts: 0,
      ackTimeout: 2_000,
      socketAuthentication: { accessToken: token },
    });
    const wire = client.io;
    await new Promise<void>((resolve, reject) => {
      wire.once('connect', () => resolve());
      wire.once('connect_error', reject);
      wire.connect();
    });

    read.mockClear();
    const startedAt = performance.now();
    const chunks = Array.from({ length: 40 }, (_, i) =>
      wire.timeout(2_000).emitWithAck('create', 'messages/streaming', { i })
    );
    const acks = await Promise.all(chunks);
    const ticks = Math.ceil((performance.now() - startedAt) / TENANT_RESTRICTION_OBSERVATION_MS);
    // The ack resolves with its error slot: null means each chunk was admitted.
    expect(acks.every((error) => error === null)).toBe(true);
    expect(relayed).toHaveLength(40);
    // One shared read per tick; a hook landing just past the shared read's tick reads once more.
    expect(read.mock.calls.length).toBeLessThanOrEqual(2 * ticks);
    expect(read.mock.calls.every(([, tenantId]) => tenantId === TENANT)).toBe(true);

    // A writing executor RPC still admits against its own read, once per call.
    read.mockClear();
    for (let i = 0; i < 3; i++) await wire.timeout(2_000).emitWithAck('create', 'messages', { i });
    expect(written).toEqual([0, 1, 2]);
    expect(read).toHaveBeenCalledTimes(3);

    // Once the shared tick lapses, a closed tenant's chunks are refused and never relayed.
    tenant.closed = true;
    await new Promise((resolve) => setTimeout(resolve, TENANT_RESTRICTION_OBSERVATION_MS + 50));
    const refused = await wire
      .timeout(2_000)
      .emitWithAck('create', 'messages/streaming', { i: 99 });
    expect(refused).toMatchObject({ name: 'Forbidden' });
    expect(relayed).not.toContain(99);
  }, 20_000);
});
