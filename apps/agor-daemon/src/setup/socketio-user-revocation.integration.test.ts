import type { Server } from 'node:http';
import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  AuthenticationService,
  authenticate,
  feathers,
  feathersExpress,
  socketio,
} from '@agor/core/feathers';
import { io } from 'socket.io-client';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { createRequireAuthHook } from '../auth/require-auth.js';
import { RuntimeJWTStrategy } from '../auth/runtime-jwt-strategy.js';
import {
  issueRuntimeTokenPair,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
} from '../auth/runtime-tokens.js';
import { installUserAuthorityCheck } from '../auth/user-authority.js';
import {
  LOCAL_AUTHORIZATION_INVALIDATION_EVENT,
  terminalChannelName,
} from '../realtime/routing.js';
import { UsersService } from '../services/users.js';
import {
  TERMINAL_REQUEST_JOIN_CHANNEL,
  type TerminalRequestConnection,
} from '../terminal-socket-connection.js';
import { configureChannels, createSocketIOConfig } from './socketio.js';

dbTest(
  'missed invalidation cannot preserve RPC, terminal reattachment, passive output or reconnect authority',
  async ({ db }) => {
    const app = feathersExpress(feathers());
    const tenant = resolveMultiTenancyConfig({});
    const secret = 'synthetic-socket-revocation-secret';
    app.set('authentication', {
      secret,
      entity: 'user',
      entityId: 'user_id',
      service: 'users',
      authStrategies: ['jwt'],
      jwtOptions: {
        issuer: RUNTIME_JWT_ISSUER,
        audience: RUNTIME_JWT_AUDIENCE,
        algorithm: 'HS256',
        expiresIn: '15m',
      },
    });
    const users = new UsersService(db);
    const user = await users.create({
      email: 'socket-revocation@example.test',
      password: 'test-password-1234',
      role: 'member',
    });
    app.use('users', users);
    const checker = installUserAuthorityCheck(app, db);
    const auth = new AuthenticationService(app);
    auth.register(
      'jwt',
      new RuntimeJWTStrategy({ multiTenancy: tenant, checkUserAuthority: checker })
    );
    app.use('authentication', auth);
    app.use('protected', {
      async get() {
        return { ok: true };
      },
    });
    app.service('protected').hooks({
      before: { all: [createRequireAuthHook(authenticate({ strategies: ['jwt'] }), tenant)] },
    });
    const sockets = createSocketIOConfig(app as never, {
      corsOrigin: '*',
      credentialsAllowed: false,
      multiTenancy: tenant,
    });
    app.configure(socketio(sockets.serverOptions, sockets.callback));
    configureChannels(app as never);
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    const token = issueRuntimeTokenPair(user, secret, '15m', '30d', {
      auth_credential_generation: 0,
    }).accessToken;
    const client = io(`http://127.0.0.1:${address.port}`, {
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
      auth: { token },
    });
    const request = () =>
      new Promise<unknown>((resolve, reject) =>
        client.emit('get', 'protected', 'id', {}, (error: unknown, data: unknown) =>
          error ? reject(error) : resolve(data)
        )
      );
    const received: unknown[] = [];
    client.on('terminal:output', (data) => received.push(data));
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('connect', resolve);
        client.once('connect_error', reject);
        client.connect();
      });
      await expect(request()).resolves.toEqual({ ok: true });
      const socket = sockets.getSocketServer()!.sockets.sockets.get(client.id!)!;
      const connection = (socket as unknown as { feathers: TerminalRequestConnection }).feathers;
      const channel = terminalChannelName('default', user.user_id, 'terminal-test');
      const allocation = {
        userId: user.user_id,
        terminalId: 'terminal-test',
        branchId: 'branch-test',
      };
      expect(await connection[TERMINAL_REQUEST_JOIN_CHANNEL]?.(channel, allocation)).toBe(true);
      const terminalRetirement = vi.fn();
      app.on(LOCAL_AUTHORIZATION_INVALIDATION_EVENT, terminalRetirement);
      app.emit('realtime:authorization-invalidated', { tenantId: 'default', userId: 'other-user' });
      await expect(request()).resolves.toEqual({ ok: true });
      const targetedDisconnect = new Promise<void>((resolve) =>
        client.once('disconnect', () => resolve())
      );
      app.emit('realtime:authorization-invalidated', { tenantId: 'default', userId: user.user_id });
      await targetedDisconnect;
      expect(terminalRetirement).not.toHaveBeenCalled();
      await new Promise<void>((resolve, reject) => {
        client.once('connect', resolve);
        client.once('connect_error', reject);
        client.connect();
      });
      const reconnectedSocket = sockets.getSocketServer()!.sockets.sockets.get(client.id!)!;
      const reconnected = (reconnectedSocket as unknown as { feathers: TerminalRequestConnection })
        .feathers;
      expect(await reconnected[TERMINAL_REQUEST_JOIN_CHANNEL]?.(channel, allocation)).toBe(true);
      // Direct service mutation deliberately omits event hooks/Redis publication.
      await users.patch(user.user_id, { access_disabled: true });
      await expect(request()).rejects.toMatchObject({ code: 401 });
      expect(await reconnected[TERMINAL_REQUEST_JOIN_CHANNEL]?.(channel, allocation)).toBe(false);
      // Advance only the lease's monotonic clock. Real transports and timers remain real.
      const originalNow = performance.now.bind(performance);
      vi.spyOn(performance, 'now').mockImplementation(() => originalNow() + 60_001);
      const disconnected = new Promise<void>((resolve) =>
        client.once('disconnect', () => resolve())
      );
      sockets.getSocketServer()!.to(channel).emit('terminal:output', { data: 'must-not-arrive' });
      await disconnected;
      expect(received).toEqual([]);
      vi.restoreAllMocks();
      await expect(
        new Promise<void>((resolve, reject) => {
          client.once('connect', resolve);
          client.once('connect_error', reject);
          client.connect();
        })
      ).rejects.toThrow();
    } finally {
      vi.restoreAllMocks();
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
);
