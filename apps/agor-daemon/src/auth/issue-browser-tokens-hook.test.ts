import jwt from 'jsonwebtoken';
import { expect, test } from 'vitest';
import { createIssueBrowserTokensHook } from './issue-browser-tokens-hook';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from './runtime-tokens';

const JWT_SECRET = 'issue-browser-tokens-hook-test-secret';
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '30d';
const ORIGINAL_TOKEN = 'original-machine-token';

function makeHook() {
  return createIssueBrowserTokensHook({
    jwtSecret: JWT_SECRET,
    accessTokenTtl: ACCESS_TOKEN_TTL,
    refreshTokenTtl: REFRESH_TOKEN_TTL,
    tenantClaim: 'tenant_id',
  });
}

function makeUser() {
  return {
    user_id: 'user-1',
    email: 'user@example.com',
    tokens_valid_after: new Date(0),
    password: 'hashed-secret',
  };
}

function makeContext(payloadType?: string, strategy = 'jwt') {
  return {
    params: {},
    result: {
      accessToken: ORIGINAL_TOKEN,
      user: makeUser(),
      authentication: {
        strategy,
        ...(payloadType ? { payload: { sub: 'user-1', type: payloadType } } : {}),
      },
    },
  };
}

function verifyToken(token: string) {
  return jwt.verify(token, JWT_SECRET, {
    issuer: RUNTIME_JWT_ISSUER,
    audience: RUNTIME_JWT_AUDIENCE,
  }) as Record<string, unknown>;
}

function expectRedactedUser(user: unknown): void {
  expect(user).not.toHaveProperty('tokens_valid_after');
  expect(user).not.toHaveProperty('password');
}

test('executor-session login keeps its original access token and gets no refresh token', async () => {
  const context = makeContext('executor-session');

  const result = (await makeHook()(context)).result;

  expect(result.accessToken).toBe(ORIGINAL_TOKEN);
  expect(result).not.toHaveProperty('refreshToken');
  expectRedactedUser(result.user);
});

test('service login keeps its original access token and gets no refresh token', async () => {
  const context = makeContext('service');

  const result = (await makeHook()(context)).result;

  expect(result.accessToken).toBe(ORIGINAL_TOKEN);
  expect(result).not.toHaveProperty('refreshToken');
  expectRedactedUser(result.user);
});

test('local login receives a browser access + refresh token pair', async () => {
  const context = makeContext(undefined, 'local');

  const result = (await makeHook()(context)).result;

  expect(result.accessToken).not.toBe(ORIGINAL_TOKEN);
  expect(result.refreshToken).toEqual(expect.any(String));
  expectRedactedUser(result.user);

  const accessPayload = verifyToken(result.accessToken);
  expect(accessPayload.type).toBe('access');
  expect(accessPayload.sub).toBe('user-1');

  const refreshPayload = verifyToken(result.refreshToken);
  expect(refreshPayload.type).toBe('refresh');
  expect(refreshPayload.sub).toBe('user-1');
});

test('api-key login (no JWT payload) receives a browser access + refresh token pair', async () => {
  const context = makeContext(undefined, 'api-key');

  const result = (await makeHook()(context)).result;

  expect(result.accessToken).not.toBe(ORIGINAL_TOKEN);
  expect(result.refreshToken).toEqual(expect.any(String));
  expectRedactedUser(result.user);

  const accessPayload = verifyToken(result.accessToken);
  expect(accessPayload.type).toBe('access');
  expect(accessPayload.sub).toBe('user-1');
});

test('params.tenant tenant_id propagates into both minted tokens', async () => {
  const context = makeContext(undefined, 'local');
  context.params = { tenant: { tenant_id: 'tenant-1' } };

  const result = (await makeHook()(context)).result;

  expect(verifyToken(result.accessToken).tenant_id).toBe('tenant-1');
  expect(verifyToken(result.refreshToken).tenant_id).toBe('tenant-1');
});

test('user.tenant_id is the fallback tenant claim when params carry no tenant', async () => {
  const context = makeContext(undefined, 'local');
  context.result.user = { ...makeUser(), tenant_id: 'tenant-2' };

  const result = (await makeHook()(context)).result;

  expect(verifyToken(result.accessToken).tenant_id).toBe('tenant-2');
});

test('browser jwt re-auth (payload.type=access) still receives a fresh token pair', async () => {
  const context = makeContext('access');

  const result = (await makeHook()(context)).result;

  expect(result.accessToken).not.toBe(ORIGINAL_TOKEN);
  expect(result.refreshToken).toEqual(expect.any(String));
  expectRedactedUser(result.user);

  const accessPayload = verifyToken(result.accessToken);
  expect(accessPayload.type).toBe('access');
  expect(accessPayload.sub).toBe('user-1');
});

test('result without a user is left untouched', async () => {
  const context = {
    params: {},
    result: { accessToken: ORIGINAL_TOKEN, authentication: { strategy: 'jwt' } },
  };

  const result = (await makeHook()(context)).result;

  expect(result.accessToken).toBe(ORIGINAL_TOKEN);
  expect(result).not.toHaveProperty('refreshToken');
  expect(result).not.toHaveProperty('user');
});
