import { describe, expect, it, vi } from 'vitest';
import { probeRemoteAuthType } from './auth-probe';

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
