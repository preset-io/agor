/**
 * Tests for OAuth MCP transport helpers.
 *
 * Covers:
 * - isOAuthRequired(): Bearer challenge detection
 * - discoverResourceMetadataUrl(): .well-known fallback discovery
 * - resolveResourceMetadataUrl(): header parse + .well-known fallback
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  discoverAuthorizationServerFromMcpOrigin,
  discoverResourceMetadataUrl,
  isOAuthRequired,
  resolveMCPOAuthDiscovery,
  resolveResourceMetadataUrl,
  startMCPOAuthFlow,
} from './oauth-mcp-transport';

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

    const result = await resolveMCPOAuthDiscovery(null, 'https://mcp.reo.dev/mcp');

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

  beforeEach(() => {
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
          json: async () => ({ client_id: 'dcr-client-123' }),
        };
      }
      // Fail loud on anything else — we should NOT be probing well-known here.
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const ctx = await startMCPOAuthFlow('', undefined, 'http://127.0.0.1:9999/oauth/callback', {
      prefetchedAuthServerMetadata: {
        issuer: 'https://auth.reo.dev',
        authorization_endpoint: 'https://auth.reo.dev/oauth/authorize',
        token_endpoint: 'https://auth.reo.dev/oauth/token',
        registration_endpoint: 'https://auth.reo.dev/oauth/register',
      },
      cacheKey: 'https://mcp.reo.dev/mcp',
    });

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

  it('throws when cacheKey is missing (would silently break token reuse)', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await expect(
      startMCPOAuthFlow('', undefined, undefined, {
        prefetchedAuthServerMetadata: {
          issuer: 'https://auth.reo.dev',
          authorization_endpoint: 'https://auth.reo.dev/oauth/authorize',
          token_endpoint: 'https://auth.reo.dev/oauth/token',
          registration_endpoint: 'https://auth.reo.dev/oauth/register',
        },
        // cacheKey omitted on purpose
      })
    ).rejects.toThrow(/cacheKey is required/);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
