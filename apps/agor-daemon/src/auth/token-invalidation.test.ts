import { AuthenticationService, feathers } from '@agor/core/feathers';
import type { User, UserID } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { expect, test, vi } from 'vitest';
import {
  eq,
  select,
  UserApiKeysRepository,
  UsersRepository,
  update,
  users,
} from '../../../../packages/core/src/db';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { AgorLocalStrategy } from '../register-routes';
import { createUsersService, type UsersService } from '../services/users';
import { ApiKeyStrategy } from './api-key-strategy';
import { createIssueBrowserTokensHook } from './issue-browser-tokens-hook';
import { createRefreshTokenService } from './refresh-token-service';
import {
  issueRuntimeToken,
  issueRuntimeTokenPair,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
  readRuntimeTenantClaim,
  runtimeTenantClaims,
} from './runtime-tokens';
import { ServiceJWTStrategy } from './service-jwt-strategy';
import {
  AUTH_CREDENTIAL_GENERATION_CLAIM,
  AUTH_TOKEN_ISSUED_AT_MS_CLAIM,
  assertUserTokenNotInvalidated,
  authCredentialGenerationClaim,
  authTokenIssuedAtClaim,
} from './token-invalidation';

const JWT_SECRET = 'password-token-invalidation-test-secret';
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '30d';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function authTime(ms: number) {
  return { [AUTH_TOKEN_ISSUED_AT_MS_CLAIM]: ms };
}

function expectNoTokenMarker(value: unknown): void {
  expect(value).not.toHaveProperty('tokens_valid_after');
  expect(value).not.toHaveProperty('credential_generation');
}

function expectTokenMarker(value: unknown): void {
  expect(value).toHaveProperty('tokens_valid_after', expect.any(Date));
}

test('treats tokens issued at the invalidation boundary as stale', () => {
  const user = { credential_generation: 0, tokens_valid_after: new Date(1_000) };

  expect(() =>
    assertUserTokenNotInvalidated(user, { sub: 'user-1', type: 'access', ...authTime(1_000) })
  ).toThrow(/Session expired/);
  expect(authTokenIssuedAtClaim(1_000, user)[AUTH_TOKEN_ISSUED_AT_MS_CLAIM]).toBe(1_001);
});

test('requires current user metadata while accepting legacy generation-zero token claims', () => {
  expect(() => assertUserTokenNotInvalidated({}, { sub: 'user-1', type: 'access' })).toThrow(
    /credential metadata unavailable/
  );
  expect(() =>
    assertUserTokenNotInvalidated({ credential_generation: 0 }, { sub: 'user-1', type: 'access' })
  ).not.toThrow();
});

test('rejects a token from an older credential generation without using clocks', () => {
  expect(() =>
    assertUserTokenNotInvalidated(
      { credential_generation: 2 },
      { sub: 'user-1', type: 'access', [AUTH_CREDENTIAL_GENERATION_CLAIM]: 1 }
    )
  ).toThrow(/Session expired/);
  expect(authCredentialGenerationClaim({ credential_generation: 2 })).toEqual({
    [AUTH_CREDENTIAL_GENERATION_CLAIM]: 2,
  });
});

test('runtime tenant helpers preserve standard and custom tenant claims', () => {
  expect(runtimeTenantClaims('tenant-a')).toEqual({ tenant_id: 'tenant-a' });
  expect(runtimeTenantClaims('tenant-a', 'org_id')).toEqual({
    tenant_id: 'tenant-a',
    org_id: 'tenant-a',
  });
  expect(readRuntimeTenantClaim({ org_id: 'tenant-b' }, 'org_id')).toBe('tenant-b');
  expect(readRuntimeTenantClaim({ tenant_id: 'tenant-c' }, 'org_id')).toBe('tenant-c');
  expect(() =>
    readRuntimeTenantClaim({ tenant_id: 'tenant-a', org_id: 'tenant-b' }, 'org_id')
  ).toThrow(/Conflicting signed tenant claims/);
});

