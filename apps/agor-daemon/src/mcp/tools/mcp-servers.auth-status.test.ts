import type { MCPServer } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';

// `getOAuthStatus` re-reads the row and its grant from the database, because
// binding authority must come from stored state rather than a hook-redacted
// service response. These tests are about the COPY the tool returns, so the
// storage layer is stubbed to "no grant" — the unauthenticated case.
const { mockFindMCPServer, mockGetOAuthToken } = vi.hoisted(() => ({
  mockFindMCPServer: vi.fn(async (mcpServerId: string) => ({
    mcp_server_id: mcpServerId,
    enabled: true,
    auth: { type: 'oauth', oauth_mode: 'per_user' },
  })),
  mockGetOAuthToken: vi.fn(async () => null),
}));

vi.mock('@agor/core/db', () => ({
  MCPServerRepository: class {
    findById = mockFindMCPServer;
  },
  UserMCPOAuthTokenRepository: class {
    getToken = mockGetOAuthToken;
  },
}));

import { summarizeMcpServer } from './mcp-servers.js';

function server(auth: MCPServer['auth']): MCPServer {
  return {
    mcp_server_id: '01900000-0000-7000-8000-000000000001',
    name: 'status-test',
    transport: 'http',
    url: 'https://mcp.example.test/mcp',
    auth,
    scope: 'global',
    source: 'user',
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('MCP server structured missing-auth status', () => {
  it.each([
    { type: 'bearer' as const },
    { type: 'jwt' as const, api_url: 'https://auth.example.test/token' },
  ])('reports an incomplete saved $type row as actionable needs-auth', async (auth) => {
    const summary = await summarizeMcpServer({} as never, server(auth));
    expect(summary.oauth_authenticated).toBe(false);
    expect(summary.recovery).toEqual({
      category: 'authentication_required',
      action: 'save_and_retry',
      message:
        'Save the required authentication settings for this MCP server, then retry the task.',
      mcp_server_id: '01900000-0000-7000-8000-000000000001',
    });
  });
});

/**
 * `agor_mcp_servers_auth_status` used to answer an unauthenticated OAuth server
 * with "sign in from an available authentication surface" — advice no agent
 * could act on and no user could follow when it was relayed into Slack. There
 * is now a tool that starts the sign-in, so the recovery names it.
 */
describe('agor_mcp_servers_auth_status — actionable OAuth recovery', () => {
  const MCP_SERVER_ID = '01900000-0000-7000-8000-000000000001';

  async function authStatus(auth: MCPServer['auth']) {
    const { registerMcpServerTools } = await import('./mcp-servers.js');
    const row = server(auth);
    let handler:
      | ((args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>)
      | null = null;
    registerMcpServerTools(
      {
        registerTool: (name: string, _cfg: unknown, cb: never) => {
          if (name === 'agor_mcp_servers_auth_status') handler = cb;
        },
      } as never,
      {
        app: { service: () => ({ get: async () => row }) } as never,
        db: {} as never,
        userId: 'user-1' as never,
        authenticatedUser: { user_id: 'user-1', role: 'member' } as never,
        baseServiceParams: {
          authenticated: true,
          provider: 'mcp',
          user: { user_id: 'user-1', role: 'member' },
        } as never,
      }
    );
    if (!handler) throw new Error('tool not registered');
    const result = await (
      handler as (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
    )({ mcpServerId: MCP_SERVER_ID });
    return JSON.parse(result.content[0].text);
  }

  it('names agor_widgets_request_oauth, with the server id already filled in', async () => {
    const payload = await authStatus({ type: 'oauth', oauth_mode: 'per_user' });

    expect(payload.oauth_authenticated).toBe(false);
    expect(payload.instructions).toContain('agor_widgets_request_oauth');
    expect(payload.instructions).toContain(MCP_SERVER_ID);
    expect(payload.recovery).toMatchObject({
      category: 'authentication_required',
      action: 'reauthenticate',
      mcp_server_id: MCP_SERVER_ID,
    });
    expect(payload.recovery.message).toContain('agor_widgets_request_oauth');

    // The dead-end phrasing is gone, and the agent is told not to fall back to
    // asking for a pasted token.
    expect(JSON.stringify(payload)).not.toContain('available authentication surface');
    expect(payload.instructions).toMatch(/not ask the user to paste a token/i);
  });

  it('says nothing about signing in for a non-OAuth server', async () => {
    const payload = await authStatus({ type: 'none' });
    expect(payload.instructions).toBeUndefined();
    expect(payload.recovery).toBeUndefined();
  });
});
