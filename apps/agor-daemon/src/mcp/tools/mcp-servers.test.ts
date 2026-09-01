/**
 * Tests for `agor_mcp_servers_list`.
 *
 * Catalog contract: this tool MUST NOT include rows from the
 * `session-mcp-servers` junction. Per-session attachment lives on
 * `agor_sessions_get_current.attached_mcp_servers`, while Agor-provided
 * session-scoped entries remain discoverable before they are attached.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetOAuthToken, mockFindMCPServer, mockGrantAuthority } = vi.hoisted(() => ({
  mockGetOAuthToken: vi.fn(async () => null),
  mockFindMCPServer: vi.fn(async (mcpServerId: string) => ({
    mcp_server_id: mcpServerId,
    enabled: true,
    auth: { type: 'oauth', oauth_mode: 'per_user' },
  })),
  mockGrantAuthority: vi.fn(async () => true),
}));

vi.mock('../resolve-ids.js', () => ({
  resolveBoardId: async (_ctx: unknown, id: string) => id,
  resolveSessionId: async (_ctx: unknown, id: string) => id,
  resolveBranchId: async (_ctx: unknown, id: string) => id,
  resolveMcpServerId: async (_ctx: unknown, id: string) => `full-${id}`,
}));

vi.mock('@agor/core/db', () => ({
  BranchRepository: class FakeBranchRepository {},
  MCPServerRepository: class FakeMCPServerRepository {
    findById = mockFindMCPServer;
  },
  UserMCPOAuthTokenRepository: class FakeUserMCPOAuthTokenRepository {
    getToken = mockGetOAuthToken;
  },
}));

vi.mock('../../services/mcp-oauth-grant-authority.js', () => ({
  isMCPOAuthGrantAuthorizedForServer: mockGrantAuthority,
}));

beforeEach(() => {
  mockGetOAuthToken.mockReset().mockResolvedValue(null);
  mockFindMCPServer.mockReset().mockImplementation(async (mcpServerId: string) => ({
    mcp_server_id: mcpServerId,
    enabled: true,
    auth: { type: 'oauth', oauth_mode: 'per_user' },
  }));
  mockGrantAuthority.mockReset().mockResolvedValue(true);
});

describe('safe MCP server config readback', () => {
  it('redacts auth, header, and environment secrets even for an internal service result', async () => {
    const { safeMcpServerConfigReadback } = await import('./mcp-servers.js');
    const readback = safeMcpServerConfigReadback({
      mcp_server_id: 'server-1',
      name: 'private',
      transport: 'http',
      url: 'https://mcp.example.test',
      scope: 'global',
      source: 'user',
      enabled: true,
      headers: { 'X-Api-Key': 'header-secret' },
      env: { API_KEY: 'env-secret' },
      auth: { type: 'oauth', oauth_client_secret: 'client-secret' },
      created_at: new Date(),
      updated_at: new Date(),
    } as never);

    const serialized = JSON.stringify(readback);
    expect(serialized).not.toContain('header-secret');
    expect(serialized).not.toContain('env-secret');
    expect(serialized).not.toContain('client-secret');
    expect(readback.auth_secret_fields_configured).toEqual(['oauth_client_secret']);
  });
});

describe('surface-neutral MCP authentication recovery', () => {
  it.each(['<@U123> **urgent**', '[click me](https://evil.test) @channel'])(
    'keeps markup-shaped server label %s out of recovery prose',
    async (label) => {
      const { summarizeMcpServer } = await import('./mcp-servers.js');
      const summary = await summarizeMcpServer(
        {
          db: {} as never,
          userId: '01900000-0000-7000-8000-000000000001' as never,
          authenticatedUser: {} as never,
          baseServiceParams: {} as never,
          app: {} as never,
        },
        {
          mcp_server_id: '01900000-0000-7000-8000-000000000002',
          name: label,
          display_name: label,
          transport: 'http',
          url: 'https://mcp.example.test',
          scope: 'global',
          source: 'user',
          enabled: true,
          auth: { type: 'oauth' },
          created_at: new Date(),
          updated_at: new Date(),
        } as never
      );

      expect(summary.display_name).toBe(label);
      expect(summary.recovery?.message).toBe(
        'Sign in to this MCP server from an available authentication surface, then retry the task.'
      );
      expect(summary.recovery?.message).not.toContain(label);
    }
  );
});

type ServiceStub = Record<string, (...args: unknown[]) => unknown>;
function makeFakeApp(services: Record<string, ServiceStub>) {
  return {
    service: (name: string) => {
      const svc = services[name];
      if (!svc) throw new Error(`Unexpected service call: ${name}`);
      return svc;
    },
  };
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

async function captureTool(
  ctx: { app: unknown; userId: string; sessionId: string },
  toolName: string
): Promise<ToolHandler> {
  const { registerMcpServerTools } = await import('./mcp-servers.js');
  let handler: ToolHandler | null = null;
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
      if (name === toolName) handler = cb;
    },
  } as unknown as McpServer;
  registerMcpServerTools(fakeServer, {
    app: ctx.app as any,
    db: {} as any,
    userId: ctx.userId as any,
    sessionId: ctx.sessionId as any,
    authenticatedUser: { user_id: ctx.userId, role: 'member' } as any,
    baseServiceParams: {
      authenticated: true,
      provider: 'mcp',
      user: { user_id: ctx.userId, role: 'member' },
    } as any,
  });
  if (!handler) throw new Error(`Tool ${toolName} not registered`);
  return handler;
}

describe('listAttachedMcpServers prompt identity', () => {
  it('omits a Session owner private server when a collaborator is prompting', async () => {
    const servers = new Map([
      [
        'owner-private',
        {
          mcp_server_id: 'owner-private',
          name: 'Owner private',
          transport: 'http',
          enabled: true,
          owner_user_id: 'session-owner',
          auth: { type: 'none' },
        },
      ],
      [
        'actor-private',
        {
          mcp_server_id: 'actor-private',
          name: 'Actor private',
          transport: 'http',
          enabled: true,
          owner_user_id: 'prompt-actor',
          auth: { type: 'none' },
        },
      ],
      [
        'shared',
        {
          mcp_server_id: 'shared',
          name: 'Shared',
          transport: 'http',
          enabled: true,
          auth: { type: 'none' },
        },
      ],
    ]);
    const app = makeFakeApp({
      sessions: { get: async () => ({ session_id: 'sess-1', created_by: 'session-owner' }) },
      'session-mcp-servers': {
        find: async () => ({
          data: [...servers.keys()].map((mcp_server_id) => ({ mcp_server_id })),
        }),
      },
      'mcp-servers': {
        get: async (id: unknown) => servers.get(String(id)),
      },
    });
    const { listAttachedMcpServers } = await import('./mcp-servers.js');

    const result = await listAttachedMcpServers(
      {
        app,
        db: {},
        userId: 'prompt-actor',
        sessionId: 'sess-1',
        authenticatedUser: { user_id: 'prompt-actor', role: 'member' },
        baseServiceParams: {},
      } as never,
      'sess-1'
    );

    expect(result.map((server) => server.mcp_server_id)).toEqual(['actor-private', 'shared']);
  });
});

describe('agor_mcp_servers_list', () => {
  it('returns eligible global and official session-scope servers without consulting attachments', async () => {
    let sessionMcpServersWasCalled = false;
    const app = makeFakeApp({
      'mcp-servers': {
        find: async (params: { query?: { scope?: string; source?: string } }) => {
          if (params.query?.scope === 'global') {
            return {
              data: [
                {
                  mcp_server_id: 'srv-a',
                  name: 'a',
                  display_name: 'A',
                  transport: 'http',
                  scope: 'global',
                  source: 'user',
                  enabled: true,
                  auth: { type: 'none' },
                },
                {
                  mcp_server_id: 'srv-foreign',
                  name: 'foreign-private-global',
                  transport: 'http',
                  scope: 'global',
                  source: 'user',
                  owner_user_id: 'user-2',
                  enabled: true,
                  auth: { type: 'bearer', token: 'foreign-secret' },
                },
              ],
            };
          }

          expect(params.query).toMatchObject({
            scope: 'session',
            source: 'agor',
            ownerless: true,
          });
          return {
            data: [
              {
                mcp_server_id: 'srv-official',
                name: 'official-slack',
                display_name: 'Slack',
                transport: 'http',
                scope: 'session',
                source: 'agor',
                enabled: true,
                url: 'https://mcp.slack.com/mcp',
                headers: { Authorization: 'Bearer official-secret' },
                auth: { type: 'oauth', oauth_access_token: 'official-secret' },
              },
              {
                mcp_server_id: 'srv-private',
                name: 'private-session-server',
                transport: 'http',
                scope: 'session',
                source: 'user',
                enabled: true,
                auth: { type: 'none' },
              },
            ],
          };
        },
      },
      'session-mcp-servers': {
        find: async () => {
          sessionMcpServersWasCalled = true;
          return { data: [] };
        },
      },
    });

    const list = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-1' },
      'agor_mcp_servers_list'
    );
    const result = await list({});
    const payload = JSON.parse(result.content[0].text);

    expect(sessionMcpServersWasCalled).toBe(false);
    expect(payload.mcp_servers).toHaveLength(2);
    expect(payload.mcp_servers[0]).toMatchObject({
      mcp_server_id: 'srv-a',
      auth_type: 'none',
      oauth_authenticated: true,
    });
    expect(payload.mcp_servers).toContainEqual(
      expect.objectContaining({ mcp_server_id: 'srv-official', auth_type: 'oauth' })
    );
    expect(payload.mcp_servers).not.toContainEqual(
      expect.objectContaining({ mcp_server_id: 'srv-private' })
    );
    expect(payload.mcp_servers).not.toContainEqual(
      expect.objectContaining({ mcp_server_id: 'srv-foreign' })
    );
    expect(JSON.stringify(payload)).not.toContain('official-secret');
    expect(JSON.stringify(payload)).not.toContain('foreign-secret');
    expect(payload.summary).toMatchObject({ total: 2, oauth_servers: 1, needs_auth: 1 });
  });

  it('omits disabled servers by default and includes them when asked', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const app = makeFakeApp({
      'mcp-servers': {
        find: async (params: { query?: Record<string, unknown> }) => {
          calls.push(params.query);
          return { data: [] };
        },
      },
    });

    const list = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-1' },
      'agor_mcp_servers_list'
    );
    await list({});
    await list({ includeDisabled: true });

    expect(calls[0]).toMatchObject({ scope: 'global', enabled: true, usableByUserId: 'user-1' });
    expect(calls[1]).toMatchObject({
      scope: 'session',
      source: 'agor',
      ownerless: true,
      enabled: true,
      usableByUserId: 'user-1',
    });
    expect(calls[2]).toMatchObject({ scope: 'global', usableByUserId: 'user-1' });
    expect(calls[2]).not.toHaveProperty('enabled');
    expect(calls[3]).toMatchObject({
      scope: 'session',
      source: 'agor',
      ownerless: true,
      usableByUserId: 'user-1',
    });
    expect(calls[3]).not.toHaveProperty('enabled');
  });

  it('returns an empty catalog when no eligible servers are configured', async () => {
    const app = makeFakeApp({
      'mcp-servers': {
        find: async () => ({ data: [] }),
      },
    });

    const list = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-1' },
      'agor_mcp_servers_list'
    );
    const result = await list({});
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({
      mcp_servers: [],
      pagination: { total: 0, hasMore: false, nextOffset: null },
      summary: { total: 0, oauth_servers: 0, authenticated: 0, needs_auth: 0 },
    });
  });

  it('merges scopes into one stable created-at order before paging', async () => {
    const find = async (params: { query?: { scope?: string } }) => {
      if (params.query?.scope === 'global') {
        return {
          total: 2,
          data: [
            {
              mcp_server_id: 'global-new',
              name: 'global-new',
              transport: 'http',
              scope: 'global',
              source: 'user',
              enabled: true,
              created_at: new Date('2026-08-11T10:00:00Z'),
              auth: { type: 'none' },
            },
            {
              mcp_server_id: 'global-old',
              name: 'global-old',
              transport: 'http',
              scope: 'global',
              source: 'user',
              enabled: true,
              created_at: new Date('2026-08-11T08:00:00Z'),
              auth: { type: 'none' },
            },
          ],
        };
      }
      return {
        total: 1,
        data: [
          {
            mcp_server_id: 'official-mid',
            name: 'official-mid',
            transport: 'http',
            scope: 'session',
            source: 'agor',
            enabled: true,
            created_at: new Date('2026-08-11T09:00:00Z'),
            auth: { type: 'none' },
          },
        ],
      };
    };
    const app = makeFakeApp({ 'mcp-servers': { find } });
    const list = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-1' },
      'agor_mcp_servers_list'
    );

    const firstPage = JSON.parse((await list({ limit: 2 })).content[0].text);
    expect(
      firstPage.mcp_servers.map((server: { mcp_server_id: string }) => server.mcp_server_id)
    ).toEqual(['global-new', 'official-mid']);
    expect(firstPage.pagination).toMatchObject({ total: 3, hasMore: true, nextOffset: 2 });

    const finalPage = JSON.parse((await list({ limit: 2, offset: 2 })).content[0].text);
    expect(
      finalPage.mcp_servers.map((server: { mcp_server_id: string }) => server.mcp_server_id)
    ).toEqual(['global-old']);
    expect(finalPage.pagination).toMatchObject({ total: 3, hasMore: false, nextOffset: null });
  });

  it('does not expose a foreign server through direct OAuth status lookup', async () => {
    const app = makeFakeApp({
      'mcp-servers': {
        get: async () => ({
          mcp_server_id: 'foreign-server',
          name: 'private-foreign',
          transport: 'http',
          scope: 'global',
          source: 'user',
          owner_user_id: 'user-2',
          enabled: true,
          auth: { type: 'oauth' },
        }),
      },
    });
    const authStatus = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-1' },
      'agor_mcp_servers_auth_status'
    );

    await expect(authStatus({ mcpServerId: 'foreign-server' })).rejects.toThrow(
      'MCP server not found'
    );
  });

  it('allows an owner to check auth status for their session-scoped user server', async () => {
    const app = makeFakeApp({
      'mcp-servers': {
        get: async () => ({
          mcp_server_id: 'owned-server',
          name: 'private-owned',
          transport: 'http',
          scope: 'session',
          source: 'user',
          owner_user_id: 'user-1',
          enabled: true,
          auth: { type: 'oauth' },
        }),
      },
    });
    const authStatus = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-1' },
      'agor_mcp_servers_auth_status'
    );

    const result = await authStatus({ mcpServerId: 'owned-server' });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      mcp_server_id: 'owned-server',
      oauth_authenticated: false,
    });
  });

  it('does not report raw token presence when the authoritative binding is invalid', async () => {
    mockGetOAuthToken.mockResolvedValue({
      oauth_access_token: 'raw-but-mismatched',
      oauth_token_expires_at: new Date(Date.now() + 60_000),
      refresh_status: 'idle',
    });
    mockGrantAuthority.mockResolvedValue(false);
    const app = makeFakeApp({
      'mcp-servers': {
        get: async () => ({
          mcp_server_id: 'owned-server',
          name: 'private-owned',
          transport: 'http',
          scope: 'session',
          source: 'user',
          owner_user_id: 'user-1',
          enabled: true,
          auth: { type: 'oauth' },
        }),
      },
    });
    const authStatus = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-1' },
      'agor_mcp_servers_auth_status'
    );

    const result = await authStatus({ mcpServerId: 'owned-server' });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ oauth_authenticated: false });
    expect(mockGrantAuthority).toHaveBeenCalledOnce();
  });
});

describe('agor_mcp_servers_create/update/attach', () => {
  it('registers a simple remote OAuth MCP server without requiring advanced OAuth fields', async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const app = makeFakeApp({
      'mcp-servers': {
        create: async (data: Record<string, unknown>) => {
          createCalls.push(data);
          return {
            mcp_server_id: 'srv-new',
            name: data.name,
            display_name: data.display_name,
            transport: data.transport,
            enabled: data.enabled,
            auth: data.auth,
          };
        },
      },
    });

    const create = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-1' },
      'agor_mcp_servers_create'
    );
    const result = await create({
      name: 'context7',
      displayName: 'Context7',
      url: 'https://mcp.context7.com/mcp',
      auth: { type: 'oauth' },
    });
    const payload = JSON.parse(result.content[0].text);

    expect(createCalls).toEqual([
      expect.objectContaining({
        name: 'context7',
        display_name: 'Context7',
        transport: 'http',
        url: 'https://mcp.context7.com/mcp',
        scope: 'global',
        enabled: true,
        auth: { type: 'oauth' },
      }),
    ]);
    expect(createCalls[0]).not.toHaveProperty('source');
    expect(payload.mcp_server).toMatchObject({
      mcp_server_id: 'srv-new',
      name: 'context7',
      auth_type: 'oauth',
      oauth_authenticated: false,
    });
    expect(payload.next_steps.join('\n')).toContain('available MCP authentication surface');
  });

  it('does not create a server when attachToCurrentSession is requested without session context', async () => {
    const app = makeFakeApp({
      'mcp-servers': {
        create: async () => {
          throw new Error('create should not be called');
        },
      },
    });

    const create = await captureTool(
      { app, userId: 'user-1', sessionId: '' },
      'agor_mcp_servers_create'
    );
    const result = await create({
      name: 'context7',
      url: 'https://mcp.context7.com/mcp',
      auth: { type: 'oauth' },
      attachToCurrentSession: true,
    });
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.error).toContain('No current session context');
  });

  it('validates conditional fields before creating', async () => {
    const { registerMcpServerTools } = await import('./mcp-servers.js');
    const schemas: Record<
      string,
      { safeParse: (v: unknown) => { success: boolean; error?: unknown } }
    > = {};
    const fakeServer = {
      registerTool: (
        name: string,
        cfg: { inputSchema?: { safeParse: (v: unknown) => { success: boolean; error?: unknown } } }
      ) => {
        if (cfg.inputSchema) schemas[name] = cfg.inputSchema;
      },
    } as unknown as McpServer;
    registerMcpServerTools(fakeServer, {
      app: makeFakeApp({}) as any,
      db: {} as any,
      userId: 'user-1' as any,
      sessionId: 'sess-1' as any,
      authenticatedUser: { user_id: 'user-1', role: 'admin' } as any,
      baseServiceParams: {},
    });

    const parsed = schemas.agor_mcp_servers_create?.safeParse({
      name: 'bad-http',
      transport: 'http',
      auth: { type: 'oauth' },
    });

    expect(parsed?.success).toBe(false);
    expect(String(parsed?.error)).toContain('url is required for http transport');

    const updateParsed = schemas.agor_mcp_servers_update?.safeParse({
      mcpServerId: 'abc12345',
      transport: 'sse',
    });
    expect(updateParsed?.success).toBe(true);
  });

  it('updates only provided fields and resolves short MCP server IDs', async () => {
    const patchCalls: Array<{ id: string; data: Record<string, unknown> }> = [];
    const app = makeFakeApp({
      'mcp-servers': {
        get: async (id: string) => ({
          mcp_server_id: id,
          name: 'github',
          transport: 'http',
          url: 'https://mcp.github.com/mcp',
          enabled: true,
          auth: { type: 'none' },
        }),
        patch: async (id: string, data: Record<string, unknown>) => {
          patchCalls.push({ id, data });
          return {
            mcp_server_id: id,
            name: 'github',
            display_name: data.display_name,
            transport: 'http',
            enabled: data.enabled,
            auth: { type: 'none' },
          };
        },
      },
    });

    const update = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-1' },
      'agor_mcp_servers_update'
    );
    const result = await update({
      mcpServerId: 'abc12345',
      displayName: 'GitHub MCP',
      enabled: false,
      auth: { type: 'none' },
    });
    const payload = JSON.parse(result.content[0].text);

    expect(patchCalls).toEqual([
      {
        id: 'full-abc12345',
        data: {
          display_name: 'GitHub MCP',
          enabled: false,
          auth: { type: 'none' },
        },
      },
    ]);
    expect(payload.mcp_server).toMatchObject({
      mcp_server_id: 'full-abc12345',
      display_name: 'GitHub MCP',
      enabled: false,
    });
  });

  it('allows transport-only update when current server already has required URL', async () => {
    const patchCalls: Array<{ id: string; data: Record<string, unknown> }> = [];
    const app = makeFakeApp({
      'mcp-servers': {
        get: async (id: string) => ({
          mcp_server_id: id,
          name: 'github',
          transport: 'http',
          url: 'https://mcp.github.com/mcp',
          enabled: true,
          auth: { type: 'none' },
        }),
        patch: async (id: string, data: Record<string, unknown>) => {
          patchCalls.push({ id, data });
          return {
            mcp_server_id: id,
            name: 'github',
            transport: data.transport,
            url: 'https://mcp.github.com/mcp',
            enabled: true,
            auth: { type: 'none' },
          };
        },
      },
    });

    const update = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-1' },
      'agor_mcp_servers_update'
    );
    await update({ mcpServerId: 'abc12345', transport: 'sse' });

    expect(patchCalls).toEqual([
      {
        id: 'full-abc12345',
        data: {
          transport: 'sse',
          command: undefined,
          args: undefined,
        },
      },
    ]);
  });

  it('rejects update fields that do not make sense for the current transport', async () => {
    const app = makeFakeApp({
      'mcp-servers': {
        get: async (id: string) => ({
          mcp_server_id: id,
          name: 'remote',
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          enabled: true,
          auth: { type: 'none' },
        }),
        patch: async () => {
          throw new Error('patch should not be called');
        },
      },
    });

    const update = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-1' },
      'agor_mcp_servers_update'
    );

    await expect(
      update({
        mcpServerId: 'abc12345',
        command: 'npx',
      })
    ).rejects.toThrow('command only applies to stdio transport');
  });

  it('attaches a registered MCP server to the current session by default', async () => {
    const attachCalls: Array<{ data: unknown; params: any }> = [];
    const app = makeFakeApp({
      '/sessions/:id/mcp-servers': {
        create: async (data: unknown, params: any) => {
          attachCalls.push({ data, params });
          return { session_id: params.route.id, ...(data as Record<string, unknown>) };
        },
      },
      'mcp-servers': {
        get: async (id: string) => ({
          mcp_server_id: id,
          name: 'linear',
          transport: 'http',
          enabled: true,
          auth: { type: 'none' },
        }),
      },
    });

    const attach = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-current' },
      'agor_sessions_add_mcp_server'
    );
    const result = await attach({ mcpServerId: 'linear1' });
    const payload = JSON.parse(result.content[0].text);

    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0].data).toEqual({ mcpServerId: 'full-linear1' });
    expect(attachCalls[0].params.route.id).toBe('sess-current');
    expect(payload.relationship).toMatchObject({
      session_id: 'sess-current',
      mcpServerId: 'full-linear1',
    });
  });

  it('removes a session-specific MCP server link', async () => {
    const removeCalls: Array<{ id: string; params: any }> = [];
    const app = makeFakeApp({
      '/sessions/:id/mcp-servers': {
        remove: async (id: string, params: any) => {
          removeCalls.push({ id, params });
          return { session_id: params.route.id, mcp_server_id: id };
        },
      },
    });

    const remove = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-current' },
      'agor_sessions_remove_mcp_server'
    );
    const result = await remove({ mcpServerId: 'linear1' });
    const payload = JSON.parse(result.content[0].text);

    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0].id).toBe('full-linear1');
    expect(removeCalls[0].params.route.id).toBe('sess-current');
    expect(payload.removed).toEqual({
      session_id: 'sess-current',
      mcp_server_id: 'full-linear1',
    });
  });

  it('sets session-specific MCP server links with one atomic replacement', async () => {
    const updateCalls: Array<unknown> = [];
    const app = makeFakeApp({
      '/sessions/:id/mcp-servers': {
        find: async () => [{ mcp_server_id: 'full-keep' }, { mcp_server_id: 'full-remove' }],
        update: async (id: unknown, data: unknown, params: unknown) => {
          updateCalls.push({ id, data, params });
          return data;
        },
      },
    });

    const set = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-current' },
      'agor_sessions_set_mcp_servers'
    );
    const result = await set({ mcpServerIds: ['keep', 'add'] });
    const payload = JSON.parse(result.content[0].text);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({
      id: null,
      data: { mcpServerIds: ['full-keep', 'full-add'] },
      params: { route: { id: 'sess-current' } },
    });
    expect(payload).toMatchObject({
      session_id: 'sess-current',
      desired_mcp_server_ids: ['full-keep', 'full-add'],
      added_mcp_server_ids: ['full-add'],
      removed_mcp_server_ids: ['full-remove'],
      unchanged_mcp_server_ids: ['full-keep'],
    });
  });

  it('marks set session-specific MCP links as an MCP error when replacement fails', async () => {
    const app = makeFakeApp({
      '/sessions/:id/mcp-servers': {
        find: async () => [{ mcp_server_id: 'full-remove' }],
        update: async () => {
          throw new Error('RBAC denied');
        },
      },
    });

    const set = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-current' },
      'agor_sessions_set_mcp_servers'
    );
    const result = await set({ mcpServerIds: [] });
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.failures).toEqual([
      { mcp_server_id: 'sess-current', action: 'replace', reason: 'RBAC denied' },
    ]);
  });

  it('returns a clear error when attaching without current or explicit session context', async () => {
    const app = makeFakeApp({});
    const attach = await captureTool(
      { app, userId: 'user-1', sessionId: '' },
      'agor_sessions_add_mcp_server'
    );
    const result = await attach({ mcpServerId: 'linear1' });
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.error).toContain('No current session context');
  });
});
