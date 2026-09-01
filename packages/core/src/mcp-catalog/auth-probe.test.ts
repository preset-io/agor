import { describe, expect, it, vi } from 'vitest';
import { probeRemoteAuth, probeRemoteAuthType, probeRemoteBearerToken } from './auth-probe';

// These cover the status-to-verdict rules, so the transport is injected. The
// outbound destination filter is not exercised here: it lives in
// `createPinnedFetch`, which this seam replaces, and is tested against a real
// socket in `utils/pinned-fetch.test.ts`.

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
  let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

  function mockFetch(impl: (input: unknown, init?: RequestInit) => Promise<Response>) {
    const spy = vi.fn(impl);
    fetchImpl = spy as unknown as typeof fetchImpl;
    return spy;
  }

  it.each([
    [
      'an RFC 9728 challenge naming resource metadata',
      'Bearer realm="OAuth", resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
    ],
    ['a bare Bearer challenge', 'Bearer realm="OAuth"'],
  ])('reports oauth when the server answers 401 with %s', async (_label, challenge) => {
    mockFetch(async () => jsonResponse(401, { 'www-authenticate': challenge }));

    expect(await probeRemoteAuthType('https://example.com/mcp', { fetchImpl })).toBe('oauth');
  });

  it('returns the challenge to the read-only metadata auditor', async () => {
    const challenge =
      'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"';
    mockFetch(async () => jsonResponse(401, { 'www-authenticate': challenge }));

    await expect(probeRemoteAuth('https://example.com/mcp', { fetchImpl })).resolves.toEqual({
      authType: 'oauth',
      wwwAuthenticate: challenge,
    });
  });

  it('issues exactly one request, to the URL it was given', async () => {
    // The verdict is read off a single handshake. Nothing here follows a URL
    // the probed server names in its own headers, which is what would turn the
    // daemon into a proxy for whatever that server wants fetched.
    const spy = mockFetch(async () =>
      jsonResponse(401, {
        'www-authenticate':
          'Bearer realm="OAuth", resource_metadata="http://169.254.169.254/latest/meta-data/"',
      })
    );

    expect(await probeRemoteAuthType('https://example.com/mcp', { fetchImpl })).toBe('oauth');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe('https://example.com/mcp');
  });

  it('reports none when an unauthenticated initialize succeeds', async () => {
    mockFetch(async () => new Response(INITIALIZE_RESULT, { status: 200 }));

    expect(await probeRemoteAuthType('https://open.example.com/mcp', { fetchImpl })).toBe('none');
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

    expect(await probeRemoteAuthType('https://sse.example.com/mcp', { fetchImpl })).toBe('none');
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
    // `none` is the verdict that installs a server into a session. Anything that
    // merely returned 200 has not shown it is an MCP server, let alone an open
    // one.
    mockFetch(async () => new Response(body, { status: 200 }));

    expect(await probeRemoteAuthType('https://notmcp.example.com/mcp', { fetchImpl })).toBe(
      'unknown'
    );
  });

  it('distinguishes a non-OAuth challenge from an unreachable host', async () => {
    // The refusal a user reads differs — "sign in" against "this needs an API
    // key" — so collapsing this into `unknown` would render it identically to
    // "we could not reach it".
    mockFetch(async () => jsonResponse(401, { 'www-authenticate': 'ApiKey realm="internal"' }));

    expect(await probeRemoteAuthType('https://apikey.example.com/mcp', { fetchImpl })).toBe(
      'credentials'
    );
  });

  it('reports credentials for a 403', async () => {
    mockFetch(async () => jsonResponse(403, { 'www-authenticate': 'Basic realm="x"' }));
    expect(await probeRemoteAuthType('https://example.com/mcp', { fetchImpl })).toBe('credentials');
  });

  it('reports credentials for a 401 carrying no challenge at all', async () => {
    mockFetch(async () => jsonResponse(401));
    expect(await probeRemoteAuthType('https://example.com/mcp', { fetchImpl })).toBe('credentials');
  });

  it('reports unreachable for a server error', async () => {
    mockFetch(async () => jsonResponse(503));
    expect(await probeRemoteAuthType('https://example.com/mcp', { fetchImpl })).toBe('unreachable');
  });

  it('reports unreachable without throwing when the host does not answer', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });

    expect(await probeRemoteAuthType('https://gone.example.com/mcp', { fetchImpl })).toBe(
      'unreachable'
    );
  });

  it('reports unreachable without throwing when the request times out', async () => {
    mockFetch(async () => {
      throw new DOMException('The operation was aborted', 'TimeoutError');
    });

    expect(await probeRemoteAuthType('https://slow.example.com/mcp', { fetchImpl })).toBe(
      'unreachable'
    );
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

    expect(await probeRemoteAuthType(url, { fetchImpl })).toBe('unknown');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(['https://fdn.example.com/mcp', 'https://fc-cdn.net/mcp', 'https://fd7.io/mcp'])(
    'probes %s, which is a real hostname and not an IPv6 unique-local address',
    async (url) => {
      const spy = mockFetch(async () => new Response(INITIALIZE_RESULT, { status: 200 }));

      expect(await probeRemoteAuthType(url, { fetchImpl })).toBe('none');
      expect(spy).toHaveBeenCalled();
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

    expect(await probeRemoteAuthType('https://open.example.com/mcp', { fetchImpl })).toBe('none');
  });

  it('sends an unauthenticated initialize as the handshake', async () => {
    const spy = mockFetch(async () => new Response(INITIALIZE_RESULT, { status: 200 }));

    await probeRemoteAuthType('https://example.com/mcp', { fetchImpl });

    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).method).toBe('initialize');
    // No Authorization header: the question is what the server does with an
    // anonymous client.
    expect(new Headers(init.headers).get('authorization')).toBeNull();
  });
});

