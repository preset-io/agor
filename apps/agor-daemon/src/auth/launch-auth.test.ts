import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgorConfig } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import {
  createDatabase,
  eq,
  hash,
  initializeDatabase,
  insert,
  select,
  update,
  users,
} from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import type { InternalUser, User, UserID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLaunchAuthService, resolvePublicLaunchAuthSettings } from './launch-auth.js';

const ASSERTION_SECRET = 'test-launch-assertion-secret';
const RUNTIME_JWT_SECRET = 'test-runtime-jwt-secret';

function baseConfig(): AgorConfig {
  return {
    external_launch: {
      enabled: true,
      exchange_url: 'https://issuer.example.test/exchange',
      issuer: 'https://issuer.example.test',
      audience: 'runtime:test',
      instance_id: 'instance-1',
      dev_shared_secret: ASSERTION_SECRET,
      service_credential: 'exchange-credential',
    },
  };
}

function signClaims(overrides: Record<string, unknown> = {}) {
  return jwt.sign(
    {
      sub: 'external-user-1',
      email: 'person@example.test',
      name: 'Launch User',
      role: 'member',
      instance_id: 'instance-1',
      ...overrides,
    },
    ASSERTION_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: '5m',
      issuer: 'https://issuer.example.test',
      audience: 'runtime:test',
    }
  );
}

function mockExchange(assertion: string, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ assertion }, { status })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function makeDb(): Promise<{ db: Database; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'agor-launch-auth-test-'));
  const db = createDatabase({ url: `file:${join(dir, 'test.db')}` });
  await initializeDatabase(db);
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeUsersService(db: Database) {
  return {
    async get(id: UserID, _params?: unknown): Promise<InternalUser> {
      const row = await select(db).from(users).where(eq(users.user_id, id)).one();
      if (!row) throw new Error('missing user');
      return {
        user_id: row.user_id as UserID,
        email: row.email,
        name: row.name ?? undefined,
        emoji: row.emoji ?? undefined,
        role: row.role as User['role'],
        onboarding_completed: row.onboarding_completed,
        must_change_password: row.must_change_password,
        tokens_valid_after: row.tokens_valid_after ? new Date(row.tokens_valid_after) : undefined,
        created_at: row.created_at,
        updated_at: row.updated_at ?? undefined,
        avatar: (row.data as { avatar?: string }).avatar,
        preferences: (row.data as { preferences?: Record<string, unknown> }).preferences,
      };
    },
  };
}

