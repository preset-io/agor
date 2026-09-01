import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type OAuthDisconnectDeps, performOAuthDisconnect } from './oauth-disconnect';

function createMockDeps(overrides: Partial<OAuthDisconnectDeps> = {}): OAuthDisconnectDeps {
  return {
    userId: 'user-1234-abcd',
    mcpServerId: 'srv-5678-efgh',
    isAdmin: false,
    userTokenRepo: {
      deleteToken: vi.fn().mockResolvedValue(true),
    },
    mcpServerRepo: {
      findById: vi.fn().mockResolvedValue({
        url: 'https://mcp.example.com/api',
        auth: {},
      }),
    },
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

  it('deletes the shared-mode row from the unified token table when mode is shared', async () => {
    const deleteToken = vi.fn().mockResolvedValue(true);
    const deps = createMockDeps({
      userTokenRepo: { deleteToken },
      mcpServerRepo: {
        findById: vi.fn().mockResolvedValue({
          url: 'https://mcp.example.com/api',
          auth: { type: 'oauth', oauth_mode: 'shared' },
        }),
      },
    });

    const result = await performOAuthDisconnect(deps);

    expect(deleteToken).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'Shared OAuth grants can only be disconnected by an admin',
    });
  });

  it('allows an admin to delete only the shared-mode row', async () => {
    const deleteToken = vi.fn().mockResolvedValue(true);
    const deps = createMockDeps({
      isAdmin: true,
      userTokenRepo: { deleteToken },
      mcpServerRepo: {
        findById: vi.fn().mockResolvedValue({
          url: 'https://mcp.example.com/api',
          auth: { type: 'oauth', oauth_mode: 'shared' },
        }),
      },
    });

    await performOAuthDisconnect(deps);

    expect(deleteToken).toHaveBeenCalledWith(null, 'srv-5678-efgh');
    expect(deleteToken).not.toHaveBeenCalledWith('user-1234-abcd', 'srv-5678-efgh');
  });

  it('does not touch the shared-mode row for per_user servers', async () => {
    const deleteToken = vi.fn().mockResolvedValue(true);
    const deps = createMockDeps({
      userTokenRepo: { deleteToken },
      mcpServerRepo: {
        findById: vi.fn().mockResolvedValue({
          url: 'https://mcp.example.com/api',
          auth: { type: 'oauth', oauth_mode: 'per_user' },
        }),
      },
    });

    await performOAuthDisconnect(deps);

    expect(deleteToken).toHaveBeenCalledWith('user-1234-abcd', 'srv-5678-efgh');
    expect(deleteToken).not.toHaveBeenCalledWith(null, 'srv-5678-efgh');
  });

  it('succeeds even when no per-user token was found', async () => {
    const deps = createMockDeps({
      userTokenRepo: {
        deleteToken: vi.fn().mockResolvedValue(false),
      },
    });

    const result = await performOAuthDisconnect(deps);
    expect(result.success).toBe(true);
    expect(result.message).toBe(
      'OAuth connection removed locally; provider access was not revoked'
    );
  });

  it('supports a server with no URL', async () => {
    const deps = createMockDeps({
      mcpServerRepo: {
        findById: vi.fn().mockResolvedValue({ auth: {} }),
      },
    });

    const result = await performOAuthDisconnect(deps);
    expect(result.success).toBe(true);
  });

  it('returns and logs only the closed contract for hostile repository exceptions', async () => {
    const sentinel = 'SENTINEL_OAUTH_DISCONNECT_EXCEPTION';
    const failure = new Error(sentinel);
    Object.defineProperty(failure, 'name', {
      get() {
        throw new Error(sentinel);
      },
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = createMockDeps({
      mcpServerRepo: { findById: vi.fn().mockRejectedValue(failure) },
    });

    const result = await performOAuthDisconnect(deps);

    expect(result).toEqual({
      success: false,
      error: 'OAuth connection could not be removed',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
  });
});
