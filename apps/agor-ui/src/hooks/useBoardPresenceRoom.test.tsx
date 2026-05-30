import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useBoardPresenceRoom } from './useBoardPresenceRoom';

function makeMockClient() {
  const listeners = new Map<string, Set<() => void>>();

  return {
    client: {
      io: {
        emit: vi.fn(),
        on: vi.fn((event: string, listener: () => void) => {
          const set = listeners.get(event) ?? new Set();
          set.add(listener);
          listeners.set(event, set);
        }),
        off: vi.fn((event: string, listener: () => void) => {
          listeners.get(event)?.delete(listener);
        }),
      },
    } as never,
    emitEvent: (event: string) => {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    },
  };
}

describe('useBoardPresenceRoom', () => {
  it('joins on mount, rejoins on reconnect, and leaves on unmount', () => {
    const { client, emitEvent } = makeMockClient();
    const { unmount } = renderHook(() =>
      useBoardPresenceRoom({
        client,
        boardId: 'board-1' as never,
      })
    );

    expect(client.io.emit).toHaveBeenNthCalledWith(1, 'presence:watch-board', 'board-1');

    emitEvent('connect');
    expect(client.io.emit).toHaveBeenNthCalledWith(2, 'presence:watch-board', 'board-1');

    unmount();
    expect(client.io.emit).toHaveBeenLastCalledWith('presence:unwatch-board', 'board-1');
  });
});
