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
  it('uses session-scoped effective config retrieval when available', async () => {
    const globalServer = makeServer('global-server', 'global');
    const sessionServer = makeServer('session-server', 'session');
    const listEffectiveServers = vi.fn().mockResolvedValue([globalServer, sessionServer]);
    const findAll = vi.fn();
    const listServers = vi.fn();

    const servers = await getMcpServersForSession('session-a' as SessionID, {
      mcpServerRepo: { findAll } as never,
      sessionMCPRepo: { listEffectiveServers, listServers } as never,
    });

    expect(listEffectiveServers).toHaveBeenCalledWith('session-a', true);
    expect(findAll).not.toHaveBeenCalled();
    expect(listServers).not.toHaveBeenCalled();
    expect(servers).toEqual([
      { server: globalServer, source: 'global' },
      { server: sessionServer, source: 'session-assigned' },
    ]);
  });
});
