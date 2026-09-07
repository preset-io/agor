/**
 * Tests for OAuth MCP transport helpers.
 *
 * Covers:
 * - isOAuthRequired(): Bearer challenge detection
 * - discoverResourceMetadataUrl(): .well-known fallback discovery
 * - resolveResourceMetadataUrl(): header parse + .well-known fallback
 */

import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPOAuthDCRDiagnostic } from '../../types/mcp.js';

vi.mock('../../utils/safe-outbound-fetch', () => ({
  assertSafeOAuthUrl: (input: string, options: { allowLocalhostHttp?: boolean } = {}) => {
    const url = new URL(input);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(options.allowLocalhostHttp && loopback)) {
      throw new Error('OAuth endpoints require HTTPS');
    }
    return url;
  },
  safeOutboundFetch: vi.fn((input: string | URL, options: Record<string, unknown> = {}) => {
    const {
      timeoutMs: _timeout,
      maxRedirects: _max,
      maxResponseBytes: _bytes,
      allowLocalhostHttp: _local,
      ...init
    } = options;
    return globalThis.fetch(input, init as RequestInit);
  }),
}));

import { safeOutboundFetch } from '../../utils/safe-outbound-fetch';
import {
  __dynamicClientCacheSizeForTests,
  __seedAuthCodeTokenCacheForTests,
  __seedDynamicClientCacheForTests,
  clearAuthCodeTokenCache,
  completeMCPOAuthFlow,
  discoverAuthorizationServerFromMcpOrigin,
  discoverResourceMetadataUrl,
  getAuthCodeTokenCacheStats,
  isGoogleAuthorizationEndpoint,
  isOAuthRequired,
  OAuthCallbackValidationError,
  OAuthCodeExchangeError,
  parseOAuthCallback,
  performMCPOAuthFlow,
  resolveMCPOAuthDiscovery,
  resolveResourceMetadataUrl,
  startMCPOAuthFlow,
} from './oauth-mcp-transport';

describe('Google authorization endpoint classification', () => {
  it('accepts only the exact HTTPS Google Accounts host', () => {
    expect(isGoogleAuthorizationEndpoint(new URL('https://accounts.google.com/authorize'))).toBe(
      true
    );
    expect(isGoogleAuthorizationEndpoint(new URL('http://accounts.google.com/authorize'))).toBe(
      false
    );
    expect(
      isGoogleAuthorizationEndpoint(
        new URL('https://accounts.google.com.attacker.example/authorize')
      )
    ).toBe(false);
    expect(
      isGoogleAuthorizationEndpoint(new URL('https://accounts.google.example/authorize'))
    ).toBe(false);
  });
});

async function rejectedError<T extends Error>(promise: Promise<unknown>): Promise<T> {
  try {
    await promise;
  } catch (failure) {
    if (failure instanceof Error) return failure as T;
    throw failure;
  }
  throw new Error('Expected OAuth flow to reject');
}

