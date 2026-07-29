import type { AgorClient } from '@agor/core/api';
import type { SessionID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  FeathersMCPOAuthAuthHeadersRepository,
  FeathersMessagesRepository,
  FeathersSessionMCPServersRepository,
} from './feathers-repositories';

describe('FeathersMessagesRepository', () => {
  it('requests session-wide history without adding a task filter', async () => {
    const find = vi.fn().mockResolvedValue([]);
    const service = vi.fn((path: string) => {
      if (path !== 'messages') {
        throw new Error(`unexpected service path: ${path}`);
      }
      return { find };
    });
    const repo = new FeathersMessagesRepository({
      service,
    } as unknown as AgorClient);

    await repo.findBySessionId('session-1' as SessionID);

    expect(find).toHaveBeenCalledWith({
      query: {
        session_id: 'session-1',
        $sort: { index: 1 },
        $limit: 10000,
      },
    });
  });
});

describe('FeathersMCPOAuthAuthHeadersRepository', () => {
  it('requests OAuth auth headers through the trusted executor route', async () => {
    const create = vi.fn().mockResolvedValue({
      headers: {
        'mcp-1': { authorization: 'Bearer token' },
      },
    });
    const service = vi.fn((path: string) => {
      if (path !== 'mcp-servers/oauth-auth-headers') {
        throw new Error(`unexpected service path: ${path}`);
      }
      return { create };
    });
    const repo = new FeathersMCPOAuthAuthHeadersRepository({
      service,
    } as unknown as AgorClient);

    const result = await repo.getAuthHeaders(['mcp-1'] as never);

    expect(service).toHaveBeenCalledWith('mcp-servers/oauth-auth-headers');
    expect(create).toHaveBeenCalledWith({ mcp_server_ids: ['mcp-1'] });
    expect(result).toEqual({ 'mcp-1': { authorization: 'Bearer token' } });
  });

  it('includes the explicit executor session token when socket params drop JWT claims', async () => {
    const create = vi.fn().mockResolvedValue({ headers: {} });
    const repo = new FeathersMCPOAuthAuthHeadersRepository({
      executorSessionToken: 'executor-jwt',
      service: () => ({ create }),
    } as unknown as AgorClient);

    await repo.getAuthHeaders(['mcp-1'] as never);

    expect(create).toHaveBeenCalledWith({
      mcp_server_ids: ['mcp-1'],
      executorSessionToken: 'executor-jwt',
    });
  });
});

describe('FeathersSessionMCPServersRepository', () => {
  it('carries forUserId through effective session MCP route lookups', async () => {
    const find = vi.fn().mockResolvedValue([]);
    const service = vi.fn((path: string) => {
      if (path !== '/sessions/session-1/mcp-servers') {
        throw new Error(`unexpected service path: ${path}`);
      }
      return { find };
    });
    const repo = new FeathersSessionMCPServersRepository({
      service,
    } as unknown as AgorClient);

    await repo.listEffectiveServers('session-1' as SessionID, true, 'user-1');

    expect(find).toHaveBeenCalledWith({
      query: { includeGlobal: true, enabledOnly: true, forUserId: 'user-1' },
    });
  });

  it('resolves MCP metadata through the session-scoped route', async () => {
    const find = vi.fn().mockResolvedValue([
      {
        server: { mcp_server_id: 'mcp-1', name: 'server one' },
        added_at: 123,
        enabled: true,
      },
    ]);
    const service = vi.fn((path: string) => {
      if (path !== '/sessions/session-1/mcp-servers') {
        throw new Error(`unexpected service path: ${path}`);
      }
      return { find };
    });
    const repo = new FeathersSessionMCPServersRepository({
      service,
    } as unknown as AgorClient);

    const result = await repo.listServersWithMetadata('session-1' as SessionID, true);

    expect(service).toHaveBeenCalledWith('/sessions/session-1/mcp-servers');
    expect(find).toHaveBeenCalledWith({
      query: { includeMetadata: true, enabledOnly: true },
    });
    expect(result).toEqual([
      {
        server: { mcp_server_id: 'mcp-1', name: 'server one' },
        added_at: 123,
        enabled: true,
      },
    ]);
  });
});
