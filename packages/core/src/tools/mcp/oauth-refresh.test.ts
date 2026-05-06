/**
 * Tests for MCP OAuth token refresh.
 *
 * Two layers:
 *   1. `refreshMCPToken` — pure HTTP wiring (fetch mocking only)
 *   2. `refreshAndPersistToken` — DB + mutex orchestration (repo mocking)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MCPServerID, UserID } from '../../types';
import {
  __refreshMutexSizeForTests,
  __resetRefreshMutexForTests,
  InvalidGrantError,
  MissingRefreshTokenError,
  MissingTokenEndpointError,
  needsRefresh,
  REFRESH_BUFFER_MS,
  refreshAndPersistToken,
  refreshMCPToken,
} from './oauth-refresh';

// ---------------------------------------------------------------------------
// Repo mocks.
//
// `vi.mock()` is hoisted above all top-level `const` declarations, so the mock
// factory would see `undefined` if we used plain `const`s here. Hoist the
// mock fns via `vi.hoisted()` so they exist when the factory runs, and use
// plain `function` constructors (not arrow factories) so `new X()` works.
// ---------------------------------------------------------------------------

const { mockGetToken, mockSaveToken, mockDeleteToken, mockFindById } = vi.hoisted(() => ({
  mockGetToken: vi.fn(),
  mockSaveToken: vi.fn(),
  mockDeleteToken: vi.fn(),
  mockFindById: vi.fn(),
}));

vi.mock('../../db/repositories', () => ({
  UserMCPOAuthTokenRepository: function UserMCPOAuthTokenRepositoryMock() {
    return {
      getToken: mockGetToken,
      saveToken: mockSaveToken,
      deleteToken: mockDeleteToken,
    };
  },
  MCPServerRepository: function MCPServerRepositoryMock() {
    return {
      findById: mockFindById,
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
      { error: 'invalid_grant', error_description: 'refresh token has been revoked' },
      { status: 400 }
    );

    await expect(
      refreshMCPToken({
        tokenEndpoint: 'https://auth.example.com/token',
        refreshToken: 'stale',
        clientId: 'c',
      })
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('throws generic Error for other OAuth errors', async () => {
    mockFetchOnce({ error: 'server_error' }, { status: 500 });

    await expect(
      refreshMCPToken({
        tokenEndpoint: 'https://auth.example.com/token',
        refreshToken: 'rt',
        clientId: 'c',
      })
    ).rejects.toThrow(/server_error/);
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
    ).rejects.toThrow(/no access_token/);
  });

  it('throws on non-JSON body (HTML error page etc.)', async () => {
    mockFetchOnce('<!DOCTYPE html><h1>500 Internal Server Error</h1>', { status: 500 });

    await expect(
      refreshMCPToken({
        tokenEndpoint: 'https://auth.example.com/token',
        refreshToken: 'rt',
        clientId: 'c',
      })
    ).rejects.toThrow(/non-JSON body/);
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
});

// ---------------------------------------------------------------------------
// refreshAndPersistToken — DB orchestration + mutex
// ---------------------------------------------------------------------------

describe('refreshAndPersistToken', () => {
  const originalFetch = globalThis.fetch;
  const USER_ID = 'user-1' as UserID;
  const SERVER_ID = 'srv-1' as MCPServerID;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    mockGetToken.mockReset();
    mockSaveToken.mockReset();
    mockDeleteToken.mockReset();
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
    mockSaveToken.mockResolvedValue(undefined);
    mockFetchJson({ access_token: 'new-a', expires_in: 3600 });

    const token = await refreshAndPersistToken({
      db: {} as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
    });

    expect(token).toBe('new-a');
    expect(mockSaveToken).toHaveBeenCalledWith(USER_ID, SERVER_ID, {
      accessToken: 'new-a',
      expiresAt: expect.any(Date), // resolved from expires_in: 3600 → ~now+1h
      refreshToken: undefined, // provider omitted — repo preserves existing
    });
    // Spot-check the resolved expiry is roughly +1h from now (within 5s slop).
    const call = mockSaveToken.mock.calls[0]?.[2] as { expiresAt: Date };
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
      db: {} as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
    });

    expect(mockSaveToken).toHaveBeenCalledWith(
      USER_ID,
      SERVER_ID,
      expect.objectContaining({ refreshToken: 'rt-2' })
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
    mockDeleteToken.mockResolvedValue(true);

    const onInvalidGrant = vi.fn();

    await expect(
      refreshAndPersistToken({
        db: {} as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
        onInvalidGrant,
      })
    ).rejects.toBeInstanceOf(InvalidGrantError);

    expect(mockDeleteToken).toHaveBeenCalledWith(USER_ID, SERVER_ID);
    expect(onInvalidGrant).toHaveBeenCalledWith({
      userId: USER_ID,
      mcpServerId: SERVER_ID,
    });
    expect(mockSaveToken).not.toHaveBeenCalled();
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
        db: {} as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
      })
    ).rejects.toBeInstanceOf(MissingRefreshTokenError);
  });

  it('throws MissingRefreshTokenError when no row exists', async () => {
    mockGetToken.mockResolvedValue(null);

    await expect(
      refreshAndPersistToken({
        db: {} as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
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
      db: {} as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
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
        db: {} as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
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
      db: {} as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
    });

    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    // Pre-registered with secret → Basic auth
    const expectedAuth = `Basic ${Buffer.from('admin-preregistered:admin-secret').toString('base64')}`;
    expect(init.headers.Authorization).toBe(expectedAuth);
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
      db: {} as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
    });
    const p2 = refreshAndPersistToken({
      db: {} as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
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
    expect(mockSaveToken).toHaveBeenCalledTimes(1);
  });

  it('mutex: different keys refresh independently', async () => {
    const SERVER_ID_2 = 'srv-2' as MCPServerID;

    mockGetToken.mockImplementation((_u, s) => ({
      user_id: USER_ID,
      mcp_server_id: s,
      oauth_access_token: 'old',
      oauth_refresh_token: `rt-${s}`,
      oauth_client_id: 'cid',
    }));
    mockFindById.mockResolvedValue({
      url: 'https://srv.example.com/mcp',
      auth: { oauth_token_url: 'https://auth.example.com/token' },
    });
    // `mockImplementation` returns a fresh Response per call — `Response.text()`
    // consumes the body, so reusing a single instance across two calls throws
    // "Body has already been read" on the second read.
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    ) as typeof globalThis.fetch;

    await Promise.all([
      refreshAndPersistToken({
        db: {} as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
      }),
      refreshAndPersistToken({
        db: {} as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID_2,
      }),
    ]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
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
      db: {} as any,
      userId: USER_ID,
      mcpServerId: SERVER_ID,
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
    mockDeleteToken.mockResolvedValue(true);

    await expect(
      refreshAndPersistToken({
        db: {} as any,
        userId: USER_ID,
        mcpServerId: SERVER_ID,
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
      db: {} as any,
      userId: null,
      mcpServerId: SERVER_ID,
    });

    expect(token).toBe('shared-new');
    expect(mockGetToken).toHaveBeenCalledWith(null, SERVER_ID);
    expect(mockSaveToken).toHaveBeenCalledWith(null, SERVER_ID, expect.any(Object));
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
