import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgorConfig, resolveExternalLaunchSettings } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import {
  createDatabase,
  eq,
  executeRaw,
  initializeDatabase,
  select,
  sql,
  UserApiKeysRepository,
  userExternalIdentities,
  users,
} from '@agor/core/db';
import type { InternalUser, User, UserID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS,
  API_KEY_MEMBERSHIP_RETRY_MS,
  createApiKeyMembershipCheck,
} from './api-key-membership-check.js';
import { ApiKeyStrategy } from './api-key-strategy.js';
import { finalizeAuthenticatedConnectionAuthority } from './authenticated-connection-authority.js';
import { createIssueBrowserTokensHook } from './issue-browser-tokens-hook.js';
import {
  createLaunchAuthService,
  createLaunchProjectionSerializer,
  createLaunchSessionRevalidator,
  LAUNCH_REVALIDATION_OUTAGE_GRACE_SECONDS,
  LaunchMembershipRefusedError,
  launchSessionsAreRevalidated,
  resolveLaunchConnectionBounds,
} from './launch-auth.js';
import { createRefreshTokenService } from './refresh-token-service.js';
import { issueRuntimeToken, RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from './runtime-tokens.js';
import {
  AUTH_LAUNCH_SUBJECT_CLAIM,
  AUTH_REVALIDATED_AT_MS_CLAIM,
  AUTH_SESSION_STARTED_AT_MS_CLAIM,
} from './session-lifetime.js';
import {
  AUTH_CREDENTIAL_GENERATION_CLAIM,
  AUTH_TOKEN_ISSUED_AT_MS_CLAIM,
  assertUserTokenNotInvalidated,
} from './token-invalidation.js';

const ASSERTION_SECRET = 'test-launch-assertion-secret';
const RUNTIME_JWT_SECRET = 'test-runtime-jwt-secret';
const ISSUER = 'https://issuer.example.test';
const EXCHANGE_URL = `${ISSUER}/exchange`;
const REVALIDATION_URL = `${ISSUER}/sessions/revalidate`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

function cloudConfig(overrides: Partial<NonNullable<AgorConfig['external_launch']>> = {}) {
  return {
    database: { dialect: 'postgresql' as const },
    multi_tenancy: { mode: 'required_from_auth' as const, auth_claim: 'tenant_id' },
    identity: {
      user_lifecycle: 'external',
      role_authority: 'claims',
      local_auth: 'disabled',
      external: { provider: 'external_launch', provisioning: 'jit' },
    },
    execution: { allow_superadmin: true },
    external_launch: {
      enabled: true,
      exchange_url: EXCHANGE_URL,
      session_revalidation_url: REVALIDATION_URL,
      issuer: ISSUER,
      audience: 'runtime:test',
      provider_id: 'agor-cloud',
      dev_shared_secret: ASSERTION_SECRET,
      service_credential: 'cell-credential',
      allow_admin_roles: true,
      ...overrides,
    },
  } as AgorConfig;
}

function assertion(overrides: Record<string, unknown> = {}, secret = ASSERTION_SECRET) {
  return jwt.sign(
    {
      sub: 'user:cloud-1',
      email: 'person@example.test',
      name: 'Cloud User',
      role: 'admin',
      tenant_id: 'tenant-a',
      ...overrides,
    },
    secret,
    { algorithm: 'HS256', expiresIn: '60s', issuer: ISSUER, audience: 'runtime:test' }
  );
}

function revalidation(overrides: Record<string, unknown> = {}, secret = ASSERTION_SECRET) {
  return assertion({ purpose: 'session_revalidation', ...overrides }, secret);
}

type RevalidationHandler = (body: Record<string, unknown>, init: RequestInit) => Response;

function stubIssuer(state: { exchange: string; revalidate: RevalidationHandler }) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === EXCHANGE_URL) return Response.json({ assertion: state.exchange });
    if (url === REVALIDATION_URL) {
      return state.revalidate(JSON.parse(String(init.body)) as Record<string, unknown>, init);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function makeUsersService(db: Database) {
  return {
    async get(id: UserID): Promise<InternalUser> {
      const row = await select(db).from(users).where(eq(users.user_id, id)).one();
      if (!row) throw new Error('missing user');
      return {
        user_id: row.user_id as UserID,
        email: row.email,
        name: row.name ?? undefined,
        role: row.role as User['role'],
        onboarding_completed: row.onboarding_completed,
        must_change_password: row.must_change_password,
        credential_generation: row.credential_generation,
        tokens_valid_after: row.tokens_valid_after ? new Date(row.tokens_valid_after) : undefined,
        created_at: row.created_at,
      };
    },
  };
}

function verify(token: string) {
  return jwt.verify(token, RUNTIME_JWT_SECRET, {
    issuer: RUNTIME_JWT_ISSUER,
    audience: RUNTIME_JWT_AUDIENCE,
  }) as Record<string, unknown>;
}

describe('refresh-time launch membership revalidation', () => {
  let db: Database;
  let dir: string;
  const invalidated = vi.fn();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agor-launch-revalidation-test-'));
    db = createDatabase({ url: `file:${join(dir, 'test.db')}` });
    await initializeDatabase(db);
    invalidated.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function services(config = cloudConfig()) {
    const { settings, error } = resolveExternalLaunchSettings(config);
    if (error) throw new Error(error);
    const serializeProjection = createLaunchProjectionSerializer();
    const usersService = makeUsersService(db);
    const launch = createLaunchAuthService({
      db,
      config,
      provider: settings,
      jwtSecret: RUNTIME_JWT_SECRET,
      accessTokenTtl: '15m',
      refreshTokenTtl: MAX_LIFETIME_SECONDS,
      sessionMaxLifetimeSeconds: MAX_LIFETIME_SECONDS,
      usersService,
      serializeProjection,
    });
    const revalidateLaunchSession = createLaunchSessionRevalidator({
      db,
      config,
      provider: settings,
      serializeProjection,
      onAuthorizationInvalidated: invalidated,
    });
    const refresh = createRefreshTokenService({
      jwtSecret: RUNTIME_JWT_SECRET,
      accessTokenTtl: '15m',
      refreshTokenTtl: MAX_LIFETIME_SECONDS,
      sessionMaxLifetimeSeconds: MAX_LIFETIME_SECONDS,
      usersService,
      revalidateLaunchSession,
    });
    return { launch, refresh, revalidateLaunchSession, usersService };
  }

  /** Real key verification followed by the real `POST /authentication` token hook. */
  function apiKeySignIn(usersService: ReturnType<typeof makeUsersService>) {
    const keys = new UserApiKeysRepository(db);
    const strategy = new ApiKeyStrategy();
    strategy.setDependencies(keys, usersService, db);
    const hook = createIssueBrowserTokensHook({
      jwtSecret: RUNTIME_JWT_SECRET,
      accessTokenTtl: '15m',
      refreshTokenTtl: MAX_LIFETIME_SECONDS,
      sessionMaxLifetimeSeconds: MAX_LIFETIME_SECONDS,
      tenantClaim: 'tenant_id',
    });
    const params = { tenant: { tenant_id: 'tenant-a' } };
    return {
      keys,
      strategy,
      authenticate: (apiKey: string) => strategy.authenticate({ apiKey }, params),
      signIn: async (apiKey: string) => {
        const result = await strategy.authenticate({ apiKey }, params);
        return (await hook({ params, result })).result;
      },
    };
  }

  async function readRole(userId: string) {
    const row = await select(db).from(users).where(eq(users.user_id, userId)).one();
    return row?.role;
  }

  it('is disabled unless external launch configures a revalidation URL', () => {
    const { settings } = resolveExternalLaunchSettings(
      cloudConfig({ session_revalidation_url: undefined })
    );
    expect(
      createLaunchSessionRevalidator({
        db,
        config: cloudConfig(),
        provider: settings,
        serializeProjection: createLaunchProjectionSerializer(),
      })
    ).toBeUndefined();
  });

  it('rejects refresh once the issuer reports the membership removed or suspended', async () => {
    const state = {
      exchange: assertion(),
      revalidate: (() => Response.json({ assertion: revalidation() })) as RevalidationHandler,
    };
    const fetchMock = stubIssuer(state);
    const { launch, refresh } = services();
    const signedIn = await launch.create({ launchCode: 'code' });
    expect(verify(signedIn.refreshToken)[AUTH_LAUNCH_SUBJECT_CLAIM]).toBe('user:cloud-1');

    const ok = await refresh.create({ refreshToken: signedIn.refreshToken });
    const call = fetchMock.mock.calls.find(([url]) => url === REVALIDATION_URL);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      subject: 'user:cloud-1',
      tenant_id: 'tenant-a',
      audience: 'runtime:test',
    });
    expect((call?.[1]?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      'Bearer cell-credential'
    );

    state.revalidate = () => Response.json({ error: 'membership_inactive' }, { status: 403 });
    await expect(refresh.create({ refreshToken: ok.refreshToken })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
    // An earlier refresh token of the same session is rejected too.
    await expect(refresh.create({ refreshToken: signedIn.refreshToken })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
  });

  it('deletes personal API keys on a refusal, so they neither authenticate nor mint browser tokens', async () => {
    const state = {
      exchange: assertion(),
      revalidate: (() => Response.json({ assertion: revalidation() })) as RevalidationHandler,
    };
    stubIssuer(state);
    const all = services();
    const signedIn = await all.launch.create({ launchCode: 'code' });
    const { keys, authenticate, signIn } = apiKeySignIn(all.usersService);
    const { rawKey } = await keys.create(signedIn.user.user_id, 'laptop');
    await expect(authenticate(rawKey)).resolves.toMatchObject({
      authentication: { strategy: 'api-key' },
    });

    state.revalidate = () => Response.json({ error: 'membership_inactive' }, { status: 403 });
    await expect(all.refresh.create({ refreshToken: signedIn.refreshToken })).rejects.toThrow(
      /Invalid or expired refresh token/
    );

    await expect(keys.listByUser(signedIn.user.user_id)).resolves.toEqual([]);
    await expect(authenticate(rawKey)).rejects.toThrow(/Invalid API key/);
    await expect(signIn(rawKey)).rejects.toThrow(/Invalid API key/);
  });

  describe('direct personal API key use', () => {
    async function keyHolder(state: { exchange: string; revalidate: RevalidationHandler }) {
      const fetchMock = stubIssuer(state);
      const all = services();
      const signedIn = await all.launch.create({ launchCode: 'code' });
      const { keys, authenticate, strategy, signIn } = apiKeySignIn(all.usersService);
      strategy.setMembershipCheck(
        createApiKeyMembershipCheck({ revalidate: all.revalidateLaunchSession! })
      );
      const { rawKey } = await keys.create(signedIn.user.user_id, 'laptop');
      const issuerCalls = () =>
        fetchMock.mock.calls.filter(([url]) => url === REVALIDATION_URL).length;
      return { all, signedIn, keys, authenticate, signIn, rawKey, issuerCalls };
    }

    const member = () => ({
      exchange: assertion(),
      revalidate: (() => Response.json({ assertion: revalidation() })) as RevalidationHandler,
    });
    const refused = () => Response.json({ error: 'membership_inactive' }, { status: 403 });
    const down = () => new Response('bad gateway', { status: 502 });

    it('cuts off a removed user who never refreshes', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.parse('2026-06-01T10:00:00Z'));
        const state = member();
        const { signedIn, keys, authenticate, signIn, rawKey, issuerCalls } =
          await keyHolder(state);

        await expect(authenticate(rawKey)).resolves.toMatchObject({
          authentication: { strategy: 'api-key' },
        });
        expect(issuerCalls()).toBe(1);

        state.revalidate = refused;
        // Inside the interval the key still works, and the issuer isn't asked again.
        vi.advanceTimersByTime(API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS - 1);
        await expect(authenticate(rawKey)).resolves.toBeDefined();
        expect(issuerCalls()).toBe(1);

        vi.advanceTimersByTime(1);
        await expect(authenticate(rawKey)).rejects.toMatchObject({
          name: 'NotAuthenticated',
          message: 'Invalid API key',
        });
        await expect(keys.listByUser(signedIn.user.user_id)).resolves.toEqual([]);
        expect(invalidated).toHaveBeenCalledWith('tenant-a', signedIn.user.user_id);
        // The same fence as a refresh refusal: browser tokens stop working too.
        const row = await select(db)
          .from(users)
          .where(eq(users.user_id, signedIn.user.user_id))
          .one();
        expect(row?.credential_generation).toBe(1);
        await expect(signIn(rawKey)).rejects.toThrow(/Invalid API key/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses to mint browser tokens for a removed user on first use', async () => {
      const state = member();
      const { signIn, rawKey } = await keyHolder(state);
      state.revalidate = refused;
      await expect(signIn(rawKey)).rejects.toThrow(/Invalid API key/);
    });

    it('applies a demotion from the issuer to the request that found it', async () => {
      const state = member();
      const { signedIn, authenticate, rawKey } = await keyHolder(state);
      expect(signedIn.user.role).toBe('admin');
      state.revalidate = () => Response.json({ assertion: revalidation({ role: 'member' }) });
      await expect(authenticate(rawKey)).resolves.toMatchObject({ user: { role: 'member' } });
      expect(invalidated).toHaveBeenCalledWith('tenant-a', signedIn.user.user_id);
    });

    it('allows the outage grace after a confirmation, then returns a retryable 503', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const start = Date.parse('2026-06-01T10:00:00Z');
        vi.setSystemTime(start);
        const state = member();
        const { signedIn, keys, authenticate, rawKey } = await keyHolder(state);
        await authenticate(rawKey);

        state.revalidate = down;
        vi.setSystemTime(start + API_KEY_MEMBERSHIP_CHECK_INTERVAL_MS);
        await expect(authenticate(rawKey)).resolves.toBeDefined();

        vi.setSystemTime(start + LAUNCH_REVALIDATION_OUTAGE_GRACE_SECONDS * 1000);
        await expect(authenticate(rawKey)).rejects.toMatchObject({ code: 503 });
        // An outage never costs the user their key, and it recovers on its own.
        await expect(keys.listByUser(signedIn.user.user_id)).resolves.toHaveLength(1);
        state.revalidate = () => Response.json({ assertion: revalidation() });
        vi.advanceTimersByTime(API_KEY_MEMBERSHIP_RETRY_MS);
        await expect(authenticate(rawKey)).resolves.toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns 503 when the issuer has never confirmed the user on this replica', async () => {
      const state = member();
      const { authenticate, rawKey } = await keyHolder(state);
      state.revalidate = down;
      await expect(authenticate(rawKey)).rejects.toMatchObject({ code: 503 });
    });

    it('marks only a membership refusal as one', async () => {
      const state = member();
      const { all } = await keyHolder(state);
      const payload = {
        sub: 'x',
        tenant_id: 'tenant-a',
        [AUTH_LAUNCH_SUBJECT_CLAIM]: 'user:cloud-1',
      };
      const revalidate = (userId: UserID) =>
        all.revalidateLaunchSession!({ userId, payload }).catch((error: unknown) => error);
      const row = await select(db).from(users).one();
      const userId = row?.user_id as UserID;

      state.revalidate = () => Response.json({ assertion: 'not-a-jwt' });
      const badResponse = await revalidate(userId);
      expect(badResponse).toMatchObject({ name: 'NotAuthenticated' });
      expect(badResponse).not.toBeInstanceOf(LaunchMembershipRefusedError);

      state.revalidate = refused;
      await expect(revalidate(userId)).resolves.toBeInstanceOf(LaunchMembershipRefusedError);
    });

    it('leaves keys of accounts with no launch identity alone', async () => {
      const state = member();
      const { keys, authenticate, issuerCalls } = await keyHolder(state);
      const localId = 'local-user-1' as UserID;
      await executeRaw(
        db,
        sql`INSERT INTO users (user_id, email, password, name, role, created_at, data) VALUES (${localId}, 'local@example.test', 'x', 'Local', 'member', ${Date.now()}, '{}')`
      );
      const { rawKey: localKey } = await keys.create(localId, 'laptop');
      state.revalidate = refused;
      await expect(authenticate(localKey)).resolves.toMatchObject({ user: { user_id: localId } });
      expect(issuerCalls()).toBe(0);
      await expect(keys.listByUser(localId)).resolves.toHaveLength(1);
    });
  });

  it('skips the user write when the assertion changes nothing and keeps last_login_at', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.parse('2026-06-01T10:00:00Z');
      vi.setSystemTime(start);
      const state = {
        exchange: assertion({ picture: 'https://cdn.example.test/a.png' }),
        revalidate: (() =>
          Response.json({
            assertion: revalidation({ picture: 'https://cdn.example.test/a.png' }),
          })) as RevalidationHandler,
      };
      stubIssuer(state);
      const config = cloudConfig();
      const { launch, refresh } = services(config);
      const signedIn = await launch.create({ launchCode: 'code' });
      const readRows = async () => {
        const row = await select(db)
          .from(users)
          .where(eq(users.user_id, signedIn.user.user_id))
          .one();
        const binding = await select(db)
          .from(userExternalIdentities)
          .where(eq(userExternalIdentities.user_id, signedIn.user.user_id))
          .one();
        return { row, binding };
      };
      const before = await readRows();

      vi.setSystemTime(start + 3_600_000);
      await refresh.create({ refreshToken: signedIn.refreshToken });
      const unchanged = await readRows();
      expect(unchanged.row?.updated_at).toEqual(before.row?.updated_at);
      expect(unchanged.row?.data).toEqual(before.row?.data);
      expect(unchanged.binding?.updated_at).toEqual(before.binding?.updated_at);

      // A real change is written, but a refresh still isn't a sign-in.
      state.revalidate = () => Response.json({ assertion: revalidation({ name: 'New Name' }) });
      vi.setSystemTime(start + 7_200_000);
      await refresh.create({ refreshToken: signedIn.refreshToken });
      const changed = await readRows();
      expect(changed.row?.name).toBe('New Name');
      expect(changed.row?.updated_at).not.toEqual(before.row?.updated_at);
      expect(changed.binding?.name).toBe('New Name');
      expect(changed.binding?.last_login_at).toEqual(before.binding?.last_login_at);
      const identityLogin = (row: typeof before.row) =>
        (row?.data as { external_identities?: Array<{ last_login_at: string }> })
          ?.external_identities?.[0]?.last_login_at;
      expect(identityLogin(changed.row)).toBe(identityLogin(before.row));

      // A launch is a sign-in and moves it.
      vi.setSystemTime(start + 10_800_000);
      state.exchange = assertion({ name: 'New Name' });
      await launch.create({ launchCode: 'code-2' });
      const relaunched = await readRows();
      expect(relaunched.binding?.last_login_at).not.toEqual(before.binding?.last_login_at);
      expect(identityLogin(relaunched.row)).not.toBe(identityLogin(before.row));
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a demotion on refresh instead of re-issuing the old role', async () => {
    const state = {
      exchange: assertion({ role: 'admin' }),
      revalidate: (() =>
        Response.json({ assertion: revalidation({ role: 'member' }) })) as RevalidationHandler,
    };
    stubIssuer(state);
    const { launch, refresh } = services();
    const signedIn = await launch.create({ launchCode: 'code' });
    expect(await readRole(signedIn.user.user_id)).toBe('admin');

    const refreshed = await refresh.create({ refreshToken: signedIn.refreshToken });
    expect(refreshed.user.role).toBe('member');
    expect(await readRole(signedIn.user.user_id)).toBe('member');
    expect(invalidated).toHaveBeenCalledExactlyOnceWith('tenant-a', signedIn.user.user_id);

    invalidated.mockReset();
    await refresh.create({ refreshToken: refreshed.refreshToken });
    expect(invalidated).not.toHaveBeenCalled();
  });

  it('tolerates an unavailable issuer only inside the outage grace after the last confirmation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.UTC(2026, 0, 1);
      vi.setSystemTime(start);
      const state = {
        exchange: assertion(),
        revalidate: (() => {
          throw new TypeError('fetch failed');
        }) as RevalidationHandler,
      };
      stubIssuer(state);
      const { launch, refresh } = services();
      const signedIn = await launch.create({ launchCode: 'code' });
      expect(verify(signedIn.refreshToken)[AUTH_REVALIDATED_AT_MS_CLAIM]).toBe(start);
      const graceEnd = start / 1000 + LAUNCH_REVALIDATION_OUTAGE_GRACE_SECONDS;

      vi.setSystemTime(start + 20 * 60 * 1000);
      const deferred = await refresh.create({ refreshToken: signedIn.refreshToken });
      // The outage never moves the last confirmation and caps the session at the grace end.
      expect(verify(deferred.refreshToken)[AUTH_REVALIDATED_AT_MS_CLAIM]).toBe(start);
      // Only access is capped: the refresh token must survive past the grace to retry.
      expect(verify(deferred.refreshToken).exp).toBe(start / 1000 + MAX_LIFETIME_SECONDS);
      vi.setSystemTime(start + 55 * 60 * 1000);
      const nearGraceEnd = await refresh.create({ refreshToken: deferred.refreshToken });
      expect(verify(nearGraceEnd.accessToken).exp).toBe(graceEnd);
      vi.setSystemTime(start + 20 * 60 * 1000);
      for (const answer of [
        () => Response.json({ error: 'unavailable' }, { status: 503 }),
        () => Response.json({ error: 'not_found' }, { status: 404 }),
        () => Response.json({ error: 'origin_required' }, { status: 403 }),
        () => Response.json({ error: 'cell_exchange_credential_invalid' }, { status: 403 }),
        () => new Response('denied', { status: 401 }),
        () => Response.json({}),
        () => new Response('<html>bad gateway</html>', { status: 200 }),
      ]) {
        state.revalidate = answer;
        await expect(refresh.create({ refreshToken: deferred.refreshToken })).resolves.toBeTruthy();
      }

      // Past the grace nothing is issued, but the 503 tells the client to keep its tokens.
      vi.setSystemTime(start + LAUNCH_REVALIDATION_OUTAGE_GRACE_SECONDS * 1000);
      await expect(refresh.create({ refreshToken: signedIn.refreshToken })).rejects.toMatchObject({
        code: 503,
      });
      // A token already deferred during the outage also gets the retryable answer, not a 401.
      await expect(refresh.create({ refreshToken: deferred.refreshToken })).rejects.toMatchObject({
        code: 503,
      });

      // Recovery confirms membership again and restarts the grace clock.
      vi.setSystemTime(start + 50 * 60 * 1000);
      state.revalidate = () => Response.json({ assertion: revalidation() });
      const recovered = await refresh.create({ refreshToken: deferred.refreshToken });
      expect(verify(recovered.refreshToken)[AUTH_REVALIDATED_AT_MS_CLAIM]).toBe(
        start + 50 * 60 * 1000
      );
      const warnings = vi.mocked(console.warn).mock.calls.map(([line]) => String(line));
      expect(warnings).toContain(
        '[auth.refresh] session_revalidation_deferred reason=issuer_unavailable'
      );
      expect(warnings).toContain(
        '[auth.refresh] session_revalidation_deferred reason=response_invalid'
      );
      expect(warnings.join('\n')).not.toContain('cell-credential');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never applies the outage grace to a refusal, a bad assertion or a token without a confirmation', async () => {
    const state = {
      exchange: assertion(),
      revalidate: (() =>
        Response.json({ assertion: revalidation({}, 'wrong-signing-key') })) as RevalidationHandler,
    };
    stubIssuer(state);
    const { launch, refresh, usersService } = services();
    const signedIn = await launch.create({ launchCode: 'code' });
    const attempt = () => refresh.create({ refreshToken: signedIn.refreshToken });
    await expect(attempt()).rejects.toThrow(/Invalid or expired refresh token/);
    // A login assertion (no revalidation purpose) is never accepted for a refresh.
    state.revalidate = () => Response.json({ assertion: assertion() });
    await expect(attempt()).rejects.toThrow(/Invalid or expired refresh token/);
    // Another device of the same user, signed in before the refusal.
    const otherDevice = await launch.create({ launchCode: 'other-device' });
    state.revalidate = () => Response.json({ error: 'membership_inactive' }, { status: 403 });
    await expect(attempt()).rejects.toThrow(/Invalid or expired refresh token/);
    expect(invalidated).toHaveBeenCalledWith('tenant-a', signedIn.user.user_id);
    // The refusal fences every earlier token of the user, even if the issuer later answers.
    state.revalidate = () => Response.json({ assertion: revalidation() });
    await expect(refresh.create({ refreshToken: otherDevice.refreshToken })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
    // The other device's access token fails the same fence every API and socket request checks.
    const fencedUser = await usersService.get(signedIn.user.user_id);
    expect(() =>
      assertUserTokenNotInvalidated(fencedUser, verify(otherDevice.accessToken))
    ).toThrow(/Session expired/);
    // Same fence as a password change: a racing refresh or fast clock can't mint a surviving token.
    const fencedRow = await select(db)
      .from(users)
      .where(eq(users.user_id, signedIn.user.user_id))
      .one();
    expect(fencedRow?.credential_generation).toBe(1);
    const racedAfterFence = issueRuntimeToken(
      {
        sub: signedIn.user.user_id,
        type: 'refresh',
        tenant_id: 'tenant-a',
        [AUTH_CREDENTIAL_GENERATION_CLAIM]: 0,
        [AUTH_TOKEN_ISSUED_AT_MS_CLAIM]: Date.now() + 60_000,
        [AUTH_LAUNCH_SUBJECT_CLAIM]: 'user:cloud-1',
        [AUTH_REVALIDATED_AT_MS_CLAIM]: Date.now(),
      },
      RUNTIME_JWT_SECRET,
      3600
    );
    await expect(refresh.create({ refreshToken: racedAfterFence })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
    expect(() => assertUserTokenNotInvalidated(fencedUser, verify(racedAfterFence))).toThrow(
      /Session expired/
    );
    const relaunched = await launch.create({ launchCode: 'after-readd' });
    await expect(refresh.create({ refreshToken: relaunched.refreshToken })).resolves.toBeTruthy();

    state.revalidate = () => Response.json({ error: 'unavailable' }, { status: 503 });
    const unconfirmed = issueRuntimeToken(
      {
        sub: signedIn.user.user_id,
        type: 'refresh',
        tenant_id: 'tenant-a',
        [AUTH_CREDENTIAL_GENERATION_CLAIM]: 1,
        [AUTH_TOKEN_ISSUED_AT_MS_CLAIM]: Date.now() + 1_000,
        [AUTH_LAUNCH_SUBJECT_CLAIM]: 'user:cloud-1',
      },
      RUNTIME_JWT_SECRET,
      3600
    );
    await expect(refresh.create({ refreshToken: unconfirmed })).rejects.toMatchObject({
      code: 503,
    });
    const warnings = vi.mocked(console.warn).mock.calls.map(([line]) => String(line));
    expect(warnings).toContain(
      '[auth.refresh] session_revalidation_failed reason=assertion_rejected'
    );
    expect(warnings).toContain(
      '[auth.refresh] session_revalidation_failed reason=membership_refused'
    );
    expect(warnings).toContain(
      '[auth.refresh] session_revalidation_failed reason=issuer_unavailable'
    );
  });

  it('a launch refuses a revalidation-purpose assertion', async () => {
    stubIssuer({ exchange: revalidation(), revalidate: vi.fn() });
    const { launch } = services();
    await expect(launch.create({ launchCode: 'code' })).rejects.toThrow();
    expect(await select(db).from(users).all()).toHaveLength(0);
  });

  it('verifies RS256 assertions over JWKS and treats an unreachable JWKS as an outage', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
    const sign = (overrides: Record<string, unknown> = {}, keyid: string | undefined = 'k1') =>
      jwt.sign(
        {
          sub: 'user:cloud-1',
          email: 'person@example.test',
          role: 'member',
          tenant_id: 'tenant-a',
          ...overrides,
        },
        privateKey,
        {
          algorithm: 'RS256',
          ...(keyid ? { keyid } : {}),
          expiresIn: '60s',
          issuer: ISSUER,
          audience: 'runtime:test',
        }
      );
    let jwksUp = true;
    let publishedKeys: unknown[] = [jwk];
    let revalidationAssertion = () => sign({ purpose: 'session_revalidation' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === JWKS_URL) {
          if (!jwksUp) throw new TypeError('fetch failed');
          return Response.json({ keys: publishedKeys });
        }
        if (url === EXCHANGE_URL) return Response.json({ assertion: sign() });
        return Response.json({ assertion: revalidationAssertion() });
      })
    );
    const { launch, refresh } = services(
      cloudConfig({ dev_shared_secret: undefined, jwks_url: JWKS_URL })
    );
    const signedIn = await launch.create({ launchCode: 'code' });
    const refreshed = await refresh.create({ refreshToken: signedIn.refreshToken });
    expect(refreshed.user.role).toBe('member');

    jwksUp = false;
    const deferred = await refresh.create({ refreshToken: refreshed.refreshToken });
    expect(verify(deferred.refreshToken)[AUTH_REVALIDATED_AT_MS_CLAIM]).toBe(
      verify(refreshed.refreshToken)[AUTH_REVALIDATED_AT_MS_CLAIM]
    );
    const warnings = vi.mocked(console.warn).mock.calls.map(([line]) => String(line));
    expect(warnings).toContain(
      '[auth.refresh] session_revalidation_deferred reason=verification_key_unavailable'
    );

    jwksUp = true;
    vi.mocked(console.warn).mockClear();
    // A key not published yet is an outage, not a bad assertion.
    revalidationAssertion = () => sign({ purpose: 'session_revalidation' }, 'unpublished');
    await expect(refresh.create({ refreshToken: refreshed.refreshToken })).resolves.toBeTruthy();
    expect(vi.mocked(console.warn).mock.calls.map(([line]) => String(line))).toEqual([
      '[auth.refresh] session_revalidation_deferred reason=verification_key_unavailable',
    ]);

    // Malformed assertions get no grace, even with a recent confirmation.
    for (const malformed of ['not-a-jwt', sign({ purpose: 'session_revalidation' }, '')]) {
      vi.mocked(console.warn).mockClear();
      revalidationAssertion = () => malformed;
      await expect(refresh.create({ refreshToken: refreshed.refreshToken })).rejects.toThrow(
        /Invalid or expired refresh token/
      );
      expect(vi.mocked(console.warn).mock.calls.map(([line]) => String(line))).toEqual([
        '[auth.refresh] session_revalidation_failed reason=assertion_rejected',
      ]);
    }

    // A published but unusable key fails closed, with no outage grace.
    revalidationAssertion = () => sign({ purpose: 'session_revalidation' });
    for (const unusable of [
      { kid: 'k1', kty: 'bogus' },
      { ...jwk, use: 'enc' },
      { ...jwk, alg: 'RS512' },
    ]) {
      vi.mocked(console.warn).mockClear();
      publishedKeys = [unusable];
      await expect(refresh.create({ refreshToken: refreshed.refreshToken })).rejects.toThrow(
        /Invalid or expired refresh token/
      );
      expect(vi.mocked(console.warn).mock.calls.map(([line]) => String(line))).toEqual([
        '[auth.refresh] session_revalidation_failed reason=assertion_rejected',
      ]);
    }
  });

  it('bounds user sockets by the outage grace only when revalidation is configured', () => {
    const authResult = {
      user: { user_id: 'user-1' },
      authentication: { strategy: 'jwt', payload: { exp: Date.now() / 1000 + 60 } },
    };
    const plain = finalizeAuthenticatedConnectionAuthority({ connection: {}, authResult });
    expect(plain.retireAtExpiry).toBe(false);
    const before = Date.now();
    const bounded = finalizeAuthenticatedConnectionAuthority({
      connection: {},
      authResult,
      userConnectionMaxAgeMs: 3_600_000,
    });
    expect(bounded.retireAtExpiry).toBe(true);
    expect(bounded.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(bounded.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);

    // A launched session retires at the earlier of its deadline and the max age.
    const startedAtMs = Date.now() - 1_000_000;
    const launchedResult = {
      user: { user_id: 'user-1' },
      authentication: {
        strategy: 'jwt',
        payload: {
          exp: Date.now() / 1000 + 60,
          [AUTH_LAUNCH_SUBJECT_CLAIM]: 'user:cloud-1',
          [AUTH_SESSION_STARTED_AT_MS_CLAIM]: startedAtMs,
        },
      },
    };
    const capped = finalizeAuthenticatedConnectionAuthority({
      connection: {},
      authResult: launchedResult,
      userConnectionMaxAgeMs: 3_600_000,
      launchedSessionMaxLifetimeSeconds: 1_600,
    });
    expect(capped.retireAtExpiry).toBe(true);
    expect(capped.expiresAt).toBe((Math.floor(startedAtMs / 1000) + 1_600) * 1000);

    // A session with no launch subject stays open as before.
    expect(
      finalizeAuthenticatedConnectionAuthority({
        connection: {},
        authResult,
        launchedSessionMaxLifetimeSeconds: 1_600,
      }).retireAtExpiry
    ).toBe(false);

    // A malformed start fails the handshake rather than leaving the socket unbounded.
    expect(() =>
      finalizeAuthenticatedConnectionAuthority({
        connection: {},
        authResult: {
          user: { user_id: 'user-1' },
          authentication: {
            strategy: 'jwt',
            payload: {
              exp: Date.now() / 1000 + 60,
              [AUTH_LAUNCH_SUBJECT_CLAIM]: 'user:cloud-1',
              [AUTH_SESSION_STARTED_AT_MS_CLAIM]: 'later',
            },
          },
        },
        launchedSessionMaxLifetimeSeconds: 1_600,
      })
    ).toThrow(/Session expired/);
  });

  it('rejects an assertion for another subject without projecting it onto a local user', async () => {
    const state = {
      exchange: assertion(),
      revalidate: (() =>
        Response.json({
          assertion: revalidation({ sub: 'user:cloud-2', email: 'other@example.test' }),
        })) as RevalidationHandler,
    };
    stubIssuer(state);
    const { launch, refresh } = services();
    const signedIn = await launch.create({ launchCode: 'code' });
    await expect(refresh.create({ refreshToken: signedIn.refreshToken })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
    expect(await select(db).from(users).all()).toHaveLength(1);
  });

  it('binds the check to the signed tenant: membership in tenant A cannot keep tenant B alive', async () => {
    const state = {
      exchange: assertion({ tenant_id: 'tenant-b', role: 'member' }),
      // The issuer only knows an active membership in tenant A.
      revalidate: ((body) =>
        body.tenant_id === 'tenant-a'
          ? Response.json({ assertion: revalidation({ tenant_id: 'tenant-a' }) })
          : Response.json(
              { error: 'membership_inactive' },
              { status: 403 }
            )) as RevalidationHandler,
    };
    stubIssuer(state);
    const { launch, refresh } = services();
    const inB = await launch.create({ launchCode: 'code-b' });
    const handler = state.revalidate;

    // An issuer answer for tenant A is never accepted for a tenant B session.
    state.revalidate = () => Response.json({ assertion: revalidation({ tenant_id: 'tenant-a' }) });
    await expect(refresh.create({ refreshToken: inB.refreshToken })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
    const warnings = vi.mocked(console.warn).mock.calls.map(([line]) => String(line));
    expect(warnings).toContain('[auth.refresh] session_revalidation_failed reason=tenant_mismatch');

    // The issuer is asked about tenant B, where the subject is not a member.
    state.revalidate = handler;
    await expect(refresh.create({ refreshToken: inB.refreshToken })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
    expect(invalidated).toHaveBeenCalledWith('tenant-b', inB.user.user_id);

    // The same subject's tenant A session still refreshes.
    state.exchange = assertion({ tenant_id: 'tenant-a' });
    const inA = await launch.create({ launchCode: 'code-a' });
    await expect(refresh.create({ refreshToken: inA.refreshToken })).resolves.toMatchObject({
      user: { user_id: inA.user.user_id },
    });
  });

  it('revalidates a pre-upgrade launch token through its stored identity binding', async () => {
    const state = {
      exchange: assertion(),
      revalidate: (() =>
        Response.json({ error: 'membership_inactive' }, { status: 403 })) as RevalidationHandler,
    };
    const fetchMock = stubIssuer(state);
    const { launch, refresh } = services();
    const signedIn = await launch.create({ launchCode: 'code' });
    const legacy = issueRuntimeToken(
      {
        sub: signedIn.user.user_id,
        type: 'refresh',
        tenant_id: 'tenant-a',
        [AUTH_CREDENTIAL_GENERATION_CLAIM]: 0,
      },
      RUNTIME_JWT_SECRET,
      3600
    );
    state.revalidate = () => Response.json({ assertion: revalidation() });
    const refreshed = await refresh.create({ refreshToken: legacy });
    expect(verify(refreshed.refreshToken)[AUTH_LAUNCH_SUBJECT_CLAIM]).toBe('user:cloud-1');
    // Once revalidated it is a launched session, anchored at its own issue time.
    const legacyIssuedAtMs = (verify(legacy).iat as number) * 1000;
    expect(verify(refreshed.refreshToken)[AUTH_SESSION_STARTED_AT_MS_CLAIM]).toBe(legacyIssuedAtMs);
    expect(verify(refreshed.refreshToken).exp as number).toBeLessThanOrEqual(
      legacyIssuedAtMs / 1000 + MAX_LIFETIME_SECONDS
    );
    const call = fetchMock.mock.calls.find(([url]) => url === REVALIDATION_URL);
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ subject: 'user:cloud-1' });

    state.revalidate = () => Response.json({ error: 'membership_inactive' }, { status: 403 });
    await expect(refresh.create({ refreshToken: legacy })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
  });

  it('treats a database error during projection as an outage, not a refusal', async () => {
    stubIssuer({
      exchange: assertion(),
      revalidate: () => Response.json({ assertion: revalidation() }),
    });
    const config = cloudConfig();
    const { settings } = resolveExternalLaunchSettings(config);
    const revalidate = createLaunchSessionRevalidator({
      db,
      config,
      provider: settings,
      serializeProjection: async () => {
        throw new Error('connection terminated');
      },
    });
    const confirmedAt = Date.now() - 60_000;
    await expect(
      revalidate?.({
        userId: 'user-1' as UserID,
        payload: {
          sub: 'user-1',
          type: 'refresh',
          tenant_id: 'tenant-a',
          [AUTH_LAUNCH_SUBJECT_CLAIM]: 'user:cloud-1',
          [AUTH_REVALIDATED_AT_MS_CLAIM]: confirmedAt,
        },
      })
    ).resolves.toMatchObject({ launchSubject: 'user:cloud-1', revalidatedAtMs: confirmedAt });
    const warnings = vi.mocked(console.warn).mock.calls.map(([line]) => String(line));
    expect(warnings).toContain(
      '[auth.refresh] session_revalidation_deferred reason=projection_unavailable'
    );
  });

  it('rejects a pre-upgrade launch token already past the lifetime even when the issuer approves', async () => {
    stubIssuer({
      exchange: assertion(),
      revalidate: () => Response.json({ assertion: revalidation() }),
    });
    const { launch, refresh } = services();
    const signedIn = await launch.create({ launchCode: 'code' });
    const legacy = issueRuntimeToken(
      {
        sub: signedIn.user.user_id,
        type: 'refresh',
        tenant_id: 'tenant-a',
        [AUTH_CREDENTIAL_GENERATION_CLAIM]: 0,
        [AUTH_TOKEN_ISSUED_AT_MS_CLAIM]: Date.now() - (MAX_LIFETIME_SECONDS + 60) * 1000,
      },
      RUNTIME_JWT_SECRET,
      3600
    );
    await expect(refresh.create({ refreshToken: legacy })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
  });

  it('gives a projection-rule refusal or identity mismatch no outage grace', async () => {
    stubIssuer({
      exchange: assertion(),
      revalidate: (body) =>
        Response.json({ assertion: revalidation({ sub: body.subject as string }) }),
    });
    const { launch, revalidateLaunchSession } = services();
    const signedIn = await launch.create({ launchCode: 'code' });
    const payload = (userId: string, subject: string) => ({
      sub: userId,
      type: 'refresh',
      tenant_id: 'tenant-a',
      [AUTH_LAUNCH_SUBJECT_CLAIM]: subject,
      [AUTH_REVALIDATED_AT_MS_CLAIM]: Date.now() - 60_000,
    });
    // An unbound subject is refused by the projection rules.
    await expect(
      revalidateLaunchSession?.({
        userId: signedIn.user.user_id as UserID,
        payload: payload(signedIn.user.user_id, 'user:never-bound'),
      })
    ).rejects.toThrow(/Invalid or expired refresh token/);
    // A subject bound to a different local user never projects onto this one.
    await expect(
      revalidateLaunchSession?.({
        userId: 'other-user' as UserID,
        payload: payload('other-user', 'user:cloud-1'),
      })
    ).rejects.toThrow(/Invalid or expired refresh token/);
    const warnings = vi.mocked(console.warn).mock.calls.map(([line]) => String(line));
    expect(warnings).toContain(
      '[auth.refresh] session_revalidation_failed reason=projection_rejected'
    );
    expect(warnings).toContain(
      '[auth.refresh] session_revalidation_failed reason=identity_mismatch'
    );
  });

  it('classifies a real database failure inside the projection as an outage', async () => {
    stubIssuer({
      exchange: assertion(),
      revalidate: () => Response.json({ assertion: revalidation() }),
    });
    const { launch, revalidateLaunchSession } = services();
    const signedIn = await launch.create({ launchCode: 'code' });
    await executeRaw(db, sql.raw('DROP TABLE user_external_identities'));
    const confirmedAt = Date.now() - 60_000;
    await expect(
      revalidateLaunchSession?.({
        userId: signedIn.user.user_id as UserID,
        payload: {
          sub: signedIn.user.user_id,
          type: 'refresh',
          tenant_id: 'tenant-a',
          [AUTH_LAUNCH_SUBJECT_CLAIM]: 'user:cloud-1',
          [AUTH_REVALIDATED_AT_MS_CLAIM]: confirmedAt,
        },
      })
    ).resolves.toMatchObject({ revalidatedAtMs: confirmedAt });
    const warnings = vi.mocked(console.warn).mock.calls.map(([line]) => String(line));
    expect(warnings).toContain(
      '[auth.refresh] session_revalidation_deferred reason=projection_unavailable'
    );
  });

  it('refreshes an unlinked account on a revalidating install under local rules', async () => {
    const fetchMock = stubIssuer({
      exchange: assertion(),
      revalidate: () => Response.json({ assertion: revalidation() }),
    });
    const { launch, refresh } = services();
    const signedIn = await launch.create({ launchCode: 'code' });
    await executeRaw(db, sql.raw('DELETE FROM user_external_identities'));
    await executeRaw(db, sql.raw("UPDATE users SET data = '{}'"));
    const local = issueRuntimeToken(
      {
        sub: signedIn.user.user_id,
        type: 'refresh',
        tenant_id: 'tenant-a',
        [AUTH_CREDENTIAL_GENERATION_CLAIM]: 0,
      },
      RUNTIME_JWT_SECRET,
      3600
    );
    const refreshed = await refresh.create({ refreshToken: local });
    expect(verify(refreshed.refreshToken)).not.toHaveProperty(AUTH_SESSION_STARTED_AT_MS_CLAIM);
    expect(verify(refreshed.refreshToken)).not.toHaveProperty(AUTH_LAUNCH_SUBJECT_CLAIM);
    expect(fetchMock.mock.calls.filter(([url]) => url === REVALIDATION_URL)).toHaveLength(0);
  });

  it('revalidates a session whose identity exists only in the legacy JSON list', async () => {
    const fetchMock = stubIssuer({
      exchange: assertion(),
      revalidate: () => Response.json({ assertion: revalidation() }),
    });
    const { launch, refresh } = services();
    const signedIn = await launch.create({ launchCode: 'code' });
    await executeRaw(db, sql.raw('DELETE FROM user_external_identities'));
    const legacy = issueRuntimeToken(
      {
        sub: signedIn.user.user_id,
        type: 'refresh',
        tenant_id: 'tenant-a',
        [AUTH_CREDENTIAL_GENERATION_CLAIM]: 0,
      },
      RUNTIME_JWT_SECRET,
      3600
    );
    const refreshed = await refresh.create({ refreshToken: legacy });
    expect(verify(refreshed.refreshToken)[AUTH_LAUNCH_SUBJECT_CLAIM]).toBe('user:cloud-1');
    expect(fetchMock.mock.calls.filter(([url]) => url === REVALIDATION_URL)).toHaveLength(1);
  });

  it('refuses to guess between two different subjects at the same issuer', async () => {
    stubIssuer({
      exchange: assertion(),
      revalidate: () => Response.json({ assertion: revalidation() }),
    });
    const { launch, refresh } = services();
    const signedIn = await launch.create({ launchCode: 'code' });
    const identities = JSON.stringify({
      external_identities: [
        { key: 'k2', provider: 'agor-cloud', issuer: ISSUER, subject: 'user:cloud-2' },
      ],
    });
    await executeRaw(db, sql.raw(`UPDATE users SET data = '${identities}'`));
    const legacy = issueRuntimeToken(
      {
        sub: signedIn.user.user_id,
        type: 'refresh',
        tenant_id: 'tenant-a',
        [AUTH_CREDENTIAL_GENERATION_CLAIM]: 0,
      },
      RUNTIME_JWT_SECRET,
      3600
    );
    await expect(refresh.create({ refreshToken: legacy })).rejects.toThrow(
      /Invalid or expired refresh token/
    );
    const warnings = vi.mocked(console.warn).mock.calls.map(([line]) => String(line));
    expect(warnings).toContain(
      '[auth.refresh] session_revalidation_failed reason=identity_ambiguous'
    );
  });

  it('derives install wiring only from external launch and its revalidation URL', () => {
    const provider = (overrides: Partial<NonNullable<AgorConfig['external_launch']>>) =>
      resolveExternalLaunchSettings(cloudConfig(overrides)).settings;
    const revalidating = provider({});
    expect(launchSessionsAreRevalidated(revalidating)).toBe(true);
    expect(resolveLaunchConnectionBounds(revalidating, 1_600)).toEqual({
      launchedSessionMaxLifetimeSeconds: 1_600,
      userConnectionMaxAgeMs: LAUNCH_REVALIDATION_OUTAGE_GRACE_SECONDS * 1000,
    });
    const launchOnly = provider({ session_revalidation_url: undefined });
    expect(launchSessionsAreRevalidated(launchOnly)).toBe(false);
    expect(resolveLaunchConnectionBounds(launchOnly, 1_600)).toEqual({
      launchedSessionMaxLifetimeSeconds: 1_600,
    });
    const selfHosted = resolveExternalLaunchSettings({}).settings;
    expect(launchSessionsAreRevalidated(selfHosted)).toBe(false);
    expect(resolveLaunchConnectionBounds(selfHosted, 1_600)).toEqual({});
  });

  it('leaves accounts without a launch identity to local refresh rules', async () => {
    const fetchMock = stubIssuer({ exchange: assertion(), revalidate: vi.fn() });
    const { revalidateLaunchSession } = services();
    await expect(
      revalidateLaunchSession?.({
        userId: 'local-user' as UserID,
        payload: { sub: 'local-user', type: 'refresh', tenant_id: 'tenant-a' },
      })
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still enforces the absolute session lifetime when the issuer approves', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.UTC(2026, 0, 1);
      vi.setSystemTime(start);
      stubIssuer({
        exchange: assertion(),
        revalidate: () => Response.json({ assertion: revalidation() }),
      });
      const { launch, refresh } = services();
      const signedIn = await launch.create({ launchCode: 'code' });
      expect(verify(signedIn.refreshToken)[AUTH_SESSION_STARTED_AT_MS_CLAIM]).toBe(start);
      vi.setSystemTime(start + MAX_LIFETIME_SECONDS * 1000);
      await expect(refresh.create({ refreshToken: signedIn.refreshToken })).rejects.toThrow(
        /Invalid or expired refresh token/
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
