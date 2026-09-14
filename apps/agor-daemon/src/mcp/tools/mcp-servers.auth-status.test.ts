import type { MCPServer } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
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
