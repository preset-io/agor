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
  discoverResourceMetadataUrl,
  isOAuthRequired,
  resolveResourceMetadataUrl,
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
