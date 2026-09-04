import type dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGuardedLookup, createPinnedFetch, isOutboundRefusal } from './pinned-fetch';

/** Resolve the guarded lookup as a promise, so assertions read as pass/fail. */
function resolveThrough(
  lookup: ReturnType<typeof createGuardedLookup>,
  hostname: string,
  options: dns.LookupOptions = {}
): Promise<dns.LookupAddress[] | string> {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address) => {
      if (error) reject(error);
      else resolve(address as dns.LookupAddress[] | string);
    });
  });
}

/** A stub resolver that answers every name with the given addresses. */
function answering(...addresses: string[]) {
  return (
    _hostname: string,
    _options: dns.LookupAllOptions,
    callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void
  ) => {
    callback(
      null,
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    );
  };
}

describe('createGuardedLookup', () => {
  it('passes a public answer through with its family', async () => {
    const lookup = createGuardedLookup(answering('93.184.216.34'));
    await expect(resolveThrough(lookup, 'example.com')).resolves.toBe('93.184.216.34');
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['loopback via a non-canonical spelling', '127.1.2.3'],
    ['RFC 1918', '10.0.0.5'],
    ['RFC 1918 in the 172 range', '172.20.1.1'],
    ['cloud metadata link-local', '169.254.169.254'],
    ['CGNAT', '100.64.0.1'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unique-local', 'fd00::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
  ])('refuses a name resolving to %s', async (_label, address) => {
    const lookup = createGuardedLookup(answering(address));
    await expect(resolveThrough(lookup, 'evil.example')).rejects.toThrow(/Refusing to connect/);
  });

  it.each([
    ['RFC 2544 benchmarking', '198.18.0.1'],
    ['IPv6 multicast', 'ff02::1'],
    ['IPv6 deprecated site-local', 'fec0::1'],
    ['deprecated 6to4', '2002::1'],
    ['NAT64 well-known prefix', '64:ff9b::1'],
    ['TEST-NET-3', '203.0.113.1'],
    ['Teredo', '2001::1'],
    ['an unlisted IETF Protocol Assignments sub-block', '2001:5::1'],
    ['SRv6 SIDs', '5f00::1'],
    ['new documentation space', '3fff::1'],
  ])(
    'refuses a name resolving into %s, which is not globally reachable',
    async (_label, address) => {
      // Ranges outside global unicast reach the guard through DNS, not just
      // through a literal URL, so the resolved path is asserted separately.
      const lookup = createGuardedLookup(answering(address));
      await expect(resolveThrough(lookup, 'evil.example')).rejects.toThrow(/Refusing to connect/);
    }
  );

  it('still admits the reachable blocks carved out of a denied parent', async () => {
    // ORCHIDv2 sits inside `2001::/23`, which is denied wholesale; the registry
    // marks it globally reachable, so it has to survive the parent deny.
    const lookup = createGuardedLookup(answering('2001:20::1'));
    await expect(resolveThrough(lookup, 'orchid.example')).resolves.toBe('2001:20::1');
  });

  it('refuses when only one of several answers is private', async () => {
    // The whole point of pinning: a record mixing a public and a private
    // address must not become a coin flip decided by resolver ordering.
    const lookup = createGuardedLookup(answering('93.184.216.34', '169.254.169.254'));
    await expect(resolveThrough(lookup, 'rebind.example')).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('marks a refusal as a refusal rather than a network failure', async () => {
    const lookup = createGuardedLookup(answering('127.0.0.1'));
    const error = await resolveThrough(lookup, 'evil.example').catch((thrown) => thrown);
    expect(isOutboundRefusal(error)).toBe(true);
  });

  it('refuses a name with no answers at all', async () => {
    const lookup = createGuardedLookup(answering());
    await expect(resolveThrough(lookup, 'empty.example')).rejects.toThrow(/No address/);
  });

  it('returns every answer when the caller asked for all of them', async () => {
    // Node's autoSelectFamily path asks for `all`, and returning one address
    // there would silently disable happy-eyeballs for every outbound request.
    const lookup = createGuardedLookup(answering('93.184.216.34', '2606:2800:220::1'));
    await expect(resolveThrough(lookup, 'example.com', { all: true })).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220::1', family: 6 },
    ]);
  });

  it('propagates a resolver failure untouched', async () => {
    const lookup = createGuardedLookup((_hostname, _options, callback) => {
      const error: NodeJS.ErrnoException = new Error('getaddrinfo ENOTFOUND');
      error.code = 'ENOTFOUND';
      callback(error, []);
    });
    await expect(resolveThrough(lookup, 'nope.example')).rejects.toThrow(/ENOTFOUND/);
  });
});

describe('createPinnedFetch', () => {
  let server: http.Server;
  let origin: string;
  let lastRequest: { host?: string; method?: string; body: string } | null = null;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        lastRequest = {
          host: request.headers.host,
          method: request.method,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        const url = request.url ?? '/';
        if (url === '/redirect') {
          response.writeHead(302, { location: 'http://elsewhere.test/' });
          response.end();
          return;
        }
        if (url === '/huge') {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('x'.repeat(5_000));
          return;
        }
        if (url === '/stream') {
          // Answers, then holds the connection open the way a streamable-HTTP
          // MCP server does for the rest of a session.
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('data: {"done":true}\n\n');
          return;
        }
        if (url === '/hang') {
          // Headers, then silence: an idle-socket timer would never fire here.
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.write('.');
          return;
        }
        if (url === '/no-content') {
          response.writeHead(204);
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json', 'x-probe': 'yes' });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://pinned.test:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Drives the HTTP mechanics against loopback; the guard is tested above. */
  const loopbackLookup: Parameters<typeof createPinnedFetch>[0]['lookup'] = (
    _hostname,
    options,
    callback
  ) => {
    if ((options as dns.LookupAllOptions)?.all) {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    } else {
      callback(null, '127.0.0.1', 4);
    }
  };

  const pinned = (overrides: Partial<Parameters<typeof createPinnedFetch>[0]> = {}) =>
    createPinnedFetch({ timeoutMs: 3_000, maxBytes: 1_000, lookup: loopbackLookup, ...overrides });

  it('sends the request and returns status, headers, and body', async () => {
    const response = await pinned()(`${origin}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"hello":true}',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-probe')).toBe('yes');
    expect(await response.json()).toEqual({ ok: true });
    expect(lastRequest?.method).toBe('POST');
    expect(lastRequest?.body).toBe('{"hello":true}');
    // The pinned address goes to the socket; the name still goes on the wire,
    // which is what keeps virtual hosts and TLS certificates working.
    expect(lastRequest?.host).toContain('pinned.test');
  });

  it('returns a redirect instead of following it', async () => {
    // Following one would reach a destination nothing checked.
    const response = await pinned()(`${origin}/redirect`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://elsewhere.test/');
  });

  it('rejects a body past the cap rather than truncating it', async () => {
    await expect(pinned({ maxBytes: 100 })(`${origin}/huge`)).rejects.toThrow(/exceeded 100 bytes/);
  });

  it('returns early when the caller recognises a complete body', async () => {
    // Without this the open stream would burn the whole timeout and report a
    // server that answered correctly as unreachable.
    const response = await pinned({
      timeoutMs: 30_000,
      isBodyComplete: (text) => text.includes('"done":true'),
    })(`${origin}/stream`);
    expect(await response.text()).toContain('"done":true');
  });

  it('handles a status that must not carry a body', async () => {
    const response = await pinned()(`${origin}/no-content`);
    expect(response.status).toBe(204);
  });

  it('bounds the whole exchange, not just socket idleness', async () => {
    // A host that sends headers and one byte then stalls keeps the socket
    // technically active, so only a total deadline ends this.
    await expect(pinned({ timeoutMs: 150 })(`${origin}/hang`)).rejects.toThrow(/Timed out/);
  });

  it('honors caller cancellation while a request is in flight', async () => {
    const controller = new AbortController();
    const request = pinned({ timeoutMs: 30_000 })(`${origin}/hang`, {
      signal: controller.signal,
    });
    controller.abort(new Error('health observation cancelled'));
    await expect(request).rejects.toThrow('health observation cancelled');
  });

  it.each([
    ['a literal private address', 'http://127.0.0.1:9/'],
    ['a non-HTTP scheme', 'file:///etc/passwd'],
    ['embedded credentials', 'https://user:pass@example.com/'],
    ['cloud metadata by name', 'http://metadata.google.internal/'],
  ])('refuses %s before resolving anything', async (_label, url) => {
    const error = await pinned()(url).catch((thrown) => thrown);
    expect(isOutboundRefusal(error)).toBe(true);
  });

  it('refuses a public-looking name that resolves into private space', async () => {
    // The gap a URL-string filter cannot close: `pinned.test` passes every
    // literal check and still answers with a loopback address. Runs after the
    // tests that connect to the same host:port on purpose — a pooled keep-alive
    // socket would skip the lookup and quietly answer 200.
    const guarded = createPinnedFetch({
      timeoutMs: 3_000,
      maxBytes: 1_000,
      lookup: createGuardedLookup(answering('127.0.0.1')),
    });
    const error = await guarded(`${origin}/`).catch((thrown) => thrown);
    expect(isOutboundRefusal(error)).toBe(true);
  });
});
