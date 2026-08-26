import type { MCPCatalogReadiness } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCatalogReadiness } from './useCatalogReadiness';

function emitter() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    on: vi.fn((event: string, listener: () => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, listener: () => void) => listeners.get(event)?.delete(listener)),
    emit: (event: string) =>
      listeners.get(event)?.forEach((listener) => {
        listener();
      }),
  };
}

describe('useCatalogReadiness request coalescing', () => {
  afterEach(() => vi.useRealTimers());

  it('debounces the first lookup and coalesces rapid invalidations', async () => {
    vi.useFakeTimers();
    const serverEvents = emitter();
    const io = emitter();
    const get = vi.fn(
      async (): Promise<MCPCatalogReadiness> => ({
        catalog_key: 'io.example/server',
        state: 'oauth_required',
      })
    );
    const client = {
      service: (path: string) => (path === 'mcp-catalog/readiness' ? { get } : { ...serverEvents }),
      io,
    } as unknown as AgorClient;

    const rendered = renderHook(() =>
      useCatalogReadiness({
        client,
        entryKey: 'io.example/server',
        ready: true,
        authGeneration: 7,
        userId: 'alice',
      })
    );

    expect(rendered.result.current.loading).toBe(true);
    expect(rendered.result.current.readiness).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(get).not.toHaveBeenCalled();
    // An invalidation during the initial debounce replaces that timer rather
    // than allowing both an initial and invalidation read to escape.
    act(() => io.emit('marketplace:invalidated'));
    expect(rendered.result.current.loading).toBe(true);
    expect(rendered.result.current.readiness).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(99));
    expect(get).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(get).toHaveBeenCalledTimes(1);
    expect(rendered.result.current.loading).toBe(false);
    expect(rendered.result.current.readiness?.state).toBe('oauth_required');

    act(() => {
      io.emit('marketplace:invalidated');
    });
    expect(rendered.result.current.loading).toBe(true);
    expect(rendered.result.current.readiness).toBeNull();
    act(() => {
      serverEvents.emit('created');
      serverEvents.emit('patched');
      io.emit('oauth:completed');
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => vi.advanceTimersByTimeAsync(99));
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(get).toHaveBeenCalledTimes(2);
  });
});