/**
 * Trying a user's API key against the endpoint before anything is installed
 * with it.
 *
 * Same handshake, same reading of the answer, one added header. What differs is
 * the question: not "what does this server want" but "does this key work", and
 * the three verdicts exist because "wrong key" and "nothing usable answered"
 * send a user to different places.
 *
 * The key is an obvious fake. A fixture is a file in a public repository.
 */
describe('probeRemoteBearerToken', () => {
  const KEY = 'fake-not-a-real-key-0000';
  let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

  function mockFetch(impl: (input: unknown, init?: RequestInit) => Promise<Response>) {
    const spy = vi.fn(impl);
    fetchImpl = spy as unknown as typeof fetchImpl;
    return spy;
  }

  it('accepts a key the endpoint completes a handshake for', async () => {
    mockFetch(async () => new Response(INITIALIZE_RESULT, { status: 200 }));

    expect(await probeRemoteBearerToken('https://example.com/mcp', KEY, { fetchImpl })).toBe(
      'accepted'
    );
  });

  it('sends the key as a bearer credential, once, to the URL it was given', async () => {
    // The one request in this module that carries a secret. A second request,
    // or a request to a URL the server named, would be that secret handed
    // somewhere nobody chose.
    const spy = mockFetch(async () => new Response(INITIALIZE_RESULT, { status: 200 }));

    await probeRemoteBearerToken('https://example.com/mcp', KEY, { fetchImpl });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe('https://example.com/mcp');
    const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it.each([401, 403])('rejects a key the endpoint answers %s to', async (status) => {
    mockFetch(async () => jsonResponse(status));

    expect(await probeRemoteBearerToken('https://example.com/mcp', KEY, { fetchImpl })).toBe(
      'rejected'
    );
  });

  it('rejects a key the endpoint answers with an OAuth challenge', async () => {
    // A credential was presented and the client still was not let in. However
    // the server phrases it, that is one fact from the user's side.
    mockFetch(async () => jsonResponse(401, { 'www-authenticate': 'Bearer realm="OAuth"' }));

    expect(await probeRemoteBearerToken('https://example.com/mcp', KEY, { fetchImpl })).toBe(
      'rejected'
    );
  });

  it('does not accept a 200 that is not an MCP handshake', async () => {
    // A marketing page, a captive portal, and an API gateway stub all answer
    // 200. Installing on the strength of one produces a server whose every tool
    // fails — the failure this check exists to prevent.
    mockFetch(async () => new Response('<html>Welcome</html>', { status: 200 }));

    expect(await probeRemoteBearerToken('https://example.com/mcp', KEY, { fetchImpl })).toBe(
      'unusable'
    );
  });

  it('reads an accepted handshake delivered as an SSE event', async () => {
    mockFetch(
      async () =>
        new Response(`event: message\ndata: ${INITIALIZE_RESULT}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
    );

    expect(await probeRemoteBearerToken('https://example.com/mcp', KEY, { fetchImpl })).toBe(
      'accepted'
    );
  });

  it.each([500, 502, 404])('calls a %s unusable rather than a bad key', async (status) => {
    // Reporting a vendor outage as a rejected key sends somebody to rotate a
    // credential that is fine.
    mockFetch(async () => jsonResponse(status));

    expect(await probeRemoteBearerToken('https://example.com/mcp', KEY, { fetchImpl })).toBe(
      'unusable'
    );
  });

  it('calls an unreachable endpoint unusable rather than throwing', async () => {
    mockFetch(async () => {
      throw new Error('ECONNREFUSED');
    });

    expect(await probeRemoteBearerToken('https://example.com/mcp', KEY, { fetchImpl })).toBe(
      'unusable'
    );
  });

  it('does not dial a non-public URL at all', async () => {
    // The key would otherwise be posted to whatever answers inside the daemon's
    // own network.
    const spy = mockFetch(async () => new Response(INITIALIZE_RESULT, { status: 200 }));

    expect(await probeRemoteBearerToken('http://169.254.169.254/mcp', KEY, { fetchImpl })).toBe(
      'unusable'
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
