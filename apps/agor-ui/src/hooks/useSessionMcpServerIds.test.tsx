import type { AgorClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../store/agorStore';
import { setRealtimeAuthorityScope } from '../store/realtimeBatch';
import { resetSessionMcpLinks } from '../store/sessionMcpLinks';
import { deferred, makeSession, withTestAuthority } from '../test/harness';
import { useSessionMcpServerIds } from './useSessionMcpServerIds';

function makeClient(rows: Array<{ session_id: string; mcp_server_id: string }>) {
  const find = vi.fn(async () => rows);
  return { client: { service: () => ({ find }) } as unknown as AgorClient, find };
}

describe('useSessionMcpServerIds', () => {
  withTestAuthority('user-a:member:1', { dataAuthority: false });
  // The displayed session is one the store holds: only those take links.
  beforeEach(() =>
    agorStore.getState().setMap('sessionById', new Map([['s-1', makeSession('s-1', 'b-1')]]))
  );

  it('waits for first paint, then loads the session once and reports it loaded', async () => {
    agorStore.getState().setLoading(true);
    const { client, find } = makeClient([{ session_id: 's-1', mcp_server_id: 'a' }]);
    const { result, rerender } = renderHook(() => useSessionMcpServerIds(client, 's-1'));
    expect(find).not.toHaveBeenCalled();
    expect(result.current).toEqual({ ids: [], loaded: false });

    act(() => agorStore.getState().setLoading(false));
    await waitFor(() => expect(result.current).toEqual({ ids: ['a'], loaded: true }));
    rerender();
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({ query: { session_id: 's-1' } });
  });

  it('reloads after a reset (reconnect) and keeps showing the ids meanwhile', async () => {
    const { client, find } = makeClient([{ session_id: 's-1', mcp_server_id: 'a' }]);
    const { result } = renderHook(() => useSessionMcpServerIds(client, 's-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => resetSessionMcpLinks());
    expect(result.current.ids).toEqual(['a']);
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loaded).toBe(true));
  });

  it('loads nothing without a session', () => {
    const { client, find } = makeClient([]);
    const { result } = renderHook(() => useSessionMcpServerIds(client, null));
    expect(result.current).toEqual({ ids: [], loaded: false });
    expect(find).not.toHaveBeenCalled();
  });

  it('reloads once the authority becomes valid again (an authenticated reconnect)', async () => {
    const { client, find } = makeClient([{ session_id: 's-1', mcp_server_id: 'a' }]);
    const { result } = renderHook(() => useSessionMcpServerIds(client, 's-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    // Disconnect: the authority goes away and every session is unloaded.
    act(() => {
      setRealtimeAuthorityScope(null);
      resetSessionMcpLinks();
    });
    expect(result.current.loaded).toBe(false);
    expect(find).toHaveBeenCalledTimes(1);

    act(() => setRealtimeAuthorityScope('user-a:member:2'));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('reloads when a reset supersedes a read still in flight', async () => {
    const gate = deferred();
    const find = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate.promise;
        return [{ session_id: 's-1', mcp_server_id: 'a' }];
      })
      .mockResolvedValue([{ session_id: 's-1', mcp_server_id: 'a' }]);
    const client = { service: () => ({ find }) } as unknown as AgorClient;
    const { result } = renderHook(() => useSessionMcpServerIds(client, 's-1'));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    // A reconnect resync resets the links while the first read is in flight:
    // that read applies nothing, so the hook must read again.
    act(() => resetSessionMcpLinks());
    await act(async () => gate.resolve());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(find).toHaveBeenCalledTimes(2);
  });
});
