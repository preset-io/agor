import type { MCPServer, SessionID } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMcpServersForSession, resolveScopedMCPAuthHeaders } from './scoping';
import type { HandlerPermissionCapabilities } from './tool-permissions';

const makeServer = (id: string, scope: MCPServer['scope'], name = id): MCPServer =>
  ({
    mcp_server_id: id,
    name,
    transport: 'http',
    url: `https://${id}.example.test/mcp`,
    scope,
    source: 'user',
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
    auth: { type: 'bearer', token: `value-${id}` },
  }) as unknown as MCPServer;

/** A handler that can drop individual tools — keeps these cases about scoping. */
const ENFORCING: HandlerPermissionCapabilities = { toolFiltering: 'exclude' };

afterEach(() => vi.restoreAllMocks());

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
      { server: globalServer, source: 'global', oauthAuthResolution: 'not_applicable' },
      { server: sessionServer, source: 'session-assigned', oauthAuthResolution: 'not_applicable' },
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

  it('filters private servers by the current prompt actor', async () => {
    const shared = makeServer('shared', 'global');
    const actorPrivate = {
      ...makeServer('actor-private', 'session'),
      owner_user_id: 'prompt-user',
    } as MCPServer;
    const foreignPrivate = {
      ...makeServer('foreign-private', 'global'),
      owner_user_id: 'owner-b',
    } as MCPServer;
    const listEffectiveServers = vi.fn().mockResolvedValue([shared, actorPrivate, foreignPrivate]);

    const servers = await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: { listEffectiveServers } as never,
        forUserId: 'prompt-user',
      },
      ENFORCING
    );

    expect(servers.map(({ server }) => server.mcp_server_id)).toEqual(['shared', 'actor-private']);
  });

  it('warns when a private server is withheld because prompt actor identity is missing', async () => {
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
        expect.stringContaining('prompt actor identity is missing')
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('passes the prompt actor to global repository filtering', async () => {
    const findAll = vi.fn().mockResolvedValue([makeServer('shared', 'global')]);
    const listServers = vi.fn().mockResolvedValue([]);

    await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll } as never,
        sessionMCPRepo: { listServers } as never,
        forUserId: 'prompt-user',
      },
      ENFORCING
    );

    expect(findAll).toHaveBeenCalledWith({
      scope: 'global',
      enabled: true,
      usableByUserId: 'prompt-user',
    });
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
        oauth_token_expires_at: 1,
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
    const hydrated = servers.find(({ server }) => server.mcp_server_id === 'oauth-server');
    expect(hydrated?.server.auth).toMatchObject({
      type: 'oauth',
      oauth_access_token: 'real-oauth-token',
    });
    expect(hydrated?.oauthAuthResolution).toBe('available');
    await expect(resolveScopedMCPAuthHeaders(hydrated!)).resolves.toEqual({
      Authorization: 'Bearer real-oauth-token',
    });
  });

  it('does not fall through when the scoped credential authority has no OAuth grant', async () => {
    const oauthServer = {
      ...makeServer('oauth-server', 'session', 'oauth'),
      url: 'https://provider.example/mcp',
      auth: {
        type: 'oauth',
        oauth_client_id: 'client-id',
        oauth_client_secret: 'client-secret',
        oauth_token_url: 'https://provider.example/token',
      },
    } as MCPServer;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const servers = await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: {
          listEffectiveServers: vi.fn().mockResolvedValue([oauthServer]),
        } as never,
        mcpOAuthAuthHeadersRepo: { getAuthHeaders: vi.fn().mockResolvedValue({}) } as never,
      },
      ENFORCING
    );

    expect(servers[0].oauthAuthResolution).toBe('unavailable');
    await expect(resolveScopedMCPAuthHeaders(servers[0])).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['file protocol', 'file:///tmp/mcp'],
    ['embedded credentials', 'https://user:secret@mcp.example.test'],
    ['malformed URL', 'not a url'],
  ])('withholds a server whose resolved URL uses %s before SDK dispatch', async (_label, url) => {
    const invalid = { ...makeServer('invalid', 'global'), url } as MCPServer;
    const servers = await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: { listEffectiveServers: vi.fn().mockResolvedValue([invalid]) } as never,
      },
      ENFORCING
    );

    expect(servers).toEqual([]);
  });

  it('withholds malformed secret-bearing templates without leaking their values', async () => {
    const sentinel = 'SENTINEL_NO_MCP_DISPATCH_19d2';
    const malformed = `${sentinel}{{#if user.env.MISSING_SECRET}}`;
    const invalid = {
      ...makeServer('invalid-template', 'global'),
      url: `https://mcp.example.test/${malformed}`,
      headers: { Authorization: malformed },
      env: { MCP_SECRET: malformed },
      auth: {
        type: 'jwt',
        api_url: `https://auth.example.test/${malformed}`,
        api_token: malformed,
        api_secret: malformed,
      },
    } as MCPServer;
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ];
    try {
      const servers = await getMcpServersForSession(
        'session-a' as SessionID,
        {
          mcpServerRepo: { findAll: vi.fn() } as never,
          sessionMCPRepo: {
            listEffectiveServers: vi.fn().mockResolvedValue([invalid]),
          } as never,
        },
        ENFORCING
      );

      expect(servers).toEqual([]);
      expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(sentinel);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  const markerFieldCases = [
    {
      family: 'url',
      build: (value: string) => ({
        ...makeServer('marker-url', 'global'),
        url: `https://mcp.example.test/${value}`,
      }),
    },
    {
      family: 'headers',
      build: (value: string) => ({
        ...makeServer('marker-headers', 'global'),
        headers: { 'X-Private': value },
      }),
    },
    {
      family: 'env',
      build: (value: string) => ({
        ...makeServer('marker-env', 'global'),
        env: { PRIVATE_VALUE: value },
      }),
    },
    {
      family: 'bearer',
      build: (value: string) => ({
        ...makeServer('marker-bearer', 'global'),
        auth: { type: 'bearer' as const, token: value },
      }),
    },
    {
      family: 'jwt',
      build: (value: string) => ({
        ...makeServer('marker-jwt', 'global'),
        auth: {
          type: 'jwt' as const,
          api_url: 'https://auth.example.test/token',
          api_token: 'configured',
          api_secret: value,
        },
      }),
    },
    {
      family: 'oauth',
      build: (value: string) => ({
        ...makeServer('marker-oauth', 'global'),
        auth: { type: 'oauth' as const, oauth_client_secret: value },
      }),
    },
  ];

  it.each(
    markerFieldCases.flatMap(({ family, build }) =>
      (['{{', '}}'] as const).flatMap((delimiter) =>
        (['stored', 'user.env'] as const).map((source) => ({
          family,
          build,
          delimiter,
          source,
        }))
      )
    )
  )(
    'withholds a $source unmatched $delimiter marker in $family before executor dispatch',
    async ({ build, delimiter, source, family }) => {
      const sentinel = `SENTINEL_${source === 'stored' ? 'STORED' : 'ENV'}_${family}_${delimiter === '{{' ? 'OPEN' : 'CLOSE'}_${delimiter}`;
      const storedValue = source === 'stored' ? sentinel : '{{ user.env.INJECTED_MARKER }}';
      const userEnv = source === 'user.env' ? { INJECTED_MARKER: sentinel } : {};
      const invalid = build(storedValue) as MCPServer;
      const previousKeys = process.env.AGOR_USER_ENV_KEYS;
      const previousValue = process.env.INJECTED_MARKER;
      process.env.AGOR_USER_ENV_KEYS = Object.keys(userEnv).join(',');
      Object.assign(process.env, userEnv);
      const spies = [
        vi.spyOn(console, 'log').mockImplementation(() => undefined),
        vi.spyOn(console, 'warn').mockImplementation(() => undefined),
        vi.spyOn(console, 'error').mockImplementation(() => undefined),
        vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      ];
      try {
        const servers = await getMcpServersForSession(
          'session-a' as SessionID,
          {
            mcpServerRepo: { findAll: vi.fn() } as never,
            sessionMCPRepo: {
              listEffectiveServers: vi.fn().mockResolvedValue([invalid]),
            } as never,
          },
          ENFORCING
        );
        expect(servers).toEqual([]);
        expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(sentinel);
      } finally {
        if (previousKeys === undefined) delete process.env.AGOR_USER_ENV_KEYS;
        else process.env.AGOR_USER_ENV_KEYS = previousKeys;
        if (previousValue === undefined) delete process.env.INJECTED_MARKER;
        else process.env.INJECTED_MARKER = previousValue;
        for (const spy of spies) spy.mockRestore();
      }
    }
  );
  it('can surface a sanitized authority failure separately from credential unavailability', async () => {
    const server = makeServer('oauth-server', 'session', 'oauth');
    server.url = 'https://provider.example/mcp';
    server.auth = {
      type: 'oauth',
      oauth_client_id: 'client-id',
      oauth_client_secret: 'client-secret',
      oauth_token_url: 'https://provider.example/token',
    };
    const repositoryDetail = 'repository-sensitive-detail';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const servers = await getMcpServersForSession(
      'session-a' as SessionID,
      {
        mcpServerRepo: { findAll: vi.fn() } as never,
        sessionMCPRepo: {
          listEffectiveServers: vi.fn().mockResolvedValue([server]),
        } as never,
        mcpOAuthAuthHeadersRepo: {
          getAuthHeaders: vi.fn().mockRejectedValue(new Error(repositoryDetail)),
        } as never,
      },
      ENFORCING
    );

    await expect(
      resolveScopedMCPAuthHeaders(servers[0], { surfaceAuthorityError: true })
    ).rejects.toMatchObject({
      name: 'MCPOAuthAuthorityUnavailableError',
      message: 'OAuth credential authority unavailable',
    });
    expect(servers[0].oauthAuthResolution).toBe('error');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[mcp.auth] authority_unavailable authority=executor_repository'
    );
    expect(warn.mock.calls.flat().join(' ')).not.toContain(repositoryDetail);
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

  // Only `deny` and `ask` need enforcing. A gate that keyed off "has any
  // tool_permissions at all" would withhold every permission-bearing server
  // from the handlers that cannot filter, and would still pass every case
  // above, because none of them configures a permission meant to be harmless.
  it('admits a server whose permissions are all allow, even where nothing can filter', async () => {
    const allowOnly = makeServer('allow-only', 'global');
    allowOnly.tool_permissions = { read_file: 'allow', list_files: 'allow' };

    const servers = await resolve(allowOnly, { toolFiltering: 'none' });

    expect(servers.map(({ server }) => server.mcp_server_id)).toEqual(['allow-only']);
  });

  it.each(['deny', 'ask'] as const)(
    'keeps a server carrying a %s for a handler that enforces at call time',
    async (permission) => {
      // `intercept` cannot pre-filter but refuses the call itself, so
      // withholding would cost the user the whole server for no added safety.
      const servers = await resolve(gatedServer(permission), { toolFiltering: 'intercept' });

      expect(servers.map(({ server }) => server.mcp_server_id)).toEqual(['gated']);
    }
  );

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
