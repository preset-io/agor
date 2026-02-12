import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type OAuthDisconnectDeps, performOAuthDisconnect } from './oauth-disconnect';

function createMockDeps(overrides: Partial<OAuthDisconnectDeps> = {}): OAuthDisconnectDeps {
  return {
    userId: 'user-1234-abcd',
    mcpServerId: 'srv-5678-efgh',
    userTokenRepo: {
      deleteToken: vi.fn().mockResolvedValue(true),
    },
    mcpServerRepo: {
      findById: vi.fn().mockResolvedValue({
        url: 'https://mcp.example.com/api',
        auth: {},
      }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    oauthTokenCache: new Map(),
    clearCoreTokenCache: vi.fn(),
    ...overrides,
  };
}

describe('performOAuthDisconnect', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when userId is undefined', async () => {
    const deps = createMockDeps({ userId: undefined });
    const result = await performOAuthDisconnect(deps);
    expect(result).toEqual({ success: false, error: 'User not authenticated' });
  });

  it('returns error when mcpServerId is empty', async () => {
    const deps = createMockDeps({ mcpServerId: '' });
    const result = await performOAuthDisconnect(deps);
    expect(result).toEqual({ success: false, error: 'MCP server ID is required' });
  });

  it('deletes the per-user token from the database', async () => {
    const deps = createMockDeps();
    await performOAuthDisconnect(deps);
    expect(deps.userTokenRepo.deleteToken).toHaveBeenCalledWith('user-1234-abcd', 'srv-5678-efgh');
  });

  it('clears daemon cache by origin', async () => {
    const cache = new Map<string, unknown>();
    cache.set('https://mcp.example.com', { token: 'old' });
    const deps = createMockDeps({ oauthTokenCache: cache });

    await performOAuthDisconnect(deps);

    expect(cache.has('https://mcp.example.com')).toBe(false);
  });

  it('calls clearCoreTokenCache', async () => {
    const deps = createMockDeps();
    await performOAuthDisconnect(deps);
    expect(deps.clearCoreTokenCache).toHaveBeenCalled();
  });

  it('clears shared token from auth config when present', async () => {
    const deps = createMockDeps({
      mcpServerRepo: {
        findById: vi.fn().mockResolvedValue({
          url: 'https://mcp.example.com/api',
          auth: {
            oauth_access_token: 'shared-token-abc',
            oauth_token_expires_at: 9999999,
            oauth_client_id: 'keep-this',
          },
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    });

    await performOAuthDisconnect(deps);

    expect(deps.mcpServerRepo.update).toHaveBeenCalledWith('srv-5678-efgh', {
      auth: expect.objectContaining({
        oauth_client_id: 'keep-this',
        oauth_access_token: undefined,
        oauth_token_expires_at: undefined,
      }),
    });
  });

  it('succeeds even when no per-user token was found', async () => {
    const deps = createMockDeps({
      userTokenRepo: {
        deleteToken: vi.fn().mockResolvedValue(false),
      },
    });

    const result = await performOAuthDisconnect(deps);
    expect(result.success).toBe(true);
    expect(result.message).toBe('OAuth connection removed');
  });

  it('skips cache clear when server has no URL', async () => {
    const deps = createMockDeps({
      mcpServerRepo: {
        findById: vi.fn().mockResolvedValue({ auth: {} }),
        update: vi.fn(),
      },
    });

    const result = await performOAuthDisconnect(deps);
    expect(result.success).toBe(true);
    expect(deps.clearCoreTokenCache).not.toHaveBeenCalled();
  });
});