describe('one-time launch auth service', () => {
  let db: Database;
  let cleanup: () => void;

  beforeEach(async () => {
    const fixture = await makeDb();
    db = fixture.db;
    cleanup = fixture.cleanup;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup?.();
  });

  function service(config = baseConfig(), usersService = makeUsersService(db)) {
    return createLaunchAuthService({
      db,
      config,
      jwtSecret: RUNTIME_JWT_SECRET,
      accessTokenTtl: '15m',
      refreshTokenTtl: '30d',
      usersService,
    });
  }

  it('rejects when disabled', async () => {
    await expect(
      service({ external_launch: { ...baseConfig().external_launch, enabled: false } }).create({
        launchCode: 'code',
      })
    ).rejects.toBeInstanceOf(NotAuthenticated);
  });

  it('rejects exchange failures', async () => {
    mockExchange(signClaims(), 400);
    await expect(service().create({ launchCode: 'bad-code' })).rejects.toBeInstanceOf(
      NotAuthenticated
    );
  });

  it('rejects invalid issuer, audience, and expired assertions', async () => {
    mockExchange(signClaims(), 200);
    await expect(
      service({
        external_launch: { ...baseConfig().external_launch, issuer: 'https://other.test' },
      }).create({ launchCode: 'code' })
    ).rejects.toBeInstanceOf(NotAuthenticated);

    mockExchange(signClaims(), 200);
    await expect(
      service({
        external_launch: { ...baseConfig().external_launch, audience: 'other-aud' },
      }).create({ launchCode: 'code' })
    ).rejects.toBeInstanceOf(NotAuthenticated);

    const expired = jwt.sign(
      { sub: 'external-user-1', instance_id: 'instance-1' },
      ASSERTION_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: -1,
        issuer: 'https://issuer.example.test',
        audience: 'runtime:test',
      }
    );
    mockExchange(expired, 200);
    await expect(service().create({ launchCode: 'code' })).rejects.toBeInstanceOf(NotAuthenticated);
  });

  it('rejects assertions without an expiration', async () => {
    const noExpiration = jwt.sign(
      { sub: 'external-user-1', instance_id: 'instance-1' },
      ASSERTION_SECRET,
      {
        algorithm: 'HS256',
        issuer: 'https://issuer.example.test',
        audience: 'runtime:test',
      }
    );
    mockExchange(noExpiration, 200);
    await expect(service().create({ launchCode: 'code' })).rejects.toBeInstanceOf(NotAuthenticated);
  });

  it('requires a matching instance claim when instance_id is configured', async () => {
    mockExchange(signClaims({ instance_id: undefined, runtime_instance_id: undefined }));
    await expect(service().create({ launchCode: 'code' })).rejects.toBeInstanceOf(NotAuthenticated);

    mockExchange(signClaims({ instance_id: 'other-instance' }));
    await expect(service().create({ launchCode: 'code' })).rejects.toBeInstanceOf(NotAuthenticated);
  });

  it('rejects ambiguous assertion verification configuration', async () => {
    mockExchange(signClaims());
    await expect(
      service({
        external_launch: {
          ...baseConfig().external_launch,
          public_key: '-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----',
        },
      }).create({ launchCode: 'code' })
    ).rejects.toBeInstanceOf(NotAuthenticated);
  });

  it('creates a local user and issues normal runtime tokens', async () => {
    const fetchMock = mockExchange(signClaims());
    const result = await service().create({ launchCode: 'one-time-code' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://issuer.example.test/exchange',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer exchange-credential' }),
      })
    );
    expect(result.user.email).toBe('person@example.test');
    expect(result.user).not.toHaveProperty('tokens_valid_after');
    expect(result.refreshToken).toBeTruthy();

    const decoded = jwt.verify(result.accessToken, RUNTIME_JWT_SECRET, {
      issuer: 'agor',
      audience: 'https://agor.dev',
    }) as { sub: string; type: string };
    expect(decoded.sub).toBe(result.user.user_id);
    expect(decoded.type).toBe('access');
  });

  it('scopes launch auth with the configured tenant claim', async () => {
    const usersService = makeUsersService(db);
    const getSpy = vi.spyOn(usersService, 'get');
    mockExchange(
      signClaims({
        sub: 'tenant-launch-user',
        email: 'tenant-launch@example.test',
        tenant_id: 'tenant-a',
      })
    );
    const result = await service(
      {
        ...baseConfig(),
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      },
      usersService
    ).create({ launchCode: 'tenant-code' });

    expect(getSpy).toHaveBeenCalledWith(
      result.user.user_id,
      expect.objectContaining({
        tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
      })
    );
    const decoded = jwt.verify(result.accessToken, RUNTIME_JWT_SECRET, {
      issuer: 'agor',
      audience: 'https://agor.dev',
    }) as { tenant_id?: string };
    expect(decoded.tenant_id).toBe('tenant-a');
  });

  it('maps admin roles only when explicitly allowed', async () => {
    mockExchange(
      signClaims({ sub: 'role-user-default', email: 'role-default@example.test', role: 'admin' })
    );
    const defaultResult = await service().create({ launchCode: 'default-role' });
    expect(defaultResult.user.role).toBe('member');

    mockExchange(
      signClaims({ sub: 'role-user-admin', email: 'role-admin@example.test', role: 'admin' })
    );
    const allowedResult = await service({
      external_launch: { ...baseConfig().external_launch, allow_admin_roles: true },
    }).create({ launchCode: 'admin-role' });
    expect(allowedResult.user.role).toBe('admin');
  });

  it('repeat login maps the same external identity to the same local user', async () => {
    mockExchange(signClaims());
    const first = await service().create({ launchCode: 'first' });

    mockExchange(signClaims({ name: 'Updated Name' }));
    const second = await service().create({ launchCode: 'second' });

    expect(second.user.user_id).toBe(first.user.user_id);
    expect(second.user.name).toBe('Updated Name');
  });

  it('uses token invalidation metadata for launch tokens without returning it', async () => {
    mockExchange(signClaims());
    const first = await service().create({ launchCode: 'first' });
    const marker = new Date(Date.now() + 1_000);
    await update(db, users)
      .set({ tokens_valid_after: marker })
      .where(eq(users.user_id, first.user.user_id))
      .run();

    mockExchange(signClaims({ name: 'Updated Name' }));
    const second = await service().create({ launchCode: 'second' });

    expect(second.user).not.toHaveProperty('tokens_valid_after');
    const decoded = jwt.verify(second.accessToken, RUNTIME_JWT_SECRET, {
      issuer: 'agor',
      audience: 'https://agor.dev',
    }) as jwt.JwtPayload;
    expect(decoded.auth_time_ms).toBe(marker.getTime() + 1);
  });

  it('links to an existing local user by verified email when explicitly trusted', async () => {
    const now = new Date();
    await insert(db, users)
      .values({
        user_id: 'local-user-1',
        created_at: now,
        updated_at: now,
        email: 'person@example.test',
        password: await hash('local-password', 10),
        name: 'Existing Local User',
        emoji: '👤',
        role: 'member',
        onboarding_completed: false,
        must_change_password: false,
        data: { preferences: {} },
      })
      .run();

    mockExchange(signClaims({ email_verified: true }));
    const result = await service({
      external_launch: {
        ...baseConfig().external_launch,
        trust_verified_email_for_linking: true,
      },
    }).create({ launchCode: 'trusted-email' });

    expect(result.user.user_id).toBe('local-user-1');
    expect(result.user.email).toBe('person@example.test');

    const row = await select(db).from(users).where(eq(users.user_id, 'local-user-1')).one();
    expect((row!.data as { external_identities?: unknown[] }).external_identities).toHaveLength(1);
  });

  it('does not merge a new external identity by email alone', async () => {
    mockExchange(signClaims({ sub: 'external-user-1', email: 'same@example.test' }));
    const first = await service().create({ launchCode: 'first' });

    mockExchange(signClaims({ sub: 'external-user-2', email: 'same@example.test' }));
    const second = await service().create({ launchCode: 'second' });

    expect(second.user.user_id).not.toBe(first.user.user_id);
    expect(second.user.email).not.toBe('same@example.test');
    expect(second.user.email).toContain('+launch-');
  });
});

describe('public one-time launch auth settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns only the public external launch shape', () => {
    const result = resolvePublicLaunchAuthSettings({
      external_launch: {
        ...baseConfig().external_launch,
        login_redirect_url: 'https://workspace.example.test/open',
      },
    });

    expect(result).toEqual({
      enabled: true,
      loginRedirectUrl: 'https://workspace.example.test/open',
    });
    expect(result).not.toHaveProperty('exchangeUrl');
    expect(result).not.toHaveProperty('serviceCredential');
    expect(result).not.toHaveProperty('audience');
    expect(result).not.toHaveProperty('issuer');
  });

  it('does not expose an inactive login redirect URL', () => {
    expect(
      resolvePublicLaunchAuthSettings({
        external_launch: {
          ...baseConfig().external_launch,
          enabled: false,
          login_redirect_url: 'https://workspace.example.test/open',
        },
      })
    ).toEqual({ enabled: false });
  });
});
