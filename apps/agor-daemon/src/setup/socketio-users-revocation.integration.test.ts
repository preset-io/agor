import type { Server } from 'node:http';
import { resolveMultiTenancyConfig } from '@agor/core/config';
import { UserApiKeysRepository, UsersRepository } from '@agor/core/db';
import {
  AuthenticationService,
  authenticate,
  feathers,
  feathersExpress,
  socketio,
} from '@agor/core/feathers';
import { io } from 'socket.io-client';
import { expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { ApiKeyStrategy } from '../auth/api-key-strategy.js';
import { createIssueBrowserTokensHook } from '../auth/issue-browser-tokens-hook.js';
import { createRequireAuthHook } from '../auth/require-auth.js';
import { RuntimeJWTStrategy } from '../auth/runtime-jwt-strategy.js';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';
import { installUserAuthorityCheck } from '../auth/user-authority.js';
import { type RegisterHooksContext, registerHooks } from '../register-hooks.js';
import { AgorLocalStrategy } from '../register-routes.js';
import { UsersService } from '../services/users.js';
import { configureChannels, createSocketIOConfig } from './socketio.js';

for (const revoke of ['disable', 'logins', 'source-key'] as const) {
  dbTest(
    `production users hooks deny stale socket reads/password writes after ${revoke} without fanout`,
    async ({ db }) => {
      const app = feathersExpress(feathers());
      const tenant = resolveMultiTenancyConfig({});
      const secret = 'synthetic-users-hook-secret';
      app.set('authentication', {
        secret,
        entity: 'user',
        entityId: 'user_id',
        service: 'users',
        authStrategies: ['jwt', 'local', 'api-key'],
        local: { usernameField: 'email', passwordField: 'password' },
        jwtOptions: {
          issuer: RUNTIME_JWT_ISSUER,
          audience: RUNTIME_JWT_AUDIENCE,
          algorithm: 'HS256',
          expiresIn: '15m',
        },
      });
      // Separate service instance: mutations intentionally bypass notification hooks.
      const writer = new UsersService(db);
      const user = await writer.create({
        email: 'users-socket@example.test',
        password: 'original-password-1234',
        role: 'member',
      });
      app.use('users', new UsersService(db));
      const checker = installUserAuthorityCheck(app, db as never);
      const keys = new UserApiKeysRepository(db);
      const key = await keys.create(user.user_id, 'socket-source');
      const authentication = new AuthenticationService(app);
      authentication.register(
        'jwt',
        new RuntimeJWTStrategy({ multiTenancy: tenant, checkUserAuthority: checker })
      );
      authentication.register('local', new AgorLocalStrategy());
      const apiKey = new ApiKeyStrategy();
      apiKey.setDependencies(keys, app.service('users'), checker, 'default');
      authentication.register('api-key', apiKey);
      app.use('authentication', authentication);
      app.service('authentication').hooks({
        after: {
          create: [
            createIssueBrowserTokensHook({
              jwtSecret: secret,
              accessTokenTtl: '15m',
              refreshTokenTtl: '30d',
              tenantClaim: 'tenant_id',
            }),
          ],
        },
      });
      const requireAuth = createRequireAuthHook(
        authenticate({ strategies: ['jwt', 'api-key'] }),
        tenant
      );
      // Register the actual production chains on the real users service; unrelated
      // services are inert, following the existing registerHooks fixture convention.
      const registrationApp = {
        service: (path: string) => (path === 'users' ? app.service('users') : { hooks() {} }),
        use() {},
        publish() {},
      };
      registerHooks({
        app: registrationApp as unknown as RegisterHooksContext['app'],
        db: db as never,
        config: { database: { dialect: 'sqlite' } },
        jwtSecret: secret,
        requireAuth,
        superadminOpts: { allowSuperadmin: false },
        deployment: { mode: 'standalone' },
        sessionsService: {},
        messagesService: {},
        boardsService: undefined,
        branchRepository: {},
        usersRepository: new UsersRepository(db),
        sessionsRepository: {},
      } as RegisterHooksContext);
      const login = () =>
        app
          .service('authentication')
          .create(
            { strategy: 'local', email: user.email, password: 'original-password-1234' },
            { provider: 'rest' }
          );
      // Real local-auth internal find/get exemptions must remain nonrecursive.
      const local = await login();
      const issued =
        revoke === 'source-key'
          ? await app
              .service('authentication')
              .create({ strategy: 'api-key', apiKey: key.rawKey }, { provider: 'rest' })
          : local;
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
      const client = io(`http://127.0.0.1:${address.port}`, {
        autoConnect: false,
        reconnection: false,
        transports: ['websocket'],
        auth: { token: issued.accessToken },
      });
      const call = (method: string, ...args: unknown[]) =>
        new Promise<unknown>((resolve, reject) =>
          client.emit(method, 'users', ...args, (error: unknown, result: unknown) =>
            error ? reject(error) : resolve(result)
          )
        );
      try {
        await new Promise<void>((resolve, reject) => {
          client.once('connect', resolve);
          client.once('connect_error', reject);
          client.connect();
        });
        await expect(call('get', user.user_id, {})).resolves.toMatchObject({
          user_id: user.user_id,
        });
        await expect(call('find', {})).resolves.toBeDefined();
        await expect(
          call('patch', user.user_id, { name: 'Current authority' }, {})
        ).resolves.toMatchObject({ name: 'Current authority' });
        if (revoke === 'source-key') await keys.delete(key.key.id, user.user_id);
        else
          await writer.patch(
            user.user_id,
            revoke === 'disable' ? { access_disabled: true } : { revoke_logins: true }
          );
        // No clock advance or notification: still admitted, but every operation denies.
        expect(client.connected).toBe(true);
        await expect(call('get', user.user_id, {})).rejects.toMatchObject({ code: 401 });
        await expect(call('find', {})).rejects.toMatchObject({ code: 401 });
        await expect(call('patch', user.user_id, { name: 'stale' }, {})).rejects.toMatchObject({
          code: 401,
        });
        await expect(
          call('patch', user.user_id, { password: 'attacker-password-1234' }, {})
        ).rejects.toMatchObject({ code: 401 });
        if (revoke === 'disable') await expect(login()).rejects.toThrow();
        else await expect(login()).resolves.toHaveProperty('accessToken');
      } finally {
        client.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
}
