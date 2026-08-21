import type { Server as HttpServer } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import { runWithTenantContext } from '@agor/core/db';
import { AuthenticationService, feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { ROLES } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getExecutorConnectionCapability,
  getOrCreateExecutorConnectionRevocationFence,
} from '../auth/executor-connection-capability.js';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';
import { ServiceJWTStrategy } from '../auth/service-jwt-strategy.js';
import {
  type SessionTokenAuthorityStore,
  SessionTokenService,
} from '../services/session-token-service.js';
import { executorTaskChannelName } from '../utils/realtime-publish.js';
import { configureChannels, createSocketIOConfig, getSocketAuthState } from './socketio.js';

const JWT_SECRET = 'executor-capability-integration-secret';
const TENANT_ID = 'executor-capability-tenant';
const USER_ID = '018f0000-0000-7000-8000-0000000000a1';
const SESSION_ID = '018f0000-0000-7000-8000-0000000000a2';
const TASK_ID = '018f0000-0000-7000-8000-0000000000a3';
const BRANCH_ID = '018f0000-0000-7000-8000-0000000000a4';

function waitForConnect(client: AgorClient): Promise<void> {
  if (client.io.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket.IO client did not connect')), 3_000);
    client.io.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    client.io.once('connect_error', reject);
  });
}

function waitForDisconnect(client: AgorClient): Promise<void> {
  if (!client.io.connected) return Promise.resolve();
  return new Promise((resolve) => client.io.once('disconnect', () => resolve()));
}

interface Harness {
  app: ReturnType<typeof feathersExpress>;
  client: AgorClient;
  server: HttpServer;
  sessionTokens: SessionTokenService;
  socketConfig: ReturnType<typeof createSocketIOConfig>;
  token: string;
}

async function startHarness(
  options: { pauseValidation?: boolean } = {}
): Promise<Harness & { validationStarted?: Promise<void>; releaseValidation?: () => void }> {
  const app = feathersExpress(feathers());
  let markValidationStarted!: () => void;
  let releaseValidation!: () => void;
  const validationStarted = options.pauseValidation
    ? new Promise<void>((resolve) => {
        markValidationStarted = resolve;
      })
    : undefined;
  const validationGate = options.pauseValidation
    ? new Promise<void>((resolve) => {
        releaseValidation = resolve;
      })
    : undefined;
  let revoked = false;
  const authorityStore: SessionTokenAuthorityStore = {
    async issue() {},
    async validateAndConsume(input) {
      if (validationGate) {
        markValidationStarted();
        await validationGate;
      }
      // Returning the already-observed success after the gate deliberately
      // models a database validation that completed just before revocation.
      if (revoked && !validationGate) return null;
      return {
        session_id: input.sessionId,
        ...(input.taskId ? { task_id: input.taskId } : {}),
        ...(input.branchId ? { branch_id: input.branchId } : {}),
        user_id: input.userId,
      };
    },
    async revoke() {
      revoked = true;
      return true;
    },
    async revokeSession() {
      revoked = true;
      return 1;
    },
    async purgeRetained() {
      return 0;
    },
  };
  const sessionTokens = new SessionTokenService(
    { expiration_ms: 60_000, max_uses: -1 },
    {
      authorityStore,
      startCleanupTimer: false,
      onRevoked: (revocation) => app.emit('realtime:executor-token-invalidated', revocation),
    }
  );
  sessionTokens.setJwtSecret(JWT_SECRET);
  const token = await runWithTenantContext(TENANT_ID, () =>
    sessionTokens.generateToken(SESSION_ID, USER_ID, {
      taskId: TASK_ID,
      branchId: BRANCH_ID,
    })
  );

  app.set('authentication', {
    secret: JWT_SECRET,
    entity: 'user',
    entityId: 'user_id',
    service: 'users',
    authStrategies: ['jwt'],
    jwtOptions: {
      header: { typ: 'access' },
      audience: RUNTIME_JWT_AUDIENCE,
      issuer: RUNTIME_JWT_ISSUER,
      algorithm: 'HS256',
      expiresIn: '1m',
    },
  });
  app.use('users', {
    async get(id: string) {
      return { user_id: id, email: 'executor-owner@example.test', role: ROLES.MEMBER };
    },
  });
  const authentication = new AuthenticationService(app);
  authentication.register(
    'jwt',
    new ServiceJWTStrategy(
      sessionTokens,
      'tenant_id',
      getOrCreateExecutorConnectionRevocationFence(app)
    )
  );
  app.use('authentication', authentication);

  const socketConfig = createSocketIOConfig(app as never, {
    corsOrigin: '*',
    jwtSecret: JWT_SECRET,
    credentialsAllowed: false,
    multiTenancy: {
      mode: 'required_from_auth',
      static_tenant_id: 'unused' as never,
      auth_claim: 'tenant_id',
    },
  });
  app.configure(socketio(socketConfig.serverOptions, socketConfig.callback));
  configureChannels(app as never, {
    multiTenancy: {
      mode: 'required_from_auth',
      static_tenant_id: 'unused' as never,
      auth_claim: 'tenant_id',
    },
  });

  const server = await new Promise<HttpServer>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
  const authStorage = new Map<string, string>();
  const client = createClient(`http://127.0.0.1:${address.port}`, false, {
    reconnectionAttempts: 0,
    ackTimeout: 2_000,
    authStorage: {
      getItem: (key) => authStorage.get(key) ?? null,
      setItem: (key, value) => authStorage.set(key, value),
      removeItem: (key) => authStorage.delete(key),
    },
  });
  client.io.connect();
  await waitForConnect(client);

  return {
    app,
    client,
    server,
    sessionTokens,
    socketConfig,
    token,
    ...(validationStarted ? { validationStarted, releaseValidation } : {}),
  };
}

