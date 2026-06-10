import type { BoardID, CursorMovedEvent, PresenceUpdatedEvent, User } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePresence } from './usePresence';

type Listener = (payload: unknown) => void;

function makeMockClient() {
  const ioListeners = new Map<string, Listener[]>();

  return {
    client: {
      io: {
        on: (event: string, fn: Listener) => {
          const listeners = ioListeners.get(event) ?? [];
          listeners.push(fn);
          ioListeners.set(event, listeners);
        },
        off: (event: string, fn: Listener) => {
          const listeners = ioListeners.get(event) ?? [];
          ioListeners.set(
            event,
            listeners.filter((listener) => listener !== fn)
          );
        },
      },
    } as never,
    emit: (event: string, payload: unknown) => {
      for (const listener of ioListeners.get(event) ?? []) {
        listener(payload);
      }
    },
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    user_id: 'user-1',
    email: 'user-1@example.com',
    role: 'member',
    ...overrides,
  } as User;
}

function boardId(value: string): BoardID {
  return value as BoardID;
}

describe('usePresence', () => {
  it('ignores cursor events for other boards without re-rendering board-scoped consumers', () => {
    const { client, emit } = makeMockClient();
    const users = [makeUser()];
    let renders = 0;

    const { result } = renderHook(() => {
      renders += 1;
      return usePresence({
        client,
        boardId: boardId('board-a'),
        users,
      });
    });

    const beforeActiveUsers = result.current.activeUsers;
    const beforeRemoteCursors = result.current.remoteCursors;

    act(() => {
      emit('cursor-moved', {
        userId: 'user-1',
        boardId: boardId('board-b'),
        x: 120,
        y: 80,
        timestamp: 1_000,
      } satisfies CursorMovedEvent);
    });

    expect(renders).toBe(1);
    expect(result.current.activeUsers).toBe(beforeActiveUsers);
    expect(result.current.remoteCursors).toBe(beforeRemoteCursors);
    expect(result.current.remoteCursors.size).toBe(0);
  });

  it('coalesces global facepile updates while a user stays on the same board', () => {
    const { client, emit } = makeMockClient();
    const users = [makeUser()];

    const { result } = renderHook(() => {
      return usePresence({
        client,
        boardId: boardId('board-a'),
        users,
        globalPresence: true,
        presenceMinUpdateIntervalMs: 10_000,
      });
    });

    act(() => {
      emit('presence-updated', {
        userId: 'user-1',
        boardId: boardId('board-b'),
        timestamp: 1_000,
      } satisfies PresenceUpdatedEvent);
    });

    const firstActiveUsers = result.current.activeUsers;

    act(() => {
      emit('presence-updated', {
        userId: 'user-1',
        boardId: boardId('board-b'),
        timestamp: 5_000,
      } satisfies PresenceUpdatedEvent);
    });

    expect(result.current.activeUsers).toBe(firstActiveUsers);
    expect(result.current.activeUsers[0]).toMatchObject({
      boardId: boardId('board-b'),
      lastSeen: 1_000,
    });
    expect(result.current.activeUsers[0]?.cursor).toBeUndefined();

    act(() => {
      emit('presence-updated', {
        userId: 'user-1',
        boardId: boardId('board-b'),
        timestamp: 12_000,
      } satisfies PresenceUpdatedEvent);
    });

    expect(result.current.activeUsers[0]).toMatchObject({
      boardId: boardId('board-b'),
      lastSeen: 12_000,
    });
    expect(result.current.activeUsers[0]?.cursor).toBeUndefined();
  });

  it('keeps global facepile presence when the current route has no board', () => {
    const { client, emit } = makeMockClient();
    const users = [makeUser()];

    const { result, rerender } = renderHook(
      ({ currentBoardId }: { currentBoardId: BoardID | null }) =>
        usePresence({
          client,
          boardId: currentBoardId,
          users,
          globalPresence: true,
          presenceMinUpdateIntervalMs: 10_000,
        }),
      {
        initialProps: { currentBoardId: boardId('board-a') },
      }
    );

    act(() => {
      emit('presence-updated', {
        userId: 'user-1',
        boardId: boardId('board-b'),
        timestamp: 1_000,
      } satisfies PresenceUpdatedEvent);
    });

    expect(result.current.activeUsers).toHaveLength(1);
    expect(result.current.activeUsers[0]).toMatchObject({
      boardId: boardId('board-b'),
      lastSeen: 1_000,
    });

    rerender({ currentBoardId: null });

    expect(result.current.activeUsers).toHaveLength(1);
    expect(result.current.activeUsers[0]).toMatchObject({
      boardId: boardId('board-b'),
      lastSeen: 1_000,
    });

    act(() => {
      emit('presence-updated', {
        userId: 'user-1',
        boardId: boardId('board-c'),
        timestamp: 20_000,
      } satisfies PresenceUpdatedEvent);
    });

    expect(result.current.activeUsers[0]).toMatchObject({
      boardId: boardId('board-c'),
      lastSeen: 20_000,
    });
  });
});
