import type { AgorClient } from '@agor/core/api';
import type { SessionID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
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

describe('FeathersSessionMCPServersRepository', () => {
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
