import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { isSpecialUseAddress, safeFetch } from './safe-fetch';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];

describe('safe outbound egress', () => {
  it.each([
    '0.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])('blocks special-use public destination %s', (address) => {
    expect(isSpecialUseAddress(address, 'public')).toBe(true);
  });

  it('allows private health targets but never metadata/link-local targets', () => {
    expect(isSpecialUseAddress('10.0.0.2', 'health')).toBe(false);
    expect(isSpecialUseAddress('127.0.0.1', 'health')).toBe(false);
    expect(isSpecialUseAddress('169.254.169.254', 'health')).toBe(true);
    expect(isSpecialUseAddress('fe80::1', 'health')).toBe(true);
  });

  it('rejects when any DNS answer is private (rebind defense)', async () => {
    const lookup = async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '127.0.0.1', family: 4 as const },
    ];
    await expect(safeFetch('https://example.test', { lookup })).rejects.toThrow('blocked address');
  });

  it.each(['http://example.test:8080', 'file:///etc/passwd', 'http://user:pass@example.test'])(
    'rejects disallowed URL %s',
    async (url) => {
      await expect(safeFetch(url, { lookup: publicLookup })).rejects.toThrow();
    }
  );

  it('rejects metadata hostnames before DNS', async () => {
    await expect(
      safeFetch('http://metadata.google.internal', { lookup: publicLookup })
    ).rejects.toThrow('blocked');
  });

  it('revalidates redirect destinations', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try {
      await expect(
        safeFetch(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, {
          addressPolicy: 'health',
        })
      ).rejects.toThrow('blocked address');
    } finally {
      server.close();
    }
  });

  it('does not forward credentials to a redirected origin', async () => {
    let forwardedApiKey: string | undefined;
    const target = http.createServer((request, response) => {
      forwardedApiKey = request.headers['x-api-key'] as string | undefined;
      response.end('ok');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetAddress = target.address();
    const redirector = http.createServer((_request, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${typeof targetAddress === 'object' && targetAddress ? targetAddress.port : 0}`,
      });
      response.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    const redirectAddress = redirector.address();
    try {
      const response = await safeFetch(
        `http://127.0.0.1:${typeof redirectAddress === 'object' && redirectAddress ? redirectAddress.port : 0}`,
        { addressPolicy: 'health', headers: { 'X-API-Key': 'secret' } }
      );
      expect(response.ok).toBe(true);
      expect(forwardedApiKey).toBeUndefined();
    } finally {
      redirector.close();
      target.close();
    }
  });
});
