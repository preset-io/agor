import type { User, UserID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIssueBrowserTokensHook } from './issue-browser-tokens-hook';
import { createRefreshTokenService } from './refresh-token-service';
import { issueRuntimeToken, RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from './runtime-tokens';
import {
  AUTH_LAUNCH_SUBJECT_CLAIM,
  AUTH_REVALIDATED_AT_MS_CLAIM,
  AUTH_SESSION_STARTED_AT_MS_CLAIM,
} from './session-lifetime';

const JWT_SECRET = 'session-lifetime-test-secret';
const DAY_SECONDS = 24 * 60 * 60;
const DAY_MS = DAY_SECONDS * 1000;
const MAX_LIFETIME_SECONDS = 30 * DAY_SECONDS;
const REFRESH_TTL_SECONDS = 30 * DAY_SECONDS;
const T0 = Date.UTC(2026, 0, 1);

const user = {
  user_id: 'user-1' as UserID,
  email: 'user@example.test',
  role: 'admin',
  credential_generation: 0,
} as unknown as User;

const usersService = { get: vi.fn(async () => user) };

function verify(token: string) {
  return jwt.verify(token, JWT_SECRET, {
    issuer: RUNTIME_JWT_ISSUER,
    audience: RUNTIME_JWT_AUDIENCE,
  }) as Record<string, number | string>;
}

function refreshService(sessionMaxLifetimeSeconds = MAX_LIFETIME_SECONDS) {
  return createRefreshTokenService({
    jwtSecret: JWT_SECRET,
    accessTokenTtl: '15m',
    refreshTokenTtl: REFRESH_TTL_SECONDS,
    sessionMaxLifetimeSeconds,
    usersService,
  });
}

function hook(sessionMaxLifetimeSeconds = MAX_LIFETIME_SECONDS) {
  return createIssueBrowserTokensHook({
    jwtSecret: JWT_SECRET,
    accessTokenTtl: '15m',
    refreshTokenTtl: REFRESH_TTL_SECONDS,
    sessionMaxLifetimeSeconds,
    tenantClaim: 'tenant_id',
  });
}

async function login(strategy = 'local', payload?: Record<string, unknown>) {
  const context = {
    params: {},
    result: {
      accessToken: 'presented',
      user: { ...user },
      authentication: { strategy, ...(payload ? { payload } : {}) },
    },
  };
  return (await hook()(context)).result as { accessToken: string; refreshToken: string };
}

function launchedRefreshToken(startedAtMs = T0) {
  return issueRuntimeToken(
    {
      sub: user.user_id,
      type: 'refresh',
      [AUTH_SESSION_STARTED_AT_MS_CLAIM]: startedAtMs,
      [AUTH_LAUNCH_SUBJECT_CLAIM]: 'user:cloud-1',
    },
    JWT_SECRET,
    REFRESH_TTL_SECONDS
  );
}

describe('absolute browser session lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the original launch time of a session across refreshes and stops at the bound', async () => {
    vi.setSystemTime(T0 + 20 * DAY_MS);
    const first = await refreshService().create({ refreshToken: launchedRefreshToken() });
    const firstPayload = verify(first.refreshToken);
    expect(firstPayload[AUTH_SESSION_STARTED_AT_MS_CLAIM]).toBe(T0);
    // The refresh cannot slide: it ends at launch + 30 days, not now + 30 days.
    expect(firstPayload.exp).toBe(T0 / 1000 + MAX_LIFETIME_SECONDS);
    expect(verify(first.accessToken)[AUTH_SESSION_STARTED_AT_MS_CLAIM]).toBe(T0);

    vi.setSystemTime(T0 + 30 * DAY_MS - 60_000);
    const last = await refreshService().create({ refreshToken: first.refreshToken });
    expect(verify(last.accessToken).exp).toBe(T0 / 1000 + MAX_LIFETIME_SECONDS);

    vi.setSystemTime(T0 + 30 * DAY_MS);
    await expect(refreshService().create({ refreshToken: last.refreshToken })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
  });

  function refreshServiceReachingDeadline(deadlineSeconds: number) {
    return createRefreshTokenService({
      jwtSecret: JWT_SECRET,
      accessTokenTtl: '15m',
      refreshTokenTtl: REFRESH_TTL_SECONDS,
      sessionMaxLifetimeSeconds: MAX_LIFETIME_SECONDS,
      usersService,
      // The second ticks over between the deferral and the signing.
      revalidateLaunchSession: async () => {
        vi.setSystemTime(deadlineSeconds * 1000);
        return {
          launchSubject: 'user:cloud-1',
          revalidatedAtMs: T0,
          notAfterSeconds: deadlineSeconds,
        };
      },
    });
  }

  it('answers a retryable 503 when the outage grace runs out during the refresh', async () => {
    const graceEnd = T0 / 1000 + 3_600;
    vi.setSystemTime((graceEnd - 1) * 1000);
    await expect(
      refreshServiceReachingDeadline(graceEnd).create({ refreshToken: launchedRefreshToken() })
    ).rejects.toMatchObject({ code: 503 });
  });

  it('still answers 401 when the session deadline is what runs out during the refresh', async () => {
    const sessionDeadline = T0 / 1000 + MAX_LIFETIME_SECONDS;
    vi.setSystemTime((sessionDeadline - 1) * 1000);
    await expect(
      refreshServiceReachingDeadline(sessionDeadline).create({
        refreshToken: launchedRefreshToken(),
      })
    ).rejects.toMatchObject({ code: 401 });
  });

  it('rejects a launched refresh token past a shorter configured bound', async () => {
    const token = launchedRefreshToken();
    vi.setSystemTime(T0 + 2 * 60 * 60 * 1000);
    await expect(refreshService(60 * 60).create({ refreshToken: token })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
  });

  it('rejects a launched refresh token with a malformed session start', async () => {
    const forged = issueRuntimeToken(
      {
        sub: user.user_id,
        type: 'refresh',
        [AUTH_SESSION_STARTED_AT_MS_CLAIM]: 'later',
        [AUTH_LAUNCH_SUBJECT_CLAIM]: 'user:cloud-1',
      },
      JWT_SECRET,
      REFRESH_TTL_SECONDS
    );
    await expect(refreshService().create({ refreshToken: forged })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
  });

  it('never caps a password session: refresh slides past the bound with no new claims', async () => {
    const signIn = await login();
    expect(verify(signIn.refreshToken)).not.toHaveProperty(AUTH_SESSION_STARTED_AT_MS_CLAIM);
    expect(verify(signIn.refreshToken).exp).toBe(T0 / 1000 + REFRESH_TTL_SECONDS);

    let refreshToken = signIn.refreshToken;
    for (const day of [20, 40, 60, 80]) {
      vi.setSystemTime(T0 + day * DAY_MS);
      const refreshed = await refreshService().create({ refreshToken });
      refreshToken = refreshed.refreshToken;
      const payload = verify(refreshToken);
      expect(payload.exp).toBe((T0 + day * DAY_MS) / 1000 + REFRESH_TTL_SECONDS);
      expect(payload).not.toHaveProperty(AUTH_SESSION_STARTED_AT_MS_CLAIM);
      expect(payload).not.toHaveProperty(AUTH_LAUNCH_SUBJECT_CLAIM);
    }
  });

  it('JWT re-authentication of a password session still gets a fresh access token', async () => {
    const signIn = await login();
    const presented = verify(signIn.accessToken);
    vi.setSystemTime(T0 + 10 * 60 * 1000);
    const reauth = await login('jwt', presented);
    expect(verify(reauth.accessToken).exp).toBe((T0 + 10 * 60 * 1000) / 1000 + 15 * 60);
    expect(verify(reauth.refreshToken)).not.toHaveProperty(AUTH_SESSION_STARTED_AT_MS_CLAIM);
  });

  it('JWT re-authentication of any session never extends access once refresh revalidates', async () => {
    const signIn = await login();
    const presented = verify(signIn.accessToken);
    vi.setSystemTime(T0 + 10 * 60 * 1000);
    const context = {
      params: {},
      result: {
        accessToken: 'presented',
        user: { ...user },
        authentication: { strategy: 'jwt', payload: presented },
      },
    };
    const pinned = await createIssueBrowserTokensHook({
      jwtSecret: JWT_SECRET,
      accessTokenTtl: '15m',
      refreshTokenTtl: REFRESH_TTL_SECONDS,
      sessionMaxLifetimeSeconds: MAX_LIFETIME_SECONDS,
      pinReauthenticatedAccessExpiry: true,
      tenantClaim: 'tenant_id',
    })(context);
    expect(verify(pinned.result.accessToken).exp).toBe(presented.exp);
  });

  it('JWT re-authentication of a launched session keeps its start and never extends access', async () => {
    const launched = issueRuntimeToken(
      {
        sub: user.user_id,
        type: 'access',
        [AUTH_SESSION_STARTED_AT_MS_CLAIM]: T0,
        [AUTH_LAUNCH_SUBJECT_CLAIM]: 'user:cloud-1',
        [AUTH_REVALIDATED_AT_MS_CLAIM]: T0,
      },
      JWT_SECRET,
      '15m'
    );
    const presented = verify(launched);
    vi.setSystemTime(T0 + 10 * 60 * 1000);
    const reauth = await login('jwt', presented);
    const access = verify(reauth.accessToken);
    expect(access.exp).toBe(presented.exp);
    expect(access[AUTH_SESSION_STARTED_AT_MS_CLAIM]).toBe(T0);
    expect(verify(reauth.refreshToken)[AUTH_LAUNCH_SUBJECT_CLAIM]).toBe('user:cloud-1');
    // The outage grace stays anchored to the last confirmation.
    expect(verify(reauth.refreshToken)[AUTH_REVALIDATED_AT_MS_CLAIM]).toBe(T0);
    expect(verify(reauth.refreshToken).exp).toBeLessThanOrEqual(T0 / 1000 + MAX_LIFETIME_SECONDS);
  });

  it('JWT re-authentication of a launched session fails past the absolute bound', async () => {
    const launched = issueRuntimeToken(
      {
        sub: user.user_id,
        type: 'access',
        [AUTH_SESSION_STARTED_AT_MS_CLAIM]: T0 - 31 * DAY_MS,
        [AUTH_LAUNCH_SUBJECT_CLAIM]: 'user:cloud-1',
      },
      JWT_SECRET,
      '15m'
    );
    await expect(login('jwt', verify(launched))).rejects.toThrow(/Session expired/);
  });

  it('impersonation re-auth is unchanged without revalidation and never refreshable with it', async () => {
    const impersonation = verify(
      issueRuntimeToken(
        { sub: user.user_id, type: 'access', is_impersonated: true },
        JWT_SECRET,
        3600
      )
    );
    const unchanged = await login('jwt', impersonation);
    expect(unchanged.refreshToken).toEqual(expect.any(String));

    const context = {
      params: {},
      result: {
        accessToken: 'presented',
        user: { ...user },
        authentication: { strategy: 'jwt', payload: impersonation },
      },
    };
    const revalidating = await createIssueBrowserTokensHook({
      jwtSecret: JWT_SECRET,
      accessTokenTtl: '15m',
      refreshTokenTtl: REFRESH_TTL_SECONDS,
      sessionMaxLifetimeSeconds: MAX_LIFETIME_SECONDS,
      pinReauthenticatedAccessExpiry: true,
      tenantClaim: 'tenant_id',
    })(context);
    expect(revalidating.result.accessToken).toBe('presented');
    expect(revalidating.result).not.toHaveProperty('refreshToken');
  });
});
