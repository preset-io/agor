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
});
