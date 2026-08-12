import type { MCPServer, SessionID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { getMcpServerAvailabilityForSession, getMcpServersForSession } from './scoping';
import type { HandlerPermissionCapabilities } from './tool-permissions';

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
  }) as unknown as MCPServer;

/** A handler that can drop individual tools — keeps these cases about scoping. */
const ENFORCING: HandlerPermissionCapabilities = { toolFiltering: 'exclude' };

describe('getMcpServersForSession', () => {
  it('uses session-scoped effective config retrieval when available', async () => {
    const globalServer = makeServer('global-server', 'global');
    const sessionServer = makeServer('session-server', 'session');
    const listEffectiveServers = vi.fn().mockResolvedValue([globalServer, sessionServer]);
    const findAll = vi.fn();
    const listServers = vi.fn();

    const servers = await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll } as never,
        sessionMCPRepo: { listEffectiveServers, listServers } as never,
        forUserId: 'user-a',
      },
      ENFORCING
    );

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

    const servers = await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: { listEffectiveServers } as never,
      },
      ENFORCING
    );

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

    const servers = await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: { listEffectiveServers } as never,
      },
      ENFORCING
    );

    expect(servers.map(({ server }) => server.mcp_server_id)).toEqual([
      'global-a',
      'global-b',
      'session-a',
      'session-b',
    ]);
  });

  it('filters private servers by session owner, not the OAuth context user', async () => {
    const shared = makeServer('shared', 'global');
    const foreignPrivate = {
      ...makeServer('foreign-private', 'global'),
      owner_user_id: 'owner-b',
    } as MCPServer;
    const listEffectiveServers = vi.fn().mockResolvedValue([shared, foreignPrivate]);

    const servers = await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: { listEffectiveServers } as never,
        forUserId: 'prompt-user',
        sessionOwnerId: 'owner-a',
      },
      ENFORCING
    );

    expect(servers.map(({ server }) => server.mcp_server_id)).toEqual(['shared']);
  });

  it('warns when a private server is withheld because session owner identity is missing', async () => {
    const privateServer = {
      ...makeServer('private', 'session'),
      owner_user_id: 'owner-a',
    } as MCPServer;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const servers = await getMcpServersForSession(
        'session-a' as SessionID,
        {
          mcpServerRepo: { findAll: vi.fn() } as never,
          sessionMCPRepo: {
            listEffectiveServers: vi.fn().mockResolvedValue([privateServer]),
          } as never,
        },
        ENFORCING
      );

      expect(servers).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('session owner identity is missing')
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('passes the session owner to global repository filtering', async () => {
    const findAll = vi.fn().mockResolvedValue([makeServer('shared', 'global')]);
    const listServers = vi.fn().mockResolvedValue([]);

    await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll } as never,
        sessionMCPRepo: { listServers } as never,
        forUserId: 'prompt-user',
        sessionOwnerId: 'owner-a',
      },
      ENFORCING
    );

    expect(findAll).toHaveBeenCalledWith(
      { scope: 'global', enabled: true, usableByUserId: 'owner-a' },
      'prompt-user'
    );
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

      const servers = await getMcpServersForSession(
        'session-a' as SessionID,
        {
          mcpServerRepo: { findAll: vi.fn() } as never,
          sessionMCPRepo: { listEffectiveServers } as never,
          mcpOAuthAuthHeadersRepo: {
            getAuthHeaders: vi.fn().mockResolvedValue({
              'oauth-server': { authorization: 'Bearer resolved-access-token' },
            }),
          },
        },
        ENFORCING
      );

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

    const servers = await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: { listEffectiveServers } as never,
        mcpOAuthAuthHeadersRepo: { getAuthHeaders } as never,
      },
      ENFORCING
    );

    expect(getAuthHeaders).toHaveBeenCalledWith(['oauth-server']);
    const hydrated = servers.find(({ server }) => server.mcp_server_id === 'oauth-server')?.server;
    expect(hydrated?.auth).toMatchObject({
      type: 'oauth',
      oauth_access_token: 'real-oauth-token',
    });
  });

  it('omits OAuth servers that the auth service reports require authentication', async () => {
    const needsAuth = {
      ...makeServer('oauth-needs-auth', 'global', 'Needs auth'),
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    } as MCPServer;
    const usable = makeServer('usable', 'session', 'Usable');

    const availability = await getMcpServerAvailabilityForSession('session-a' as SessionID, {
      mcpServerRepo: { findAll: vi.fn() } as never,
      sessionMCPRepo: {
        listEffectiveServers: vi.fn().mockResolvedValue([usable, needsAuth]),
      } as never,
      mcpOAuthAuthHeadersRepo: {
        getAuthHeaders: vi.fn().mockResolvedValue({
          'oauth-needs-auth': { error: 'needs_reauth' },
        }),
      },
    });

    expect(availability.usable.map(({ server }) => server.mcp_server_id)).toEqual(['usable']);
    expect(availability.unavailable).toEqual([
      {
        server: { server: needsAuth, source: 'global' },
        reason: 'authentication_required',
      },
    ]);
  });

  it('resolves a full OAuth URL from an explicit template env before classifying reauth', async () => {
    const needsAuth = {
      ...makeServer('oauth-templated-url', 'global', 'Templated URL'),
      url: '{{ user.env.MCP_URL }}',
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    } as MCPServer;
    const getAuthHeaders = vi.fn().mockResolvedValue({
      'oauth-templated-url': { error: 'needs_reauth' },
    });

    const availability = await getMcpServerAvailabilityForSession('session-a' as SessionID, {
      mcpServerRepo: { findAll: vi.fn() } as never,
      sessionMCPRepo: {
        listEffectiveServers: vi.fn().mockResolvedValue([needsAuth]),
      } as never,
      mcpOAuthAuthHeadersRepo: { getAuthHeaders },
      templateEnv: {
        AGOR_USER_ENV_KEYS: 'MCP_URL',
        MCP_URL: 'https://prompter.example.com/mcp',
      },
    });

    expect(getAuthHeaders).toHaveBeenCalledWith(['oauth-templated-url']);
    expect(availability.usable).toEqual([]);
    expect(availability.unavailable).toHaveLength(1);
    expect(availability.unavailable[0]).toMatchObject({
      server: {
        server: {
          mcp_server_id: 'oauth-templated-url',
          url: 'https://prompter.example.com/mcp',
        },
        source: 'global',
      },
      reason: 'authentication_required',
    });
  });

  it('keeps a refreshable expired OAuth server when the auth service returns its refreshed token', async () => {
    const refreshable = {
      ...makeServer('oauth-refreshable', 'session', 'Refreshable'),
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    } as MCPServer;

    const servers = await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: {
          listEffectiveServers: vi.fn().mockResolvedValue([refreshable]),
        } as never,
        mcpOAuthAuthHeadersRepo: {
          getAuthHeaders: vi.fn().mockResolvedValue({
            'oauth-refreshable': { authorization: 'Bearer refreshed-token' },
          }),
        },
      },
      ENFORCING
    );

    expect(servers).toHaveLength(1);
    expect(servers[0].server.auth?.oauth_access_token).toBe('refreshed-token');
  });

  it('omits an OAuth server after invalid_grant is normalized to needs_reauth', async () => {
    const invalidGrant = {
      ...makeServer('oauth-invalid-grant', 'session', 'Invalid grant'),
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    } as MCPServer;

    const servers = await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: {
          listEffectiveServers: vi.fn().mockResolvedValue([invalidGrant]),
        } as never,
        mcpOAuthAuthHeadersRepo: {
          getAuthHeaders: vi.fn().mockResolvedValue({
            'oauth-invalid-grant': { error: 'needs_reauth' },
          }),
        },
      },
      ENFORCING
    );

    expect(servers).toEqual([]);
  });

  it('omits OAuth servers when authentication is transiently unavailable', async () => {
    const transient = {
      ...makeServer('oauth-transient', 'session', 'Transient'),
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    } as MCPServer;

    const availability = await getMcpServerAvailabilityForSession('session-a' as SessionID, {
      mcpServerRepo: { findAll: vi.fn() } as never,
      sessionMCPRepo: {
        listEffectiveServers: vi.fn().mockResolvedValue([transient]),
      } as never,
      mcpOAuthAuthHeadersRepo: {
        getAuthHeaders: vi.fn().mockResolvedValue({
          'oauth-transient': { error: 'unknown_error' },
        }),
      },
    });

    expect(availability.usable).toEqual([]);
    expect(availability.unavailable).toEqual([
      {
        server: { server: transient, source: 'session-assigned' },
        reason: 'authentication_unavailable',
      },
    ]);
  });

  it('omits OAuth servers when the auth service is unreachable', async () => {
    const oauth = {
      ...makeServer('oauth-network', 'session', 'Network failure'),
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    } as MCPServer;

    const availability = await getMcpServerAvailabilityForSession('session-a' as SessionID, {
      mcpServerRepo: { findAll: vi.fn() } as never,
      sessionMCPRepo: {
        listEffectiveServers: vi.fn().mockResolvedValue([oauth]),
      } as never,
      mcpOAuthAuthHeadersRepo: {
        getAuthHeaders: vi.fn().mockRejectedValue(new Error('connection reset')),
      },
    });

    expect(availability.usable).toEqual([]);
    expect(availability.unavailable).toEqual([
      {
        server: { server: oauth, source: 'session-assigned' },
        reason: 'authentication_unavailable',
      },
    ]);
  });

  it('omits OAuth servers when the auth service returns no authoritative Bearer header', async () => {
    const oauth = {
      ...makeServer('oauth-no-header', 'session', 'Missing header'),
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    } as MCPServer;

    const availability = await getMcpServerAvailabilityForSession('session-a' as SessionID, {
      mcpServerRepo: { findAll: vi.fn() } as never,
      sessionMCPRepo: {
        listEffectiveServers: vi.fn().mockResolvedValue([oauth]),
      } as never,
      mcpOAuthAuthHeadersRepo: {
        getAuthHeaders: vi.fn().mockResolvedValue({
          'oauth-no-header': {},
        }),
      },
    });

    expect(availability.usable).toEqual([]);
    expect(availability.unavailable).toEqual([
      {
        server: { server: oauth, source: 'session-assigned' },
        reason: 'authentication_unavailable',
      },
    ]);
  });

  it('omits OAuth servers when no trusted auth-header service is available', async () => {
    const oauth = {
      ...makeServer('oauth-no-service', 'global', 'No auth service'),
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    } as MCPServer;

    const availability = await getMcpServerAvailabilityForSession('session-a' as SessionID, {
      mcpServerRepo: { findAll: vi.fn() } as never,
      sessionMCPRepo: {
        listEffectiveServers: vi.fn().mockResolvedValue([oauth]),
      } as never,
    });

    expect(availability.usable).toEqual([]);
    expect(availability.unavailable).toEqual([
      {
        server: { server: oauth, source: 'global' },
        reason: 'authentication_unavailable',
      },
    ]);
  });

  it('does not classify missing bearer or JWT configuration as OAuth authentication', async () => {
    const bearer = {
      ...makeServer('bearer', 'global', 'Bearer'),
      auth: { type: 'bearer', token: undefined },
    } as MCPServer;
    const jwt = {
      ...makeServer('jwt', 'session', 'JWT'),
      auth: { type: 'jwt', api_token: undefined, api_secret: undefined },
    } as MCPServer;
    const getAuthHeaders = vi.fn();

    const availability = await getMcpServerAvailabilityForSession('session-a' as SessionID, {
      mcpServerRepo: { findAll: vi.fn() } as never,
      sessionMCPRepo: {
        listEffectiveServers: vi.fn().mockResolvedValue([jwt, bearer]),
      } as never,
      mcpOAuthAuthHeadersRepo: { getAuthHeaders },
    });

    expect(getAuthHeaders).not.toHaveBeenCalled();
    expect(availability.unavailable).toEqual([]);
    expect(availability.usable.map(({ server }) => server.mcp_server_id)).toEqual([
      'bearer',
      'jwt',
    ]);
  });

  it('preserves stable ordering after unavailable OAuth servers are removed', async () => {
    const global = makeServer('global-z', 'global', 'zeta');
    const unavailable = {
      ...makeServer('global-a', 'global', 'alpha'),
      auth: { type: 'oauth', oauth_mode: 'per_user' },
    } as MCPServer;
    const session = makeServer('session-a', 'session', 'alpha');

    const servers = await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: {
          listEffectiveServers: vi.fn().mockResolvedValue([session, global, unavailable]),
        } as never,
        mcpOAuthAuthHeadersRepo: {
          getAuthHeaders: vi.fn().mockResolvedValue({
            'global-a': { error: 'needs_reauth' },
          }),
        },
      },
      ENFORCING
    );

    expect(servers.map(({ server }) => server.mcp_server_id)).toEqual(['global-z', 'session-a']);
  });
});

