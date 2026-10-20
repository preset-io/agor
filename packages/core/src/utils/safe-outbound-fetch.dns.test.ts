import type dns from 'node:dns';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { fetchOAuthToken } from '../tools/mcp/oauth-auth';
import {
  assertSafeOutboundUrl,
  configurePrivateOutboundDestinations,
  createPinnedLookup,
  OutboundPreDispatchAuthorityError,
  safeOutboundFetch,
  UnsafeOutboundUrlError,
} from './safe-outbound-fetch';

let server: http.Server | undefined;

interface LookupResult {
  address: string | dns.LookupAddress[];
  family?: number;
}

function invokeLookup(
  lookup: ReturnType<typeof createPinnedLookup>,
  options: dns.LookupOptions
): Promise<LookupResult> {
  return new Promise((resolve, reject) => {
    lookup('provider.example', options, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ address, family });
    });
  });
}

describe('safe outbound connection-time DNS policy', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it.each([
    ['IPv4', '93.184.216.34', 4],
    ['IPv6', '2606:2800:220:1:248:1893:25c8:1946', 6],
  ] as const)(
    'returns the pinned %s address in both Node lookup callback modes',
    async (_label, address, family) => {
      const lookup = createPinnedLookup({ address, family });

      await expect(invokeLookup(lookup, { all: true, family })).resolves.toEqual({
        address: [{ address, family }],
      });
      await expect(invokeLookup(lookup, { all: false, family })).resolves.toEqual({
        address,
        family,
      });
    }
  );

  it('lets the OAuth client-credentials path complete through Node all-address lookup', async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'oauth-access', token_type: 'Bearer' }));
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    await expect(
      fetchOAuthToken({
        token_url: `http://localhost:${port}/token`,
        client_id: 'client',
        client_secret: 'secret',
        allowLocalhostHttp: true,
        cache: false,
      })
    ).resolves.toMatchObject({ token: 'oauth-access' });
  });

  it('does not reuse a pooled socket after the pinned address changes', async () => {
    let requests = 0;
    server = http.createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, {
        connection: 'keep-alive',
        'content-length': '2',
      });
      response.end('ok');
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    let lookups = 0;
    lookupMock.mockImplementation(async () => [
      { address: lookups++ === 0 ? '127.0.0.1' : '127.0.0.2', family: 4 },
    ]);
    const options = { allowLocalhostHttp: true, timeoutMs: 500 };

    await expect(
      safeOutboundFetch(`http://localhost:${port}/first`, options)
    ).resolves.toMatchObject({
      status: 200,
    });
    await expect(safeOutboundFetch(`http://localhost:${port}/second`, options)).rejects.toThrow();
    expect(requests).toBe(1);
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a mixed public/private DNS answer before opening a connection', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.23.45.67', family: 4 },
    ]);

    await expect(safeOutboundFetch('https://mixed-answer.example/token')).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError
    );
    expect(lookupMock).toHaveBeenCalledWith('mixed-answer.example', {
      all: true,
      verbatim: true,
    });
  });

  it('rejects a DNS answer that changes entirely to private space', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    await expect(
      safeOutboundFetch('https://rebound.example/latest/meta-data')
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });

  it('applies the absolute deadline to unresolved DNS', async () => {
    lookupMock.mockReturnValue(new Promise(() => undefined));

    const failure = await safeOutboundFetch('https://unresolved.example/token', {
      timeoutMs: 30,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: 'Outbound OAuth timeout', code: 'ETIMEDOUT' });
  });

  it('propagates DNS resolver failures without attempting a socket', async () => {
    const error = new Error('getaddrinfo ENOTFOUND');
    lookupMock.mockRejectedValue(error);

    await expect(safeOutboundFetch('https://resolver-error.example/token')).rejects.toBe(error);
  });
});

