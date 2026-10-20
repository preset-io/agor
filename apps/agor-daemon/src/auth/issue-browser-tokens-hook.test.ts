import { analyticsLogger } from '@agor/core/analytics';
import { getCurrentTenantId } from '@agor/core/db';
import jwt from 'jsonwebtoken';
import { afterEach, expect, test, vi } from 'vitest';
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
    staticTenantId: 'default',
  });
}

function makeUser() {
  return {
    user_id: 'user-1',
    email: 'user@example.com',
    credential_generation: 0,
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

test('interactive issuance fails closed when an authentication strategy returns a redacted user', async () => {
  const context = makeContext(undefined, 'api-key');
  delete (context.result.user as { credential_generation?: number }).credential_generation;

  await expect(makeHook()(context)).rejects.toThrow(/credential metadata unavailable/);
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

test('socket-provider login never mints and discards a browser token pair', async () => {
  const context = makeContext('access');
  context.params = { provider: 'socketio' };

  const result = (await makeHook()(context)).result;

  expect(result.accessToken).toBe(ORIGINAL_TOKEN);
  expect(result).not.toHaveProperty('refreshToken');
  expectRedactedUser(result.user);
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

afterEach(() => vi.restoreAllMocks());

test('records exactly one local success after token issuance, with trusted tenant identity', async () => {
  const seen = vi.fn();
  vi.spyOn(analyticsLogger, 'track').mockImplementation((...args) =>
    seen(getCurrentTenantId(), ...args)
  );
  const context = makeContext(undefined, 'local');
  context.params = { tenant: { tenant_id: 'tenant-a' } };
  await makeHook()(context);
  expect(seen.mock.calls).toEqual([
    ['tenant-a', 'auth.login_succeeded', { method: 'local' }, { userId: 'user-1' }],
  ]);
});

test('records configured static-tenant local sign-ins without inventing a Cloud tenant', async () => {
  const seen = vi.fn();
  vi.spyOn(analyticsLogger, 'track').mockImplementation(() => seen(getCurrentTenantId()));
  await makeHook()(makeContext(undefined, 'local'));
  expect(seen).toHaveBeenCalledExactlyOnceWith('default');
  seen.mockClear();
  const noFallback = createIssueBrowserTokensHook({
    jwtSecret: JWT_SECRET,
    accessTokenTtl: ACCESS_TOKEN_TTL,
    refreshTokenTtl: REFRESH_TOKEN_TTL,
    tenantClaim: 'tenant_id',
  });
  await noFallback(makeContext(undefined, 'local'));
  expect(seen).not.toHaveBeenCalled();
});

test('does not record JWT revalidation/reconnect, API keys, machine tokens, or failed issuance', async () => {
  const track = vi.spyOn(analyticsLogger, 'track');
  for (const context of [
    makeContext('access'),
    makeContext('executor-session'),
    makeContext('service'),
    makeContext(undefined, 'api-key'),
    { ...makeContext(undefined, 'local'), params: { provider: 'socketio' } },
  ]) {
    await makeHook()(context);
  }
  const failed = makeContext(undefined, 'local');
  delete (failed.result.user as { credential_generation?: number }).credential_generation;
  await expect(makeHook()(failed)).rejects.toThrow();
  expect(track).not.toHaveBeenCalled();
});
