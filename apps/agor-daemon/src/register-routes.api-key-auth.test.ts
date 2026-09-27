import {
  BranchRepository,
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  runMigrations,
  runWithTenantDatabaseScope,
  UserApiKeysRepository,
} from '@agor/core/db';
import { type Application, feathers, feathersExpress } from '@agor/core/feathers';
import jwt from 'jsonwebtoken';
import { afterEach, expect, it, vi } from 'vitest';
import { type RegisterRoutesContext, registerRoutes } from './register-routes.js';
import { UsersService } from './services/users.js';
import { createTenantDatabaseScopeAroundHook } from './utils/tenant-db-scope.js';

const secret = 'disposable-api-key-route-test-secret';
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});

async function fixture() {
  const raw = await createDatabaseAsync({ url: ':memory:' });
  cleanup.push(() => (raw as unknown as { $client: { close(): void } }).$client.close());
  await runMigrations(raw);
  const db = createTenantScopedDatabaseProxy(raw);
  const scoped = <T>(work: () => Promise<T>) => runWithTenantDatabaseScope(db, 'default', work);
  const app = feathersExpress(feathers()) as unknown as Application;
  app.use('tasks', { get: vi.fn() });
  app.use('repos', { get: vi.fn() });
  const users = new UsersService(db);
  app.use('users', users);
  app.service('users').hooks({
    around: { all: [createTenantDatabaseScopeAroundHook({ db, config: {}, jwtSecret: secret })] },
  });
  const user = await scoped(() =>
    users.create({
      email: 'key-qa@example.test',
      password: 'synthetic-password-1234',
      role: 'member',
    })
  );
  const keys = new UserApiKeysRepository(db);
  const key = await scoped(() => keys.create(user.user_id, 'source'));
  const other = await scoped(() => keys.create(user.user_id, 'unrelated'));
  // Actual production registration, stopped before unrelated endpoints.
  // No listener or executor is started; repositories retain their scope guard.
  const stop = new Error('authentication routes registered');
  const use = app.use.bind(app);
  const spy = vi.spyOn(app, 'use').mockImplementation((...args) => {
    if (args[0] === '/authentication/impersonate') throw stop;
    return use(...args);
  });
  try {
    await expect(
      registerRoutes({
        app,
        db,
        branchRepository: new BranchRepository(db),
        config: {},
        jwtSecret: secret,
        externalLaunchProvider: { enabled: false },
      } as unknown as RegisterRoutesContext)
    ).rejects.toBe(stop);
  } finally {
    spy.mockRestore();
  }
  return {
    app,
    user,
    keys,
    key,
    other,
    scoped,
    auth: app.service('authentication'),
    refresh: app.service('authentication/refresh'),
  };
}

it('registered key exchange scopes reads and preserves revocation through refresh and JWT reauthentication', async () => {
  const f = await fixture();
  const exchange = (apiKey: string, headers = {}) =>
    f.auth.create({ strategy: 'api-key', apiKey }, { provider: 'rest', headers });
  const initial = await exchange(f.key.rawKey);
  const headerExchange = await exchange(f.key.rawKey, { authorization: `Bearer ${f.key.rawKey}` });
  const refreshed = await f.refresh.create(
    { refreshToken: initial.refreshToken },
    { provider: 'rest' }
  );
  const reauthenticated = await f.auth.create(
    { strategy: 'jwt', accessToken: initial.accessToken },
    { provider: 'rest' }
  );
  for (const pair of [initial, headerExchange, refreshed, reauthenticated]) {
    for (const token of [pair.accessToken, pair.refreshToken]) {
      expect(jwt.verify(token, secret)).toMatchObject({
        sub: f.user.user_id,
        source_api_key_id: f.key.key.id,
      });
    }
  }
  await f.scoped(() => f.keys.delete(f.key.key.id, f.user.user_id));
  await expect(exchange(f.key.rawKey)).rejects.toMatchObject({ code: 401 });
  for (const pair of [initial, headerExchange, refreshed, reauthenticated]) {
    await expect(
      f.auth.create({ strategy: 'jwt', accessToken: pair.accessToken }, { provider: 'rest' })
    ).rejects.toMatchObject({ code: 401 });
    await expect(
      f.refresh.create({ refreshToken: pair.refreshToken }, { provider: 'rest' })
    ).rejects.toMatchObject({ code: 401 });
  }
  await expect(exchange(f.other.rawKey)).resolves.toHaveProperty('accessToken');
  await expect(
    f.auth.create(
      { strategy: 'local', email: f.user.email, password: 'synthetic-password-1234' },
      { provider: 'rest' }
    )
  ).resolves.toHaveProperty('accessToken');
});

it('returns 401 rather than user-not-found for a deleted login subject', async () => {
  const f = await fixture();
  const pair = await f.auth.create(
    { strategy: 'api-key', apiKey: f.key.rawKey },
    { provider: 'rest' }
  );
  await f.scoped(() => f.app.service('users').remove(f.user.user_id));
  await expect(
    f.auth.create({ strategy: 'jwt', accessToken: pair.accessToken }, { provider: 'rest' })
  ).rejects.toMatchObject({ code: 401 });
});
