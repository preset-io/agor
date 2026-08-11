import type dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { fetchOAuthToken } from '../tools/mcp/oauth-auth';
import {
  createPinnedLookup,
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

      await expect(invokeLookup(lookup, { all: true })).resolves.toEqual({
        address: [{ address, family }],
      });
      await expect(invokeLookup(lookup, { all: false })).resolves.toEqual({
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

    await expect(
      safeOutboundFetch('https://unresolved.example/token', { timeoutMs: 30 })
    ).rejects.toThrow('Outbound OAuth timeout');
  });
});