function createAuthApp(
  db: Parameters<typeof createUsersService>[0],
  options: { now?: () => number } = {}
) {
  const app = feathers();
  app.set('authentication', {
    secret: JWT_SECRET,
    entity: 'user',
    entityId: 'user_id',
    service: 'users',
    authStrategies: ['jwt', 'local', 'api-key'],
    jwtOptions: {
      header: { typ: 'access' },
      audience: RUNTIME_JWT_AUDIENCE,
      issuer: RUNTIME_JWT_ISSUER,
      algorithm: 'HS256',
      expiresIn: ACCESS_TOKEN_TTL,
    },
    local: {
      usernameField: 'email',
      passwordField: 'password',
    },
  });

  const usersService = createUsersService(db);
  app.use('users', usersService);

  const authentication = new AuthenticationService(app);
  authentication.register('jwt', new ServiceJWTStrategy());
  const localStrategy = new AgorLocalStrategy();
  authentication.register('local', localStrategy);
  const apiKeysRepo = new UserApiKeysRepository(db);
  const apiKeyStrategy = new ApiKeyStrategy();
  apiKeyStrategy.setDependencies(apiKeysRepo, usersService);
  authentication.register('api-key', apiKeyStrategy);
  app.use('authentication', authentication);

  const authService = app.service('authentication') as {
    hooks(hooks: {
      after: {
        create: Array<
          (context: {
            result?: { user?: User; accessToken?: string; refreshToken?: string };
          }) => Promise<unknown> | unknown
        >;
      };
    }): void;
  };
  authService.hooks({
    after: {
      create: [
        createIssueBrowserTokensHook({
          jwtSecret: JWT_SECRET,
          accessTokenTtl: ACCESS_TOKEN_TTL,
          refreshTokenTtl: REFRESH_TOKEN_TTL,
          tenantClaim: 'tenant_id',
          now: options.now,
        }),
      ],
    },
  });

  return { app, usersService, localStrategy, apiKeysRepo };
}

async function createUser(service: UsersService, email: string): Promise<User> {
  return service.create({ email, password: 'old-password-1234', role: ROLES.MEMBER });
}

dbTest('redacts token invalidation marker from external user service responses', async ({ db }) => {
  const usersService = createUsersService(db);
  const admin = await usersService.create({
    email: 'redaction-admin@example.test',
    password: 'test-password-1234',
    role: ROLES.ADMIN,
  });
  const adminParams = {
    provider: 'rest',
    user: { user_id: admin.user_id, email: admin.email, role: admin.role },
  };
  const user = await createUser(usersService, 'redacted-users@example.test');

  const createResult = await usersService.create(
    { email: 'redacted-create@example.test', password: 'test-password-1234', role: ROLES.MEMBER },
    adminParams
  );
  expectNoTokenMarker(createResult);

  const patchResult = await usersService.patch(
    user.user_id,
    { password: 'new-password-1234' },
    adminParams
  );
  expectNoTokenMarker(patchResult);

  const internalUser = await usersService.get(user.user_id);
  expectTokenMarker(internalUser);

  const getResult = await usersService.get(user.user_id, { provider: 'rest' });
  expectNoTokenMarker(getResult);

  const findResult = await usersService.find({ provider: 'rest' });
  expect(findResult.data).toHaveLength(3);
  for (const publicUser of findResult.data) {
    expectNoTokenMarker(publicUser);
  }
});

dbTest(
  'rejects a browser access token issued before the password change marker',
  async ({ db }) => {
    const { app, usersService } = createAuthApp(db);
    const user = await createUser(usersService, 'stale-access@example.test');
    const issuedBefore = Date.now() - 10_000;
    const oldAccessToken = issueRuntimeToken(
      { sub: user.user_id, type: 'access', ...authTime(issuedBefore) },
      JWT_SECRET,
      ACCESS_TOKEN_TTL
    );

    await usersService.patch(user.user_id, { password: 'new-password-1234' });

    await expect(
      app
        .service('authentication')
        .create({ strategy: 'jwt', accessToken: oldAccessToken }, { provider: 'rest' })
    ).rejects.toThrow(/Session expired|not authenticated|Invalid/);
  }
);

dbTest('rejects a refresh token issued before the password change marker', async ({ db }) => {
  const usersService = createUsersService(db);
  const refreshService = createRefreshTokenService({
    jwtSecret: JWT_SECRET,
    accessTokenTtl: ACCESS_TOKEN_TTL,
    refreshTokenTtl: REFRESH_TOKEN_TTL,
    usersService,
  });
  const user = await createUser(usersService, 'stale-refresh@example.test');
  const issuedBefore = Date.now() - 10_000;
  const oldRefreshToken = issueRuntimeToken(
    { sub: user.user_id, type: 'refresh', ...authTime(issuedBefore) },
    JWT_SECRET,
    REFRESH_TOKEN_TTL
  );

  await usersService.patch(user.user_id, { password: 'new-password-1234' });

  await expect(refreshService.create({ refreshToken: oldRefreshToken })).rejects.toThrow(
    /Invalid or expired refresh token/
  );
});

