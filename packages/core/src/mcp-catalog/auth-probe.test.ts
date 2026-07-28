import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeRemoteAuthType } from './auth-probe';

// The probe delegates RFC 9728 / 8414 discovery to `oauth-mcp-transport`, which
// calls the global fetch. Mocking it here (rather than injecting a client)
// covers the probe request and every discovery request it triggers.
const originalFetch = globalThis.fetch;

const NOW = new Date('2026-07-28T00:00:00.000Z');
const now = () => NOW;

function jsonResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : '{}', { status, headers });
}

describe('probeRemoteAuthType', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(impl: (input: unknown, init?: RequestInit) => Promise<Response>) {
    const spy = vi.fn(impl);
    globalThis.fetch = spy as unknown as typeof fetch;
    return spy;
  }

  it('reports oauth when the server answers 401 with an RFC 9728 challenge', async () => {
    mockFetch(async (input) => {
      if (String(input).endsWith('/mcp')) {
        return jsonResponse(401, {
          'www-authenticate':
            'Bearer realm="OAuth", resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
        });
      }
      return new Response(
        JSON.stringify({ authorization_servers: ['https://auth.example.com/tenant'] }),
        { status: 200 }
      );
    });

    const result = await probeRemoteAuthType('https://example.com/mcp', { now });

    expect(result.probed_auth_type).toBe('oauth');
    expect(result.auth_server_origin).toBe('https://auth.example.com');
    expect(result.probed_at).toEqual(NOW);
  });

  it('still reports oauth when the authorization server cannot be resolved', async () => {
    mockFetch(async (input) => {
      if (String(input).endsWith('/mcp')) {
        return jsonResponse(401, { 'www-authenticate': 'Bearer realm="OAuth"' });
      }
      throw new Error('metadata host unreachable');
    });

    const result = await probeRemoteAuthType('https://example.com/mcp', { now });

    expect(result.probed_auth_type).toBe('oauth');
    expect(result.auth_server_origin).toBeUndefined();
  });

  it('reports none when an unauthenticated initialize succeeds', async () => {
    mockFetch(async () => jsonResponse(200));

    const result = await probeRemoteAuthType('https://open.example.com/mcp', { now });

    expect(result.probed_auth_type).toBe('none');
  });

  it('distinguishes a non-OAuth challenge from an unreachable host, and names the scheme', async () => {
    mockFetch(async () => jsonResponse(401, { 'www-authenticate': 'ApiKey realm="internal"' }));

    const result = await probeRemoteAuthType('https://apikey.example.com/mcp', { now });

    // The connect form can ask for a key; collapsing this into `unknown` would
    // render it identically to "we could not reach it".
    expect(result.probed_auth_type).toBe('credentials');
    expect(result.probed_auth_scheme).toBe('ApiKey');
  });

  it('reports credentials for a 403', async () => {
    mockFetch(async () => jsonResponse(403, { 'www-authenticate': 'Basic realm="x"' }));
    const result = await probeRemoteAuthType('https://example.com/mcp', { now });
    expect(result.probed_auth_type).toBe('credentials');
    expect(result.probed_auth_scheme).toBe('Basic');
  });

  it.each([
    ['A'.repeat(200), 'over-long token'],
    ['<script>alert(1)</script>', 'markup'],
    ['', 'empty header'],
  ])('records no challenge scheme for %s (%s)', async (header) => {
    // The header is attacker-controlled and the value is persisted and later
    // rendered, so anything that is not a plausible scheme token is dropped
    // rather than truncated into something that looks legitimate.
    mockFetch(async () => jsonResponse(401, { 'www-authenticate': header }));

    const result = await probeRemoteAuthType('https://example.com/mcp', { now });

    expect(result.probed_auth_type).toBe('credentials');
    expect(result.probed_auth_scheme).toBeUndefined();
  });

  it('reports unreachable for a server error', async () => {
    mockFetch(async () => jsonResponse(503));
    const result = await probeRemoteAuthType('https://example.com/mcp', { now });
    expect(result.probed_auth_type).toBe('unreachable');
  });

  it('reports unreachable without throwing when the host does not answer', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });

    const result = await probeRemoteAuthType('https://gone.example.com/mcp', { now });

    expect(result.probed_auth_type).toBe('unreachable');
    expect(result.probed_at).toEqual(NOW);
  });

  it('reports unreachable without throwing when the request times out', async () => {
    mockFetch(async () => {
      throw new DOMException('The operation was aborted', 'TimeoutError');
    });

    const result = await probeRemoteAuthType('https://slow.example.com/mcp', { now });

    expect(result.probed_auth_type).toBe('unreachable');
  });

  it.each([
    ['http://127.0.0.1:3030/mcp', 'loopback'],
    ['http://localhost:3030/mcp', 'localhost'],
    ['http://169.254.169.254/mcp', 'cloud metadata'],
    ['http://10.1.2.3/mcp', 'RFC 1918 class A'],
    ['http://192.168.1.10/mcp', 'RFC 1918 class C'],
    ['http://172.20.0.5/mcp', 'RFC 1918 class B'],
    ['http://[::1]/mcp', 'IPv6 loopback'],
    ['http://metadata.google.internal/mcp', 'GCP metadata'],
    ['file:///etc/passwd', 'non-http scheme'],
    ['https://user:secret@example.com/mcp', 'embedded credentials'],
    ['http://2130706433/mcp', 'decimal-encoded loopback'],
    ['http://0x7f000001/mcp', 'hex-encoded loopback'],
    ['http://[::ffff:127.0.0.1]/mcp', 'IPv4-mapped loopback'],
    ['http://[::]/mcp', 'IPv6 unspecified'],
    ['http://100.64.0.1/mcp', 'CGNAT'],
    ['not a url at all', 'unparseable'],
  ])('never issues a request to %s (%s)', async (url) => {
    const spy = mockFetch(async () => jsonResponse(200));

    const result = await probeRemoteAuthType(url, { now });

    expect(spy).not.toHaveBeenCalled();
    expect(result.probed_auth_type).toBe('unknown');
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://10.0.0.5/admin', 'RFC 1918'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['file:///etc/passwd', 'non-http scheme'],
  ])('refuses to follow a WWW-Authenticate resource_metadata pointing at %s (%s)', async (metadataUrl) => {
    // The header comes from the probed server, which any stranger can publish
    // to the public registry. Following it unchecked would turn the daemon
    // into a blind SSRF proxy into its own network.
    const spy = mockFetch(async (input) => {
      if (String(input).endsWith('/mcp')) {
        return jsonResponse(401, {
          'www-authenticate': `Bearer realm="OAuth", resource_metadata="${metadataUrl}"`,
        });
      }
      throw new Error(`probe must not fetch ${String(input)}`);
    });

    const result = await probeRemoteAuthType('https://example.com/mcp', { now });

    expect(result.probed_auth_type).toBe('oauth');
    expect(result.auth_server_origin).toBeUndefined();
    // The probe request itself is the only fetch that may have happened.
    for (const call of spy.mock.calls) {
      expect(String(call[0])).toBe('https://example.com/mcp');
    }
  });

  it('refuses to record an authorization server that resolves to a private host', async () => {
    mockFetch(async (input) => {
      if (String(input).endsWith('/mcp')) {
        return jsonResponse(401, {
          'www-authenticate':
            'Bearer realm="OAuth", resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
        });
      }
      return new Response(JSON.stringify({ authorization_servers: ['http://192.168.0.1/'] }), {
        status: 200,
      });
    });

    const result = await probeRemoteAuthType('https://example.com/mcp', { now });

    expect(result.probed_auth_type).toBe('oauth');
    expect(result.auth_server_origin).toBeUndefined();
  });

  it('does not follow redirects when reading resource metadata either', async () => {
    const spy = mockFetch(async (input) => {
      if (String(input).endsWith('/mcp')) {
        return jsonResponse(401, {
          'www-authenticate':
            'Bearer realm="OAuth", resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
        });
      }
      return new Response(JSON.stringify({ authorization_servers: ['https://auth.example.com'] }), {
        status: 200,
      });
    });

    await probeRemoteAuthType('https://example.com/mcp', { now });

    const metadataCall = spy.mock.calls.find((call) =>
      String(call[0]).includes('oauth-protected-resource')
    );
    expect((metadataCall?.[1] as RequestInit | undefined)?.redirect).toBe('manual');
  });

  it.each([
    'https://fdn.example.com/mcp',
    'https://fc-cdn.net/mcp',
    'https://fd7.io/mcp',
  ])('probes %s, which is a real hostname and not an IPv6 unique-local address', async (url) => {
    const spy = mockFetch(async () => jsonResponse(200));

    const result = await probeRemoteAuthType(url, { now });

    expect(spy).toHaveBeenCalled();
    expect(result.probed_auth_type).toBe('none');
  });

  it('does not follow redirects, so a probe cannot be aimed at a private host', async () => {
    const spy = mockFetch(async () => jsonResponse(200));

    await probeRemoteAuthType('https://example.com/mcp', { now });

    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).method).toBe('initialize');
  });
});