describe('executor Socket.IO connection capability', () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const harness of harnesses) {
      harness.client.io.close();
      harness.sessionTokens.close();
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    }
    harnesses.length = 0;
  });

  it('survives Feathers connection-state replacement and exact revocation', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    await harness.client.authenticate({ strategy: 'jwt', accessToken: harness.token });

    const serverSocket = harness.socketConfig
      .getSocketServer()
      ?.sockets.sockets.get(harness.client.io.id!);
    expect(serverSocket).toBeDefined();
    const connection = (serverSocket as unknown as { feathers?: Record<string, unknown> }).feathers;
    expect(connection?.authentication).not.toHaveProperty('payload');
    expect(getSocketAuthState(serverSocket!)).toMatchObject({
      userId: null,
      isService: false,
      isTaskExecutor: true,
      tenant: { tenant_id: TENANT_ID },
    });
    expect(getExecutorConnectionCapability(connection)).toMatchObject({
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      branchId: BRANCH_ID,
      tenant: { tenant_id: TENANT_ID },
    });
    expect(harness.app.channels).toContain(executorTaskChannelName(TENANT_ID, TASK_ID));

    const disconnected = waitForDisconnect(harness.client);
    await runWithTenantContext(TENANT_ID, () => harness.sessionTokens.revokeToken(harness.token));
    await disconnected;
    expect(getExecutorConnectionCapability(connection)).toBeUndefined();
  });

  it('rejects login when revocation lands after authority validation starts', async () => {
    const harness = await startHarness({ pauseValidation: true });
    harnesses.push(harness);
    const serverSocket = harness.socketConfig
      .getSocketServer()
      ?.sockets.sockets.get(harness.client.io.id!);
    const connection = (serverSocket as unknown as { feathers?: Record<string, unknown> }).feathers;

    const authentication = harness.client
      .authenticate({ strategy: 'jwt', accessToken: harness.token })
      .catch(() => undefined);
    await harness.validationStarted;
    await runWithTenantContext(TENANT_ID, () => harness.sessionTokens.revokeToken(harness.token));
    expect(harness.client.io.connected).toBe(true);

    const disconnected = waitForDisconnect(harness.client);
    harness.releaseValidation?.();
    await Promise.all([authentication, disconnected]);
    expect(getExecutorConnectionCapability(connection)).toBeUndefined();
    expect(harness.app.channels).not.toContain(executorTaskChannelName(TENANT_ID, TASK_ID));
  });
});