describe('operator-pinned private outbound destinations', () => {
  const ALLOWED_HOST = 'internal-api.example.internal';
  const answers: Record<string, Array<{ address: string; family: number }>> = {};
  const resolveDns = vi.fn(async (hostname: string) => answers[hostname] ?? []);

  beforeEach(() => {
    for (const key of Object.keys(answers)) delete answers[key];
    resolveDns.mockClear();
    configurePrivateOutboundDestinations([{ host: ALLOWED_HOST, cidrs: ['10.200.0.0/24'] }]);
  });

  afterEach(() => {
    configurePrivateOutboundDestinations([]);
    vi.restoreAllMocks();
  });

  it('allows a listed HTTPS host whose every address is inside its CIDRs', async () => {
    answers[ALLOWED_HOST] = [
      { address: '10.200.0.5', family: 4 },
      { address: '10.200.0.6', family: 4 },
    ];

    await expect(
      assertSafeOutboundUrl(`https://${ALLOWED_HOST}/token`, { resolveDns })
    ).resolves.toBeUndefined();

    // The full request path passes DNS validation and reaches the pre-dispatch
    // fence; throwing there proves no socket was needed to show admission.
    const fence = new Error('stop before dispatch');
    await expect(
      safeOutboundFetch(`https://${ALLOWED_HOST.toUpperCase()}/token`, {
        resolveDns,
        assertCurrent: () => {
          throw fence;
        },
      })
    ).rejects.toBeInstanceOf(OutboundPreDispatchAuthorityError);
  });

  it.each([
    ['a public address', '93.184.216.34', 4],
    ['a different private range', '10.201.0.5', 4],
    ['an IPv6 address', '2606:2800:220:1:248:1893:25c8:1946', 6],
  ] as const)('rejects the listed host when one answer is %s', async (_label, address, family) => {
    answers[ALLOWED_HOST] = [
      { address: '10.200.0.5', family: 4 },
      { address, family },
    ];

    await expect(
      assertSafeOutboundUrl(`https://${ALLOWED_HOST}/token`, { resolveDns })
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });

  it('rejects an unlisted host that resolves into an allowed CIDR', async () => {
    answers['other.example.internal'] = [{ address: '10.200.0.5', family: 4 }];

    await expect(
      assertSafeOutboundUrl('https://other.example.internal/token', { resolveDns })
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });

  it('rejects plain HTTP to a listed host', async () => {
    answers[ALLOWED_HOST] = [{ address: '10.200.0.5', family: 4 }];

    await expect(
      assertSafeOutboundUrl(`http://${ALLOWED_HOST}/token`, { resolveDns })
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    expect(resolveDns).not.toHaveBeenCalled();
  });

  it('refuses a redirect from a listed host to an unlisted private host', async () => {
    answers[ALLOWED_HOST] = [{ address: '10.200.0.5', family: 4 }];
    answers['unlisted.example.internal'] = [{ address: '10.200.0.9', family: 4 }];
    const requestSpy = vi.spyOn(https, 'request').mockImplementation(((
      _url: URL,
      _options: https.RequestOptions,
      callback: (response: http.IncomingMessage) => void
    ) => {
      const request = Object.assign(new EventEmitter(), {
        write: () => true,
        destroy: () => request,
        end: () => {
          const response = Object.assign(Readable.from([]), {
            statusCode: 302,
            statusMessage: 'Found',
            headers: { location: 'https://unlisted.example.internal/next' },
          });
          callback(response as unknown as http.IncomingMessage);
          return request;
        },
      });
      return request as unknown as http.ClientRequest;
    }) as unknown as typeof https.request);

    await expect(
      safeOutboundFetch(`https://${ALLOWED_HOST}/start`, { resolveDns, redirect: 'follow' })
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(resolveDns).toHaveBeenCalledWith('unlisted.example.internal', {
      all: true,
      verbatim: true,
    });
  });

  it('keeps blocking private answers when no destinations are configured', async () => {
    configurePrivateOutboundDestinations([]);
    answers[ALLOWED_HOST] = [{ address: '10.200.0.5', family: 4 }];
    answers['public.example.com'] = [{ address: '93.184.216.34', family: 4 }];

    await expect(
      assertSafeOutboundUrl(`https://${ALLOWED_HOST}/token`, { resolveDns })
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    await expect(
      assertSafeOutboundUrl('https://public.example.com/token', { resolveDns })
    ).resolves.toBeUndefined();
  });
});
