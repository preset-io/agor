/**
 * Tests for `agor_mcp_servers_list`.
 *
 * Catalog-only contract: this tool MUST NOT include rows from the
 * `session-mcp-servers` junction. Per-session attachment lives on
 * `agor_sessions_get_current.attached_mcp_servers`. Locking the boundary so
 * the previous "globals + current session merge" behavior doesn't sneak back.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';

vi.mock('../resolve-ids.js', () => ({
  resolveBoardId: async (_ctx: unknown, id: string) => id,
  resolveSessionId: async (_ctx: unknown, id: string) => id,
  resolveBranchId: async (_ctx: unknown, id: string) => id,
  resolveMcpServerId: async (_ctx: unknown, id: string) => `full-${id}`,
}));

vi.mock('@agor/core/db', () => ({
  BranchRepository: class FakeBranchRepository {},
  UserMCPOAuthTokenRepository: class FakeUserMCPOAuthTokenRepository {
    getToken = vi.fn(async () => null);
  },
}));

import { vi } from 'vitest';

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
    baseServiceParams: {},
  });
  if (!handler) throw new Error(`Tool ${toolName} not registered`);
  return handler;
}

describe('agor_mcp_servers_list (catalog-only)', () => {
  it('returns global-scope servers and does NOT consult session-mcp-servers', async () => {
    let sessionMcpServersWasCalled = false;
    const app = makeFakeApp({
      'mcp-servers': {
        find: async (params: { query?: { scope?: string } }) => {
          // Catalog query is scope:'global' — the previous implementation
          // also did a session-mcp-servers.find first; if that lookup ever
          // comes back the test below would fail.
          expect(params.query?.scope).toBe('global');
          return {
            data: [
              {
                mcp_server_id: 'srv-a',
                name: 'a',
                display_name: 'A',
                transport: 'http',
                enabled: true,
                auth: { type: 'none' },
              },
              {
                mcp_server_id: 'srv-b',
                name: 'b',
                transport: 'stdio',
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
    expect(payload.summary).toMatchObject({ total: 2, oauth_servers: 0, needs_auth: 0 });
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

    expect(calls[0]).toMatchObject({ scope: 'global', enabled: true });
    expect(calls[1]).toMatchObject({ scope: 'global' });
    expect(calls[1]).not.toHaveProperty('enabled');
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
        source: 'user',
        enabled: true,
        auth: { type: 'oauth' },
      }),
    ]);
    expect(payload.mcp_server).toMatchObject({
      mcp_server_id: 'srv-new',
      name: 'context7',
      auth_type: 'oauth',
      oauth_authenticated: false,
    });
    expect(payload.next_steps.join('\n')).toContain('Settings > MCP Servers');
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

  it('sets session-specific MCP server links by diffing add/remove operations', async () => {
    const createCalls: Array<string> = [];
    const removeCalls: Array<string> = [];
    const app = makeFakeApp({
      '/sessions/:id/mcp-servers': {
        find: async () => [{ mcp_server_id: 'full-keep' }, { mcp_server_id: 'full-remove' }],
        create: async (data: { mcpServerId: string }) => {
          createCalls.push(data.mcpServerId);
          return data;
        },
        remove: async (id: string) => {
          removeCalls.push(id);
          return { mcp_server_id: id };
        },
      },
    });

    const set = await captureTool(
      { app, userId: 'user-1', sessionId: 'sess-current' },
      'agor_sessions_set_mcp_servers'
    );
    const result = await set({ mcpServerIds: ['keep', 'add'] });
    const payload = JSON.parse(result.content[0].text);

    expect(removeCalls).toEqual(['full-remove']);
    expect(createCalls).toEqual(['full-add']);
    expect(payload).toMatchObject({
      session_id: 'sess-current',
      desired_mcp_server_ids: ['full-keep', 'full-add'],
      added_mcp_server_ids: ['full-add'],
      removed_mcp_server_ids: ['full-remove'],
      unchanged_mcp_server_ids: ['full-keep'],
    });
  });

  it('marks set session-specific MCP links as an MCP error when diff operations fail', async () => {
    const app = makeFakeApp({
      '/sessions/:id/mcp-servers': {
        find: async () => [{ mcp_server_id: 'full-remove' }],
        create: async () => ({}),
        remove: async () => {
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
      { mcp_server_id: 'full-remove', action: 'remove', reason: 'RBAC denied' },
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
