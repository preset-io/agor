import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  function exchangeBody(fetchMock: ReturnType<typeof mockExchange>): Record<string, unknown> {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    return JSON.parse((init?.body as string) ?? '{}');
  }

  function hostConfig(overrides: Record<string, unknown> = {}): AgorConfig {
    return {
      external_launch: {
        ...baseConfig().external_launch,
        forward_request_host: true,
        ...overrides,
      },
    };
  }

  it('forwards request_host from the trusted Host header when configured', async () => {
    const fetchMock = mockExchange(signClaims());
    await service(hostConfig()).create({ launchCode: 'code' }, {
      headers: { host: 'primary.cloud.agor.live' },
    } as never);
    expect(exchangeBody(fetchMock).request_host).toBe('primary.cloud.agor.live');
  });

  it('omits request_host when host forwarding is not configured', async () => {
    const fetchMock = mockExchange(signClaims());
    await service().create({ launchCode: 'code' }, {
      headers: { host: 'primary.cloud.agor.live' },
    } as never);
    expect(exchangeBody(fetchMock)).not.toHaveProperty('request_host');
  });

  it('reads only the configured trusted header, ignoring spoofable x-forwarded-host', async () => {
    const fetchMock = mockExchange(signClaims());
    await service(hostConfig()).create({ launchCode: 'code' }, {
      headers: { host: 'primary.cloud.agor.live', 'x-forwarded-host': 'attacker.example' },
    } as never);
    expect(exchangeBody(fetchMock).request_host).toBe('primary.cloud.agor.live');
  });

  it('honors a configurable trusted host header set by a trusted edge', async () => {
    const fetchMock = mockExchange(signClaims());
    await service(hostConfig({ trusted_host_header: 'x-forwarded-host' })).create(
      { launchCode: 'code' },
      {
        headers: { host: 'internal-service:4000', 'x-forwarded-host': 'primary.cloud.agor.live' },
      } as never
    );
    expect(exchangeBody(fetchMock).request_host).toBe('primary.cloud.agor.live');
  });

  it('fails closed on ambiguous multi-valued or comma-joined request hosts', async () => {
    mockExchange(signClaims());
    await expect(
      service(hostConfig()).create({ launchCode: 'code' }, {
        headers: { host: ['a.example', 'b.example'] },
      } as never)
    ).rejects.toBeInstanceOf(NotAuthenticated);

    mockExchange(signClaims());
    await expect(
      service(hostConfig()).create({ launchCode: 'code' }, {
        headers: { host: 'a.example, b.example' },
      } as never)
    ).rejects.toBeInstanceOf(NotAuthenticated);
  });

  it('builds an exchange body whose keys stay within the daemon-side contract tripwire fixture', async () => {
    const fetchMock = mockExchange(signClaims());
    await service(hostConfig()).create({ launchCode: 'code' }, {
      headers: { host: 'primary.cloud.agor.live' },
    } as never);
    const body = exchangeBody(fetchMock);
    const contract = JSON.parse(
      readFileSync(new URL('./__fixtures__/launch-exchange-request.json', import.meta.url), 'utf8')
    ) as { required: string[]; properties: Record<string, unknown> };
    const allowed = new Set(Object.keys(contract.properties));
    for (const key of Object.keys(body)) {
      expect(allowed.has(key)).toBe(true);
    }
    for (const required of contract.required) {
      expect(body).toHaveProperty(required);
    }
  });

  it('accepts a valid RS256 assertion and rejects HS256 algorithm confusion', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const { dev_shared_secret: _dev, ...rest } = baseConfig().external_launch as Record<
      string,
      unknown
    >;
    const rsaConfig: AgorConfig = { external_launch: { ...rest, public_key: publicKeyPem } };

    const good = jwt.sign({ sub: 'rs-user', instance_id: 'instance-1' }, privateKeyPem, {
      algorithm: 'RS256',
      keyid: 'k1',
      expiresIn: '5m',
      issuer: 'https://issuer.example.test',
      audience: 'runtime:test',
    });
    mockExchange(good);
    const ok = await service(rsaConfig).create({ launchCode: 'code' });
    expect(ok.user.user_id).toBeTruthy();

    // Attacker re-signs with HS256 using the PEM public key as the HMAC secret.
    const forged = jwt.sign({ sub: 'rs-user', instance_id: 'instance-1' }, publicKeyPem, {
      algorithm: 'HS256',
      keyid: 'k1',
      expiresIn: '5m',
      issuer: 'https://issuer.example.test',
      audience: 'runtime:test',
    });
    mockExchange(forged);
    await expect(service(rsaConfig).create({ launchCode: 'code2' })).rejects.toBeInstanceOf(
      NotAuthenticated
    );
  });

  it('rejects an alg:none assertion', async () => {
    const none = jwt.sign(
      {
        sub: 'none-user',
        instance_id: 'instance-1',
        iss: 'https://issuer.example.test',
        aud: 'runtime:test',
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      null as unknown as jwt.Secret,
      { algorithm: 'none' }
    );
    mockExchange(none);
    await expect(service().create({ launchCode: 'code' })).rejects.toBeInstanceOf(NotAuthenticated);
  });

  it('fails closed with no session when a required tenant claim is missing', async () => {
    mockExchange(signClaims({ sub: 'no-tenant-user', email: 'no-tenant@example.test' }));
    await expect(
      service({
        ...baseConfig(),
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      }).create({ launchCode: 'code' })
    ).rejects.toBeInstanceOf(NotAuthenticated);
  });

  it('derives tenant scope only from the signed claim, never a trusted header', async () => {
    // Legal required_from_auth config that allows a header fallback for the
    // generic request path. On the launch path the header must NOT be trusted:
    // the assertion omits the tenant claim but a tenant header is present, so
    // the exchange must reject and create no session.
    mockExchange(signClaims({ sub: 'header-tenant-user', email: 'header-tenant@example.test' }));
    await expect(
      service({
        ...baseConfig(),
        database: { dialect: 'postgresql' },
        multi_tenancy: {
          mode: 'required_from_auth',
          auth_claim: 'tenant_id',
          trusted_header: 'x-agor-tenant-id',
        },
      }).create({ launchCode: 'code' }, {
        headers: { 'x-agor-tenant-id': 'tenant-from-header' },
      } as never)
    ).rejects.toBeInstanceOf(NotAuthenticated);

    const rows = await select(db).from(users).all();
    expect(rows).toHaveLength(0);
  });

  it('rejects asymmetric verification configured with an HS* algorithm', async () => {
    mockExchange(signClaims());
    const { dev_shared_secret: _dev, ...rest } = baseConfig().external_launch as Record<
      string,
      unknown
    >;

    await expect(
      service({
        external_launch: { ...rest, public_key: 'pem-placeholder', algorithms: ['HS256'] },
      }).create({ launchCode: 'code' })
    ).rejects.toBeInstanceOf(NotAuthenticated);

    await expect(
      service({
        external_launch: {
          ...rest,
          jwks_url: 'https://issuer.example.test/jwks',
          algorithms: ['HS384'],
        },
      }).create({ launchCode: 'code' })
    ).rejects.toBeInstanceOf(NotAuthenticated);
  });

  it('accepts a non-RS256 asymmetric algorithm when explicitly configured (ES256)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const { dev_shared_secret: _dev, ...rest } = baseConfig().external_launch as Record<
      string,
      unknown
    >;
    const es256Config: AgorConfig = {
      external_launch: { ...rest, public_key: publicKeyPem, algorithms: ['ES256'] },
    };

    const token = jwt.sign({ sub: 'es-user', instance_id: 'instance-1' }, privateKeyPem, {
      algorithm: 'ES256',
      keyid: 'k1',
      expiresIn: '5m',
      issuer: 'https://issuer.example.test',
      audience: 'runtime:test',
    });
    mockExchange(token);
    const ok = await service(es256Config).create({ launchCode: 'code' });
    expect(ok.user.user_id).toBeTruthy();
  });

  it('logs a coarse, secret-safe diagnostic on expected launch failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const launchCode = 'otc_super_secret_launch_code_9999';
    const serviceCredential = 'exchange-credential-do-not-log-abcdef';

    // Exchange returns no assertion -> NotAuthenticated thrown inside the
    // try/catch (the expected-failure path).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}, { status: 200 }))
    );
    await expect(
      service({
        external_launch: { ...baseConfig().external_launch, service_credential: serviceCredential },
      }).create({ launchCode })
    ).rejects.toBeInstanceOf(NotAuthenticated);

    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('[auth/launch]');
    expect(logged).not.toContain(launchCode);
    expect(logged).not.toContain(serviceCredential);
  });

  it('never logs an unexpected error message carrying a query credential', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const launchCode = 'otc_unexpected_secret_code_4242';
    // The exchange fetch throws an unexpected (non-Feathers) error whose message
    // embeds a credential-bearing URL the structural redactor does not match on.
    // The classifier must keep that free text out of the log entirely.
    const leakyUrl = 'https://issuer.example.test/exchange?access_token=supersecret';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED ${leakyUrl}`);
      })
    );

    await expect(service().create({ launchCode })).rejects.toBeInstanceOf(NotAuthenticated);

    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('[auth/launch] unexpected_error');
    expect(logged).not.toContain('supersecret');
    expect(logged).not.toContain('access_token');
    expect(logged).not.toContain(launchCode);
  });

  it('fails closed before the network call with a static diagnostic on an invalid host', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = mockExchange(signClaims());

    await expect(
      service(hostConfig()).create({ launchCode: 'code' }, {
        headers: { host: 'a.example, b.example' },
      } as never)
    ).rejects.toBeInstanceOf(NotAuthenticated);

    // No launch code ever leaves the daemon: the exchange fetch is never called.
    expect(fetchMock).not.toHaveBeenCalled();
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('[auth/launch] request_host_invalid');
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
      returnHostParam: 'return_host',
    });
    expect(result).not.toHaveProperty('exchangeUrl');
    expect(result).not.toHaveProperty('serviceCredential');
    expect(result).not.toHaveProperty('audience');
    expect(result).not.toHaveProperty('issuer');
  });

  it('exposes a default return-host param alongside a login redirect', () => {
    const result = resolvePublicLaunchAuthSettings({
      external_launch: {
        ...baseConfig().external_launch,
        login_redirect_url: 'https://console.example.test/launch-init',
      },
    });
    expect(result.returnHostParam).toBe('return_host');
  });

  it('honors a configured return-host param name', () => {
    const result = resolvePublicLaunchAuthSettings({
      external_launch: {
        ...baseConfig().external_launch,
        login_redirect_url: 'https://console.example.test/launch-init',
        return_host_param: 'workspace_host',
      },
    });
    expect(result.returnHostParam).toBe('workspace_host');
  });

  it('does not expose a return-host param without a login redirect', () => {
    const result = resolvePublicLaunchAuthSettings({
      external_launch: { ...baseConfig().external_launch },
    });
    expect(result).not.toHaveProperty('returnHostParam');
  });

  it('never exposes the exchange service credential in public settings', () => {
    const result = resolvePublicLaunchAuthSettings({
      external_launch: {
        ...baseConfig().external_launch,
        service_credential: 'exchange-only-credential',
        login_redirect_url: 'https://console.example.test/launch-init',
      },
    });
    expect(JSON.stringify(result)).not.toContain('exchange-only-credential');
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
