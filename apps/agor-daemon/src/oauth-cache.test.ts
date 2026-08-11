import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSaveToken, mockFindById, mockUpdate } = vi.hoisted(() => ({
  mockSaveToken: vi.fn(),
  mockFindById: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('@agor/core/db', () => ({
  UserMCPOAuthTokenRepository: function UserMCPOAuthTokenRepositoryMock() {
    return { saveToken: mockSaveToken };
  },
  MCPServerRepository: function MCPServerRepositoryMock() {
    return { findById: mockFindById, update: mockUpdate };
  },
}));

vi.mock('@agor/core/tools/mcp/oauth-token-expiry', () => ({
  resolveTokenExpiry: () => ({
    expiresAt: new Date(Date.now() + 3_600_000),
    source: 'expires_in',
  }),
}));

import { persistOAuthToken } from './oauth-cache';

describe('persistOAuthToken', () => {
  beforeEach(() => {
    mockSaveToken.mockReset().mockResolvedValue(undefined);
    mockFindById.mockReset();
    mockUpdate.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the grant binding without mutating server configuration', async () => {
    mockFindById.mockResolvedValue({
      mcp_server_id: 'srv-1',
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    });

    await persistOAuthToken(
      {} as never,
      { access_token: 'access', expires_in: 3600, refresh_token: 'refresh' },
      {
        mcpServerId: 'srv-1',
        userId: 'user-1',
        oauthMode: 'per_user',
        clientId: 'client-1',
        tokenEndpoint: 'https://auth.example.com/oauth/token',
        grantBinding: {
          generation: 7,
          version: 1,
          fingerprint: 'a'.repeat(64),
          metadataUri: 'https://mcp.example.com/.well-known/oauth-protected-resource',
          resourceUri: 'https://mcp.example.com/api',
          issuer: 'https://auth.example.com',
          authorizationEndpoint: 'https://auth.example.com/oauth/authorize',
          tokenEndpoint: 'https://auth.example.com/oauth/token',
          redirectUri: 'https://agor.example.com/mcp-servers/oauth-callback',
        },
      },
      'Test'
    );

    expect(mockSaveToken).toHaveBeenCalledWith(
      'user-1',
      'srv-1',
      expect.objectContaining({
        accessToken: 'access',
        refreshToken: 'refresh',
        clientId: 'client-1',
        grantBinding: expect.objectContaining({
          generation: 7,
          fingerprint: 'a'.repeat(64),
        }),
      })
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('never overwrites an explicitly configured token endpoint', async () => {
    mockFindById.mockResolvedValue({
      mcp_server_id: 'srv-1',
      auth: {
        type: 'oauth',
        oauth_mode: 'per_user',
        oauth_token_url: 'https://configured.example.com/token',
      },
    });

    await persistOAuthToken(
      {} as never,
      { access_token: 'access', expires_in: 3600, refresh_token: 'refresh' },
      {
        mcpServerId: 'srv-1',
        userId: 'user-1',
        oauthMode: 'per_user',
        clientId: 'client-1',
        tokenEndpoint: 'https://discovered.example.com/token',
      },
      'Test'
    );

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not log bearer, refresh, or client-secret material', async () => {
    mockFindById.mockResolvedValue({
      mcp_server_id: 'srv-1',
      auth: { type: 'oauth', oauth_mode: 'per_user', oauth_token_url: 'https://auth.test/token' },
    });
    const log = vi.mocked(console.log);
    const warn = vi.mocked(console.warn);

    await persistOAuthToken(
      {} as never,
      {
        access_token: 'ACCESS-DO-NOT-LOG',
        refresh_token: 'REFRESH-DO-NOT-LOG',
        expires_in: 3600,
      },
      {
        mcpServerId: 'srv-1',
        userId: 'user-1',
        oauthMode: 'per_user',
        clientSecret: 'CLIENT-SECRET-DO-NOT-LOG',
      },
      'Test'
    );

    const rendered = [...log.mock.calls, ...warn.mock.calls].flat().map(String).join('\n');
    expect(rendered).not.toContain('ACCESS-DO-NOT-LOG');
    expect(rendered).not.toContain('REFRESH-DO-NOT-LOG');
    expect(rendered).not.toContain('CLIENT-SECRET-DO-NOT-LOG');
  });
});
