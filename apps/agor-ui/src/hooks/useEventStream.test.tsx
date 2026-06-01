import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEventStream } from './useEventStream';

function makeMockClient() {
  const anyListeners = new Set<(eventName: string, ...args: unknown[]) => void>();

  return {
    client: {
      io: {
        onAny: vi.fn((listener: (eventName: string, ...args: unknown[]) => void) => {
          anyListeners.add(listener);
        }),
        offAny: vi.fn((listener: (eventName: string, ...args: unknown[]) => void) => {
          anyListeners.delete(listener);
        }),
      },
    } as never,
    emit: (eventName: string, ...args: unknown[]) => {
      for (const listener of anyListeners) listener(eventName, ...args);
    },
  };
}

describe('useEventStream', () => {
  it('does not subscribe while disabled', () => {
    const { client, emit } = makeMockClient();
    const { result } = renderHook(() =>
      useEventStream({
        client,
        enabled: false,
      })
    );

    expect(client.io.onAny).not.toHaveBeenCalled();

    act(() => {
      emit('cursor-moved', { userId: 'u1' });
    });

    expect(result.current.events).toEqual([]);
  });

  it('subscribes only while enabled and tears down cleanly', () => {
    const { client, emit } = makeMockClient();
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) =>
        useEventStream({
          client,
          enabled,
        }),
      {
        initialProps: { enabled: true },
      }
    );

    expect(client.io.onAny).toHaveBeenCalledTimes(1);

    act(() => {
      emit('presence-updated', { userId: 'u1', boardId: 'b1' });
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.type).toBe('cursor');

    rerender({ enabled: false });
    expect(client.io.offAny).toHaveBeenCalledTimes(1);
    expect(result.current.events).toEqual([]);

    act(() => {
      emit('presence-updated', { userId: 'u2', boardId: 'b2' });
    });

    expect(result.current.events).toEqual([]);

    unmount();
  });
});