dbTest(
  'rejects a local login whose verified password changes while bcrypt is in flight',
  async ({ db }) => {
    const { app, usersService, localStrategy } = createAuthApp(db);
    const user = await createUser(usersService, 'racing-login@example.test');
    const compared = deferred();
    const release = deferred();
    const comparePassword = localStrategy.comparePassword.bind(localStrategy);
    vi.spyOn(localStrategy, 'comparePassword').mockImplementation(async (entity, password) => {
      const verified = await comparePassword(entity, password);
      compared.resolve();
      await release.promise;
      return verified;
    });

    const login = app
      .service('authentication')
      .create(
        { strategy: 'local', email: user.email, password: 'old-password-1234' },
        { provider: 'rest' }
      );
    await compared.promise;
    await usersService.patch(user.user_id, { password: 'replacement-password-1234' });
    release.resolve();

    await expect(login).rejects.toThrow(/Invalid login/);
  }
);

dbTest(
  'generic user updates cannot restore credential metadata from a stale snapshot',
  async ({ db }) => {
    const { usersService } = createAuthApp(db);
    const user = await createUser(usersService, 'racing-profile-update@example.test');
    const repo = new UsersRepository(db);
    const readSnapshot = deferred();
    const releaseUpdate = deferred();
    const findById = repo.findById.bind(repo);
    vi.spyOn(repo, 'findById').mockImplementation(async (id) => {
      const snapshot = await findById(id);
      readSnapshot.resolve();
      await releaseUpdate.promise;
      return snapshot;
    });

    const oldToken = issueRuntimeToken(
      {
        sub: user.user_id,
        type: 'access',
        [AUTH_CREDENTIAL_GENERATION_CLAIM]: 0,
      },
      JWT_SECRET,
      ACCESS_TOKEN_TTL
    );
    const profileUpdate = repo.update(user.user_id, { name: 'Renamed concurrently' });
    await readSnapshot.promise;
    try {
      await usersService.patch(user.user_id, { password: 'replacement profile race passphrase' });
    } finally {
      releaseUpdate.resolve();
    }
    await expect(profileUpdate).resolves.toMatchObject({ name: 'Renamed concurrently' });

    const row = await select(db).from(users).where(eq(users.user_id, user.user_id)).one();
    expect(row?.credential_generation).toBe(1);
    expect(row?.tokens_valid_after).toEqual(expect.any(Date));
    const decoded = jwt.verify(oldToken, JWT_SECRET) as jwt.JwtPayload;
    expect(() => assertUserTokenNotInvalidated(row!, decoded)).toThrow(/Session expired/);
  }
);

test('a refresh racing a password change can mint only an already-stale generation', async () => {
  const enteredLookup = deferred();
  const releaseLookup = deferred();
  const currentUser = {
    user_id: 'racing-refresh-user' as UserID,
    email: 'racing-refresh@example.test',
    role: ROLES.MEMBER,
    onboarding_completed: true,
    must_change_password: false,
    created_at: new Date(),
    credential_generation: 0,
  } as User & { credential_generation: number };
  const usersService = {
    get: async () => {
      const credentialSnapshot = { ...currentUser };
      enteredLookup.resolve();
      await releaseLookup.promise;
      return credentialSnapshot;
    },
  };
  const refreshService = createRefreshTokenService({
    jwtSecret: JWT_SECRET,
    accessTokenTtl: ACCESS_TOKEN_TTL,
    refreshTokenTtl: REFRESH_TOKEN_TTL,
    usersService,
  });
  const refreshToken = issueRuntimeToken(
    {
      sub: currentUser.user_id,
      type: 'refresh',
      [AUTH_CREDENTIAL_GENERATION_CLAIM]: 0,
    },
    JWT_SECRET,
    REFRESH_TOKEN_TTL
  );

  const refresh = refreshService.create({ refreshToken });
  await enteredLookup.promise;
  currentUser.credential_generation = 1;
  releaseLookup.resolve();
  const result = await refresh;
  const decoded = jwt.verify(result.accessToken, JWT_SECRET) as jwt.JwtPayload;

  expect(decoded[AUTH_CREDENTIAL_GENERATION_CLAIM]).toBe(0);
  expect(() => assertUserTokenNotInvalidated(currentUser, decoded)).toThrow(/Session expired/);
});

