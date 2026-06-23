import { AuthenticationService, feathers } from '@agor/core/feathers';
import type { User, UserID } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { expect, test } from 'vitest';
import { eq, update, users } from '../../../../packages/core/src/db';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { AgorLocalStrategy } from '../register-routes';
import { createUsersService, type UsersService } from '../services/users';
import { createRefreshTokenService } from './refresh-token-service';
import {
  issueRuntimeToken,
  issueRuntimeTokenPair,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
} from './runtime-tokens';
import { ServiceJWTStrategy } from './service-jwt-strategy';
import {
  AUTH_TOKEN_ISSUED_AT_MS_CLAIM,
  assertUserTokenNotInvalidated,
  authTokenIssuedAtClaim,
} from './token-invalidation';
import { redactUserAuthMetadata } from './user-redaction';

const JWT_SECRET = 'password-token-invalidation-test-secret';
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '30d';

function authTime(ms: number) {
  return { [AUTH_TOKEN_ISSUED_AT_MS_CLAIM]: ms };
}

function expectNoTokenMarker(value: unknown): void {
  expect(value).not.toHaveProperty('tokens_valid_after');
}

function expectTokenMarker(value: unknown): void {
  expect(value).toHaveProperty('tokens_valid_after', expect.any(Date));
}

test('treats tokens issued at the invalidation boundary as stale', () => {
  const user = { tokens_valid_after: new Date(1_000) };

  expect(() =>
    assertUserTokenNotInvalidated(user, { sub: 'user-1', type: 'access', ...authTime(1_000) })
  ).toThrow(/Session expired/);
  expect(authTokenIssuedAtClaim(1_000, user)[AUTH_TOKEN_ISSUED_AT_MS_CLAIM]).toBe(1_001);
});

function createAuthApp(db: Parameters<typeof createUsersService>[0]) {
  const app = feathers();
  app.set('authentication', {
    secret: JWT_SECRET,
    entity: 'user',
    entityId: 'user_id',
    service: 'users',
    authStrategies: ['jwt', 'local'],
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
  authentication.register('local', new AgorLocalStrategy());
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
        async (context) => {
          if (context.result?.user) {
            const tokens = issueRuntimeTokenPair(
              context.result.user,
              JWT_SECRET,
              ACCESS_TOKEN_TTL,
              REFRESH_TOKEN_TTL,
              authTokenIssuedAtClaim(Date.now(), context.result.user)
            );
            context.result.accessToken = tokens.accessToken;
            context.result.refreshToken = tokens.refreshToken;
            context.result.user = redactUserAuthMetadata(context.result.user);
          }
          return context;
        },
      ],
    },
  });

  return { app, usersService };
}

async function createUser(service: UsersService, email: string): Promise<User> {
  return service.create({ email, password: 'old-password-1234', role: ROLES.MEMBER });
}

dbTest('redacts token invalidation marker from external user service responses', async ({ db }) => {
  const usersService = createUsersService(db);
  const user = await createUser(usersService, 'redacted-users@example.test');

  const createResult = await usersService.create(
    { email: 'redacted-create@example.test', password: 'password-1234', role: ROLES.MEMBER },
    { provider: 'rest' }
  );
  expectNoTokenMarker(createResult);

  const patchResult = await usersService.patch(
    user.user_id,
    { password: 'new-password-1234' },
    { provider: 'rest' }
  );
  expectNoTokenMarker(patchResult);

  const internalUser = await usersService.get(user.user_id);
  expectTokenMarker(internalUser);

  const getResult = await usersService.get(user.user_id, { provider: 'rest' });
  expectNoTokenMarker(getResult);

  const findResult = await usersService.find({ provider: 'rest' });
  expect(findResult.data).toHaveLength(2);
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
        user: { user_id: 'admin-user' as UserID, email: 'admin@example.test', role: ROLES.ADMIN },
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
});

dbTest(
  'local login uses auth metadata when issuing tokens at the invalidation boundary',
  async ({ db }) => {
    const { app, usersService } = createAuthApp(db);
    const user = await createUser(usersService, 'local-boundary@example.test');
    const marker = new Date(Date.now() + 1_000);
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
