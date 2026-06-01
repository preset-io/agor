import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useBoardPresenceRoom } from './useBoardPresenceRoom';

function makeMockClient() {
  const ioListeners = new Map<string, Set<() => void>>();
  const clientListeners = new Map<string, Set<() => void>>();

  const addListener = (
    registry: Map<string, Set<() => void>>,
    event: string,
    listener: () => void
  ) => {
    const set = registry.get(event) ?? new Set();
    set.add(listener);
    registry.set(event, set);
  };

  const removeListener = (
    registry: Map<string, Set<() => void>>,
    event: string,
    listener: () => void
  ) => {
    registry.get(event)?.delete(listener);
  };

  return {
    client: {
      io: {
        emit: vi.fn(),
        on: vi.fn((event: string, listener: () => void) => {
          addListener(ioListeners, event, listener);
        }),
        off: vi.fn((event: string, listener: () => void) => {
          removeListener(ioListeners, event, listener);
        }),
      },
      on: vi.fn((event: string, listener: () => void) => {
        addListener(clientListeners, event, listener);
      }),
      off: vi.fn((event: string, listener: () => void) => {
        removeListener(clientListeners, event, listener);
      }),
    } as never,
    emitIoEvent: (event: string) => {
      for (const listener of ioListeners.get(event) ?? []) {
        listener();
      }
    },
    emitClientEvent: (event: string) => {
      for (const listener of clientListeners.get(event) ?? []) {
        listener();
      }
    },
  };
}

describe('useBoardPresenceRoom', () => {
  it('joins on mount, rejoins after reconnect authentication, and leaves on unmount', () => {
    const { client, emitClientEvent, emitIoEvent } = makeMockClient();
    const { unmount } = renderHook(() =>
      useBoardPresenceRoom({
        client,
        boardId: 'board-1' as never,
      })
    );

    expect(client.io.emit).toHaveBeenNthCalledWith(1, 'presence:watch-board', 'board-1');

    emitIoEvent('connect');
    expect(client.io.emit).toHaveBeenNthCalledWith(2, 'presence:watch-board', 'board-1');

    emitClientEvent('authenticated');
    expect(client.io.emit).toHaveBeenNthCalledWith(3, 'presence:watch-board', 'board-1');

    unmount();
    expect(client.io.emit).toHaveBeenLastCalledWith('presence:unwatch-board', 'board-1');
  });
});