describe('getMcpServersForSession - tool_permissions admission gate', () => {
  const gatedServer = (permission: 'deny' | 'ask' = 'deny') => {
    const server = makeServer('gated', 'global');
    server.tool_permissions = { write_file: permission };
    return server;
  };

  async function resolve(server: MCPServer, caps: HandlerPermissionCapabilities, onWithheld?: any) {
    return getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: { listEffectiveServers: vi.fn().mockResolvedValue([server]) } as never,
        onServerWithheld: onWithheld,
      },
      caps
    );
  }

  // This is the only enforcement a handler without per-tool filtering gets, so
  // a server it cannot honour must never appear in what that handler configures.
  it.each(['deny', 'ask'] as const)(
    'withholds a server carrying a %s from a handler that cannot filter tools',
    async (permission) => {
      const servers = await resolve(gatedServer(permission), { toolFiltering: 'none' });

      expect(servers).toEqual([]);
      // Positive control: the same fixture is admitted by a handler that can
      // filter, so the empty result is the gate and not a resolver that found
      // nothing to begin with.
      const admitted = await resolve(gatedServer(permission), { toolFiltering: 'exclude' });
      expect(admitted).toHaveLength(1);
    }
  );

  it('keeps a gated server for a handler that can exclude tools', async () => {
    const servers = await resolve(gatedServer(), { toolFiltering: 'exclude' });

    expect(servers.map(({ server }) => server.mcp_server_id)).toEqual(['gated']);
  });

  it('leaves servers without tool_permissions untouched on every handler', async () => {
    const servers = await resolve(makeServer('plain', 'global'), { toolFiltering: 'none' });

    expect(servers.map(({ server }) => server.mcp_server_id)).toEqual(['plain']);
  });

  // A server that vanishes without explanation is indistinguishable, from the
  // session, from one that is broken.
  it('reports each withheld server with a reason', async () => {
    const onWithheld = vi.fn();
    await resolve(gatedServer(), { toolFiltering: 'none' }, onWithheld);

    expect(onWithheld).toHaveBeenCalledTimes(1);
    expect(onWithheld.mock.calls[0][0].mcp_server_id).toBe('gated');
    expect(onWithheld.mock.calls[0][1]).toMatch(/cannot enforce/);
  });
});
