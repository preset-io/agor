import type { Server as HttpServer } from 'node:http';
import { type AgorClient, createClient } from '@agor/core/api';
import { getCurrentTenantId, runWithTenantContext } from '@agor/core/db';
import { AuthenticationService, feathers, feathersExpress, socketio } from '@agor/core/feathers';
import { type Params, ROLES } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it } from 'vitest';
import { getAuthenticatedConnectionAuthority } from '../auth/authenticated-connection-authority.js';
import { getOrCreateExecutorConnectionRevocationFence } from '../auth/executor-connection-admission.js';
import { authenticatedTaskExecutorRuntimeAuthority } from '../auth/executor-runtime-scope.js';
import { RuntimeJWTStrategy } from '../auth/runtime-jwt-strategy.js';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';
import {
  type SessionTokenAuthorityStore,
  SessionTokenService,
} from '../services/session-token-service.js';
import { executorTaskChannelName } from '../utils/realtime-publish.js';
import { createTenantDatabaseScopeAroundHook } from '../utils/tenant-db-scope.js';
import { configureChannels, createSocketIOConfig, getSocketAuthState } from './socketio.js';

const JWT_SECRET = 'executor-capability-integration-secret';
const TENANT_ID = 'executor-capability-tenant';
const REPLACEMENT_TENANT_ID = 'replacement-user-tenant';
const USER_ID = '018f0000-0000-7000-8000-0000000000a1';
const SESSION_ID = '018f0000-0000-7000-8000-0000000000a2';
const TASK_ID = '018f0000-0000-7000-8000-0000000000a3';
const BRANCH_ID = '018f0000-0000-7000-8000-0000000000a4';
const MULTI_TENANCY = {
  mode: 'required_from_auth',
  static_tenant_id: 'unused' as never,
  auth_claim: 'tenant_id',
} as const;

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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Socket.IO event');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  app: ReturnType<typeof feathersExpress>;
  client: AgorClient;
  server: HttpServer;
  sessionTokens: SessionTokenService;
  socketConfig: ReturnType<typeof createSocketIOConfig>;
  token: string;
  userToken: string;
  url: string;
  invalidateUserTokens(): void;
}

function executorRoomConnections(harness: Harness): unknown[] {
  return harness.app.channel(executorTaskChannelName(TENANT_ID, TASK_ID)).connections;
}

function emitControlEventToExecutorRoom(
  harness: Harness,
  path: 'tasks' | 'messages',
  event: 'termination_requested' | 'permission_resolved',
  data: unknown
): void {
  for (const connection of executorRoomConnections(harness)) {
    const socket = [
      ...(harness.socketConfig.getSocketServer()?.sockets.sockets.values() ?? []),
    ].find((candidate) => (candidate as unknown as { feathers?: unknown }).feathers === connection);
    socket?.emit(`${path} ${event}`, data);
  }
}

async function startHarness(
  options: {
    pauseValidation?: boolean;
    pauseAdmission?: boolean;
    reconnectionAttempts?: number;
    sessionTokenExpirationMs?: number;
  } = {}
): Promise<
  Harness & {
    validationStarted?: Promise<void>;
    releaseValidation?: () => void;
    admissionStarted?: Promise<void>;
    releaseAdmission?: () => void;
  }
