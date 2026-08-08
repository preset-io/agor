/**
 * OpenCode's invocation config carries no per-tool filter, so withholding the
 * whole server is the only way a `deny` or `ask` can bind here. That makes the
 * declarative config the enforcement boundary: a gated server must be absent
 * from what gets handed to the managed server, not merely absent from some
 * intermediate list.
 */

import type { MCPServer, SessionID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { OpenCodeTool } from './opencode-tool';

const GATED = 'gated-server';
const PLAIN = 'plain-server';
/** The builder sanitizes names into its key, so assertions match that form. */
const sanitized = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_');

function server(id: string, toolPermissions?: MCPServer['tool_permissions']): MCPServer {
  return {
    mcp_server_id: id,
    name: id,
    transport: 'stdio',
    command: '/usr/bin/node',
    args: [],
    scope: 'global',
    source: 'user',
    enabled: true,
    tool_permissions: toolPermissions,
  } as unknown as MCPServer;
}

/** Stands in for the executor's admission gate, which withholds what it cannot honour. */
function admit(servers: MCPServer[]) {
  return servers
    .filter(
      (s) => !Object.values(s.tool_permissions ?? {}).some((p) => p === 'deny' || p === 'ask')
    )
    .map((s) => ({ server: s, source: 'global' as const }));
}

async function buildConfig(servers: MCPServer[]) {
  const tool = new OpenCodeTool({
    resolveMcpServers: async () => admit(servers),
    getDaemonUrl: async () => 'http://localhost:3030',
  });
  return (
    tool as unknown as {
      buildInvocationConfig: (
        s: SessionID,
        t: string,
        d?: string
      ) => Promise<{ mcp: Record<string, unknown> }>;
    }
  ).buildInvocationConfig('session-1' as SessionID, 'token', '/branch');
}

describe('MCP servers reaching OpenCode invocation config', () => {
  it('omits a server whose tools are gated, while keeping the rest', async () => {
    const config = await buildConfig([server(GATED, { write_file: 'deny' }), server(PLAIN)]);
    const configured = Object.keys(config.mcp).join(' ');

    expect(configured).not.toContain(sanitized(GATED));
    // Positive control: the builder does emit servers, so the absence above is
    // the gate and not an empty config.
    expect(configured).toContain(sanitized(PLAIN));
  });

  it('omits a server gated with ask, which has no prompt channel here', async () => {
    const config = await buildConfig([server(GATED, { write_file: 'ask' }), server(PLAIN)]);

    expect(Object.keys(config.mcp).join(' ')).not.toContain(sanitized(GATED));
  });

  it('keeps the built-in Agor server addressable', async () => {
    const config = await buildConfig([server(PLAIN)]);

    expect(Object.keys(config.mcp).some((name) => name.startsWith('agor_'))).toBe(true);
  });
});
