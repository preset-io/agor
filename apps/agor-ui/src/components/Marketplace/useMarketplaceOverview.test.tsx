import type { MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useMarketplaceOverview } from './useMarketplaceOverview';

function emitter() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    on: vi.fn((event: string, listener: () => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, listener: () => void) => listeners.get(event)?.delete(listener)),
    emit: (event: string) => {
      listeners.get(event)?.forEach((listener) => {
        listener();
      });
    },
  };
}

describe('useMarketplaceOverview live recovery', () => {
  it('refetches for authoritative row events and window focus', async () => {
    const serviceEvents = emitter();
    const io = emitter();
    let generation = 0;
    const find = vi.fn(
      async (): Promise<MCPMarketplaceOverview> => ({
        servers: [],
        attachments: [],
        credentials: [],
        generated_at: new Date(++generation).toISOString(),
      })
    );
    const service = vi.fn((path: string) =>
      path === 'mcp-marketplace' ? { find } : { ...serviceEvents, find: vi.fn() }
    );
    const client = { service, io } as unknown as AgorClient;
    const { result } = renderHook(() =>
      useMarketplaceOverview({
        client,
        connected: true,
        connecting: false,
        authGeneration: 1,
        userId: 'alice',
        role: 'member',
      })
    );
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    expect(service).toHaveBeenCalledWith('boards');
    expect(service).toHaveBeenCalledWith('boards/:id/owners');
    expect(service).toHaveBeenCalledWith('boards/:id/group-grants');

    act(() => serviceEvents.emit('created'));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(3));
    expect(result.current.error).toBeNull();
  });

  it('keeps the last good projection and initial-loading false during focus refresh', async () => {
    const serviceEvents = emitter();
    const io = emitter();
    const populated = {
      servers: [
        {
          mcp_server_id: 'server-1',
          name: 'kept-visible',
          source: 'user',
          transport: 'http',
          enabled: true,
          tools: [],
          session_count: 0,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        },
      ],
      attachments: [],
      credentials: [],
      generated_at: new Date(0).toISOString(),
    } as MCPMarketplaceOverview;
    const held = new Promise<MCPMarketplaceOverview>(() => undefined);
    const find = vi.fn().mockResolvedValueOnce(populated).mockReturnValueOnce(held);
    const client = {
      service: (path: string) =>
        path === 'mcp-marketplace' ? { find } : { ...serviceEvents, find: vi.fn() },
      io,
    } as unknown as AgorClient;
    const { result } = renderHook(() =>
      useMarketplaceOverview({
        client,
        connected: true,
        connecting: false,
        authGeneration: 1,
        userId: 'alice',
        role: 'member',
      })
    );
    await waitFor(() => expect(result.current.overview.servers).toHaveLength(1));

    act(() => window.dispatchEvent(new Event('focus')));
    expect(result.current.overview.servers).toHaveLength(1);
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    expect(result.current.overview.servers[0]?.name).toBe('kept-visible');
  });

  it('clears visible rows immediately on the user-targeted revocation signal', async () => {
    const serviceEvents = emitter();
    const io = emitter();
    const populated = {
      servers: [
        {
          mcp_server_id: 'server-private',
          name: 'private',
          source: 'user',
          transport: 'http',
          enabled: true,
          tools: [],
          session_count: 0,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        },
      ],
      attachments: [],
      credentials: [],
      generated_at: new Date(0).toISOString(),
    } as MCPMarketplaceOverview;
    const held = new Promise<MCPMarketplaceOverview>(() => undefined);
    const find = vi.fn().mockResolvedValueOnce(populated).mockReturnValue(held);
    const client = {
      service: (path: string) =>
        path === 'mcp-marketplace' ? { find } : { ...serviceEvents, find: vi.fn() },
      io,
    } as unknown as AgorClient;
    const { result } = renderHook(() =>
      useMarketplaceOverview({
        client,
        connected: true,
        connecting: false,
        authGeneration: 1,
        userId: 'alice',
        role: 'member',
      })
    );
    await waitFor(() => expect(result.current.overview.servers).toHaveLength(1));

    act(() => io.emit('marketplace:invalidated'));

    expect(result.current.overview.servers).toHaveLength(0);
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
  });

  it('synchronously clears Alice data while Bob is held, clears on failure, and discards Alice', async () => {
    const serviceEvents = emitter();
    const io = emitter();
    let resolveAlice!: (value: MCPMarketplaceOverview) => void;
    let rejectBob!: (reason: Error) => void;
    const alice = new Promise<MCPMarketplaceOverview>((resolve) => (resolveAlice = resolve));
    const bob = new Promise<MCPMarketplaceOverview>((_resolve, reject) => (rejectBob = reject));
    let identity = 'alice';
    const find = vi.fn(() => (identity === 'alice' ? alice : bob));
    const client = {
      service: (path: string) =>
        path === 'mcp-marketplace' ? { find } : { ...serviceEvents, find: vi.fn() },
      io,
    } as unknown as AgorClient;
    const view = (userId: string) => ({
      client,
      connected: true,
      connecting: false,
      authGeneration: userId === 'alice' ? 1 : 2,
      userId,
      role: 'member',
    });
    const { result, rerender } = renderHook(({ userId }) => useMarketplaceOverview(view(userId)), {
      initialProps: { userId: 'alice' },
    });
    resolveAlice({
      servers: [
        {
          mcp_server_id: 'server-alice',
          name: 'alice-private',
          source: 'user',
          transport: 'http',
          enabled: true,
          tools: [],
          session_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      attachments: [],
      credentials: [],
      generated_at: new Date().toISOString(),
    } as MCPMarketplaceOverview);
    await waitFor(() => expect(result.current.overview.servers).toHaveLength(1));

    identity = 'bob';
    rerender({ userId: 'bob' });
    expect(result.current.overview.servers).toHaveLength(0);
    rejectBob(new Error('Bob load failed'));
    await waitFor(() => expect(result.current.error).toBe('Bob load failed'));
    expect(result.current.overview.servers).toHaveLength(0);
  });

  it('does not render an earlier caller error while the next caller is held', async () => {
    const serviceEvents = emitter();
    const io = emitter();
    let identity = 'alice';
    let rejectAlice!: (reason: Error) => void;
    const alice = new Promise<MCPMarketplaceOverview>((_resolve, reject) => (rejectAlice = reject));
    const bob = new Promise<MCPMarketplaceOverview>(() => undefined);
    const client = {
      service: (path: string) =>
        path === 'mcp-marketplace'
          ? { find: () => (identity === 'alice' ? alice : bob) }
          : { ...serviceEvents, find: vi.fn() },
      io,
    } as unknown as AgorClient;
    const { result, rerender } = renderHook(
      ({ userId }) =>
        useMarketplaceOverview({
          client,
          connected: true,
          connecting: false,
          authGeneration: userId === 'alice' ? 1 : 2,
          userId,
          role: 'member',
        }),
      { initialProps: { userId: 'alice' } }
    );
    rejectAlice(new Error('Alice private load failure'));
    await waitFor(() => expect(result.current.error).toBe('Alice private load failure'));

    identity = 'bob';
    rerender({ userId: 'bob' });
    expect(result.current.error).toBeNull();
    expect(result.current.overview.servers).toHaveLength(0);
    expect(result.current.overview.attachments).toHaveLength(0);
    expect(result.current.overview.credentials).toHaveLength(0);
  });

  it('discards an older same-authority response after a newer refresh wins', async () => {
    const serviceEvents = emitter();
    const io = emitter();
    let resolveFirst!: (value: MCPMarketplaceOverview) => void;
    const first = new Promise<MCPMarketplaceOverview>((resolve) => (resolveFirst = resolve));
    const newer: MCPMarketplaceOverview = {
      servers: [],
      attachments: [],
      credentials: [],
      generated_at: new Date(2).toISOString(),
    };
    const older = { ...newer, generated_at: new Date(1).toISOString() };
    const find = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(newer);
    const client = {
      service: (path: string) =>
        path === 'mcp-marketplace' ? { find } : { ...serviceEvents, find: vi.fn() },
      io,
    } as unknown as AgorClient;
    const { result } = renderHook(() =>
      useMarketplaceOverview({
        client,
        connected: true,
        connecting: false,
        authGeneration: 1,
        userId: 'alice',
        role: 'member',
      })
    );
    await waitFor(() => expect(find).toHaveBeenCalledOnce());
    await act(async () => result.current.refresh());
    await waitFor(() => expect(result.current.overview.generated_at).toBe(newer.generated_at));
    resolveFirst(older);
    await act(async () => first);
    expect(result.current.overview.generated_at).toBe(newer.generated_at);
  });
});
