import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeRemoteAuthType } from './auth-probe';

// These cover the status-to-verdict rules and the discovery cascade the probe
// delegates to `oauth-mcp-transport`, so the transport is injected rather than
// mocked globally. The outbound destination filter is not exercised here: it
// lives in `createPinnedFetch`, which this seam replaces, and is tested against
// a real socket in `utils/pinned-fetch.test.ts`.
const NOW = new Date('2026-07-28T00:00:00.000Z');
const now = () => NOW;

/** A well-formed unauthenticated handshake, which is what earns `none`. */
const INITIALIZE_RESULT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    serverInfo: { name: 'example', version: '1' },
  },
});

function jsonResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : '{}', { status, headers });
}

describe('probeRemoteAuthType', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

  function mockFetch(impl: (input: unknown, init?: RequestInit) => Promise<Response>) {
    const spy = vi.fn(impl);
    fetchImpl = spy as unknown as typeof fetchImpl;
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

    const result = await probeRemoteAuthType('https://example.com/mcp', { now, fetchImpl });

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

    const result = await probeRemoteAuthType('https://example.com/mcp', { now, fetchImpl });

    expect(result.probed_auth_type).toBe('oauth');
    expect(result.auth_server_origin).toBeUndefined();
  });

  it('reports none when an unauthenticated initialize succeeds', async () => {
    mockFetch(async () => new Response(INITIALIZE_RESULT, { status: 200 }));

    const result = await probeRemoteAuthType('https://open.example.com/mcp', { now, fetchImpl });

    expect(result.probed_auth_type).toBe('none');
    expect(result.probed_url).toBe('https://open.example.com/mcp');
  });

  it('reads an initialize result delivered as an SSE event', async () => {
    // Streamable HTTP servers may answer either way, and a server that chose SSE
    // is no less connectable for it.
    mockFetch(
      async () =>
        new Response(`event: message\ndata: ${INITIALIZE_RESULT}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
    );

    const result = await probeRemoteAuthType('https://sse.example.com/mcp', { now, fetchImpl });

    expect(result.probed_auth_type).toBe('none');
  });

  it.each([
    [
      'a result carrying only serverInfo',
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }),
    ],
    [
      'a result answering a different request id',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 999,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          serverInfo: { name: 'example' },
        },
      }),
    ],
    [
      'a result with no capabilities',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-06-18', serverInfo: { name: 'example' } },
      }),
    ],
    [
      'a result whose serverInfo has no name',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} },
      }),
    ],
    [
      'a result with an empty protocolVersion',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '', capabilities: {}, serverInfo: { name: 'example' } },
      }),
    ],
    ['a marketing page', '<!doctype html><html><body>Buy our thing</body></html>'],
    ['an unrelated JSON API', JSON.stringify({ status: 'ok', uptime: 1234 })],
    ['an empty body', ''],
    ['a JSON-RPC error rather than a result', JSON.stringify({ jsonrpc: '2.0', id: 1, error: {} })],
    [
      'a result missing every initialize field',
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    ],
    [
      'a bare result with no jsonrpc envelope',
      JSON.stringify({ result: { protocolVersion: '1' } }),
    ],
  ])('reports unknown, not none, when a 200 carries %s', async (_label, body) => {
    // `none` is the verdict that renders a connect-directly button. Anything
    // that merely returned 200 has not shown it is an MCP server, let alone an
    // open one, and `verified` would compound the claim.
    mockFetch(async () => new Response(body, { status: 200 }));

    const result = await probeRemoteAuthType('https://notmcp.example.com/mcp', { now, fetchImpl });

    expect(result.probed_auth_type).toBe('unknown');
  });

  it('distinguishes a non-OAuth challenge from an unreachable host, and names the scheme', async () => {
    mockFetch(async () => jsonResponse(401, { 'www-authenticate': 'ApiKey realm="internal"' }));

    const result = await probeRemoteAuthType('https://apikey.example.com/mcp', { now, fetchImpl });

    // The connect form can ask for a key; collapsing this into `unknown` would
    // render it identically to "we could not reach it".
    expect(result.probed_auth_type).toBe('credentials');
    expect(result.probed_auth_scheme).toBe('ApiKey');
  });

  it('reports credentials for a 403', async () => {
    mockFetch(async () => jsonResponse(403, { 'www-authenticate': 'Basic realm="x"' }));
    const result = await probeRemoteAuthType('https://example.com/mcp', { now, fetchImpl });
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

    const result = await probeRemoteAuthType('https://example.com/mcp', { now, fetchImpl });

    expect(result.probed_auth_type).toBe('credentials');
    expect(result.probed_auth_scheme).toBeUndefined();
  });

  it('reports unreachable for a server error', async () => {
    mockFetch(async () => jsonResponse(503));
    const result = await probeRemoteAuthType('https://example.com/mcp', { now, fetchImpl });
    expect(result.probed_auth_type).toBe('unreachable');
  });

  it('reports unreachable without throwing when the host does not answer', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });

    const result = await probeRemoteAuthType('https://gone.example.com/mcp', { now, fetchImpl });

    expect(result.probed_auth_type).toBe('unreachable');
    expect(result.probed_at).toEqual(NOW);
  });

  it('reports unreachable without throwing when the request times out', async () => {
    mockFetch(async () => {
      throw new DOMException('The operation was aborted', 'TimeoutError');
    });

    const result = await probeRemoteAuthType('https://slow.example.com/mcp', { now, fetchImpl });

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

    const result = await probeRemoteAuthType(url, { now, fetchImpl });

    expect(spy).not.toHaveBeenCalled();
    expect(result.probed_auth_type).toBe('unknown');
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://10.0.0.5/admin', 'RFC 1918'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['file:///etc/passwd', 'non-http scheme'],
  ])(
    'refuses to follow a WWW-Authenticate resource_metadata pointing at %s (%s)',
    async (metadataUrl) => {
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

      const result = await probeRemoteAuthType('https://example.com/mcp', { now, fetchImpl });

      expect(result.probed_auth_type).toBe('oauth');
      expect(result.auth_server_origin).toBeUndefined();
      // The probe request itself is the only fetch that may have happened.
      for (const call of spy.mock.calls) {
        expect(String(call[0])).toBe('https://example.com/mcp');
      }
    }
  );

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

    const result = await probeRemoteAuthType('https://example.com/mcp', { now, fetchImpl });

    expect(result.probed_auth_type).toBe('oauth');
    expect(result.auth_server_origin).toBeUndefined();
  });

  it.each([
    ['well-known', 'Bearer realm="OAuth"'],
    [
      'header-named',
      'Bearer realm="OAuth", resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
    ],
  ])('never follows a %s discovery redirect into a private host', async (_label, challenge) => {
    // The candidate URL is derived from an origin that passes the filter, so
    // only the redirect is hostile. Discovery makes these fetches itself, so
    // guarding the URLs the probe sees directly is not enough.
    const spy = mockFetch(async (input) => {
      if (String(input).endsWith('/mcp')) {
        return jsonResponse(401, { 'www-authenticate': challenge });
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });
    });

    const result = await probeRemoteAuthType('https://example.com/mcp', { now, fetchImpl });

    expect(result.probed_auth_type).toBe('oauth');
    expect(result.auth_server_origin).toBeUndefined();
    // No request may have reached the metadata host. That the redirect is not
    // followed in the first place is a property of the transport, covered
    // against a real socket in `utils/pinned-fetch.test.ts`.
    for (const call of spy.mock.calls) {
      expect(String(call[0])).not.toContain('169.254.169.254');
    }
  });

  it('yields no authorization server when the metadata document is unusable', async () => {
    // 1 MiB of non-JSON, with a Content-Length that lies about it. The transport
    // refuses it on size; this asserts the probe survives either way and still
    // reports the OAuth requirement it already established.
    const oversized = 'x'.repeat(1024 * 1024);
    mockFetch(async (input) => {
      if (String(input).endsWith('/mcp')) {
        return jsonResponse(401, {
          'www-authenticate':
            'Bearer realm="OAuth", resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
        });
      }
      return new Response(oversized, { status: 200, headers: { 'content-length': '10' } });
    });

    const result = await probeRemoteAuthType('https://example.com/mcp', { now, fetchImpl });

    expect(result.probed_auth_type).toBe('oauth');
    expect(result.auth_server_origin).toBeUndefined();
  });

  it('routes discovery requests through the probe transport, not the global fetch', async () => {
    // Discovery follows URLs the probed server names in its own headers. Left on
    // the global fetch it would reach them unpinned and unbounded, which is the
    // hop the destination filter exists to cover.
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

    await probeRemoteAuthType('https://example.com/mcp', { now, fetchImpl });

    expect(
      spy.mock.calls.some((call) => String(call[0]).includes('oauth-protected-resource'))
    ).toBe(true);
  });

  it.each(['https://fdn.example.com/mcp', 'https://fc-cdn.net/mcp', 'https://fd7.io/mcp'])(
    'probes %s, which is a real hostname and not an IPv6 unique-local address',
    async (url) => {
      const spy = mockFetch(async () => new Response(INITIALIZE_RESULT, { status: 200 }));

      const result = await probeRemoteAuthType(url, { now, fetchImpl });

      expect(spy).toHaveBeenCalled();
      expect(result.probed_auth_type).toBe('none');
    }
  );

  it('accepts a server that echoes the request id as a string', async () => {
    // JSON-RPC permits a string id, and rejecting one would under-report a
    // server that is genuinely open.
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: '1',
            result: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 'example', version: '1' },
            },
          }),
          { status: 200 }
        )
    );

    const result = await probeRemoteAuthType('https://open.example.com/mcp', { now, fetchImpl });

    expect(result.probed_auth_type).toBe('none');
  });

  it('sends an unauthenticated initialize as the handshake', async () => {
    const spy = mockFetch(async () => new Response(INITIALIZE_RESULT, { status: 200 }));

    await probeRemoteAuthType('https://example.com/mcp', { now, fetchImpl });

    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).method).toBe('initialize');
    // No Authorization header: the question is what the server does with an
    // anonymous client.
    expect(new Headers(init.headers).get('authorization')).toBeNull();
  });
});
