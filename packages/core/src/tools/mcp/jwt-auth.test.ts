import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPExternalError } from './external-error';
import { clearAllJWTTokens, fetchJWTToken, resolveMCPAuthHeaders } from './jwt-auth';
import { __seedAuthCodeTokenCacheForTests, clearAuthCodeTokenCache } from './oauth-mcp-transport';

const servers: http.Server[] = [];

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

async function expectJWTConfigurationRequired(operation: Promise<unknown>): Promise<void> {
  const error = await operation.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MCPExternalError);
  expect(error).toMatchObject({
    category: 'configuration_required',
    action: 'review_configuration',
    diagnostic: {
      stage: 'jwt',
      type: 'ConfigurationError',
      code: 'unsafe_outbound_url',
    },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  clearAuthCodeTokenCache();
  clearAllJWTTokens();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

describe('resolveMCPAuthHeaders OAuth authority', () => {
  it('does not probe client credentials after a tenant/user-scoped authoritative miss', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const auth = {
      type: 'oauth' as const,
      oauth_client_id: 'client',
      oauth_client_secret: 'secret',
      oauth_token_url: 'https://provider.example/token',
    };
    await expect(
      resolveMCPAuthHeaders(auth, 'https://provider.example/mcp', {
        oauthCredentialAuthority: 'executor_repository',
      })
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('never reads an origin-only browser OAuth cache entry', async () => {
    __seedAuthCodeTokenCacheForTests(
      'https://mcp.example.test/.well-known/oauth-protected-resource',
      {
        token: 'tenant-a-user-a-token',
        fetchedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }
    );

    await expect(
      resolveMCPAuthHeaders({ type: 'oauth' }, 'https://mcp.example.test/tools')
    ).resolves.toBeUndefined();
  });

  it('uses only an explicitly hydrated durable OAuth access token', async () => {
    await expect(
      resolveMCPAuthHeaders(
        { type: 'oauth', oauth_access_token: 'bound-token' },
        'https://mcp.example.test/tools'
      )
    ).resolves.toEqual({ Authorization: 'Bearer bound-token' });
  });

  it('never logs an inferred or failed secret-bearing OAuth endpoint', async () => {
    const sentinel = 'sentinel-oauth-endpoint-09e75';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        resolveMCPAuthHeaders(
          {
            type: 'oauth',
            oauth_client_id: 'client',
            oauth_client_secret: 'secret',
          },
          `https://${sentinel}.invalid/mcp`,
          { disableProcessTokenCache: true }
        )
      ).resolves.toBeUndefined();

      const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
      expect(logged).not.toContain(sentinel);
      expect(log).toHaveBeenCalledWith('[OAuth] Token URL inferred from MCP endpoint');
      expect(warn).toHaveBeenCalledWith('[OAuth] Token fetch failed');
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('propagates authority loss during client-credential fetch instead of falling back', async () => {
    let signalRequest!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      signalRequest = resolve;
    });
    let releaseResponse!: () => void;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const tokenUrl = await listen(async (_request, response) => {
      signalRequest();
      await responseReleased;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"access_token":"must-not-return","token_type":"bearer"}');
    });
    let current = true;
    const resolving = resolveMCPAuthHeaders(
      {
        type: 'oauth',
        oauth_token_url: tokenUrl,
        oauth_client_id: 'client',
        oauth_client_secret: 'secret',
      },
      'http://127.0.0.1/mcp',
      {
        allowLocalhostHttp: true,
        disableProcessTokenCache: true,
        assertCurrent: () => {
          if (!current) throw new Error('request authority replaced');
        },
      }
    );

    await requestStarted;
    current = false;
    releaseResponse();

    await expect(resolving).rejects.toThrow('request authority replaced');
  });
});

describe('JWT discovery authentication outbound policy', () => {
  const credentials = { api_token: 'client', api_secret: 'secret' };

  it.each([
    'https://127.0.0.1/token',
    'https://10.0.0.8/token',
    'https://169.254.169.254/latest/meta-data',
    'http://example.com/token',
  ])('rejects loopback, private, metadata, and non-HTTPS destination %s', async (api_url) => {
    await expectJWTConfigurationRequired(
      fetchJWTToken({ api_url, ...credentials }, { allowLocalhostHttp: false, cache: false })
    );
  });

  it('allows the narrow loopback development exception only when explicit', async () => {
    const api_url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"access_token":"development-token"}');
    });

    await expectJWTConfigurationRequired(
      fetchJWTToken({ api_url, ...credentials }, { allowLocalhostHttp: false, cache: false })
    );
    await expect(
      fetchJWTToken({ api_url, ...credentials }, { allowLocalhostHttp: true, cache: false })
    ).resolves.toBe('development-token');
  });

  it('never follows a token POST redirect, including toward metadata', async () => {
    const api_url = await listen((_request, response) => {
      response.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data' });
      response.end();
    });

    await expectJWTConfigurationRequired(
      fetchJWTToken({ api_url, ...credentials }, { allowLocalhostHttp: true, cache: false })
    );
  });

  it('bounds provider responses before parsing', async () => {
    const api_url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('x'.repeat(300 * 1024));
    });

    await expectJWTConfigurationRequired(
      fetchJWTToken({ api_url, ...credentials }, { allowLocalhostHttp: true, cache: false })
    );
  });

  it('does not expose a provider response body in errors', async () => {
    const api_url = await listen((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"access_token":"internal-response-secret","error_description":"secret"}');
    });

    const error = await fetchJWTToken(
      { api_url, ...credentials },
      { allowLocalhostHttp: true, cache: false }
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('provider rejected');
    expect((error as Error).message).not.toContain('internal-response-secret');
    expect((error as Error).message).not.toContain('error_description');
  });

  it('partitions the standalone cache by trusted namespace', async () => {
    let requests = 0;
    const api_url = await listen((_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(`{"access_token":"token-${requests}"}`);
    });

    const first = await fetchJWTToken(
      { api_url, ...credentials },
      { allowLocalhostHttp: true, cacheNamespace: 'tenant-a:server:user', cache: true }
    );
    const second = await fetchJWTToken(
      { api_url, ...credentials },
      { allowLocalhostHttp: true, cacheNamespace: 'tenant-b:server:user', cache: true }
    );
    expect(first).toBe('token-1');
    expect(second).toBe('token-2');
    expect(requests).toBe(2);
  });
});