test('refresh token lookup is scoped to the tenant claim and reissues tenant-bearing tokens', async () => {
  const user = {
    user_id: 'tenant-user' as UserID,
    email: 'tenant-user@example.test',
    name: 'Tenant User',
    role: ROLES.MEMBER,
    onboarding_completed: true,
    must_change_password: false,
    created_at: new Date(),
    tenant_id: 'tenant-a',
    credential_generation: 0,
  } as User & { tenant_id: string; credential_generation: number };
  const usersService = {
    get: async (_id: UserID, _params?: unknown) => user,
  };
  const getSpy = vi.spyOn(usersService, 'get');
  const refreshService = createRefreshTokenService({
    jwtSecret: JWT_SECRET,
    accessTokenTtl: ACCESS_TOKEN_TTL,
    refreshTokenTtl: REFRESH_TOKEN_TTL,
    tenantClaim: 'tenant_id',
    usersService,
  });
  const refreshToken = issueRuntimeToken(
    { sub: user.user_id, type: 'refresh', tenant_id: 'tenant-a' },
    JWT_SECRET,
    REFRESH_TOKEN_TTL
  );

  const result = await refreshService.create({ refreshToken });

  expect(getSpy).toHaveBeenCalledWith(
    user.user_id,
    expect.objectContaining({
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
      authentication: { payload: expect.objectContaining({ tenant_id: 'tenant-a' }) },
    })
  );
  expectNoTokenMarker(result.user);
  expect(result.user).not.toHaveProperty('tenant_id');
  const decoded = jwt.verify(result.accessToken, JWT_SECRET) as jwt.JwtPayload;
  expect(decoded.tenant_id).toBe('tenant-a');
});

test('refresh rejects a verified token with contradictory canonical and configured tenant claims', async () => {
  const usersService = { get: vi.fn() };
  const refreshService = createRefreshTokenService({
    jwtSecret: JWT_SECRET,
    accessTokenTtl: ACCESS_TOKEN_TTL,
    refreshTokenTtl: REFRESH_TOKEN_TTL,
    tenantClaim: 'org_id',
    usersService: usersService as never,
  });
  const refreshToken = issueRuntimeToken(
    {
      sub: 'tenant-user',
      type: 'refresh',
      tenant_id: 'tenant-a',
      org_id: 'tenant-b',
    },
    JWT_SECRET,
    REFRESH_TOKEN_TTL
  );

  await expect(refreshService.create({ refreshToken })).rejects.toThrow(
    /Invalid or expired refresh token/
  );
  expect(usersService.get).not.toHaveBeenCalled();
});

