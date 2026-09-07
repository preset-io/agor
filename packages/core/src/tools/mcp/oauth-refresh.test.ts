/**
 * Tests for MCP OAuth token refresh.
 *
 * Two layers:
 *   1. `refreshMCPToken` — pure HTTP wiring (fetch mocking only)
 *   2. `refreshAndPersistToken` — DB + mutex orchestration (repo mocking)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { MockOutboundPreDispatchAuthorityError } = vi.hoisted(() => ({
  MockOutboundPreDispatchAuthorityError: class OutboundPreDispatchAuthorityError extends Error {
    readonly code = 'outbound_pre_dispatch_authority_rejected';
    readonly authorityCause: unknown;
    constructor(cause: unknown) {
      super('Outbound request authority changed before dispatch');
      this.authorityCause = cause;
    }
  },
}));

vi.mock('../../utils/safe-outbound-fetch', () => ({
  OutboundPreDispatchAuthorityError: MockOutboundPreDispatchAuthorityError,
  safeOutboundFetch: async (input: string | URL, options: Record<string, unknown> = {}) => {
    const {
      timeoutMs: _timeout,
      maxRedirects: _max,
      maxResponseBytes: _bytes,
      allowLocalhostHttp: _local,
      assertCurrent,
      resolveDns,
      ...init
    } = options;
    if (typeof resolveDns === 'function') {
      await resolveDns(new URL(input).hostname, { all: true, verbatim: true });
    }
    if (typeof assertCurrent === 'function') {
      try {
        await assertCurrent();
      } catch (error) {
        throw new MockOutboundPreDispatchAuthorityError(error);
      }
    }
    return globalThis.fetch(input, init as RequestInit);
  },
}));

import type { MCPServerID, UserID } from '../../types';
import {
  __refreshMutexSizeForTests,
  __resetRefreshMutexForTests,
  classifyFailedRefreshClaimStatus,
  GrantConfigurationChangedError,
  InvalidGrantError,
  isReplaySafeRefreshTokenEndpoint,
  MissingClientIdError,
  MissingRefreshTokenError,
  MissingTokenEndpointError,
  needsRefresh,
  OAuthRefreshAuthorityCancelledError,
  REFRESH_BUFFER_MS,
  refreshAndPersistToken,
  refreshMCPToken,
} from './oauth-refresh';

describe('refresh-token replay safety', () => {
  it.each(['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v4/token'])(
    'recognizes the exact Google token endpoint %s',
    (endpoint) => {
      expect(isReplaySafeRefreshTokenEndpoint(endpoint)).toBe(true);
    }
  );

  it.each([
    'https://oauth2.googleapis.com.attacker.example/token',
    'http://oauth2.googleapis.com/token',
    'https://auth.example.test/token',
    'not a URL',
  ])('does not broaden retry safety to %s', (endpoint) => {
    expect(isReplaySafeRefreshTokenEndpoint(endpoint)).toBe(false);
  });

  it('keeps ambiguous rotating-token failures fenced while releasing Google and known failures', () => {
    expect(classifyFailedRefreshClaimStatus(true, 'https://auth.example.test/token')).toBe(
      'ambiguous'
    );
    expect(classifyFailedRefreshClaimStatus(true, 'https://oauth2.googleapis.com/token')).toBe(
      'idle'
    );
    expect(classifyFailedRefreshClaimStatus(false, 'https://auth.example.test/token')).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Repo mocks.
//
// `vi.mock()` is hoisted above all top-level `const` declarations, so the mock
// factory would see `undefined` if we used plain `const`s here. Hoist the
// mock fns via `vi.hoisted()` so they exist when the factory runs, and use
// plain `function` constructors (not arrow factories) so `new X()` works.
// ---------------------------------------------------------------------------

const {
  mockGetToken,
  mockCompleteStandaloneRefresh,
  mockDeleteGrantVersion,
  mockFindById,
  mockUserFindById,
} = vi.hoisted(() => ({
  mockGetToken: vi.fn(),
  mockCompleteStandaloneRefresh: vi.fn(),
  mockDeleteGrantVersion: vi.fn(),
  mockFindById: vi.fn(),
  // Persisting a refreshed token now requires the grant's subject to still be
  // entitled to hold it (`assertMcpGrantSubjectEntitled`), so these
  // orchestration tests need a subject who is. The refusal itself is covered
  // where it is enforced — see the daemon's `mcp-capability-role` tests.
  mockUserFindById: vi.fn(async () => ({ user_id: 'user-1', role: 'member' })),
}));

vi.mock('../../db/repositories', () => ({
  UserMCPOAuthTokenRepository: function UserMCPOAuthTokenRepositoryMock() {
    return {
      getToken: mockGetToken,
      completeStandaloneRefresh: mockCompleteStandaloneRefresh,
      deleteGrantVersion: mockDeleteGrantVersion,
    };
  },
  MCPServerRepository: function MCPServerRepositoryMock() {
    return {
      findById: mockFindById,
    };
  },
  UsersRepository: function UsersRepositoryMock() {
    return {
      findById: mockUserFindById,
    };
  },
}));

// ---------------------------------------------------------------------------
// refreshMCPToken — pure HTTP contract
// ---------------------------------------------------------------------------

describe('refreshMCPToken', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetchOnce(body: unknown, init: { status?: number } = {}) {
    const status = init.status ?? 200;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof globalThis.fetch;
  }

  it('uses HTTP Basic auth when client_secret is present (RFC 6749 §2.3.1)', async () => {
    mockFetchOnce({ access_token: 'new-a', token_type: 'Bearer', expires_in: 3600 });

    const result = await refreshMCPToken({
      tokenEndpoint: 'https://auth.example.com/token',
      refreshToken: 'rt-abc',
      clientId: 'client-123',
      clientSecret: 'secret-xyz',
    });

    expect(result.access_token).toBe('new-a');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.method).toBe('POST');
    const expectedAuth = `Basic ${Buffer.from('client-123:secret-xyz').toString('base64')}`;
    expect(init.headers.Authorization).toBe(expectedAuth);
    // Body should NOT include client_id — it's conveyed via Basic auth.
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-abc');
    expect(body.get('client_id')).toBeNull();
  });

  it('puts client_id in the body for public clients (no secret)', async () => {
    mockFetchOnce({ access_token: 'new-a', expires_in: 3600 });

    await refreshMCPToken({
      tokenEndpoint: 'https://auth.example.com/token',
      refreshToken: 'rt-abc',
      clientId: 'public-client-42',
    });

    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
    const body = new URLSearchParams(init.body as string);
    expect(body.get('client_id')).toBe('public-client-42');
    expect(body.get('refresh_token')).toBe('rt-abc');
    expect(body.get('grant_type')).toBe('refresh_token');
  });

  it('surfaces invalid_grant as InvalidGrantError', async () => {
    mockFetchOnce(
      {
        error: 'invalid_grant',
        error_description: 'provider-body-marker-that-must-not-be-logged',
      },
      { status: 400 }
    );

    await expect(
      refreshMCPToken({
        tokenEndpoint: 'https://auth.example.com/token',
        refreshToken: 'refresh-secret-marker-that-must-not-be-logged',
        clientId: 'client-marker-that-must-not-be-logged',
      })
    ).rejects.toBeInstanceOf(InvalidGrantError);

    const logged = [console.log, console.warn, console.error]
      .flatMap((logger) => vi.mocked(logger).mock.calls)
      .flat()
      .join(' ');
    expect(logged).not.toContain('provider-body-marker');
    expect(logged).not.toContain('refresh-secret-marker');
    expect(logged).not.toContain('client-marker');
    expect(logged).not.toContain('auth.example.com');
  });

  it('throws generic Error for other OAuth errors', async () => {
    mockFetchOnce({ error: 'server_error' }, { status: 500 });

    await expect(
      refreshMCPToken({
        tokenEndpoint: 'https://auth.example.com/token',
        refreshToken: 'rt',
        clientId: 'c',
      })
    ).rejects.toThrow(/provider_rejected/);
  });

  it('returns rotated refresh_token when provider rotates (OAuth 2.1)', async () => {
    mockFetchOnce({
      access_token: 'new-a',
      refresh_token: 'new-rt',
      expires_in: 3600,
    });

    const result = await refreshMCPToken({
      tokenEndpoint: 'https://auth.example.com/token',
      refreshToken: 'old-rt',
      clientId: 'c',
    });

    expect(result.refresh_token).toBe('new-rt');
  });

  it('leaves refresh_token undefined when provider omits it (RFC 6749 §6)', async () => {
    mockFetchOnce({ access_token: 'new-a', expires_in: 3600 });

    const result = await refreshMCPToken({
      tokenEndpoint: 'https://auth.example.com/token',
      refreshToken: 'old-rt',
      clientId: 'c',
    });

    expect(result.refresh_token).toBeUndefined();
  });

  it('throws when response is 200 but missing access_token', async () => {
    mockFetchOnce({ token_type: 'Bearer' });

    await expect(
      refreshMCPToken({
        tokenEndpoint: 'https://auth.example.com/token',
        refreshToken: 'rt',
        clientId: 'c',
      })
    ).rejects.toThrow(/response_ambiguous/);
  });

  it('throws on non-JSON body (HTML error page etc.)', async () => {
    mockFetchOnce('<!DOCTYPE html><h1>500 Internal Server Error</h1>', { status: 500 });

    await expect(
      refreshMCPToken({
        tokenEndpoint: 'https://auth.example.com/token',
        refreshToken: 'rt',
        clientId: 'c',
      })
    ).rejects.toThrow(/response_ambiguous/);
  });

  it('coerces numeric-string expires_in to number', async () => {
    mockFetchOnce({ access_token: 'a', expires_in: '3600' });

    const result = await refreshMCPToken({
      tokenEndpoint: 'https://auth.example.com/token',
      refreshToken: 'rt',
      clientId: 'c',
    });

    expect(result.expires_in).toBe(3600);
  });

  it('rechecks task authority after token-endpoint DNS and before credential dispatch', async () => {
    let releaseDns!: () => void;
    let dnsStarted!: () => void;
    const dnsGate = new Promise<void>((resolve) => (releaseDns = resolve));
    const dnsObserved = new Promise<void>((resolve) => (dnsStarted = resolve));
    let current = true;
    globalThis.fetch = vi.fn() as typeof globalThis.fetch;

    const pending = refreshMCPToken({
      tokenEndpoint: 'https://auth.example.com/token',
      refreshToken: 'refresh-secret',
      clientId: 'client-id',
      resolveDns: async () => {
        dnsStarted();
        await dnsGate;
        return [{ address: '203.0.113.10', family: 4 }];
      },
      assertCurrent: () => {
        if (!current) throw new Error('task authority changed');
      },
    });
    await dnsObserved;
    current = false;
    releaseDns();

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OAuthRefreshAuthorityCancelledError);
    expect(error).toMatchObject({
      code: 'oauth_refresh_authority_cancelled',
      authorityCause: { message: 'task authority changed' },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// refreshAndPersistToken — DB orchestration + mutex
// ---------------------------------------------------------------------------

describe('refreshAndPersistToken', () => {
  const originalFetch = globalThis.fetch;
  const USER_ID = 'user-1' as UserID;
  const SERVER_ID = 'srv-1' as MCPServerID;
  const observedVersion = (grantGeneration = 0, grantBindingFingerprint?: string) => ({
    grantGeneration,
    grantBindingFingerprint,
    refreshGeneration: 0,
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    mockGetToken.mockReset();
    mockCompleteStandaloneRefresh.mockReset().mockResolvedValue(true);
    mockDeleteGrantVersion.mockReset();
    mockFindById.mockReset();

    __resetRefreshMutexForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetchJson(body: unknown, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as typeof globalThis.fetch;
  }

  it('loads token row, refreshes, and persists atomically', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'old-a',
      oauth_refresh_token: 'rt-1',
      oauth_client_id: 'cid',
      oauth_client_secret: 'csec',
    });
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: { oauth_token_url: 'https://auth.example.com/token' },
    });
    mockFetchJson({ access_token: 'new-a', expires_in: 3600 });

    const token = await refreshAndPersistToken({
      db: { run: () => undefined } as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
      observedRefreshVersion: observedVersion(),
      validateGrant: async () => true,
    });

    expect(token).toBe('new-a');
    expect(mockCompleteStandaloneRefresh).toHaveBeenCalledWith(
      USER_ID,
      SERVER_ID,
      { grantGeneration: 0, grantBindingFingerprint: undefined },
      {
        accessToken: 'new-a',
        expiresAt: expect.any(Date), // resolved from expires_in: 3600 → ~now+1h
        refreshToken: undefined, // provider omitted — repo preserves existing
      }
    );
    // Spot-check the resolved expiry is roughly +1h from now (within 5s slop).
    const call = mockCompleteStandaloneRefresh.mock.calls[0]?.[3] as { expiresAt: Date };
    const deltaSec = (call.expiresAt.getTime() - Date.now()) / 1000;
    expect(deltaSec).toBeGreaterThan(3595);
    expect(deltaSec).toBeLessThanOrEqual(3600);
  });

  it('writes rotated refresh_token when provider returns one', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'old-a',
      oauth_refresh_token: 'rt-1',
      oauth_client_id: 'cid',
    });
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: { oauth_token_url: 'https://auth.example.com/token' },
    });
    mockFetchJson({
      access_token: 'new-a',
      refresh_token: 'rt-2',
      expires_in: 3600,
    });

    await refreshAndPersistToken({
      db: { run: () => undefined } as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
      observedRefreshVersion: observedVersion(),
      validateGrant: async () => true,
    });

    expect(mockCompleteStandaloneRefresh).toHaveBeenCalledWith(
      USER_ID,
      SERVER_ID,
      expect.any(Object),
      expect.objectContaining({ refreshToken: 'rt-2' })
    );
  });

  it('fails closed when the exact SQLite grant disappears before refresh commit', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'old-a',
      oauth_refresh_token: 'rt-1',
      oauth_client_id: 'cid',
      grant_generation: 7,
      grant_binding_fingerprint: 'binding-7',
    });
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: { oauth_token_url: 'https://auth.example.com/token' },
    });
    mockFetchJson({ access_token: 'stale-refresh-result', expires_in: 3600 });
    mockCompleteStandaloneRefresh.mockResolvedValue(false);

    await expect(
      refreshAndPersistToken({
        db: { run: () => undefined } as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
        observedRefreshVersion: observedVersion(7, 'binding-7'),
        validateGrant: async () => true,
      })
    ).rejects.toBeInstanceOf(GrantConfigurationChangedError);
    expect(mockCompleteStandaloneRefresh).toHaveBeenCalledWith(
      USER_ID,
      SERVER_ID,
      { grantGeneration: 7, grantBindingFingerprint: 'binding-7' },
      expect.objectContaining({ accessToken: 'stale-refresh-result' })
    );
  });

  it('deletes token row on invalid_grant and invokes onInvalidGrant hook', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'old-a',
      oauth_refresh_token: 'rt-revoked',
      oauth_client_id: 'cid',
    });
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: { oauth_token_url: 'https://auth.example.com/token' },
    });
    mockFetchJson({ error: 'invalid_grant' }, 400);
    mockDeleteGrantVersion.mockResolvedValue(true);

    const onInvalidGrant = vi.fn();

    await expect(
      refreshAndPersistToken({
        db: { run: () => undefined } as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
        observedRefreshVersion: observedVersion(),
        validateGrant: async () => true,
        onInvalidGrant,
      })
    ).rejects.toBeInstanceOf(InvalidGrantError);

    expect(mockDeleteGrantVersion).toHaveBeenCalledWith(USER_ID, SERVER_ID, 0, undefined);
    expect(onInvalidGrant).toHaveBeenCalledWith({
      userId: USER_ID,
      mcpServerId: SERVER_ID,
    });
    expect(mockCompleteStandaloneRefresh).not.toHaveBeenCalled();
  });

  it('does not report or delete invalid_grant when the exact grant was replaced', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'old-a',
      oauth_refresh_token: 'rt-revoked',
      oauth_client_id: 'cid',
      grant_generation: 3,
      grant_binding_fingerprint: 'old-binding',
    });
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: { oauth_token_url: 'https://auth.example.com/token' },
    });
    mockFetchJson({ error: 'invalid_grant' }, 400);
    mockDeleteGrantVersion.mockResolvedValue(false);
    const onInvalidGrant = vi.fn();

    await expect(
      refreshAndPersistToken({
        db: { run: () => undefined } as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
        observedRefreshVersion: observedVersion(3, 'old-binding'),
        validateGrant: async () => true,
        onInvalidGrant,
      })
    ).rejects.toBeInstanceOf(GrantConfigurationChangedError);
    expect(mockDeleteGrantVersion).toHaveBeenCalledWith(USER_ID, SERVER_ID, 3, 'old-binding');
    expect(onInvalidGrant).not.toHaveBeenCalled();
  });

  it('throws MissingRefreshTokenError when row has no refresh_token', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'a',
      oauth_refresh_token: undefined,
      oauth_client_id: 'cid',
    });

    await expect(
      refreshAndPersistToken({
        db: { run: () => undefined } as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
        observedRefreshVersion: observedVersion(),
        validateGrant: async () => true,
      })
    ).rejects.toBeInstanceOf(MissingRefreshTokenError);
  });

  it('throws MissingRefreshTokenError when no row exists', async () => {
    mockGetToken.mockResolvedValue(null);

    await expect(
      refreshAndPersistToken({
        db: { run: () => undefined } as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
        observedRefreshVersion: observedVersion(),
        validateGrant: async () => true,
      })
    ).rejects.toBeInstanceOf(MissingRefreshTokenError);
  });

  it('falls back to inferred token endpoint when server.auth is missing one', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'old-a',
      oauth_refresh_token: 'rt-1',
      oauth_client_id: 'cid',
    });
    // No oauth_token_url — inferOAuthTokenUrl should kick in.
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: {},
    });
    mockFetchJson({ access_token: 'new-a', expires_in: 3600 });

    const token = await refreshAndPersistToken({
      db: { run: () => undefined } as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
      observedRefreshVersion: observedVersion(),
      validateGrant: async () => true,
    });

    expect(token).toBe('new-a');
    // The inferred endpoint should have been hit.
    const [url] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(typeof url).toBe('string');
  });

  it('throws MissingTokenEndpointError when endpoint cannot be resolved', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'a',
      oauth_refresh_token: 'rt',
      oauth_client_id: 'cid',
    });
    // No server at all, so no url to infer from and no config endpoint.
    mockFindById.mockResolvedValue(null);

    await expect(
      refreshAndPersistToken({
        db: { run: () => undefined } as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
        observedRefreshVersion: observedVersion(),
        validateGrant: async () => true,
      })
    ).rejects.toBeInstanceOf(MissingTokenEndpointError);
  });

  it('falls back to server config client_id when row has none', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'old-a',
      oauth_refresh_token: 'rt-1',
      oauth_client_id: undefined, // row has no DCR credentials
      oauth_client_secret: undefined,
    });
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: {
        oauth_token_url: 'https://auth.example.com/token',
        oauth_client_id: 'admin-preregistered',
        oauth_client_secret: 'admin-secret',
      },
    });
    mockFetchJson({ access_token: 'new-a', expires_in: 3600 });

    await refreshAndPersistToken({
      db: { run: () => undefined } as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
      observedRefreshVersion: observedVersion(),
      validateGrant: async () => true,
    });

    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    // Pre-registered with secret → Basic auth
    const expectedAuth = `Basic ${Buffer.from('admin-preregistered:admin-secret').toString('base64')}`;
    expect(init.headers.Authorization).toBe(expectedAuth);
  });

  it('throws MissingClientIdError when neither token row nor server config has client_id', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'old-a',
      oauth_refresh_token: 'rt-1',
      oauth_client_id: undefined,
      oauth_client_secret: undefined,
    });
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: { oauth_token_url: 'https://auth.example.com/token' },
    });
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;

    await expect(
      refreshAndPersistToken({
        db: { run: () => undefined } as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
        observedRefreshVersion: observedVersion(),
        validateGrant: async () => true,
      })
    ).rejects.toBeInstanceOf(MissingClientIdError);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('mutex: concurrent refreshes for same key collapse to ONE HTTP call', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'old-a',
      oauth_refresh_token: 'rt-1',
      oauth_client_id: 'cid',
    });
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: { oauth_token_url: 'https://auth.example.com/token' },
    });

    // Slow-responding fetch so both calls land in flight simultaneously.
    let resolveFetch!: (r: Response) => void;
    globalThis.fetch = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        })
    ) as typeof globalThis.fetch;

    const p1 = refreshAndPersistToken({
      db: { run: () => undefined } as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
      observedRefreshVersion: observedVersion(),
      validateGrant: async () => true,
    });
    const p2 = refreshAndPersistToken({
      db: { run: () => undefined } as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
      observedRefreshVersion: observedVersion(),
      validateGrant: async () => true,
    });

    // Wait for the fetch mock to be invoked before resolving — the mock's
    // `resolveFetch` is only assigned inside the Promise executor, which runs
    // after the refresh helper has awaited the DB reads.
    await vi.waitFor(() => expect(typeof resolveFetch).toBe('function'));
    resolveFetch(
      new Response(JSON.stringify({ access_token: 'shared-new-a', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const [t1, t2] = await Promise.all([p1, p2]);

    expect(t1).toBe('shared-new-a');
    expect(t2).toBe('shared-new-a');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(mockCompleteStandaloneRefresh).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale caller before it can adopt a replacement SQLite grant', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'replacement-access',
      oauth_refresh_token: 'replacement-refresh',
      oauth_client_id: 'cid',
      grant_generation: 12,
      grant_binding_fingerprint: 'replacement-binding',
    });
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const validateGrant = vi.fn(async () => true);

    await expect(
      refreshAndPersistToken({
        db: { run: () => undefined } as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
        observedRefreshVersion: observedVersion(11, 'stale-binding'),
        validateGrant,
      })
    ).rejects.toBeInstanceOf(GrantConfigurationChangedError);

    expect(validateGrant).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(__refreshMutexSizeForTests()).toBe(0);
  });

  it('does not share a user/server mutex result across grant versions', async () => {
    const oldGrant = {
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'old-access',
      oauth_refresh_token: 'old-refresh',
      oauth_client_id: 'cid',
      grant_generation: 21,
      grant_binding_fingerprint: 'old-binding',
    };
    const replacementGrant = {
      ...oldGrant,
      oauth_access_token: 'replacement-access',
      oauth_refresh_token: 'replacement-refresh',
      grant_generation: 22,
      grant_binding_fingerprint: 'replacement-binding',
    };
    mockGetToken.mockResolvedValue(oldGrant);
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: { oauth_token_url: 'https://auth.example.com/token' },
    });
    let resolveFetch!: (response: Response) => void;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    ) as typeof globalThis.fetch;

    const oldCaller = refreshAndPersistToken({
      db: { run: () => undefined } as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
      observedRefreshVersion: observedVersion(21, 'old-binding'),
      validateGrant: async () => true,
    });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    // Reauthorization replaced the row while the old exchange owns the mutex.
    mockGetToken.mockResolvedValue(replacementGrant);
    const replacementCaller = refreshAndPersistToken({
      db: { run: () => undefined } as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
      observedRefreshVersion: observedVersion(22, 'replacement-binding'),
      validateGrant: async () => true,
    });

    await expect(replacementCaller).rejects.toBeInstanceOf(GrantConfigurationChangedError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    resolveFetch(
      new Response(JSON.stringify({ access_token: 'old-refresh-result', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await expect(oldCaller).rejects.toBeInstanceOf(GrantConfigurationChangedError);
    expect(__refreshMutexSizeForTests()).toBe(0);
  });

  it('refreshes Gmail and Calendar grants independently', async () => {
    const GMAIL_SERVER_ID = 'gmail-mcp' as MCPServerID;
    const CALENDAR_SERVER_ID = 'calendar-mcp' as MCPServerID;

    mockGetToken.mockImplementation((_u, s) => ({
      user_id: USER_ID,
      mcp_server_id: s,
      oauth_access_token: 'old',
      oauth_refresh_token: `rt-${s}`,
      oauth_client_id: 'cid',
    }));
    mockFindById.mockResolvedValue({
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      auth: { oauth_token_url: 'https://oauth2.googleapis.com/token' },
    });
    // `mockImplementation` returns a fresh Response per call — `Response.text()`
    // consumes the body, so reusing a single instance across two calls throws
    // "Body has already been read" on the second read.
    globalThis.fetch = vi.fn().mockImplementation((_input, init: RequestInit) => {
      const refreshToken = new URLSearchParams(String(init.body)).get('refresh_token');
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: `access-for-${refreshToken}`, expires_in: 3600 }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );
    }) as typeof globalThis.fetch;

    await Promise.all([
      refreshAndPersistToken({
        db: { run: () => undefined } as any,
        userId: USER_ID,
        mcpServerId: GMAIL_SERVER_ID,
        observedRefreshVersion: observedVersion(),
        validateGrant: async () => true,
      }),
      refreshAndPersistToken({
        db: { run: () => undefined } as any,
        userId: USER_ID,
        mcpServerId: CALENDAR_SERVER_ID,
        observedRefreshVersion: observedVersion(),
        validateGrant: async () => true,
      }),
    ]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(mockCompleteStandaloneRefresh).toHaveBeenCalledWith(
      USER_ID,
      GMAIL_SERVER_ID,
      expect.any(Object),
      expect.objectContaining({ accessToken: 'access-for-rt-gmail-mcp' })
    );
    expect(mockCompleteStandaloneRefresh).toHaveBeenCalledWith(
      USER_ID,
      CALENDAR_SERVER_ID,
      expect.any(Object),
      expect.objectContaining({ accessToken: 'access-for-rt-calendar-mcp' })
    );
  });

  it('mutex: in-flight map is cleared after completion (success)', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'old',
      oauth_refresh_token: 'rt',
      oauth_client_id: 'cid',
    });
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: { oauth_token_url: 'https://auth.example.com/token' },
    });
    mockFetchJson({ access_token: 'a', expires_in: 3600 });

    await refreshAndPersistToken({
      db: { run: () => undefined } as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
      observedRefreshVersion: observedVersion(),
      validateGrant: async () => true,
    });

    expect(__refreshMutexSizeForTests()).toBe(0);
  });

  it('mutex: in-flight map is cleared after completion (failure)', async () => {
    mockGetToken.mockResolvedValue({
      user_id: USER_ID,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'old',
      oauth_refresh_token: 'rt-bad',
      oauth_client_id: 'cid',
    });
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: { oauth_token_url: 'https://auth.example.com/token' },
    });
    mockFetchJson({ error: 'invalid_grant' }, 400);
    mockDeleteGrantVersion.mockResolvedValue(true);

    await expect(
      refreshAndPersistToken({
        db: { run: () => undefined } as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
        observedRefreshVersion: observedVersion(),
        validateGrant: async () => true,
      })
    ).rejects.toBeInstanceOf(InvalidGrantError);

    expect(__refreshMutexSizeForTests()).toBe(0);
  });

  it('shared-mode refresh: keys on user_id=null', async () => {
    mockGetToken.mockResolvedValue({
      user_id: null,
      mcp_server_id: SERVER_ID,
      oauth_access_token: 'old',
      oauth_refresh_token: 'rt-shared',
      oauth_client_id: 'cid',
    });
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: { oauth_token_url: 'https://auth.example.com/token' },
    });
    mockFetchJson({ access_token: 'shared-new', expires_in: 3600 });

    const token = await refreshAndPersistToken({
      db: { run: () => undefined } as any,
      userId: null,
      mcpServerId: SERVER_ID,
      observedRefreshVersion: observedVersion(),
      validateGrant: async () => true,
    });

    expect(token).toBe('shared-new');
    expect(mockGetToken).toHaveBeenCalledWith(null, SERVER_ID);
    expect(mockCompleteStandaloneRefresh).toHaveBeenCalledWith(
      null,
      SERVER_ID,
      expect.any(Object),
      expect.any(Object)
    );
  });
});

// ---------------------------------------------------------------------------
// needsRefresh — pure
// ---------------------------------------------------------------------------

describe('needsRefresh', () => {
  it('returns false when expiresAt is null or undefined', () => {
    expect(needsRefresh(null)).toBe(false);
    expect(needsRefresh(undefined)).toBe(false);
  });

  it('returns true when already expired', () => {
    expect(needsRefresh(new Date(Date.now() - 1000))).toBe(true);
    expect(needsRefresh(Date.now() - 1000)).toBe(true);
  });

  it('returns true when within the buffer window', () => {
    expect(needsRefresh(new Date(Date.now() + REFRESH_BUFFER_MS / 2))).toBe(true);
  });

  it('returns false when well before expiry', () => {
    expect(needsRefresh(new Date(Date.now() + REFRESH_BUFFER_MS * 10))).toBe(false);
  });
});
