/** A failed generation read on every JWT path is a codeless 503, never a 401 that would sign the browser out. */

import { AuthenticationService, feathers } from '@agor/core/feathers';
import type { UserID } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIssueBrowserTokensHook } from './issue-browser-tokens-hook.js';
import { createRefreshTokenService } from './refresh-token-service.js';
import { RuntimeJWTStrategy } from './runtime-jwt-strategy.js';
import { issueRuntimeToken, RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from './runtime-tokens.js';

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@agor/core/db', async (original) => ({
  ...(await original<typeof import('@agor/core/db')>()),
  readTenantRestrictionState: read,
  isPostgresDatabaseHandle: () => true,
}));

const SECRET = 'tenant-credential-unavailable-secret';
const TENANT = 'unreadable-tenant';
const USER = '018f0000-0000-7000-8000-00000000cccc' as UserID;
const user = { user_id: USER, email: 'outage@example.test', role: 'member' };
const db = {} as never;

const expectUnavailable = (error: unknown) => {
  expect(error).toMatchObject({ code: 503, className: 'unavailable' });
  expect((error as { data?: unknown }).data).toBeUndefined();
};

afterEach(() => read.mockReset());

describe('credential generation read outage', () => {
  it('keeps refresh, JWT re-authentication and browser token issuance at 503', async () => {
    read.mockRejectedValue(new Error('private database address'));
    const pair = (type: 'access' | 'refresh') =>
      issueRuntimeToken({ sub: USER, type, tenant_id: TENANT }, SECRET, '5m');

    const refresh = createRefreshTokenService({
      db,
      jwtSecret: SECRET,
      accessTokenTtl: '5m',
      refreshTokenTtl: '5m',
      usersService: { get: vi.fn(async () => user as never) },
    });
    expectUnavailable(await refresh.create({ refreshToken: pair('refresh') }).catch((e) => e));

    const app = feathers();
    app.use('users', {
      async get() {
        return user;
      },
    });
    app.set('authentication', {
      secret: SECRET,
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
        db,
        multiTenancy: {
          mode: 'required_from_auth',
          static_tenant_id: 'unused' as never,
          auth_claim: 'tenant_id',
        },
      })
    );
    app.use('authentication', authentication);
    expectUnavailable(
      await app
        .service('authentication')
        .create({ strategy: 'jwt', accessToken: pair('access') }, {})
        .catch((e: unknown) => e)
    );

    const hook = createIssueBrowserTokensHook({
      db,
      jwtSecret: SECRET,
      accessTokenTtl: '5m',
      refreshTokenTtl: '5m',
      tenantClaim: 'tenant_id',
    });
    expectUnavailable(
      await hook({
        params: { tenant: { tenant_id: TENANT } },
        result: {
          user,
          authentication: { strategy: 'jwt', payload: { sub: USER, tenant_id: TENANT } },
        },
      }).catch((e: unknown) => e)
    );
    expectUnavailable(
      await hook({
        params: { tenant: { tenant_id: TENANT } },
        result: { user, authentication: { strategy: 'local' } },
      }).catch((e: unknown) => e)
    );
  });
});