> {
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
  let markAdmissionStarted!: () => void;
  let releaseAdmission!: () => void;
  const admissionStarted = options.pauseAdmission
    ? new Promise<void>((resolve) => {
        markAdmissionStarted = resolve;
      })
    : undefined;
  const admissionGate = options.pauseAdmission
    ? new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      })
    : undefined;
  let revoked = false;
  let issuedFingerprint: string | undefined;
  let userTokensValidAfter: Date | undefined;
  const authorityStore: SessionTokenAuthorityStore = {
    async issue(input) {
      issuedFingerprint = input.tokenFingerprint;
    },
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
    async isCurrent() {
      return !revoked;
    },
    async revoke() {
      revoked = true;
      return true;
    },
    async revokeByTask() {
      revoked = true;
      return issuedFingerprint ? [issuedFingerprint] : [];
    },
    async purgeRetained() {
      return 0;
    },
  };
  const sessionTokens = new SessionTokenService(
    { expiration_ms: options.sessionTokenExpirationMs ?? 60_000, max_uses: -1 },
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
      return {
        user_id: id,
        email: 'executor-owner@example.test',
        role: ROLES.MEMBER,
        credential_generation: 0,
        ...(userTokensValidAfter ? { tokens_valid_after: userTokensValidAfter } : {}),
      };
    },
  });
  app.use(
    'tasks',
    {
      async get(id: string, params: { user?: { user_id?: string } }) {
        return {
          task_id: id,
          tenant_id: getCurrentTenantId(),
          user_id: params.user?.user_id,
        };
      },
      async connectExecutor(data: { task_id: string }, params: { user?: { user_id?: string } }) {
        return {
          task_id: data.task_id,
          tenant_id: getCurrentTenantId(),
          user_id: params.user?.user_id,
        };
      },
      async finish(data: { task_id: string; status?: 'completed' | 'failed' }) {
        await sessionTokens.revokeTaskTokens(data.task_id);
        return { accepted: true, task_id: data.task_id, status: data.status ?? 'completed' };
      },
    },
    { events: ['termination_requested'], methods: ['get', 'connectExecutor', 'finish'] }
  );
  app.service('tasks').hooks({
    around: {
      all: [
        createTenantDatabaseScopeAroundHook({
          config: { multi_tenancy: MULTI_TENANCY },
          db: {} as never,
          transaction: false,
        }),
      ],
    },
  });
  app.use(
    'messages',
    {
      async get(id: string) {
        return { message_id: id };
      },
    },
    { events: ['permission_resolved'] }
  );
  const authentication = new AuthenticationService(app);
  authentication.register(
    'jwt',
    new RuntimeJWTStrategy({
      sessionTokenService: sessionTokens,
      executorRevocationFence: getOrCreateExecutorConnectionRevocationFence(app),
      multiTenancy: MULTI_TENANCY,
    })
  );
  if (admissionGate) {
    const originalHandleConnection = authentication.handleConnection.bind(authentication);
    authentication.handleConnection = async (...args) => {
      await originalHandleConnection(...args);
      markAdmissionStarted();
      await admissionGate;
    };
  }
  app.use('authentication', authentication);

  const socketConfig = createSocketIOConfig(app as never, {
    corsOrigin: '*',
    credentialsAllowed: false,
    multiTenancy: MULTI_TENANCY,
  });
  app.configure(socketio(socketConfig.serverOptions, socketConfig.callback));
  configureChannels(app as never);

  const server = await new Promise<HttpServer>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
  const url = `http://127.0.0.1:${address.port}`;
  const client = createClient(url, false, {
    reconnectionAttempts: options.reconnectionAttempts ?? 0,
    ackTimeout: 2_000,
    socketAuthentication: { accessToken: token },
  });
  client.io.connect();
  if (!options.pauseValidation && !options.pauseAdmission) await waitForConnect(client);

  return {
    app,
    client,
    server,
    sessionTokens,
    socketConfig,
    token,
    url,
    invalidateUserTokens() {
      userTokensValidAfter = new Date(Date.now() + 1_000);
    },
    userToken: jwt.sign(
      { sub: USER_ID, type: 'access', tenant_id: REPLACEMENT_TENANT_ID },
      JWT_SECRET,
      {
        algorithm: 'HS256',
        audience: RUNTIME_JWT_AUDIENCE,
        issuer: RUNTIME_JWT_ISSUER,
        expiresIn: '1m',
      }
    ),
    ...(validationStarted ? { validationStarted, releaseValidation } : {}),
    ...(admissionStarted ? { admissionStarted, releaseAdmission } : {}),
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

  it('installs executor authority during the handshake and honors exact revocation', async () => {
    const harness = await startHarness();
    harnesses.push(harness);

    const serverSocket = harness.socketConfig
      .getSocketServer()
      ?.sockets.sockets.get(harness.client.io.id!);
    expect(serverSocket).toBeDefined();
    const connection = (serverSocket as unknown as { feathers?: Record<string, unknown> }).feathers;
    expect(connection).toMatchObject({
      authenticated: true,
      authentication: {
        strategy: 'jwt',
        payload: { type: 'executor-session', tenant_id: TENANT_ID },
      },
      user: { user_id: USER_ID },
    });
    expect(connection?.authentication).not.toHaveProperty('accessToken');
    expect(Object.isFrozen(connection?.authentication)).toBe(true);
    expect(Object.isFrozen(connection?.user)).toBe(true);
    expect(getSocketAuthState(serverSocket!)).toMatchObject({
      userId: null,
      isService: false,
      isExecutor: true,
      tenant: { tenant_id: TENANT_ID },
    });
    expect(getAuthenticatedConnectionAuthority(connection)).toMatchObject({
      tenant: { tenant_id: TENANT_ID },
      principal: {
        kind: 'executor',
        taskId: TASK_ID,
      },
    });
    expect(
      authenticatedTaskExecutorRuntimeAuthority({
        ...connection,
        provider: 'socketio',
        connection,
      } as Params)
    ).toMatchObject({
      tenantId: TENANT_ID,
      userId: USER_ID,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      branchId: BRANCH_ID,
      tokenFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(connection?.tenant).toMatchObject({ tenant_id: TENANT_ID });
    await expect(
      (
        harness.client.service('tasks') as unknown as {
          connectExecutor(data: { task_id: string }): Promise<unknown>;
        }
      ).connectExecutor({ task_id: TASK_ID })
    ).resolves.toEqual({ task_id: TASK_ID, tenant_id: TENANT_ID, user_id: USER_ID });
    expect(harness.app.channels).toContain(executorTaskChannelName(TENANT_ID, TASK_ID));

    const disconnected = waitForDisconnect(harness.client);
    await runWithTenantContext(TENANT_ID, () => harness.sessionTokens.revokeToken(harness.token));
    await disconnected;
    expect(getAuthenticatedConnectionAuthority(connection)).toBeUndefined();
  });

  it('projects a taskless command as the initiating user without granting a task room', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const commandToken = await runWithTenantContext(TENANT_ID, () =>
      harness.sessionTokens.generateCommandToken('branch-files-read', USER_ID, BRANCH_ID)
    );
    const commandClient = createClient(harness.url, false, {
      reconnectionAttempts: 0,
      socketAuthentication: { accessToken: commandToken },
    });

    try {
      commandClient.io.connect();
      await waitForConnect(commandClient);
      const serverSocket = harness.socketConfig
        .getSocketServer()
        ?.sockets.sockets.get(commandClient.io.id!);
      const connection = (serverSocket as unknown as { feathers?: Record<string, unknown> })
        .feathers;
      const authority = getAuthenticatedConnectionAuthority(connection);

      expect(connection).toMatchObject({
        authenticated: true,
        user: { user_id: USER_ID, role: ROLES.MEMBER },
        tenant: { tenant_id: TENANT_ID },
      });
      expect(authority).toMatchObject({
        tenant: { tenant_id: TENANT_ID },
        principal: { kind: 'executor' },
      });
      expect(authority?.principal).not.toHaveProperty('taskId');
      expect(executorRoomConnections(harness)).not.toContain(connection);
      await expect(commandClient.service('tasks').get(TASK_ID)).resolves.toEqual({
        task_id: TASK_ID,
        tenant_id: TENANT_ID,
        user_id: USER_ID,
      });
    } finally {
      commandClient.io.close();
    }
  });

  it('retires the active task room and connection when task lifecycle revokes its lease', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    await waitForConnect(harness.client);
    const serverSocket = harness.socketConfig
      .getSocketServer()
      ?.sockets.sockets.get(harness.client.io.id!);
    const connection = (serverSocket as unknown as { feathers?: Record<string, unknown> }).feathers;
    expect(harness.app.channels).toContain(executorTaskChannelName(TENANT_ID, TASK_ID));

    const disconnected = waitForDisconnect(harness.client);
    await runWithTenantContext(TENANT_ID, () => harness.sessionTokens.revokeTaskTokens(TASK_ID));
    expect(getAuthenticatedConnectionAuthority(connection)).toBeUndefined();
    expect(harness.app.channels).not.toContain(executorTaskChannelName(TENANT_ID, TASK_ID));
    await disconnected;

    await expect(
      runWithTenantContext(TENANT_ID, () =>
        harness.sessionTokens.validateToken(harness.token, { taskId: TASK_ID })
      )
    ).resolves.toBeNull();
  });

  it.each(['completed', 'failed'] as const)(
    'drains a self-revoking %s Task RPC acknowledgement before disconnecting its executor',
    async (status) => {
      const harness = await startHarness();
      harnesses.push(harness);
      await waitForConnect(harness.client);
      const serverSocket = harness.socketConfig
        .getSocketServer()
        ?.sockets.sockets.get(harness.client.io.id!);
      if (!serverSocket) throw new Error('Expected connected executor socket');
      const connection = (serverSocket as unknown as { feathers?: Record<string, unknown> })
        .feathers;
      const transport = serverSocket.conn.transport;
      const disconnectListenersBefore = serverSocket.listenerCount('disconnect');
      const readyListenersBefore = transport.listenerCount('ready');
      const send = transport.send.bind(transport);
      let releaseAcknowledgement: (() => void) | undefined;
      transport.send = ((packets: Parameters<typeof send>[0]) => {
        // Deterministically model production transport backpressure. The Task
        // mutation and token revocation commit before Feathers queues its RPC
        // acknowledgement; closing the namespace while this write is held makes
        // the client report a false task failure even though terminality won.
        transport.writable = false;
        releaseAcknowledgement = () => {
          transport.send = send;
          send(packets);
        };
      }) as typeof transport.send;
      const disconnected = waitForDisconnect(harness.client);

      const tasks = harness.client.service('tasks') as unknown as {
        methods?: (...names: string[]) => unknown;
        finish(data: { task_id: string; status: 'completed' | 'failed' }): Promise<unknown>;
      };
      tasks.methods?.('finish');
      const finish = tasks.finish({ task_id: TASK_ID, status });
      void finish.catch(() => undefined);
      await waitFor(
        () =>
          releaseAcknowledgement !== undefined &&
          getAuthenticatedConnectionAuthority(connection) === undefined
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // Revocation is already authoritative and the Task room is already gone,
      // but transport retirement must not overtake the terminal RPC response.
      expect(serverSocket.connected).toBe(true);
      expect(harness.client.io.connected).toBe(true);
      expect(harness.app.channels).not.toContain(executorTaskChannelName(TENANT_ID, TASK_ID));
      expect(serverSocket.listenerCount('disconnect')).toBe(disconnectListenersBefore + 1);
      expect(transport.listenerCount('ready')).toBe(readyListenersBefore + 1);
      releaseAcknowledgement?.();
      await expect(finish).resolves.toEqual({
        accepted: true,
        task_id: TASK_ID,
        status,
      });

      await disconnected;
      expect(serverSocket.listenerCount('disconnect')).toBe(disconnectListenersBefore);
      expect(transport.listenerCount('ready')).toBeLessThanOrEqual(readyListenersBefore);
    }
  );

  it('rejects login when revocation lands after authority validation starts', async () => {
    const harness = await startHarness({ pauseValidation: true });
    harnesses.push(harness);
    const connectionAttempt = waitForConnect(harness.client);
    await harness.validationStarted;
    await runWithTenantContext(TENANT_ID, () => harness.sessionTokens.revokeToken(harness.token));
    expect(harness.client.io.connected).toBe(false);

    harness.releaseValidation?.();
    const rejection = await connectionAttempt.catch((error) => error);
    expect(rejection).toMatchObject({
      data: { code: 401, className: 'not-authenticated' },
    });
    // The revoked handshake is never accepted and therefore cannot install a
    // passive task publication room.
    expect(harness.client.io.connected).toBe(false);
    expect(harness.app.channels).not.toContain(executorTaskChannelName(TENANT_ID, TASK_ID));
  });

  it('rejects login when revocation lands after authority commit but before admission', async () => {
    const harness = await startHarness({ pauseAdmission: true });
    harnesses.push(harness);
    const connectionAttempt = waitForConnect(harness.client);
    await harness.admissionStarted;

    await runWithTenantContext(TENANT_ID, () => harness.sessionTokens.revokeToken(harness.token));
    expect(harness.client.io.connected).toBe(false);

    harness.releaseAdmission?.();
    const rejection = await connectionAttempt.catch((error) => error);
    expect(rejection).toMatchObject({
      data: { code: 401, className: 'not-authenticated' },
    });
    expect(harness.client.io.connected).toBe(false);
    expect(harness.app.channels).not.toContain(executorTaskChannelName(TENANT_ID, TASK_ID));
  });

  it('rejects a user token invalidated after issuance at the socket boundary', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    harness.invalidateUserTokens();
    const userClient = createClient(harness.url, false, {
      reconnectionAttempts: 0,
      socketAuthentication: { accessToken: harness.userToken },
    });
    try {
      userClient.io.connect();
      const rejection = await waitForConnect(userClient).catch((error) => error);
      expect(rejection).toMatchObject({
        data: { code: 401, className: 'not-authenticated' },
      });
      expect(userClient.io.connected).toBe(false);
    } finally {
      userClient.io.close();
    }
  });

  it('rejects live authentication replacement without disturbing executor authority', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const received: string[] = [];
    harness.client
      .service('tasks')
      .on('termination_requested', () => received.push('termination_requested'));
    harness.client
      .service('messages')
      .on('permission_resolved', () => received.push('permission_resolved'));

    const serverSocket = harness.socketConfig
      .getSocketServer()
      ?.sockets.sockets.get(harness.client.io.id!);
    expect(serverSocket).toBeDefined();
    const connection = (serverSocket as unknown as { feathers?: Record<string, unknown> }).feathers;
    expect(executorRoomConnections(harness)).toContain(connection);

    // Prove the passive delivery fixture before changing identity.
    emitControlEventToExecutorRoom(harness, 'tasks', 'termination_requested', {
      task_id: TASK_ID,
    });
    await waitFor(() => received.includes('termination_requested'));
    received.length = 0;

    await expect(
      harness.client.service('authentication').create({
        strategy: 'jwt',
        accessToken: harness.userToken,
      })
    ).rejects.toMatchObject({ code: 401 });
    expect(getAuthenticatedConnectionAuthority(connection)).toMatchObject({
      tenant: { tenant_id: TENANT_ID },
      principal: {
        kind: 'executor',
        taskId: TASK_ID,
      },
    });
    expect(getSocketAuthState(serverSocket!)).toMatchObject({
      userId: null,
      isService: false,
      isExecutor: true,
      tenant: { tenant_id: TENANT_ID },
    });
    expect(executorRoomConnections(harness)).toContain(connection);

    emitControlEventToExecutorRoom(harness, 'tasks', 'termination_requested', {
      task_id: TASK_ID,
    });
    emitControlEventToExecutorRoom(harness, 'messages', 'permission_resolved', {
      task_id: TASK_ID,
      request_id: 'request-1',
    });
    await waitFor(() => received.length === 2);
    expect(received).toEqual(['termination_requested', 'permission_resolved']);
  });

  it('changes identity only through a new handshake without retaining the old executor room', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const received: string[] = [];
    harness.client
      .service('tasks')
      .on('termination_requested', () => received.push('termination_requested'));
    harness.client
      .service('messages')
      .on('permission_resolved', () => received.push('permission_resolved'));

    const oldServerSocket = harness.socketConfig
      .getSocketServer()
      ?.sockets.sockets.get(harness.client.io.id!);
    const oldConnection = (oldServerSocket as unknown as { feathers?: Record<string, unknown> })
      .feathers;
    expect(oldConnection).toBeDefined();

    const disconnected = waitForDisconnect(harness.client);
    harness.client.io.disconnect();
    await disconnected;
    await waitFor(() => !getAuthenticatedConnectionAuthority(oldConnection));

    // The client object and listeners may survive identity rotation, but its
    // server connection does not. The next namespace handshake is the only
    // place the tenant-B identity can be installed.
    harness.client.io.auth = { token: harness.userToken };
    harness.client.io.connect();
    await waitForConnect(harness.client);

    const newServerSocket = harness.socketConfig
      .getSocketServer()
      ?.sockets.sockets.get(harness.client.io.id!);
    expect(newServerSocket).toBeDefined();
    expect(getSocketAuthState(newServerSocket!)).toMatchObject({
      userId: USER_ID,
      isService: false,
      tenant: { tenant_id: REPLACEMENT_TENANT_ID },
    });
    expect(executorRoomConnections(harness)).not.toContain(oldConnection);

    emitControlEventToExecutorRoom(harness, 'tasks', 'termination_requested', {
      task_id: TASK_ID,
    });
    emitControlEventToExecutorRoom(harness, 'messages', 'permission_resolved', {
      task_id: TASK_ID,
      request_id: 'request-after-identity-change',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toEqual([]);

    await expect(
      (
        harness.client.service('tasks') as unknown as {
          connectExecutor(data: { task_id: string }): Promise<unknown>;
        }
      ).connectExecutor({ task_id: TASK_ID })
    ).resolves.toEqual({
      task_id: TASK_ID,
      tenant_id: REPLACEMENT_TENANT_ID,
      user_id: USER_ID,
    });
  });

  it('re-establishes task-executor scope through an automatic transport reconnect', async () => {
    const harness = await startHarness({ reconnectionAttempts: 3 });
    harnesses.push(harness);
    const originalSocketId = harness.client.io.id;
    const oldServerSocket = harness.socketConfig
      .getSocketServer()
      ?.sockets.sockets.get(originalSocketId!);
    const oldConnection = (oldServerSocket as unknown as { feathers?: Record<string, unknown> })
      .feathers;
    expect(oldServerSocket).toBeDefined();
    expect(executorRoomConnections(harness)).toContain(oldConnection);

    const disconnected = waitForDisconnect(harness.client);
    const reconnected = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Task executor did not reconnect')), 3_000);
      harness.client.io.once('connect', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    oldServerSocket?.conn.close();
    await disconnected;
    await reconnected;

    const newServerSocket = harness.socketConfig
      .getSocketServer()
      ?.sockets.sockets.get(harness.client.io.id!);
    expect(harness.client.io.id).not.toBe(originalSocketId);
    expect(getSocketAuthState(newServerSocket!)).toMatchObject({
      userId: null,
      isService: false,
      isExecutor: true,
      tenant: { tenant_id: TENANT_ID },
    });
    expect(executorRoomConnections(harness)).not.toContain(oldConnection);
    expect(executorRoomConnections(harness)).toContain(
      (newServerSocket as unknown as { feathers?: Record<string, unknown> }).feathers
    );
    await expect(
      (
        harness.client.service('tasks') as unknown as {
          connectExecutor(data: { task_id: string }): Promise<unknown>;
        }
      ).connectExecutor({ task_id: TASK_ID })
    ).resolves.toEqual({ task_id: TASK_ID, tenant_id: TENANT_ID, user_id: USER_ID });
  });

  it('establishes an ordinary user tenant before the first Feathers request', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const userClient = createClient(harness.url, false, {
      reconnectionAttempts: 0,
      socketAuthentication: { accessToken: harness.userToken },
    });
    try {
      userClient.io.connect();
      await waitForConnect(userClient);
      await expect(
        (
          userClient.service('tasks') as unknown as {
            connectExecutor(data: { task_id: string }): Promise<unknown>;
          }
        ).connectExecutor({ task_id: TASK_ID })
      ).resolves.toEqual({
        task_id: TASK_ID,
        tenant_id: REPLACEMENT_TENANT_ID,
        user_id: USER_ID,
      });
    } finally {
      userClient.io.close();
    }
  });

  it('keeps a live user connection across access-token rotation but rejects an expired reconnect', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const expiringToken = jwt.sign(
      { sub: USER_ID, type: 'access', tenant_id: REPLACEMENT_TENANT_ID },
      JWT_SECRET,
      {
        algorithm: 'HS256',
        audience: RUNTIME_JWT_AUDIENCE,
        issuer: RUNTIME_JWT_ISSUER,
        expiresIn: '2s',
      }
    );
    const userClient = createClient(harness.url, false, {
      reconnectionAttempts: 1,
      socketAuthentication: { accessToken: expiringToken },
    });
    try {
      userClient.io.connect();
      await waitForConnect(userClient);
      const serverSocket = harness.socketConfig
        .getSocketServer()
        ?.sockets.sockets.get(userClient.io.id!);
      const connection = (serverSocket as unknown as { feathers?: Record<string, unknown> })
        .feathers;
      expect(getAuthenticatedConnectionAuthority(connection)?.expiresAt).toEqual(
        expect.any(Number)
      );
      expect(getAuthenticatedConnectionAuthority(connection)?.retireAtExpiry).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 2_100));
      expect(userClient.io.connected).toBe(true);
      await expect(
        (
          userClient.service('tasks') as unknown as {
            connectExecutor(data: { task_id: string }): Promise<unknown>;
          }
        ).connectExecutor({ task_id: TASK_ID })
      ).resolves.toMatchObject({
        tenant_id: REPLACEMENT_TENANT_ID,
        user_id: USER_ID,
      });

      const rejectedReconnect = new Promise<Error>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Expired reconnect was not rejected')),
          4_000
        );
        userClient.io.once('connect_error', (error) => {
          clearTimeout(timeout);
          resolve(error);
        });
      });
      serverSocket?.conn.close();
      const reconnectError = await rejectedReconnect;

      expect(reconnectError).toMatchObject({
        data: { code: 401, className: 'not-authenticated' },
      });
      expect(userClient.io.connected).toBe(false);
      expect(getAuthenticatedConnectionAuthority(connection)).toBeUndefined();
    } finally {
      userClient.io.close();
    }
  });

  it('retires task-executor authority at the executor credential expiry', async () => {
    const harness = await startHarness({ sessionTokenExpirationMs: 1_500 });
    harnesses.push(harness);
    const serverSocket = harness.socketConfig
      .getSocketServer()
      ?.sockets.sockets.get(harness.client.io.id!);
    const connection = (serverSocket as unknown as { feathers?: Record<string, unknown> }).feathers;
    expect(getAuthenticatedConnectionAuthority(connection)).toMatchObject({
      principal: { kind: 'executor' },
      retireAtExpiry: true,
    });

    await waitFor(() => !harness.client.io.connected, 3_000);

    expect(getAuthenticatedConnectionAuthority(connection)).toBeUndefined();
    expect(harness.app.channels).not.toContain(executorTaskChannelName(TENANT_ID, TASK_ID));
  });

  it('re-establishes ordinary user authority through an automatic transport reconnect', async () => {
    const harness = await startHarness();
    harnesses.push(harness);
    const userClient = createClient(harness.url, false, {
      reconnectionAttempts: 3,
      socketAuthentication: { accessToken: harness.userToken },
    });
    try {
      userClient.io.connect();
      await waitForConnect(userClient);
      const originalSocketId = userClient.io.id;
      const serverSocket = harness.socketConfig
        .getSocketServer()
        ?.sockets.sockets.get(originalSocketId!);
      expect(serverSocket).toBeDefined();

      const disconnected = waitForDisconnect(userClient);
      const reconnected = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Socket.IO client did not reconnect')),
          3_000
        );
        userClient.io.once('connect', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      // Close the Engine.IO transport rather than the namespace. Socket.IO's
      // manager owns this recovery path and must automatically present the
      // handshake bearer again on the replacement connection.
      serverSocket?.conn.close();
      await disconnected;
      await reconnected;

      expect(userClient.io.id).not.toBe(originalSocketId);
      await expect(
        (
          userClient.service('tasks') as unknown as {
            connectExecutor(data: { task_id: string }): Promise<unknown>;
          }
        ).connectExecutor({ task_id: TASK_ID })
      ).resolves.toEqual({
        task_id: TASK_ID,
        tenant_id: REPLACEMENT_TENANT_ID,
        user_id: USER_ID,
      });
    } finally {
      userClient.io.close();
    }
  });
});
