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
  resolveWorktreeId: async (_ctx: unknown, id: string) => id,
  resolveMcpServerId: async (_ctx: unknown, id: string) => `full-${id}`,
}));

vi.mock('@agor/core/db', () => ({
  WorktreeRepository: class FakeWorktreeRepository {},
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
