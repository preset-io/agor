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

  it('backfills a discovered token endpoint so OAuth grants can be refreshed later', async () => {
    mockFindById.mockResolvedValue({
      mcp_server_id: 'srv-1',
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    });

    await persistOAuthToken(
      {} as never,
      { access_token: 'access', expires_in: 3600, refresh_token: 'refresh' },
      'https://mcp.example.com/mcp',
      {
        mcpServerId: 'srv-1',
        userId: 'user-1',
        oauthMode: 'per_user',
        clientId: 'client-1',
        tokenEndpoint: 'https://auth.example.com/oauth/token',
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
      })
    );
    expect(mockUpdate).toHaveBeenCalledWith('srv-1', {
      auth: {
        type: 'oauth',
        oauth_mode: 'per_user',
        oauth_token_url: 'https://auth.example.com/oauth/token',
      },
    });
  });

  it('does not overwrite an explicitly configured token endpoint', async () => {
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
      'https://mcp.example.com/mcp',
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
});
