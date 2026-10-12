import type { AgorClient } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpServerRemoved } from '../store/agorRealtimeActions';
import { agorStore } from '../store/agorStore';
import { sessionMcpCreated, sessionMcpPatched } from '../store/sessionMcpActions';
import { updateSessionMcpServers } from './sessionMcpServers';

describe('updateSessionMcpServers', () => {
  beforeEach(() => {
    agorStore.getState().resetMaps();
    // The session being edited is one the store holds: only those take links.
    agorStore
      .getState()
      .setMap(
        'sessionById',
        new Map([['session-1', { session_id: 'session-1', archived: false } as never]])
      );
    agorStore.getState().markSessionMcpLoaded('session-1');
  });

  it('updates the relationship store from successful REST responses without waiting for websocket events', async () => {
    agorStore.getState().setMap('sessionMcpServerIds', new Map([['session-1', ['remove-me']]]));
    const create = vi.fn().mockResolvedValue({});
    const remove = vi.fn().mockResolvedValue({});
    const client = { service: () => ({ create, remove }) } as unknown as AgorClient;

    await updateSessionMcpServers(client, 'session-1', ['remove-me'], ['add-me']);

    expect(create).toHaveBeenCalledWith({ mcpServerId: 'add-me' });
    expect(remove).toHaveBeenCalledWith('remove-me');
    expect(agorStore.getState().sessionMcpServerIds.get('session-1')).toEqual(['add-me']);
  });

  it('remains idempotent when the websocket event arrived before the REST response', async () => {
    const create = vi.fn().mockImplementation(async () => {
      sessionMcpCreated({ session_id: 'session-1', mcp_server_id: 'add-me' });
    });
    const client = {
      service: () => ({ create, remove: vi.fn() }),
    } as unknown as AgorClient;

    await updateSessionMcpServers(client, 'session-1', [], ['add-me']);

    expect(agorStore.getState().sessionMcpServerIds.get('session-1')).toEqual(['add-me']);
  });
  it('does not resurrect a deleted server from a delayed attachment acknowledgement or event', async () => {
    let resolve!: () => void;
    const create = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    const client = { service: () => ({ create, remove: vi.fn() }) } as unknown as AgorClient;
    const pending = updateSessionMcpServers(client, 'session-1', [], ['deleted']);
    mcpServerRemoved({ mcp_server_id: 'deleted' } as never);
    resolve();
    await pending;
    sessionMcpCreated({ session_id: 'session-1', mcp_server_id: 'deleted' });
    sessionMcpPatched({ session_id: 'session-1', mcp_server_ids: ['deleted', 'live'] });
    expect(agorStore.getState().sessionMcpServerIds.get('session-1')).toEqual(['live']);
    agorStore.getState().resetMaps();
    expect(agorStore.getState().deletedMcpServerIds.size).toBe(0);
  });
});
