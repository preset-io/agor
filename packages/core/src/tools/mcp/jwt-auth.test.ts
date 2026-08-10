import { afterEach, describe, expect, it } from 'vitest';
import { resolveMCPAuthHeaders } from './jwt-auth';
import { __seedAuthCodeTokenCacheForTests, clearAuthCodeTokenCache } from './oauth-mcp-transport';

describe('resolveMCPAuthHeaders OAuth authority', () => {
  afterEach(() => clearAuthCodeTokenCache());

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
});