describe('loopback OAuth callback response', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it.each([
    { validState: false, expectedHeading: 'Invalid Callback' },
    { validState: true, expectedHeading: 'Authentication Failed' },
  ])(
    'validates state before provider errors (valid state: $validState) and never reflects error query HTML or secrets',
    async ({ validState, expectedHeading }) => {
      const sentinel = 'SENTINEL_LOOPBACK_CALLBACK_XSS_92f1';
      const issuer = 'http://127.0.0.1:45555';
      const metadataUrl = 'http://127.0.0.1:45554/.well-known/oauth-protected-resource';
      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === metadataUrl) {
          return new Response(
            JSON.stringify({
              resource: 'http://127.0.0.1:45554/mcp',
              authorization_servers: [issuer],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.startsWith(`${issuer}/.well-known/`)) {
          return new Response(
            JSON.stringify({
              issuer,
              authorization_endpoint: `${issuer}/authorize`,
              token_endpoint: `${issuer}/token`,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        throw new Error('unexpected test URL');
      }) as unknown as typeof fetch;

      let callbackResponse:
        | {
            status: number | undefined;
            headers: Record<string, string | string[] | undefined>;
            body: string;
          }
        | undefined;
      const flow = performMCPOAuthFlow(
        `Bearer resource_metadata="${metadataUrl}"`,
        'client-id',
        async (authorizationUrl) => {
          const auth = new URL(authorizationUrl);
          const callback = new URL(auth.searchParams.get('redirect_uri')!);
          callback.searchParams.set(
            'state',
            validState ? auth.searchParams.get('state')! : 'wrong-state'
          );
          callback.searchParams.set('error', `<script>${sentinel}</script>`);

          callbackResponse = await new Promise<NonNullable<typeof callbackResponse>>(
            (resolve, reject) => {
              const request = httpRequest(callback, (response) => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                response.on('end', () =>
                  resolve({
                    status: response.statusCode,
                    headers: response.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                  })
                );
              });
              request.on('error', reject);
              request.end();
            }
          );
        }
      );

      const failure = await rejectedError(flow);
      expect(failure.message).toBe(
        validState ? 'No authorization code received' : 'State mismatch - possible CSRF attack'
      );
      expect(callbackResponse?.status).toBe(400);
      expect(callbackResponse?.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(callbackResponse?.headers['content-security-policy']).toContain("default-src 'none'");
      expect(callbackResponse?.headers['x-content-type-options']).toBe('nosniff');
      expect(callbackResponse?.headers['cache-control']).toBe('no-store');
      expect(callbackResponse?.body).toContain(expectedHeading);
      expect(JSON.stringify({ callbackResponse, failure: String(failure) })).not.toContain(
        sentinel
      );
      expect(callbackResponse?.body).not.toContain('<script>');
    }
  );
});

// ---------------------------------------------------------------------------
// completeMCPOAuthFlow — token exchange request contract
// ---------------------------------------------------------------------------

describe('completeMCPOAuthFlow token exchange', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearAuthCodeTokenCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const context = {
    metadataUrl: 'https://metadata.example.test/.well-known/oauth-protected-resource',
    resourceUri: 'https://mcp.example.test/mcp',
    issuer: 'https://provider.example.test',
    authorizationEndpoint: 'https://provider.example.test/authorize',
    tokenEndpoint: 'https://provider.example.test/token',
    redirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
    pkceVerifier: 'verifier',
    clientId: 'client-id',
    state: 'state',
    authorizationUrl: 'https://provider.example.test/authorize',
    compatibilityMode: 'legacy' as const,
    authorizationResponseIssuerParameterSupported: false,
    allowLocalhostHttp: false,
  };

  it('requests a JSON token response for providers such as GitHub', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: 'gho_example', scope: 'repo', token_type: 'bearer' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      ) as unknown as typeof fetch;

    const result = await completeMCPOAuthFlow(
      {
        metadataUrl: 'https://github.example/.well-known/oauth-protected-resource',
        resourceUri: 'https://github.example/mcp',
        issuer: 'https://github.com',
        authorizationEndpoint: 'https://github.com/login/oauth/authorize',
        tokenEndpoint: 'https://github.com/login/oauth/access_token',
        redirectUri: 'http://127.0.0.1:3000/oauth/callback',
        pkceVerifier: 'verifier',
        clientId: 'client-id',
        state: 'state',
        authorizationUrl: 'https://github.com/login/oauth/authorize',
        compatibilityMode: 'legacy',
        authorizationResponseIssuerParameterSupported: false,
        allowLocalhostHttp: true,
      },
      'authorization-code',
      'state'
    );

    expect(result.access_token).toBe('gho_example');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      })
    );
  });

  it('does not log state, code, PKCE, client secret, bearer token, or secret-bearing URLs', async () => {
    const sentinels = {
      state: 'STATE-DO-NOT-LOG-93f3',
      code: 'CODE-DO-NOT-LOG-8ad2',
      pkce: 'PKCE-DO-NOT-LOG-1b71',
      clientSecret: 'CLIENT-SECRET-DO-NOT-LOG-c299',
      token: 'ACCESS-TOKEN-DO-NOT-LOG-44ea',
      urlSecret: 'URL-SECRET-DO-NOT-LOG-391c',
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: sentinels.token }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    await completeMCPOAuthFlow(
      {
        metadataUrl: `https://metadata.example.test/path?credential=${sentinels.urlSecret}`,
        resourceUri: 'https://mcp.example.test/mcp',
        issuer: 'https://provider.example.test',
        authorizationEndpoint: 'https://provider.example.test/authorize',
        tokenEndpoint: `https://provider.example.test/token?credential=${sentinels.urlSecret}`,
        redirectUri: 'https://agor.example.test/mcp-servers/oauth-callback',
        pkceVerifier: sentinels.pkce,
        clientId: 'client-id',
        clientSecret: sentinels.clientSecret,
        state: sentinels.state,
        authorizationUrl: `https://provider.example.test/authorize?state=${sentinels.state}`,
        compatibilityMode: 'legacy',
        authorizationResponseIssuerParameterSupported: false,
        allowLocalhostHttp: false,
      },
      sentinels.code,
      sentinels.state,
      { cacheToken: false }
    );

    const renderedLogs = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .map(String)
      .join('\n');
    for (const secret of Object.values(sentinels)) {
      expect(renderedLogs).not.toContain(secret);
    }
  });

  it('classifies a well-formed OAuth provider rejection as failed rather than ambiguous', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'do not log' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    const failure = await completeMCPOAuthFlow(context, 'code', 'state', {
      cacheToken: false,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OAuthCodeExchangeError);
    expect(failure).toMatchObject({ ambiguous: false, failureCode: 'provider_rejected' });
  });

  it.each([
    ['wrong state', 'wrong-state', 'https://provider.example.test', 'callback_state_mismatch'],
    ['missing issuer', 'state', undefined, 'callback_issuer_missing'],
    [
      'mismatched issuer',
      'state',
      'https://other-provider.example.test',
      'callback_issuer_mismatch',
    ],
  ] as const)(
    'classifies strict %s as known pre-exchange failure without token I/O',
    async (_label, state, issuer, failureCode) => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      const failure = await completeMCPOAuthFlow(
        {
          ...context,
          compatibilityMode: 'strict',
          authorizationResponseIssuerParameterSupported: true,
        },
        'single-use-code',
        state,
        { cacheToken: false, issuer }
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(OAuthCallbackValidationError);
      expect(failure).toMatchObject({
        ambiguous: false,
        afterProviderExchange: false,
        failureCode,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['network outcome', () => Promise.reject(new Error('connection reset'))],
    ['provider 5xx', () => Promise.resolve(new Response('', { status: 503 }))],
    ['bare provider 400', () => Promise.resolve(new Response('', { status: 400 }))],
    ['provider timeout', () => Promise.resolve(new Response('', { status: 408 }))],
    ['provider rate limit', () => Promise.resolve(new Response('', { status: 429 }))],
  ])(
    'classifies %s after one-shot claim as ambiguous and non-replayable',
    async (_label, reply) => {
      globalThis.fetch = vi.fn().mockImplementation(reply) as unknown as typeof fetch;

      const failure = await completeMCPOAuthFlow(context, 'code', 'state', {
        cacheToken: false,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OAuthCodeExchangeError);
      expect(failure).toMatchObject({ ambiguous: true });
    }
  );

  it('never copies code or state from an invalid callback URL into the thrown error', () => {
    const callback = 'https://agor.example.test/mcp-servers/oauth-callback?code=CODE-SECRET&state=';
    expect(() => parseOAuthCallback(callback)).toThrow('Invalid OAuth callback URL');
    try {
      parseOAuthCallback(callback);
    } catch (error) {
      expect(String(error)).not.toContain('CODE-SECRET');
      expect(String(error)).not.toContain(callback);
    }
  });
});

// ---------------------------------------------------------------------------
// clearAuthCodeTokenCache — cache clearing semantics
// ---------------------------------------------------------------------------

describe('clearAuthCodeTokenCache', () => {
  beforeEach(() => {
    // Start each test with a clean slate
    clearAuthCodeTokenCache();
  });

  it('blanket clear removes all authCode entries', () => {
    __seedAuthCodeTokenCacheForTests('https://a.example/.well-known/oauth', {
      token: 'tok-a',
      expiresAt: Date.now() + 60_000,
      fetchedAt: Date.now(),
    });
    __seedAuthCodeTokenCacheForTests('https://b.example/.well-known/oauth', {
      token: 'tok-b',
      expiresAt: Date.now() + 60_000,
      fetchedAt: Date.now(),
    });

    expect(getAuthCodeTokenCacheStats().totalEntries).toBe(2);
    clearAuthCodeTokenCache();
    expect(getAuthCodeTokenCacheStats().totalEntries).toBe(0);
  });

  it('blanket clear also clears the DCR client cache', () => {
    __seedDynamicClientCacheForTests('https://a.example/register', {
      client_id: 'client-a',
      redirect_uri: 'https://agor.dev/callback',
    });
    __seedDynamicClientCacheForTests('https://b.example/register', {
      client_id: 'client-b',
      redirect_uri: 'https://agor.dev/callback',
    });

    expect(__dynamicClientCacheSizeForTests()).toBe(2);
    clearAuthCodeTokenCache();
    expect(__dynamicClientCacheSizeForTests()).toBe(0);
  });

  it('per-key clear removes only the specified authCode entry', () => {
    __seedAuthCodeTokenCacheForTests('https://a.example/.well-known/oauth', {
      token: 'tok-a',
      expiresAt: Date.now() + 60_000,
      fetchedAt: Date.now(),
    });
    __seedAuthCodeTokenCacheForTests('https://b.example/.well-known/oauth', {
      token: 'tok-b',
      expiresAt: Date.now() + 60_000,
      fetchedAt: Date.now(),
    });

    clearAuthCodeTokenCache('https://a.example/.well-known/oauth');
    expect(getAuthCodeTokenCacheStats().totalEntries).toBe(1);
  });

  it('per-key clear does NOT clear the DCR client cache', () => {
    __seedAuthCodeTokenCacheForTests('https://a.example/.well-known/oauth', {
      token: 'tok-a',
      expiresAt: Date.now() + 60_000,
      fetchedAt: Date.now(),
    });
    __seedDynamicClientCacheForTests('https://a.example/register', {
      client_id: 'client-a',
      redirect_uri: 'https://agor.dev/callback',
    });

    clearAuthCodeTokenCache('https://a.example/.well-known/oauth');
    // DCR cache should be untouched on per-key clears
    expect(__dynamicClientCacheSizeForTests()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isOAuthRequired — pure function, no mocking
// ---------------------------------------------------------------------------

describe('isOAuthRequired', () => {
  function makeHeaders(wwwAuth?: string): Headers {
    const h = new Headers();
    if (wwwAuth) h.set('www-authenticate', wwwAuth);
    return h;
  }

  it('returns false for non-401 status', () => {
    expect(isOAuthRequired(200, makeHeaders('Bearer realm="OAuth"'))).toBe(false);
    expect(isOAuthRequired(403, makeHeaders('Bearer realm="OAuth"'))).toBe(false);
  });

  it('returns false for 401 without www-authenticate', () => {
    expect(isOAuthRequired(401, makeHeaders())).toBe(false);
  });

  it('returns true for 401 with resource_metadata (RFC 9728)', () => {
    const header =
      'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"';
    expect(isOAuthRequired(401, makeHeaders(header))).toBe(true);
  });

  it('returns true for 401 with plain Bearer challenge (Notion-style)', () => {
    const header = 'Bearer realm="OAuth", error="invalid_token"';
    expect(isOAuthRequired(401, makeHeaders(header))).toBe(true);
  });

  it('returns true for 401 with lowercase bearer', () => {
    expect(isOAuthRequired(401, makeHeaders('bearer realm="test"'))).toBe(true);
  });

  it('returns false for 401 with non-Bearer scheme', () => {
    expect(isOAuthRequired(401, makeHeaders('Basic realm="test"'))).toBe(false);
    expect(isOAuthRequired(401, makeHeaders('Digest realm="test"'))).toBe(false);
  });

  it('does not match Bearer as a substring of another scheme', () => {
    // "X-Bearer-Custom" should not match — we require word boundary
    expect(isOAuthRequired(401, makeHeaders('X-Bearer-Custom realm="test"'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// discoverResourceMetadataUrl — needs fetch mock
// ---------------------------------------------------------------------------

describe('discoverResourceMetadataUrl', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearAuthCodeTokenCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('discovers metadata at root .well-known when MCP URL has no path', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resource: 'https://mcp.example.com',
        authorization_servers: ['https://mcp.example.com'],
      }),
    }) as unknown as typeof fetch;

    const result = await discoverResourceMetadataUrl('https://mcp.example.com');
    expect(result).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('tries path-aware URL first when MCP URL has a path', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url);
      if (url.includes('/mcp')) {
        return {
          ok: true,
          json: async () => ({
            authorization_servers: ['https://example.com'],
          }),
        };
      }
      return { ok: false };
    }) as unknown as typeof fetch;

    const result = await discoverResourceMetadataUrl('https://example.com/mcp');
    expect(result).toBe('https://example.com/.well-known/oauth-protected-resource/mcp');
    // Path-aware was tried first
    expect(calls[0]).toBe('https://example.com/.well-known/oauth-protected-resource/mcp');
  });

  it('falls back to root when path-aware returns 404', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { ok: false };
      return {
        ok: true,
        json: async () => ({
          authorization_servers: ['https://example.com'],
        }),
      };
    }) as unknown as typeof fetch;

    const result = await discoverResourceMetadataUrl('https://example.com/mcp');
    expect(result).toBe('https://example.com/.well-known/oauth-protected-resource');
  });

  it('returns null when no endpoint responds', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

    const result = await discoverResourceMetadataUrl('https://example.com/mcp');
    expect(result).toBeNull();
  });

  it('returns null when response lacks authorization_servers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ resource: 'https://example.com' }), // no authorization_servers
    }) as unknown as typeof fetch;

    const result = await discoverResourceMetadataUrl('https://example.com');
    expect(result).toBeNull();
  });

  it('handles fetch errors gracefully', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network error')) as unknown as typeof fetch;

    const result = await discoverResourceMetadataUrl('https://example.com');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveResourceMetadataUrl — header parse + .well-known fallback
// ---------------------------------------------------------------------------

describe('resolveResourceMetadataUrl', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns header source when resource_metadata is in WWW-Authenticate', async () => {
    const header =
      'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"';
    const result = await resolveResourceMetadataUrl(header, 'https://example.com/mcp');

    expect(result).toEqual({
      metadataUrl: 'https://example.com/.well-known/oauth-protected-resource',
      source: 'header',
    });
  });

  it('falls back to well-known when header lacks resource_metadata (Notion-style)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        authorization_servers: ['https://mcp.notion.com'],
      }),
    }) as unknown as typeof fetch;

    const header = 'Bearer realm="OAuth", error="invalid_token"';
    const result = await resolveResourceMetadataUrl(header, 'https://mcp.notion.com/mcp');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('well-known');
  });

  it('falls back to well-known when header is null', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        authorization_servers: ['https://example.com'],
      }),
    }) as unknown as typeof fetch;

    const result = await resolveResourceMetadataUrl(null, 'https://example.com/mcp');

    expect(result).not.toBeNull();
    expect(result!.source).toBe('well-known');
  });

  it('returns null when both strategies fail', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

    const header = 'Bearer realm="OAuth"';
    const result = await resolveResourceMetadataUrl(header, 'https://example.com/mcp');

    expect(result).toBeNull();
  });

  it('does not call .well-known when header parse succeeds', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const header =
      'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"';
    await resolveResourceMetadataUrl(header, 'https://example.com/mcp');

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// discoverAuthorizationServerFromMcpOrigin — RFC 8414 / OIDC at MCP origin
// (Reo.Dev fallback when RFC 9728 is absent.)
// ---------------------------------------------------------------------------

describe('discoverAuthorizationServerFromMcpOrigin', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('discovers AS metadata at root .well-known when MCP URL has no path', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url);
      if (url === 'https://mcp.example.com/.well-known/oauth-authorization-server') {
        return {
          ok: true,
          json: async () => ({
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
          }),
        };
      }
      return { ok: false };
    }) as unknown as typeof fetch;

    const result = await discoverAuthorizationServerFromMcpOrigin('https://mcp.example.com');
    expect(result).not.toBeNull();
    expect(result!.discoveredAt).toBe(
      'https://mcp.example.com/.well-known/oauth-authorization-server'
    );
    expect(result!.metadata.token_endpoint).toBe('https://auth.example.com/token');
    expect(result!.metadata.registration_endpoint).toBe('https://auth.example.com/register');
  });

  it('reproduces the Reo.Dev pattern: 401 on resource metadata, 200 on AS metadata', async () => {
    // Reo.Dev returns 401 on /.well-known/oauth-protected-resource (broken
    // RFC 9728) but 200 on /.well-known/oauth-authorization-server.
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://mcp.reo.dev/.well-known/oauth-authorization-server') {
        return {
          ok: true,
          json: async () => ({
            issuer: 'https://auth.reo.dev',
            authorization_endpoint: 'https://auth.reo.dev/oauth/authorize',
            token_endpoint: 'https://auth.reo.dev/oauth/token',
            registration_endpoint: 'https://auth.reo.dev/oauth/register',
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            response_types_supported: ['code'],
            token_endpoint_auth_methods_supported: ['none'],
          }),
        };
      }
      return { ok: false, status: 401 };
    }) as unknown as typeof fetch;

    const result = await discoverAuthorizationServerFromMcpOrigin('https://mcp.reo.dev/mcp');
    expect(result).not.toBeNull();
    expect(result!.metadata.registration_endpoint).toBe('https://auth.reo.dev/oauth/register');
    // Public client (no secret) — `none` is the indicator
    expect(result!.metadata.code_challenge_methods_supported).toContain('S256');
  });

  it('tries path-aware first, then falls back to root', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url);
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return {
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://example.com/authorize',
            token_endpoint: 'https://example.com/token',
          }),
        };
      }
      return { ok: false };
    }) as unknown as typeof fetch;

    const result = await discoverAuthorizationServerFromMcpOrigin('https://example.com/mcp');
    expect(result).not.toBeNull();
    // Path-aware was tried first
    expect(calls[0]).toBe('https://example.com/.well-known/oauth-authorization-server/mcp');
    // Then root fallback succeeded
    expect(calls).toContain('https://example.com/.well-known/oauth-authorization-server');
  });

  it('falls back to OIDC discovery when oauth-authorization-server is unavailable', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://example.com/.well-known/openid-configuration') {
        return {
          ok: true,
          json: async () => ({
            issuer: 'https://example.com',
            authorization_endpoint: 'https://example.com/authorize',
            token_endpoint: 'https://example.com/token',
          }),
        };
      }
      return { ok: false };
    }) as unknown as typeof fetch;

    const result = await discoverAuthorizationServerFromMcpOrigin('https://example.com');
    expect(result).not.toBeNull();
    expect(result!.discoveredAt).toBe('https://example.com/.well-known/openid-configuration');
  });

  it('uses OIDC path-append construction for path-bearing issuers', async () => {
    // OIDC Discovery 1.0 §4: issuer https://host/path → discovery URL is
    // https://host/path/.well-known/openid-configuration (NOT
    // https://host/.well-known/openid-configuration/path which is RFC 8414's
    // path-insertion rule).
    const calls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url);
      if (url === 'https://example.com/mcp/.well-known/openid-configuration') {
        return {
          ok: true,
          json: async () => ({
            issuer: 'https://example.com/mcp',
            authorization_endpoint: 'https://example.com/mcp/authorize',
            token_endpoint: 'https://example.com/mcp/token',
          }),
        };
      }
      return { ok: false };
    }) as unknown as typeof fetch;

    const result = await discoverAuthorizationServerFromMcpOrigin('https://example.com/mcp');
    expect(result).not.toBeNull();
    expect(result!.discoveredAt).toBe('https://example.com/mcp/.well-known/openid-configuration');
    // Confirm RFC 8414 path-insert was tried before OIDC path-append
    expect(calls).toContain('https://example.com/.well-known/oauth-authorization-server/mcp');
    expect(calls).toContain('https://example.com/mcp/.well-known/openid-configuration');
    // Negative: never built the malformed path-insert variant for OIDC
    expect(calls).not.toContain('https://example.com/.well-known/openid-configuration/mcp');
  });

  it('rejects responses missing required endpoints', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ issuer: 'https://example.com' }), // no endpoints
    }) as unknown as typeof fetch;

    const result = await discoverAuthorizationServerFromMcpOrigin('https://example.com');
    expect(result).toBeNull();
  });

  it('returns null when no endpoint responds', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

    const result = await discoverAuthorizationServerFromMcpOrigin('https://example.com/mcp');
    expect(result).toBeNull();
  });

  it('handles fetch errors gracefully', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network error')) as unknown as typeof fetch;

    const result = await discoverAuthorizationServerFromMcpOrigin('https://example.com');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveMCPOAuthDiscovery — full cascade: WWW-Authenticate → RFC 9728 →
// AS-direct → OIDC.
// ---------------------------------------------------------------------------

describe('resolveMCPOAuthDiscovery', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns RFC 9728 result when WWW-Authenticate has resource_metadata', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const header =
      'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"';

    const result = await resolveMCPOAuthDiscovery(header, 'https://example.com/mcp');

    expect(result).toEqual({
      kind: 'resource-metadata',
      metadataUrl: 'https://example.com/.well-known/oauth-protected-resource',
      source: 'header',
    });
    // RFC 9728 header parse short-circuits — no fetch needed.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('falls through to AS-direct when RFC 9728 is unavailable (Reo.Dev case)', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      // 9728 endpoints all fail
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return { ok: false, status: 401 };
      }
      // AS metadata at MCP origin succeeds (root fallback)
      if (url === 'https://mcp.reo.dev/.well-known/oauth-authorization-server') {
        return {
          ok: true,
          json: async () => ({
            issuer: 'https://auth.reo.dev',
            authorization_endpoint: 'https://auth.reo.dev/oauth/authorize',
            token_endpoint: 'https://auth.reo.dev/oauth/token',
            registration_endpoint: 'https://auth.reo.dev/oauth/register',
          }),
        };
      }
      return { ok: false };
    }) as unknown as typeof fetch;

    const result = await resolveMCPOAuthDiscovery(null, 'https://mcp.reo.dev/mcp', {
      compatibilityMode: 'legacy',
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('authorization-server');
    if (result!.kind === 'authorization-server') {
      expect(result!.authServerMetadata.registration_endpoint).toBe(
        'https://auth.reo.dev/oauth/register'
      );
    }
  });

  it('returns null when every strategy fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

    const result = await resolveMCPOAuthDiscovery(null, 'https://broken.example.com/mcp');
    expect(result).toBeNull();
  });

  it('stops between well-known candidates when the authority deadline expires', async () => {
    let current = true;
    const fetchMock = vi.fn(async () => {
      // The first path-aware candidate began while current, but its held
      // response crossed the reservation deadline. The post-await assertion
      // must abort rather than issuing the root fallback request.
      current = false;
      return { ok: false, status: 404 };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      resolveMCPOAuthDiscovery(null, 'https://example.com/mcp', {
        compatibilityMode: 'legacy',
        assertCurrent: () => {
          if (!current) throw new Error('reservation expired');
        },
      })
    ).rejects.toThrow('reservation expired');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/.well-known/oauth-protected-resource/mcp',
      expect.anything()
    );
  });

  it('prefers RFC 9728 well-known over AS-direct when both succeed', async () => {
    // If a server publishes both RFC 9728 *and* serves AS metadata at its
    // origin, RFC 9728 should win — it's the spec-compliant indirection that
    // can list multiple ASs.
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return {
          ok: true,
          json: async () => ({
            authorization_servers: ['https://auth.example.com'],
          }),
        };
      }
      if (url.includes('/.well-known/oauth-authorization-server')) {
        return {
          ok: true,
          json: async () => ({
            authorization_endpoint: 'https://example.com/authorize',
            token_endpoint: 'https://example.com/token',
          }),
        };
      }
      return { ok: false };
    }) as unknown as typeof fetch;

    const result = await resolveMCPOAuthDiscovery(null, 'https://example.com/mcp');
    expect(result?.kind).toBe('resource-metadata');
  });
});

