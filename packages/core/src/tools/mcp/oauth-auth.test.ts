import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MCPExternalError } from './external-error';
import { clearOAuthCache, fetchOAuthToken } from './oauth-auth';

async function expectOAuthConfigurationRequired(operation: Promise<unknown>): Promise<void> {
  const error = await operation.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MCPExternalError);
  expect(error).toMatchObject({
    category: 'configuration_required',
    action: 'review_configuration',
    diagnostic: {
      stage: 'oauth',
      type: 'ConfigurationError',
      code: 'unsafe_outbound_url',
    },
  });
}

describe('OAuth client-credentials egress and cache isolation', () => {
  afterEach(() => clearOAuthCache());

  it('rejects loopback HTTP unless the standalone development exception is explicit', async () => {
    await expectOAuthConfigurationRequired(
      fetchOAuthToken({
        token_url: 'http://127.0.0.1:1/token',
        client_id: 'client',
        client_secret: 'secret',
      })
    );
  });

  it('namespaces cached bearers and allows PostgreSQL callers to bypass the cache', async () => {
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          access_token: `access-${requests}`,
          token_type: 'Bearer',
          expires_in: 3600,
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = {
      token_url: `http://127.0.0.1:${port}/token`,
      client_id: 'same-client',
      client_secret: 'same-secret',
      allowLocalhostHttp: true,
    } as const;

    try {
      await expect(
        fetchOAuthToken({ ...base, cacheNamespace: 'tenant-a:server-a:user-a' })
      ).resolves.toMatchObject({ token: 'access-1' });
      await expect(
        fetchOAuthToken({ ...base, cacheNamespace: 'tenant-a:server-a:user-a' })
      ).resolves.toMatchObject({ token: 'access-1' });
      await expect(
        fetchOAuthToken({ ...base, cacheNamespace: 'tenant-b:server-a:user-a' })
      ).resolves.toMatchObject({ token: 'access-2' });
      await expect(fetchOAuthToken({ ...base, cache: false })).resolves.toMatchObject({
        token: 'access-3',
      });
      await expect(fetchOAuthToken({ ...base, cache: false })).resolves.toMatchObject({
        token: 'access-4',
      });
      expect(requests).toBe(4);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('does not reflect provider response bodies through thrown errors', async () => {
    const marker = 'PROVIDER-BODY-DO-NOT-LOG';
    const server = http.createServer((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid_client', error_description: marker }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const error = await fetchOAuthToken({
        token_url: `http://127.0.0.1:${port}/token`,
        client_id: 'client',
        client_secret: 'secret',
        allowLocalhostHttp: true,
        cache: false,
      }).catch((caught: unknown) => caught);
      expect(String(error)).not.toContain(marker);
      expect(String(error)).toContain('provider rejected');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((closeError) => (closeError ? reject(closeError) : resolve()))
      );
    }
  });
});
