import type { MCPServer, SessionID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { getMcpServersForSession } from './mcp-scoping';

const makeServer = (id: string, scope: MCPServer['scope'], name = id): MCPServer =>
  ({
    mcp_server_id: id,
    name,
    transport: 'http',
    scope,
    source: 'user',
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
    auth: { type: 'token', token: `value-${id}` },
  }) as MCPServer;

describe('getMcpServersForSession', () => {
  it('fails closed in strict mode when repository dependencies are unavailable', async () => {
    await expect(
      getMcpServersForSession('session-a' as SessionID, { mode: 'strict' })
    ).rejects.toThrow('MCP repository dependencies are required');
  });

  it('fails closed in strict mode when a required template cannot be resolved', async () => {
    const server = {
      ...makeServer('template-server', 'session'),
      auth: {
        type: 'oauth',
        oauth_client_id: 'client',
        oauth_client_secret: '{{ user.env.MISSING_MCP_CLIENT_SECRET }}',
      },
    } as MCPServer;

    await expect(
      getMcpServersForSession('session-a' as SessionID, {
        mode: 'strict',
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: {
          listEffectiveServers: vi.fn().mockResolvedValue([server]),
        } as never,
      })
    ).rejects.toThrow(/template-server.+unresolved/i);
  });

  it('fails closed in strict mode when required OAuth hydration is unavailable', async () => {
    const oauthServer = {
      ...makeServer('oauth-server', 'session'),
      auth: { type: 'oauth', oauth_mode: 'per_user', oauth_access_token: '••••••••' },
    } as MCPServer;

    await expect(
      getMcpServersForSession('session-a' as SessionID, {
        mode: 'strict',
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: {
          listEffectiveServers: vi.fn().mockResolvedValue([oauthServer]),
        } as never,
      })
    ).rejects.toThrow(/OAuth.+auth-header hydrator/i);
  });

  it('fails closed in strict mode when a remote bearer server has no token', async () => {
    const bearerServer = {
      ...makeServer('bearer-server', 'session'),
      url: 'http://127.0.0.1:4100/mcp',
      auth: { type: 'bearer' },
    } as MCPServer;

    await expect(
      getMcpServersForSession('session-a' as SessionID, {
        mode: 'strict',
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: {
          listEffectiveServers: vi.fn().mockResolvedValue([bearerServer]),
        } as never,
      })
    ).rejects.toThrow(/bearer-server.+bearer token/i);
  });

  it('fails closed in strict mode when a remote JWT server has incomplete credentials', async () => {
    const jwtServer = {
      ...makeServer('jwt-server', 'session'),
      url: 'http://127.0.0.1:4100/mcp',
      auth: {
        type: 'jwt',
        api_url: 'http://127.0.0.1:4101/token',
        api_token: 'client-token',
      },
    } as MCPServer;

    await expect(
      getMcpServersForSession('session-a' as SessionID, {
        mode: 'strict',
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: {
          listEffectiveServers: vi.fn().mockResolvedValue([jwtServer]),
        } as never,
      })
    ).rejects.toThrow(/jwt-server.+JWT credentials/i);
  });

  it('accepts structurally complete remote bearer and JWT auth in strict mode', async () => {
    const bearerServer = {
      ...makeServer('bearer-server', 'session'),
      url: 'http://127.0.0.1:4100/mcp',
      auth: { type: 'bearer', token: 'bearer-token' },
    } as MCPServer;
    const jwtServer = {
      ...makeServer('jwt-server', 'session'),
      url: 'http://127.0.0.1:4100/mcp',
      auth: {
        type: 'jwt',
        api_url: 'http://127.0.0.1:4101/token',
        api_token: 'client-token',
        api_secret: 'client-secret',
      },
    } as MCPServer;

    await expect(
      getMcpServersForSession('session-a' as SessionID, {
        mode: 'strict',
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: {
          listEffectiveServers: vi.fn().mockResolvedValue([bearerServer, jwtServer]),
        } as never,
      })
    ).resolves.toEqual([
      { server: bearerServer, source: 'session-assigned' },
      { server: jwtServer, source: 'session-assigned' },
    ]);
  });

  it('propagates repository failures in strict mode instead of returning a partial set', async () => {
    await expect(
      getMcpServersForSession('session-a' as SessionID, {
        mode: 'strict',
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: {
          listEffectiveServers: vi.fn().mockRejectedValue(new Error('attachment route failed')),
        } as never,
      })
    ).rejects.toThrow('attachment route failed');
  });

  it('preserves best-effort behavior for existing callers', async () => {
    await expect(getMcpServersForSession('session-a' as SessionID, {})).resolves.toEqual([]);
  });

  it('uses session-scoped effective config retrieval when available', async () => {
    const globalServer = makeServer('global-server', 'global');
    const sessionServer = makeServer('session-server', 'session');
    const listEffectiveServers = vi.fn().mockResolvedValue([globalServer, sessionServer]);
    const findAll = vi.fn();
    const listServers = vi.fn();

    const servers = await getMcpServersForSession('session-a' as SessionID, {
      mcpServerRepo: { findAll } as never,
      sessionMCPRepo: { listEffectiveServers, listServers } as never,
      forUserId: 'user-a',
    });

    expect(listEffectiveServers).toHaveBeenCalledWith('session-a', true, 'user-a');
    expect(findAll).not.toHaveBeenCalled();
    expect(listServers).not.toHaveBeenCalled();
    expect(servers).toEqual([
      { server: globalServer, source: 'global' },
      { server: sessionServer, source: 'session-assigned' },
    ]);
  });

  it('returns deterministic effective ordering', async () => {
    const zSession = makeServer('session-z', 'session', 'zeta');
    const bGlobal = makeServer('global-b', 'global', 'beta');
    const aSession = makeServer('session-a', 'session', 'alpha');
    const aGlobal = makeServer('global-a', 'global', 'alpha');
    const listEffectiveServers = vi.fn().mockResolvedValue([zSession, bGlobal, aSession, aGlobal]);

    const servers = await getMcpServersForSession('session-a' as SessionID, {
      mcpServerRepo: { findAll: vi.fn() } as never,
      sessionMCPRepo: { listEffectiveServers } as never,
    });

    expect(servers.map(({ server }) => server.mcp_server_id)).toEqual([
      'global-a',
      'global-b',
      'session-a',
      'session-z',
    ]);
  });

  it('uses server IDs as a deterministic tie-breaker when names collide', async () => {
    const sessionA = makeServer('session-a', 'session', 'shared');
    const globalB = makeServer('global-b', 'global', 'shared');
    const sessionB = makeServer('session-b', 'session', 'shared');
    const globalA = makeServer('global-a', 'global', 'shared');
    const listEffectiveServers = vi.fn().mockResolvedValue([sessionB, globalB, sessionA, globalA]);

    const servers = await getMcpServersForSession('session-a' as SessionID, {
      mcpServerRepo: { findAll: vi.fn() } as never,
      sessionMCPRepo: { listEffectiveServers } as never,
    });

    expect(servers.map(({ server }) => server.mcp_server_id)).toEqual([
      'global-a',
      'global-b',
      'session-a',
      'session-b',
    ]);
  });

  it('resolves an OAuth server whose only template is oauth_client_secret', async () => {
    const prevKeys = process.env.AGOR_USER_ENV_KEYS;
    const prevSecret = process.env.OAUTH_CLIENT_SECRET;
    process.env.AGOR_USER_ENV_KEYS = 'OAUTH_CLIENT_SECRET';
    process.env.OAUTH_CLIENT_SECRET = 'resolved-client-secret';

    try {
      const oauthServer = {
        ...makeServer('oauth-server', 'session', 'oauth'),
        auth: {
          type: 'oauth',
          oauth_client_id: 'public-client',
          oauth_client_secret: '{{ user.env.OAUTH_CLIENT_SECRET }}',
        },
      } as MCPServer;
      const listEffectiveServers = vi.fn().mockResolvedValue([oauthServer]);

      const servers = await getMcpServersForSession('session-a' as SessionID, {
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: { listEffectiveServers } as never,
      });

      const resolved = servers.find(
        ({ server }) => server.mcp_server_id === 'oauth-server'
      )?.server;
      expect(resolved?.auth?.oauth_client_secret).toBe('resolved-client-secret');
    } finally {
      if (prevKeys === undefined) delete process.env.AGOR_USER_ENV_KEYS;
      else process.env.AGOR_USER_ENV_KEYS = prevKeys;
      if (prevSecret === undefined) delete process.env.OAUTH_CLIENT_SECRET;
      else process.env.OAUTH_CLIENT_SECRET = prevSecret;
    }
  });

  it('hydrates OAuth access tokens through the trusted executor auth-header route', async () => {
    const oauthServer = {
      ...makeServer('oauth-server', 'session', 'oauth'),
      auth: {
        type: 'oauth',
        oauth_mode: 'per_user',
        oauth_access_token: '••••••••',
      },
    } as MCPServer;
    const tokenServer = makeServer('token-server', 'global', 'token');
    const listEffectiveServers = vi.fn().mockResolvedValue([oauthServer, tokenServer]);
    const getAuthHeaders = vi.fn().mockResolvedValue({
      'oauth-server': { authorization: 'Bearer real-oauth-token' },
    });

    const servers = await getMcpServersForSession('session-a' as SessionID, {
      mcpServerRepo: { findAll: vi.fn() } as never,
      sessionMCPRepo: { listEffectiveServers } as never,
      mcpOAuthAuthHeadersRepo: { getAuthHeaders } as never,
    });

    expect(getAuthHeaders).toHaveBeenCalledWith(['oauth-server']);
    const hydrated = servers.find(({ server }) => server.mcp_server_id === 'oauth-server')?.server;
    expect(hydrated?.auth).toMatchObject({
      type: 'oauth',
      oauth_access_token: 'real-oauth-token',
    });
  });
});