// ---------------------------------------------------------------------------
// startMCPOAuthFlow — short-circuit path when AS metadata is prefetched
// (the actual fix wired up end-to-end). Without this, a wiring bug in the
// AS-direct branch could ship green if only discovery is tested.
// ---------------------------------------------------------------------------

describe('startMCPOAuthFlow with prefetchedAuthServerMetadata', () => {
  const originalFetch = globalThis.fetch;
  const redirectUri = 'http://127.0.0.1:9999/oauth/callback';
  const prefetchedOptions = {
    prefetchedAuthServerMetadata: {
      issuer: 'https://auth.reo.dev',
      authorization_endpoint: 'https://auth.reo.dev/oauth/authorize',
      token_endpoint: 'https://auth.reo.dev/oauth/token',
      registration_endpoint: 'https://auth.reo.dev/oauth/register',
    },
    cacheKey: 'https://mcp.reo.dev/mcp',
    resourceUri: 'https://mcp.reo.dev/mcp',
    compatibilityMode: 'legacy' as const,
    dcrMode: 'fallback' as const,
    allowLocalhostHttp: true,
  };

  beforeEach(() => {
    clearAuthCodeTokenCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('skips RFC 9728 fetch and uses prefetched AS metadata + DCR', async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      fetchCalls.push(url);
      // DCR endpoint from prefetched metadata should be the only fetch.
      if (url === 'https://auth.reo.dev/oauth/register' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            client_id: 'dcr-client-123',
            redirect_uris: ['http://127.0.0.1:9999/oauth/callback'],
            token_endpoint_auth_method: 'none',
          }),
        };
      }
      // Fail loud on anything else — we should NOT be probing well-known here.
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const ctx = await startMCPOAuthFlow('', undefined, redirectUri, prefetchedOptions);

    // No well-known probing happened — only the DCR POST.
    expect(fetchCalls).toEqual(['https://auth.reo.dev/oauth/register']);

    // Auth URL was built from the prefetched metadata, with PKCE wired up.
    const authUrl = new URL(ctx.authorizationUrl);
    expect(authUrl.origin + authUrl.pathname).toBe('https://auth.reo.dev/oauth/authorize');
    expect(authUrl.searchParams.get('client_id')).toBe('dcr-client-123');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(authUrl.searchParams.get('state')).toBeTruthy();
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:9999/oauth/callback');
  });

  it.each(['https://gmailmcp.googleapis.com/mcp/v1', 'https://calendarmcp.googleapis.com/mcp/v1'])(
    'requests a durable offline Google grant for %s',
    async (resourceUri) => {
      const ctx = await startMCPOAuthFlow('', 'configured-google-client', redirectUri, {
        prefetchedAuthServerMetadata: {
          issuer: 'https://accounts.google.com',
          authorization_endpoint:
            'https://accounts.google.com/o/oauth2/v2/auth?prompt=select_account',
          token_endpoint: 'https://oauth2.googleapis.com/token',
        },
        cacheKey: resourceUri,
        resourceUri,
        compatibilityMode: 'legacy',
        allowLocalhostHttp: true,
      });

      const authorizationUrl = new URL(ctx.authorizationUrl);
      expect(authorizationUrl.searchParams.get('access_type')).toBe('offline');
      expect(authorizationUrl.searchParams.get('prompt')?.split(/\s+/)).toEqual([
        'select_account',
        'consent',
      ]);
      expect(authorizationUrl.searchParams.get('client_id')).toBe('configured-google-client');
    }
  );

  it('does not add Google-only offline parameters to another provider', async () => {
    const ctx = await startMCPOAuthFlow('', 'configured-client', redirectUri, {
      prefetchedAuthServerMetadata: {
        issuer: 'https://auth.example.test',
        authorization_endpoint: 'https://auth.example.test/authorize',
        token_endpoint: 'https://auth.example.test/token',
      },
      cacheKey: 'https://mcp.example.test/mcp',
      resourceUri: 'https://mcp.example.test/mcp',
      compatibilityMode: 'legacy',
      allowLocalhostHttp: true,
    });

    const authorizationUrl = new URL(ctx.authorizationUrl);
    expect(authorizationUrl.searchParams.get('access_type')).toBeNull();
    expect(authorizationUrl.searchParams.get('prompt')).toBeNull();
  });

  it.each([
    'https://accounts.google.com.attacker.example/authorize',
    'https://accounts.google.example/authorize',
  ])('does not trust a lookalike Google authorization host %s', async (authorizationEndpoint) => {
    const ctx = await startMCPOAuthFlow('', 'configured-client', redirectUri, {
      prefetchedAuthServerMetadata: {
        issuer: new URL(authorizationEndpoint).origin,
        authorization_endpoint: authorizationEndpoint,
        token_endpoint: 'https://auth.example.test/token',
      },
      cacheKey: 'https://mcp.example.test/mcp',
      resourceUri: 'https://mcp.example.test/mcp',
      compatibilityMode: 'legacy',
      allowLocalhostHttp: true,
    });

    const authorizationUrl = new URL(ctx.authorizationUrl);
    expect(authorizationUrl.searchParams.get('access_type')).toBeNull();
    expect(authorizationUrl.searchParams.get('prompt')).toBeNull();
  });

  it('rejects an insecure Google authorization endpoint before provider parameters apply', async () => {
    await expect(
      startMCPOAuthFlow('', 'configured-client', redirectUri, {
        prefetchedAuthServerMetadata: {
          issuer: 'http://accounts.google.com',
          authorization_endpoint: 'http://accounts.google.com/authorize',
          token_endpoint: 'https://oauth2.googleapis.com/token',
        },
        cacheKey: 'https://gmailmcp.googleapis.com/mcp/v1',
        resourceUri: 'https://gmailmcp.googleapis.com/mcp/v1',
        compatibilityMode: 'legacy',
        allowLocalhostHttp: true,
      })
    ).rejects.toThrow('OAuth endpoints require HTTPS');
  });

  it('deduplicates consent while preserving existing Google prompts', async () => {
    const ctx = await startMCPOAuthFlow('', 'configured-google-client', redirectUri, {
      prefetchedAuthServerMetadata: {
        issuer: 'https://accounts.google.com',
        authorization_endpoint:
          'https://accounts.google.com/o/oauth2/v2/auth?prompt=consent%20select_account%20consent',
        token_endpoint: 'https://oauth2.googleapis.com/token',
      },
      cacheKey: 'https://gmailmcp.googleapis.com/mcp/v1',
      resourceUri: 'https://gmailmcp.googleapis.com/mcp/v1',
      compatibilityMode: 'legacy',
      allowLocalhostHttp: true,
    });

    const authorizationUrl = new URL(ctx.authorizationUrl);
    expect(authorizationUrl.searchParams.get('prompt')?.split(/\s+/)).toEqual([
      'consent',
      'select_account',
    ]);
  });

  it('accepts a confidential client when DCR returns a secret with auth method none/omitted, then uses HTTP Basic on token exchange', async () => {
    // Reproduces Atlassian's remote MCP: we request a public client
    // (token_endpoint_auth_method: 'none'), but the provider registers a *confidential* client —
    // HTTP 201 with a client_secret and no auth method echoed back. This previously failed DCR
    // validation ("incompatible public-client credentials"); it must now be accepted.
    const clientSecret = 'atlassian-dcr-secret';
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://auth.reo.dev/oauth/register' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            client_id: 'dcr-confidential-client',
            client_secret: clientSecret,
            redirect_uris: ['http://127.0.0.1:9999/oauth/callback'],
          }),
        };
      }
      if (url === 'https://auth.reo.dev/oauth/token' && init?.method === 'POST') {
        return new Response(JSON.stringify({ access_token: 'confidential-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    // DCR no longer rejects the returned secret — the flow starts and carries the secret.
    const ctx = await startMCPOAuthFlow('', undefined, redirectUri, prefetchedOptions);
    expect(ctx.clientSecret).toBe(clientSecret);
    expect(new URL(ctx.authorizationUrl).searchParams.get('client_id')).toBe(
      'dcr-confidential-client'
    );

    // The secret must flow into the token exchange as HTTP Basic auth (RFC 6749 §2.3.1),
    // and client_id must NOT be duplicated in the request body.
    const tokenResponse = await completeMCPOAuthFlow(ctx, 'auth-code', ctx.state, {
      cacheToken: false,
    });
    expect(tokenResponse.access_token).toBe('confidential-token');

    const tokenCall = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([url]) => String(url) === 'https://auth.reo.dev/oauth/token');
    expect(tokenCall).toBeTruthy();
    const headers = (tokenCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`dcr-confidential-client:${clientSecret}`).toString('base64')}`
    );
    expect(String(tokenCall?.[1]?.body)).not.toContain('client_id=');
  });

  it('throws when cacheKey is missing (would silently break token reuse)', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await expect(
      startMCPOAuthFlow('', undefined, undefined, {
        ...prefetchedOptions,
        cacheKey: undefined,
      })
    ).rejects.toThrow(/cacheKey is required/);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects an unsafe DCR redirect contract before registering the client', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    await expect(
      startMCPOAuthFlow('', undefined, 'http://agor.example.com/oauth/callback', {
        ...prefetchedOptions,
      })
    ).rejects.toThrow('HTTPS');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'blank client ID',
      {
        client_id: '   ',
        redirect_uris: ['http://127.0.0.1:9999/oauth/callback'],
        token_endpoint_auth_method: 'none',
      },
    ],
    [
      'unbound redirect URI',
      {
        client_id: 'client-id',
        redirect_uris: ['http://127.0.0.1:9999/different-callback'],
        token_endpoint_auth_method: 'none',
      },
    ],
    [
      'incompatible token auth method',
      {
        client_id: 'client-id',
        redirect_uris: ['http://127.0.0.1:9999/oauth/callback'],
        token_endpoint_auth_method: 'client_secret_post',
      },
    ],
    [
      'incompatible grant type',
      {
        client_id: 'client-id',
        redirect_uris: ['http://127.0.0.1:9999/oauth/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['client_credentials'],
      },
    ],
    [
      'incompatible response type',
      {
        client_id: 'client-id',
        redirect_uris: ['http://127.0.0.1:9999/oauth/callback'],
        token_endpoint_auth_method: 'none',
        response_types: ['token'],
      },
    ],
  ])('rejects DCR response with %s', async (_label, registration) => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(registration), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    await expect(startMCPOAuthFlow('', undefined, redirectUri, prefetchedOptions)).rejects.toThrow(
      'Dynamic Client Registration failed'
    );
  });
});

describe('marketplace oauth-start production boundary', () => {
  const originalFetch = globalThis.fetch;
  const redirectUri = 'https://agor.example.com/mcp-servers/oauth-callback';

  beforeEach(() => {
    clearAuthCodeTokenCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('takes an Airtable-style origin-scoped resource through discovery and advertised DCR', async () => {
    const mcpUrl = 'https://mcp.airtable.example/mcp';
    const metadataUrl = 'https://mcp.airtable.example/.well-known/oauth-protected-resource';
    const issuer = 'https://airtable.example/oauth2/v1';
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${metadataUrl}/mcp`) return json({}, 404);
      if (url === metadataUrl) {
        return json({
          resource: 'https://mcp.airtable.example',
          authorization_servers: [issuer],
        });
      }
      if (url === 'https://airtable.example/.well-known/oauth-authorization-server/oauth2/v1') {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url === `${issuer}/register` && init?.method === 'POST') {
        return json(
          {
            client_id: 'airtable-dcr-client',
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: 'none',
          },
          201
        );
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    const discovery = await resolveMCPOAuthDiscovery('Bearer', mcpUrl, {
      compatibilityMode: 'marketplace',
    });
    expect(discovery).toEqual({
      kind: 'resource-metadata',
      metadataUrl,
      source: 'well-known',
    });
    const context = await startMCPOAuthFlow('Bearer', undefined, redirectUri, {
      resourceMetadataUrl: metadataUrl,
      resourceUri: mcpUrl,
      compatibilityMode: 'marketplace',
    });

    const authorizationUrl = new URL(context.authorizationUrl);
    expect(context.clientId).toBe('airtable-dcr-client');
    expect(context.authorizationResponseIssuerParameterSupported).toBe(false);
    expect(authorizationUrl.searchParams.get('resource')).toBe(mcpUrl);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('takes Atlassian-style AS-direct discovery through the same oauth-start path', async () => {
    const mcpUrl = 'https://mcp.atlassian.example/v1/mcp';
    const issuer = 'https://mcp.atlassian.example';
    const registrationEndpoint = `${issuer}/v1/register`;
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/.well-known/oauth-protected-resource')) return json({}, 404);
      if (url === `${issuer}/.well-known/oauth-authorization-server`) {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/v1/authorize`,
          token_endpoint: `${issuer}/v1/token`,
          registration_endpoint: registrationEndpoint,
          code_challenge_methods_supported: ['plain', 'S256'],
        });
      }
      if (url === registrationEndpoint && init?.method === 'POST') {
        return json(
          {
            client_id: 'atlassian-dcr-client',
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: 'none',
          },
          201
        );
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    const discovery = await resolveMCPOAuthDiscovery('Bearer', mcpUrl, {
      compatibilityMode: 'marketplace',
    });
    expect(discovery?.kind).toBe('authorization-server');
    if (discovery?.kind !== 'authorization-server') throw new Error('expected AS-direct');

    const context = await startMCPOAuthFlow('Bearer', undefined, redirectUri, {
      prefetchedAuthServerMetadata: discovery.authServerMetadata,
      cacheKey: mcpUrl,
      resourceUri: mcpUrl,
      compatibilityMode: 'marketplace',
    });
    expect(context.clientId).toBe('atlassian-dcr-client');
    expect(new URL(context.authorizationUrl).pathname).toBe('/v1/authorize');
  });

  it('rejects a cross-origin issuer from AS-direct discovery before DCR', async () => {
    const mcpUrl = 'https://mcp.example.com/mcp';
    const registrationEndpoint = 'https://attacker.example/register';
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      startMCPOAuthFlow('Bearer', undefined, redirectUri, {
        prefetchedAuthServerMetadata: {
          issuer: 'https://attacker.example',
          authorization_endpoint: 'https://attacker.example/authorize',
          token_endpoint: 'https://attacker.example/token',
          registration_endpoint: registrationEndpoint,
          code_challenge_methods_supported: ['S256'],
        },
        cacheKey: mcpUrl,
        resourceUri: mcpUrl,
        compatibilityMode: 'marketplace',
      })
    ).rejects.toThrow('does not match the MCP resource origin');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  function linearFetch(options: { callbackIssuer?: boolean; metadataIssuer?: string } = {}) {
    const mcpUrl = 'https://mcp.linear.example/mcp';
    const metadataUrl = 'https://mcp.linear.example/.well-known/oauth-protected-resource/mcp';
    const issuer = 'https://mcp.linear.example';
    return {
      mcpUrl,
      metadataUrl,
      issuer,
      fetch: vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === metadataUrl) {
          return json({ resource: mcpUrl, authorization_servers: [issuer] });
        }
        if (url === `${issuer}/.well-known/oauth-authorization-server`) {
          return json({
            issuer: options.metadataIssuer ?? issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            registration_endpoint: `${issuer}/register`,
            code_challenge_methods_supported: ['S256'],
            ...(options.callbackIssuer
              ? { authorization_response_iss_parameter_supported: true }
              : {}),
          });
        }
        if (url === `${issuer}/register` && init?.method === 'POST') {
          return json(
            {
              client_id: 'linear-dcr-client',
              redirect_uris: [redirectUri],
              token_endpoint_auth_method: 'none',
            },
            201
          );
        }
        if (url === `${issuer}/token` && init?.method === 'POST') {
          return json({ access_token: 'linear-access-token' });
        }
        return json({}, 404);
      }),
    };
  }

  it('does not require Linear-style optional RFC 9207 declarations, but rejects a supplied wrong issuer', async () => {
    const fixture = linearFetch();
    globalThis.fetch = fixture.fetch as unknown as typeof fetch;
    const context = await startMCPOAuthFlow(
      `Bearer resource_metadata="${fixture.metadataUrl}"`,
      undefined,
      redirectUri,
      {
        resourceUri: fixture.mcpUrl,
        compatibilityMode: 'marketplace',
      }
    );
    expect(context.authorizationResponseIssuerParameterSupported).toBe(false);

    await expect(
      completeMCPOAuthFlow(context, 'code', context.state, {
        cacheToken: false,
        issuer: 'https://attacker.example',
      })
    ).rejects.toMatchObject({ failureCode: 'callback_issuer_mismatch' });
    await expect(
      completeMCPOAuthFlow(context, 'code', context.state, { cacheToken: false })
    ).resolves.toMatchObject({ access_token: 'linear-access-token' });
  });

  it('retains explicit strict opt-in and validates it before DCR', async () => {
    const fixture = linearFetch();
    globalThis.fetch = fixture.fetch as unknown as typeof fetch;
    await expect(
      startMCPOAuthFlow(
        `Bearer resource_metadata="${fixture.metadataUrl}"`,
        undefined,
        redirectUri,
        { resourceUri: fixture.mcpUrl, compatibilityMode: 'strict' }
      )
    ).rejects.toThrow('required callback issuer');
    expect(fixture.fetch).not.toHaveBeenCalledWith(
      `${fixture.issuer}/register`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('rejects cross-origin protected-resource metadata instead of relaxing validation wholesale', async () => {
    const mcpUrl = 'https://mcp.example.com/mcp';
    const metadataUrl = 'https://metadata.attacker.example/oauth-protected-resource';
    const issuer = 'https://issuer.example.com';
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === metadataUrl) {
        return json({
          resource: 'https://mcp.example.com',
          authorization_servers: [issuer],
        });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    await expect(
      startMCPOAuthFlow(`Bearer resource_metadata="${metadataUrl}"`, 'client-id', redirectUri, {
        resourceUri: mcpUrl,
        compatibilityMode: 'marketplace',
      })
    ).rejects.toThrow('Protected resource metadata does not match');
  });

  it('rejects an authorization-server issuer alias that crosses origins', async () => {
    const fixture = linearFetch({ metadataIssuer: 'https://attacker.example' });
    globalThis.fetch = fixture.fetch as unknown as typeof fetch;
    await expect(
      startMCPOAuthFlow(
        `Bearer resource_metadata="${fixture.metadataUrl}"`,
        'client-id',
        redirectUri,
        { resourceUri: fixture.mcpUrl, compatibilityMode: 'marketplace' }
      )
    ).rejects.toThrow('Failed to fetch authorization server metadata');
  });

  it('accepts exactly one trailing-slash spelling difference for a marketplace issuer', async () => {
    const fixture = linearFetch({ metadataIssuer: 'https://mcp.linear.example/' });
    globalThis.fetch = fixture.fetch as unknown as typeof fetch;
    await expect(
      startMCPOAuthFlow(
        `Bearer resource_metadata="${fixture.metadataUrl}"`,
        'pre-registered-client',
        redirectUri,
        { resourceUri: fixture.mcpUrl, compatibilityMode: 'marketplace' }
      )
    ).resolves.toMatchObject({
      issuer: 'https://mcp.linear.example/',
      compatibilityMode: 'marketplace',
    });
  });

  it.each([
    'https://MCP.linear.example',
    'https://mcp.linear.example:443',
    'https://mcp.linear.example/a/../',
    'https://mcp.linear.example//',
  ])('does not accept URL canonicalization of marketplace issuer %s', async (metadataIssuer) => {
    const fixture = linearFetch({ metadataIssuer });
    globalThis.fetch = fixture.fetch as unknown as typeof fetch;
    await expect(
      startMCPOAuthFlow(
        `Bearer resource_metadata="${fixture.metadataUrl}"`,
        'pre-registered-client',
        redirectUri,
        { resourceUri: fixture.mcpUrl, compatibilityMode: 'marketplace' }
      )
    ).rejects.toThrow('Failed to fetch authorization server metadata');
  });

  it('requires the callback issuer when a marketplace authorization server advertises RFC 9207', async () => {
    const fixture = linearFetch({ callbackIssuer: true });
    globalThis.fetch = fixture.fetch as unknown as typeof fetch;
    const context = await startMCPOAuthFlow(
      `Bearer resource_metadata="${fixture.metadataUrl}"`,
      undefined,
      redirectUri,
      { resourceUri: fixture.mcpUrl, compatibilityMode: 'marketplace' }
    );
    await expect(
      completeMCPOAuthFlow(context, 'code', context.state, { cacheToken: false })
    ).rejects.toMatchObject({ failureCode: 'callback_issuer_missing' });
  });
});

describe('strict current MCP OAuth profile', () => {
  const originalFetch = globalThis.fetch;
  const resourceUri = 'https://mcp.example.com/mcp';
  const metadataUri = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';
  const issuer = 'https://auth.example.com';

  beforeEach(() => {
    clearAuthCodeTokenCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function strictFetch(
    overrides: {
      resource?: string;
      metadataIssuer?: string;
      s256?: boolean;
      responseIssuer?: boolean;
      registrationEndpoint?: boolean;
      registrationStatus?: number;
    } = {}
  ) {
    return vi.fn().mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === metadataUri) {
        return new Response(
          JSON.stringify({
            resource: overrides.resource ?? resourceUri,
            authorization_servers: [issuer],
            scopes_supported: ['mcp:read'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === `${issuer}/.well-known/oauth-authorization-server`) {
        return new Response(
          JSON.stringify({
            issuer: overrides.metadataIssuer ?? issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            registration_endpoint: overrides.registrationEndpoint
              ? `${issuer}/register`
              : undefined,
            code_challenge_methods_supported: overrides.s256 === false ? ['plain'] : ['S256'],
            authorization_response_iss_parameter_supported: overrides.responseIssuer !== false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === `${issuer}/register` && init?.method === 'POST') {
        return new Response(
          overrides.registrationStatus === 404
            ? JSON.stringify({ error: 'not_found' })
            : JSON.stringify({
                client_id: 'dcr-client',
                redirect_uris: ['https://agor.example.com/mcp-servers/oauth-callback'],
                token_endpoint_auth_method: 'none',
              }),
          {
            status: overrides.registrationStatus ?? 201,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
  }

  async function startStrict() {
    return startMCPOAuthFlow(
      `Bearer resource_metadata="${metadataUri}"`,
      'pre-registered-client',
      'https://agor.example.com/mcp-servers/oauth-callback',
      { resourceUri }
    );
  }

  it('binds PRM, exact issuer, S256, callback issuer, and resource parameters', async () => {
    globalThis.fetch = strictFetch();
    const context = await startStrict();
    const authorizationUrl = new URL(context.authorizationUrl);
    expect(context.compatibilityMode).toBe('strict');
    expect(context.issuer).toBe(issuer);
    expect(authorizationUrl.searchParams.get('resource')).toBe(resourceUri);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');

    await expect(
      completeMCPOAuthFlow(context, 'single-use-code', context.state, {
        cacheToken: false,
        issuer: 'https://other-issuer.example.com',
      })
    ).rejects.toMatchObject({ failureCode: 'callback_issuer_mismatch', ambiguous: false });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'bound-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ) as unknown as typeof fetch;
    await completeMCPOAuthFlow(context, 'single-use-code', context.state, {
      cacheToken: false,
      issuer,
    });
    const tokenRequest = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(tokenRequest?.[1]?.body)).toContain(
      `resource=${encodeURIComponent(resourceUri)}`
    );
  });

  it('rejects protected-resource metadata for a different resource', async () => {
    globalThis.fetch = strictFetch({ resource: 'https://other-resource.example.com' });
    await expect(startStrict()).rejects.toThrow('Protected resource metadata does not match');
  });

  it('rejects authorization metadata with a different issuer', async () => {
    globalThis.fetch = strictFetch({ metadataIssuer: 'https://attacker.example.com' });
    await expect(startStrict()).rejects.toThrow('Failed to fetch authorization server metadata');
  });

  it('rejects missing S256 and authorization-response issuer support', async () => {
    globalThis.fetch = strictFetch({ s256: false });
    await expect(startStrict()).rejects.toThrow('required PKCE S256');

    globalThis.fetch = strictFetch({ responseIssuer: false });
    await expect(startStrict()).rejects.toThrow('required callback issuer');
  });

  it('validates strict metadata before creating a dynamic client', async () => {
    globalThis.fetch = strictFetch({ registrationEndpoint: true, s256: false });
    await expect(
      startMCPOAuthFlow(
        `Bearer resource_metadata="${metadataUri}"`,
        undefined,
        'https://agor.example.com/mcp-servers/oauth-callback',
        { resourceUri }
      )
    ).rejects.toThrow('required PKCE S256');
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalledWith(
      `${issuer}/register`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it.each([undefined, 'advertised' as const])(
    'uses an advertised registration endpoint with DCR mode %s',
    async (dcrMode) => {
      globalThis.fetch = strictFetch({ registrationEndpoint: true });
      const context = await startMCPOAuthFlow(
        `Bearer resource_metadata="${metadataUri}"`,
        undefined,
        'https://agor.example.com/mcp-servers/oauth-callback',
        { resourceUri, dcrMode }
      );

      expect(context.clientId).toBe('dcr-client');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${issuer}/register`,
        expect.objectContaining({ method: 'POST' })
      );
    }
  );

  it('requires a pre-registered client when DCR is explicitly disabled', async () => {
    globalThis.fetch = strictFetch({ registrationEndpoint: true });
    await expect(
      startMCPOAuthFlow(
        `Bearer resource_metadata="${metadataUri}"`,
        undefined,
        'https://agor.example.com/mcp-servers/oauth-callback',
        { resourceUri, dcrMode: 'disabled' }
      )
    ).rejects.toThrow('Dynamic Client Registration is disabled');
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalledWith(
      `${issuer}/register`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('preserves a missing advertised registration endpoint as an actionable diagnostic', async () => {
    globalThis.fetch = strictFetch();

    await expect(
      startMCPOAuthFlow(
        `Bearer resource_metadata="${metadataUri}"`,
        undefined,
        'https://agor.example.com/mcp-servers/oauth-callback',
        { resourceUri }
      )
    ).rejects.toMatchObject({
      diagnostic: { stage: 'dcr_endpoint_discovery' },
    });

    await expect(
      startMCPOAuthFlow(
        `Bearer resource_metadata="${metadataUri}"`,
        undefined,
        'https://agor.example.com/mcp-servers/oauth-callback',
        { resourceUri }
      )
    ).rejects.toThrow(/pre-registered OAuth app|Client ID and Client Secret/i);
  });

  it('preserves a provider registration 404 without the old provider-specific copy', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    const result = startMCPOAuthFlow('', undefined, 'http://127.0.0.1:9999/oauth/callback', {
      prefetchedAuthServerMetadata: {
        issuer: 'https://auth.reo.dev',
        authorization_endpoint: 'https://auth.reo.dev/oauth/authorize',
        token_endpoint: 'https://auth.reo.dev/oauth/token',
        registration_endpoint: 'https://auth.reo.dev/oauth/register',
      },
      cacheKey: 'https://mcp.reo.dev/mcp',
      resourceUri: 'https://mcp.reo.dev/mcp',
      compatibilityMode: 'legacy',
      dcrMode: 'fallback',
      allowLocalhostHttp: true,
    });

    await expect(result).rejects.toMatchObject({
      diagnostic: {
        stage: 'dcr_registration',
        http_status: 404,
        registration_endpoint_source: 'metadata',
      },
    });
    await expect(result).rejects.toThrow(/advertised registration endpoint.*HTTP 404/i);
    await expect(result).rejects.not.toThrow(/figma/i);
  });

  it('turns provider metadata rejection into manual-client guidance without leaking details', async () => {
    const clientSecret = 'CLIENT_SECRET_SHOULD_NOT_APPEAR';
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid_client_metadata',
          error_description: `The redirect URI is not in the approved redirect URI list; client_secret=${clientSecret}`,
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    ) as unknown as typeof fetch;

    const result = startMCPOAuthFlow('', undefined, 'http://127.0.0.1:9999/oauth/callback', {
      prefetchedAuthServerMetadata: {
        issuer: 'https://auth.reo.dev',
        authorization_endpoint: 'https://auth.reo.dev/oauth/authorize',
        token_endpoint: 'https://auth.reo.dev/oauth/token',
        registration_endpoint: 'https://auth.reo.dev/oauth/register',
      },
      cacheKey: 'https://mcp.reo.dev/mcp',
      resourceUri: 'https://mcp.reo.dev/mcp',
      compatibilityMode: 'legacy',
      dcrMode: 'fallback',
      allowLocalhostHttp: true,
    });

    const error = await rejectedError<Error & { diagnostic: MCPOAuthDCRDiagnostic }>(result);
    expect(error).toMatchObject({
      diagnostic: {
        stage: 'dcr_registration',
        http_status: 400,
      },
    });
    expect(error.message).toMatch(/rejected Dynamic Client Registration/i);
    expect(error.message).toMatch(/Client ID and Client Secret/i);
    expect(error.message).not.toContain(clientSecret);
  });

  it('passes the 16 KiB response limit to DCR requests', async () => {
    clearAuthCodeTokenCache();
    vi.mocked(safeOutboundFetch).mockClear();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          client_id: 'dcr-client',
          redirect_uris: ['http://127.0.0.1:9999/oauth/callback'],
          token_endpoint_auth_method: 'none',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
    ) as unknown as typeof fetch;

    await startMCPOAuthFlow('', undefined, 'http://127.0.0.1:9999/oauth/callback', {
      prefetchedAuthServerMetadata: {
        issuer: 'https://auth.reo.dev',
        authorization_endpoint: 'https://auth.reo.dev/oauth/authorize',
        token_endpoint: 'https://auth.reo.dev/oauth/token',
        registration_endpoint: 'https://auth.reo.dev/oauth/register',
      },
      cacheKey: 'https://mcp.reo.dev/mcp',
      resourceUri: 'https://mcp.reo.dev/mcp',
      compatibilityMode: 'legacy',
      dcrMode: 'fallback',
      allowLocalhostHttp: true,
    });

    expect(safeOutboundFetch).toHaveBeenCalledWith(
      'https://auth.reo.dev/oauth/register',
      expect.objectContaining({ maxResponseBytes: 16 * 1024 })
    );
  });

  it('does not propagate provider error descriptions', async () => {
    const accessToken = 'ACCESS_TOKEN_SHOULD_NOT_APPEAR';
    const longDescription = `Provider detail access_token=${accessToken} ${'x'.repeat(2_000)}`;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'invalid_request', error_description: longDescription }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      ) as unknown as typeof fetch;

    const error = await rejectedError<Error & { diagnostic: MCPOAuthDCRDiagnostic }>(
      startMCPOAuthFlow('', undefined, 'http://127.0.0.1:9999/oauth/callback', {
        prefetchedAuthServerMetadata: {
          issuer: 'https://auth.reo.dev',
          authorization_endpoint: 'https://auth.reo.dev/oauth/authorize',
          token_endpoint: 'https://auth.reo.dev/oauth/token',
          registration_endpoint: 'https://auth.reo.dev/oauth/register',
        },
        cacheKey: 'https://mcp.reo.dev/mcp',
        resourceUri: 'https://mcp.reo.dev/mcp',
        compatibilityMode: 'legacy',
        dcrMode: 'fallback',
        allowLocalhostHttp: true,
      })
    );

    expect(error.diagnostic).not.toHaveProperty('error_description');
    expect(error.diagnostic).not.toHaveProperty('error');
    expect(error.message).not.toContain(accessToken);
    expect(error.message.length).toBeLessThan(1_200);
  });

  it('guesses issuer-relative /register only for explicit legacy fallback', async () => {
    globalThis.fetch = strictFetch();
    await expect(
      startMCPOAuthFlow(
        `Bearer resource_metadata="${metadataUri}"`,
        undefined,
        'https://agor.example.com/mcp-servers/oauth-callback',
        { resourceUri, compatibilityMode: 'legacy', dcrMode: 'advertised' }
      )
    ).rejects.toThrow('does not advertise');
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalledWith(
      `${issuer}/register`,
      expect.objectContaining({ method: 'POST' })
    );

    globalThis.fetch = strictFetch();
    await expect(
      startMCPOAuthFlow(
        `Bearer resource_metadata="${metadataUri}"`,
        undefined,
        'https://agor.example.com/mcp-servers/oauth-callback',
        { resourceUri, compatibilityMode: 'legacy', dcrMode: 'fallback' }
      )
    ).resolves.toMatchObject({ clientId: 'dcr-client' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${issuer}/register`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('identifies a failed legacy /register guess without calling it advertised', async () => {
    globalThis.fetch = strictFetch({ registrationStatus: 404 });
    const result = startMCPOAuthFlow(
      `Bearer resource_metadata="${metadataUri}"`,
      undefined,
      'https://agor.example.com/mcp-servers/oauth-callback',
      { resourceUri, compatibilityMode: 'legacy', dcrMode: 'fallback' }
    );

    await expect(result).rejects.toMatchObject({
      diagnostic: {
        stage: 'dcr_registration',
        http_status: 404,
        registration_endpoint_source: 'legacy_fallback',
      },
    });
    await expect(result).rejects.toThrow(/legacy guessed \/register endpoint.*HTTP 404/i);
    await expect(result).rejects.not.toThrow(/advertised registration endpoint/i);
  });

  it('does not relax outbound endpoint safety', async () => {
    globalThis.fetch = strictFetch();
    await expect(
      startMCPOAuthFlow(
        `Bearer resource_metadata="${metadataUri}"`,
        'client-id',
        'http://agor.example.com/mcp-servers/oauth-callback',
        { resourceUri }
      )
    ).rejects.toThrow('HTTPS');
  });

  it('does not let strict manual endpoint overrides diverge from issuer metadata', async () => {
    globalThis.fetch = strictFetch();
    await expect(
      startMCPOAuthFlow(
        `Bearer resource_metadata="${metadataUri}"`,
        'client-id',
        'https://agor.example.com/mcp-servers/oauth-callback',
        {
          resourceUri,
          authorizationUrlOverride: 'https://attacker.example.com/authorize',
          tokenUrlOverride: `${issuer}/token`,
        }
      )
    ).rejects.toThrow('authorization endpoint override does not match metadata');

    globalThis.fetch = strictFetch();
    await expect(
      startMCPOAuthFlow(
        `Bearer resource_metadata="${metadataUri}"`,
        'client-id',
        'https://agor.example.com/mcp-servers/oauth-callback',
        {
          resourceUri,
          authorizationUrlOverride: `${issuer}/authorize`,
          tokenUrlOverride: 'https://attacker.example.com/token',
        }
      )
    ).rejects.toThrow('token endpoint override does not match metadata');
  });
});