dbTest(
  'admin password reset invalidates the target user access and refresh tokens',
  async ({ db }) => {
    const { app, usersService } = createAuthApp(db);
    const refreshService = createRefreshTokenService({
      jwtSecret: JWT_SECRET,
      accessTokenTtl: ACCESS_TOKEN_TTL,
      refreshTokenTtl: REFRESH_TOKEN_TTL,
      usersService,
    });
    const target = await createUser(usersService, 'admin-reset-target@example.test');
    const admin = await usersService.create({
      email: 'admin@example.test',
      password: 'admin-password-1234',
      role: ROLES.ADMIN,
    });
    const issuedBefore = Date.now() - 10_000;
    const oldTokens = issueRuntimeTokenPair(
      target,
      JWT_SECRET,
      ACCESS_TOKEN_TTL,
      REFRESH_TOKEN_TTL,
      authTime(issuedBefore)
    );

    await usersService.patch(
      target.user_id,
      { password: 'admin-reset-password-1234' },
      {
        provider: 'rest',
        authenticated: true,
        user: { user_id: admin.user_id, email: admin.email, role: admin.role },
      }
    );

    await expect(
      app
        .service('authentication')
        .create({ strategy: 'jwt', accessToken: oldTokens.accessToken }, { provider: 'rest' })
    ).rejects.toThrow();
    await expect(refreshService.create({ refreshToken: oldTokens.refreshToken })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
  }
);

dbTest('fresh login after forced password change gets usable tokens', async ({ db }) => {
  const { app, usersService } = createAuthApp(db);
  const user = await createUser(usersService, 'fresh-login@example.test');

  await usersService.patch(user.user_id, { password: 'new-password-1234' });

  const loginResult = await app
    .service('authentication')
    .create(
      { strategy: 'local', email: user.email, password: 'new-password-1234' },
      { provider: 'rest' }
    );
  expect(loginResult.user.email).toBe(user.email);
  expectNoTokenMarker(loginResult.user);

  const accessResult = await app
    .service('authentication')
    .create({ strategy: 'jwt', accessToken: loginResult.accessToken }, { provider: 'rest' });
  expect(accessResult.user.email).toBe(user.email);
  expectNoTokenMarker(accessResult.user);

  const refreshResult = await createRefreshTokenService({
    jwtSecret: JWT_SECRET,
    accessTokenTtl: ACCESS_TOKEN_TTL,
    refreshTokenTtl: REFRESH_TOKEN_TTL,
    usersService,
  }).create({ refreshToken: loginResult.refreshToken });
  expect(refreshResult.user.email).toBe(user.email);
  expectNoTokenMarker(refreshResult.user);

  const decoded = jwt.verify(refreshResult.accessToken, JWT_SECRET) as jwt.JwtPayload;
  expect(decoded[AUTH_TOKEN_ISSUED_AT_MS_CLAIM]).toEqual(expect.any(Number));
  expect(decoded[AUTH_CREDENTIAL_GENERATION_CLAIM]).toBe(1);
});

dbTest(
  'API-key login after a password change issues usable current-generation tokens',
  async ({ db }) => {
    const { app, usersService, apiKeysRepo } = createAuthApp(db);
    const user = await createUser(usersService, 'api-key-generation@example.test');
    await usersService.patch(user.user_id, { password: 'replacement api key passphrase' });
    const { rawKey } = await apiKeysRepo.create(user.user_id, 'Generation regression');

    const loginResult = await app.service('authentication').create(
      { strategy: 'api-key', apiKey: rawKey },
      {
        provider: 'rest',
        tenant: { tenant_id: 'default', source: 'auth_claim' },
      }
    );
    expectNoTokenMarker(loginResult.user);
    for (const token of [loginResult.accessToken, loginResult.refreshToken]) {
      const decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
      expect(decoded[AUTH_CREDENTIAL_GENERATION_CLAIM]).toBe(1);
    }

    const accessResult = await app
      .service('authentication')
      .create({ strategy: 'jwt', accessToken: loginResult.accessToken }, { provider: 'rest' });
    expect(accessResult.user.email).toBe(user.email);

    const refreshResult = await createRefreshTokenService({
      jwtSecret: JWT_SECRET,
      accessTokenTtl: ACCESS_TOKEN_TTL,
      refreshTokenTtl: REFRESH_TOKEN_TTL,
      usersService,
    }).create({ refreshToken: loginResult.refreshToken });
    expect(refreshResult.user.email).toBe(user.email);
    expect(
      (jwt.verify(refreshResult.accessToken, JWT_SECRET) as jwt.JwtPayload)[
        AUTH_CREDENTIAL_GENERATION_CLAIM
      ]
    ).toBe(1);
  }
);

dbTest(
  'local login uses auth metadata when issuing tokens at the invalidation boundary',
  async ({ db }) => {
    const marker = new Date(Date.now() + 1_000);
    const { app, usersService } = createAuthApp(db, { now: () => marker.getTime() });
    const user = await createUser(usersService, 'local-boundary@example.test');
    await update(db, users)
      .set({ tokens_valid_after: marker })
      .where(eq(users.user_id, user.user_id))
      .run();

    const loginResult = await app.service('authentication').create(
      {
        strategy: 'local',
        email: user.email,
        password: 'old-password-1234',
      },
      { provider: 'rest' }
    );

    expectNoTokenMarker(loginResult.user);
    const decoded = jwt.verify(loginResult.accessToken, JWT_SECRET) as jwt.JwtPayload;
    expect(decoded[AUTH_TOKEN_ISSUED_AT_MS_CLAIM]).toBe(marker.getTime() + 1);

    const accessResult = await app
      .service('authentication')
      .create({ strategy: 'jwt', accessToken: loginResult.accessToken }, { provider: 'rest' });
    expect(accessResult.user.email).toBe(user.email);
    expectNoTokenMarker(accessResult.user);
  }
);
