import type { AgorClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetHydrationRevisions } from '../store/agorHydration';
import { agorStore } from '../store/agorStore';
import { setRealtimeAuthorityScope } from '../store/realtimeBatch';
import { resetSessionMcpLinks } from '../store/sessionMcpLinks';
import { useSessionMcpServerIds } from './useSessionMcpServerIds';

function makeClient(rows: Array<{ session_id: string; mcp_server_id: string }>) {
  const find = vi.fn(async () => rows);
  return { client: { service: () => ({ find }) } as unknown as AgorClient, find };
}

describe('useSessionMcpServerIds', () => {
  beforeEach(() => {
    agorStore.getState().reset();
    resetHydrationRevisions();
    setRealtimeAuthorityScope('user-a:member:1');
  });
  afterEach(() => setRealtimeAuthorityScope(null));

  it('waits for first paint, then loads the session once and reports it loaded', async () => {
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
    agorStore.getState().setLoading(false);
    const { result } = renderHook(() => useSessionMcpServerIds(client, 's-1'));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => resetSessionMcpLinks());
    expect(result.current.ids).toEqual(['a']);
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loaded).toBe(true));
  });

  it('loads nothing without a session', () => {
    const { client, find } = makeClient([]);
    agorStore.getState().setLoading(false);
    const { result } = renderHook(() => useSessionMcpServerIds(client, null));
    expect(result.current).toEqual({ ids: [], loaded: false });
    expect(find).not.toHaveBeenCalled();
  });

  it('reloads once the authority becomes valid again (an authenticated reconnect)', async () => {
    const { client, find } = makeClient([{ session_id: 's-1', mcp_server_id: 'a' }]);
    agorStore.getState().setLoading(false);
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
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const find = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        return [{ session_id: 's-1', mcp_server_id: 'a' }];
      })
      .mockResolvedValue([{ session_id: 's-1', mcp_server_id: 'a' }]);
    const client = { service: () => ({ find }) } as unknown as AgorClient;
    agorStore.getState().setLoading(false);
    const { result } = renderHook(() => useSessionMcpServerIds(client, 's-1'));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    // A reconnect resync resets the links while the first read is in flight:
    // that read applies nothing, so the hook must read again.
    act(() => resetSessionMcpLinks());
    await act(async () => release());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(find).toHaveBeenCalledTimes(2);
  });
});
