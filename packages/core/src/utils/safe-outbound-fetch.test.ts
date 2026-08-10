import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeOAuthUrl,
  safeOutboundFetch,
  UnsafeOutboundUrlError,
} from './safe-outbound-fetch';

const servers: http.Server[] = [];

async function listen(
  handler: http.RequestListener
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe('safe OAuth outbound URL policy', () => {
  it('requires HTTPS except for the explicit loopback development exception', () => {
    expect(() => assertSafeOAuthUrl('http://example.com/token')).toThrow(UnsafeOutboundUrlError);
    expect(() =>
      assertSafeOAuthUrl('http://127.0.0.1/token', { allowLocalhostHttp: true })
    ).not.toThrow();
    expect(() =>
      assertSafeOAuthUrl('http://[::1]/token', { allowLocalhostHttp: true })
    ).not.toThrow();
    expect(() =>
      assertSafeOAuthUrl('http://127.0.0.2/token', { allowLocalhostHttp: true })
    ).not.toThrow();
  });

  it.each([
    'https://user:password@example.com/token',
    'https://example.com/token#secret',
    'https://localhost/token',
    'https://provider.local/token',
    'https://metadata.google.internal/token',
    'https://127.0.0.1/token',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/token',
  ])('rejects unsafe parsed destination %s', (url) => {
    expect(() => assertSafeOAuthUrl(url)).toThrow(UnsafeOutboundUrlError);
  });

  it.each([
    'https://0.0.0.0/token',
    'https://10.1.2.3/token',
    'https://127.0.0.1/token',
    'https://169.254.169.254/latest/meta-data',
    'https://172.16.1.1/token',
    'https://192.168.1.1/token',
    'https://198.18.0.1/token',
    'https://[::1]/token',
    'https://[fe80::1]/token',
    'https://[2001:db8::1]/token',
    'https://[2002:7f00:1::]/token',
  ])('rejects non-public connection destination %s', async (url) => {
    await expect(safeOutboundFetch(url, { timeoutMs: 50 })).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError
    );
  });

  it('connects to exact loopback only when the development exception is enabled', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });

    await expect(safeOutboundFetch(url)).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    const response = await safeOutboundFetch(url, { allowLocalhostHttp: true });
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('revalidates redirects and rejects metadata/private destinations', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      response.end();
    });

    await expect(
      safeOutboundFetch(url, { redirect: 'follow', allowLocalhostHttp: true })
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });

  it('never follows a secret-bearing POST redirect', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(307, { location: '/other-token-endpoint' });
      response.end();
    });

    await expect(
      safeOutboundFetch(url, {
        method: 'POST',
        body: 'client_secret=do-not-forward',
        redirect: 'follow',
        allowLocalhostHttp: true,
      })
    ).rejects.toThrow('Secret-bearing OAuth requests cannot redirect');
  });

  it('bounds response bodies before parsing provider-controlled content', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200);
      response.end('x'.repeat(128));
    });

    await expect(
      safeOutboundFetch(url, { allowLocalhostHttp: true, maxResponseBytes: 16 })
    ).rejects.toThrow('response is too large');
  });

  it('applies one absolute deadline while a response drips bytes', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200);
      const interval = setInterval(() => response.write('x'), 10);
      response.on('close', () => clearInterval(interval));
    });

    await expect(
      safeOutboundFetch(url, {
        allowLocalhostHttp: true,
        timeoutMs: 40,
        maxResponseBytes: 1024,
      })
    ).rejects.toThrow('Outbound OAuth timeout');
  });
});
