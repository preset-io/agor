import { AuthenticationService, feathers } from '@agor/core/feathers';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { AgorLocalStrategy } from '../register-routes';
import { createUsersService, LOCAL_AUTH_LOOKUP_PARAM, UsersService } from './users';

describe('UsersService.find', () => {
  dbTest('respects limit/skip pagination and reports total matches', async ({ db }) => {
    const service = new UsersService(db);

    await service.create({ email: 'alpha@example.com', password: 'password-123', name: 'Alpha' });
    await service.create({ email: 'bravo@example.com', password: 'password-123', name: 'Bravo' });
    await service.create({
      email: 'charlie@example.com',
      password: 'password-123',
      name: 'Charlie',
    });

    const page = await service.find({ query: { $limit: 1, $skip: 1 } });

    expect(page.total).toBe(3);
    expect(page.limit).toBe(1);
    expect(page.skip).toBe(1);
    expect(page.data).toHaveLength(1);
    expect(page.data[0].email).toBe('bravo@example.com');
  });

  dbTest('ignores tenant scope safely on SQLite users table', async ({ db }) => {
    const service = new UsersService(db);

    const created = await service.create(
      { email: 'tenant-safe@example.com', password: 'password-123', name: 'Tenant Safe' },
      { tenant: { tenant_id: 'default', source: 'static' } } as never
    );

    const page = await service.find({
      tenant: { tenant_id: 'default', source: 'static' },
      query: { $limit: 10 },
    } as never);
    const fetched = await service.get(created.user_id, {
      tenant: { tenant_id: 'default', source: 'static' },
    } as never);

    expect(page.data.map((user) => user.email)).toContain('tenant-safe@example.com');
    expect(fetched.email).toBe('tenant-safe@example.com');
  });

  dbTest('supports offset alias for pagination', async ({ db }) => {
    const service = new UsersService(db);

    await service.create({ email: 'alpha@example.com', password: 'password-123', name: 'Alpha' });
    await service.create({ email: 'bravo@example.com', password: 'password-123', name: 'Bravo' });

    const page = await service.find({ query: { limit: 1, offset: 1 } });

    expect(page.total).toBe(2);
    expect(page.limit).toBe(1);
    expect(page.skip).toBe(1);
    expect(page.data.map((user) => user.email)).toEqual(['bravo@example.com']);
  });

  dbTest(
    'searches name/email/unix_username case-insensitively before pagination',
    async ({ db }) => {
      const service = new UsersService(db);

      await service.create({
        email: 'reed@preset.io',
        password: 'password-123',
        name: 'Reed Thompson',
        unix_username: 'rthompson',
      });
      await service.create({
        email: 'someone@example.com',
        password: 'password-123',
        name: 'Someone Else',
        unix_username: 'someone',
      });

      const byName = await service.find({ query: { search: 'REED', $limit: 10 } });
      expect(byName.total).toBe(1);
      expect(byName.data[0].email).toBe('reed@preset.io');

      const byEmail = await service.find({ query: { q: 'PRESET.IO', $limit: 10 } });
      expect(byEmail.total).toBe(1);
      expect(byEmail.data[0].name).toBe('Reed Thompson');

      const byUnix = await service.find({ query: { query: 'THOMP', $limit: 10 } });
      expect(byUnix.total).toBe(1);
      expect(byUnix.data[0].unix_username).toBe('rthompson');
    }
  );
});

describe('UsersService.find exact-email hardening', () => {
  dbTest('rejects unauthenticated external exact-email lookup', async ({ db }) => {
    const service = new UsersService(db);
    await service.create({ email: 'target@example.com', password: 'password-123' });

    await expect(
      service.find({ provider: 'rest', query: { email: 'target@example.com' } })
    ).rejects.toThrow(/Authentication required/);
  });

  dbTest('rejects authenticated non-admin lookup for another user email', async ({ db }) => {
    const service = new UsersService(db);
    const requester = await service.create({
      email: 'requester@example.com',
      password: 'password-123',
    });
    await service.create({ email: 'target@example.com', password: 'password-123' });

    await expect(
      service.find({
        provider: 'rest',
        user: { user_id: requester.user_id, email: requester.email, role: 'member' },
        query: { email: 'target@example.com' },
      })
    ).rejects.toThrow(/Exact email user lookup is restricted/);
  });

  dbTest('allows self exact-email lookup without exposing password', async ({ db }) => {
    const service = new UsersService(db);
    const user = await service.create({ email: 'self@example.com', password: 'password-123' });

    const page = await service.find({
      provider: 'rest',
      user: { user_id: user.user_id, email: user.email, role: 'member' },
      query: { email: 'self@example.com' },
    });

    expect(page.total).toBe(1);
    expect(page.data[0].email).toBe('self@example.com');
    expect(page.data[0]).not.toHaveProperty('password');
  });

  dbTest('allows admin exact-email lookup without exposing password', async ({ db }) => {
    const service = new UsersService(db);
    await service.create({ email: 'target@example.com', password: 'password-123' });

    const page = await service.find({
      provider: 'rest',
      user: { user_id: 'admin-user', email: 'admin@example.com', role: 'admin' },
      query: { email: 'target@example.com' },
    });

    expect(page.total).toBe(1);
    expect(page.data[0].email).toBe('target@example.com');
    expect(page.data[0]).not.toHaveProperty('password');
  });

  dbTest('keeps password hash scoped to the local authentication pipeline', async ({ db }) => {
    const service = new UsersService(db);
    await service.create({ email: 'login@example.com', password: 'password-123' });

    const externalSelf = await service.find({
      provider: 'rest',
      user: { user_id: 'login-user', email: 'login@example.com', role: 'member' },
      query: { email: 'login@example.com' },
    });
    expect(externalSelf.data[0]).not.toHaveProperty('password');

    const authLookup = await service.find({
      provider: 'rest',
      [LOCAL_AUTH_LOOKUP_PARAM]: true,
      query: { email: 'login@example.com' },
    } as any);
    expect(authLookup.data[0]).toHaveProperty('password');
  });

  dbTest('local authentication succeeds through the registered strategy marker', async ({ db }) => {
    const app = feathers();
    app.set('authentication', {
      secret: 'test-jwt-secret',
      entity: 'user',
      entityId: 'user_id',
      service: 'users',
      authStrategies: ['local'],
      jwtOptions: {
        header: { typ: 'access' },
        audience: 'https://agor.dev',
        issuer: 'agor',
        algorithm: 'HS256',
        expiresIn: '15m',
      },
      local: {
        usernameField: 'email',
        passwordField: 'password',
      },
    });

    app.use('users', createUsersService(db));

    const authentication = new AuthenticationService(app);
    authentication.register('local', new AgorLocalStrategy());
    app.use('authentication', authentication);

    await app.service('users').create({
      email: 'strategy-login@example.com',
      password: 'password-123',
    });

    const result = await app.service('authentication').create(
      {
        strategy: 'local',
        email: 'strategy-login@example.com',
        password: 'password-123',
      },
      { provider: 'rest' }
    );

    expect(result.user.email).toBe('strategy-login@example.com');
    expect(result.user).not.toHaveProperty('password');
  });
});
