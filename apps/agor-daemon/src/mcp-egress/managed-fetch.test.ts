import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedMCPFetch } from './managed-fetch.js';

const listeners: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    listeners.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

async function provider(handler: http.RequestListener) {
  const server = http.createServer(handler);
  listeners.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  return `http://127.0.0.1:${address.port}/mcp`;
}

describe('managed non-task bounded transport', () => {
  it('refuses an oversized request before admission or any provider send', async () => {
    const sent = vi.fn((_request: http.IncomingMessage, response: http.ServerResponse) =>
      response.end()
    );
    const url = await provider(sent);
    const assertCurrent = vi.fn(async () => {});
    const fetch = createManagedMCPFetch({
      url,
      authorization: 'Bearer fake-only-credential',
      assertCurrent,
      allowLocalhostHttp: true,
    });
    await expect(
      fetch(url, { method: 'POST', body: new Uint8Array(4 * 1024 * 1024 + 1) })
    ).rejects.toThrow('too large');
    expect(sent).not.toHaveBeenCalled();
    expect(assertCurrent).not.toHaveBeenCalled();
  });

  it('revalidates the exact daemon bearer for every request and refuses known invalidation', async () => {
    let calls = 0;
    let allowed = true;
    const url = await provider((request, response) => {
      calls++;
      expect(request.headers.authorization).toBe('Bearer fake-only-credential');
      response.setHeader('Content-Type', 'application/json');
      response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    const assertCurrent = vi.fn(async (authorization: string) => {
      expect(authorization).toBe('Bearer fake-only-credential');
      if (!allowed) throw new Error('known invalidation');
    });
    const fetch = createManagedMCPFetch({
      url,
      authorization: 'Bearer fake-only-credential',
      assertCurrent,
      allowLocalhostHttp: true,
    });
    await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer SDK-override' } });
    await fetch(url, { method: 'POST' });
    allowed = false;
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
    expect(calls).toBe(2);
    expect(assertCurrent).toHaveBeenCalledTimes(3);
  });

  it('refuses GET channels, endpoint handoff and redirects without sending a second hop', async () => {
    let calls = 0;
    const url = await provider((_request, response) => {
      calls++;
      response.writeHead(302, { Location: '/other' });
      response.end();
    });
    const fetch = createManagedMCPFetch({
      url,
      authorization: 'Bearer fake-only-credential',
      assertCurrent: async () => {},
      allowLocalhostHttp: true,
    });
    await expect(fetch(url)).rejects.toThrow('bounded Streamable HTTP');
    await expect(fetch(`${url}/other`, { method: 'POST' })).rejects.toThrow(
      'bounded Streamable HTTP'
    );
    expect(calls).toBe(0);
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it.each(['text/plain', 'application/json', 'text/event-stream'])(
    'refuses unstructured/reflected %s output',
    async (contentType) => {
      const url = await provider((_request, response) => {
        response.setHeader('Content-Type', contentType);
        const json = JSON.stringify({ reflected: 'fake-only-credential' });
        response.end(contentType === 'text/event-stream' ? `data: ${json}\n\n` : json);
      });
      const fetch = createManagedMCPFetch({
        url,
        authorization: 'Bearer fake-only-credential',
        assertCurrent: async () => {},
        allowLocalhostHttp: true,
      });
      await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
    }
  );
});
