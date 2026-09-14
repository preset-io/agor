import type { AgorClient } from '@agor/core/api';
import type { SessionID, TaskID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  FeathersMCPOAuthAuthHeadersRepository,
  FeathersMCPServersRepository,
  FeathersMessagesRepository,
  FeathersSessionMCPServersRepository,
} from './feathers-repositories';

describe('FeathersMessagesRepository', () => {
  it('fetches only the first user row used by prompt idempotency', async () => {
    const find = vi.fn().mockResolvedValue({ data: [] });
    const repo = new FeathersMessagesRepository({
      service: () => ({ find }),
    } as unknown as AgorClient);

    await repo.findInitialUserMessagesByTaskId('task-1' as TaskID);

    expect(find).toHaveBeenCalledWith({
      query: { task_id: 'task-1', role: 'user', $sort: { index: 1 }, $limit: 1 },
    });
  });

  it('computes the next sparse index from one selected row', async () => {
    const find = vi.fn().mockResolvedValue({
      total: 2,
      limit: 1,
      skip: 0,
      data: [{ index: 9 }],
    });
    const repo = new FeathersMessagesRepository({
      service: () => ({ find }),
    } as unknown as AgorClient);

    await expect(repo.getNextIndexBySessionId('session-1' as SessionID)).resolves.toBe(10);
    expect(find).toHaveBeenCalledWith({
      query: {
        session_id: 'session-1',
        $sort: { index: -1 },
        $limit: 1,
        $select: ['index'],
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

describe('FeathersMCPServersRepository.findAll', () => {
  it('forwards ownership and source filters to the daemon', async () => {
    const find = vi.fn(async () => ({ data: [] }));
    const repo = new FeathersMCPServersRepository({
      service: () => ({ find }),
    } as never);

    await repo.findAll({
      scope: 'global',
      enabled: true,
      source: 'agor',
      usableByUserId: 'user-a',
      ownerless: true,
    });

    expect(find).toHaveBeenCalledWith({
      query: {
        $limit: 1000,
        scope: 'global',
        enabled: true,
        source: 'agor',
        usableByUserId: 'user-a',
        ownerless: true,
      },
    });
  });
});
