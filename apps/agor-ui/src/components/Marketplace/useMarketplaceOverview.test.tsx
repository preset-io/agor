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
    const service = (path: string) =>
      path === 'mcp-marketplace' ? { find } : { ...serviceEvents, find: vi.fn() };
    const client = { service, io } as unknown as AgorClient;
    const { result } = renderHook(() =>
      useMarketplaceOverview({
        client,
        connected: true,
        connecting: false,
        authGeneration: 1,
        userId: 'alice',
      })
    );
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));

    act(() => serviceEvents.emit('created'));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(3));
    expect(result.current.error).toBeNull();
  });
});
