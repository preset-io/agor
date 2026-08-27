import { type Board, type BoardID, PRESENCE_SOCKET_EVENTS, type User } from '@agor-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { GlobalPresenceFacepile } from './GlobalPresenceFacepile';

type Listener = (payload?: unknown) => void;

function makeMockClient() {
  const listeners = new Map<string, Set<Listener>>();
  const add = (event: string, listener: Listener) => {
    const current = listeners.get(event) ?? new Set();
    current.add(listener);
    listeners.set(event, current);
  };
  const remove = (event: string, listener: Listener) => listeners.get(event)?.delete(listener);
  const outbound = vi.fn(
    (
      event: string,
      _payload?: unknown,
      acknowledge?: (error: Error | null, result?: { ok: boolean }) => void
    ) => {
      if (event === PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations) {
        acknowledge?.(null, { ok: true });
      }
    }
  );
  return {
    client: {
      io: {
        emit: outbound,
        timeout: vi.fn(() => ({ emit: outbound })),
        on: vi.fn(add),
        off: vi.fn(remove),
      },
      on: vi.fn(add),
      off: vi.fn(remove),
    } as never,
    inbound(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    outbound,
  };
}

function user(userId: string, name: string): User {
  return {
    user_id: userId,
    email: `${userId}@example.test`,
    name,
    role: 'member',
  } as User;
}

it('restores clickable board association only while an authorized board packet is active', () => {
  const boardId = 'board-a' as BoardID;
  const currentUser = user('current-user', 'Current User');
  const remoteUser = user('remote-user', 'Remote Person');
  const board = { board_id: boardId, name: 'Authorized Board', archived: false } as Board;
  const { client, inbound, outbound } = makeMockClient();
  const onUserClick = vi.fn();

  render(
    <GlobalPresenceFacepile
      client={client}
      currentBoardId={boardId}
      users={[currentUser, remoteUser]}
      currentUser={currentUser}
      boardById={new Map([[boardId, board]])}
      onUserClick={onUserClick}
    />
  );

  expect(outbound).toHaveBeenCalledWith(
    PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations,
    { boardIds: [boardId] },
    expect.any(Function)
  );
  act(() => {
    inbound(PRESENCE_SOCKET_EVENTS.updated, {
      userId: remoteUser.user_id,
      presenceId: 'remote-tab',
      timestamp: 1_000,
    });
    inbound(PRESENCE_SOCKET_EVENTS.updated, {
      userId: remoteUser.user_id,
      presenceId: 'remote-tab',
      boardId,
      timestamp: 1_000,
    });
  });

  fireEvent.click(screen.getByText('RP'));
  expect(onUserClick).toHaveBeenCalledWith(remoteUser.user_id, boardId, undefined);

  act(() => {
    inbound(PRESENCE_SOCKET_EVENTS.left, {
      userId: remoteUser.user_id,
      presenceId: 'remote-tab',
      boardId,
      timestamp: 2_000,
    });
  });
  fireEvent.click(screen.getByText('RP'));
  expect(onUserClick).toHaveBeenCalledTimes(1);

  act(() => {
    inbound(PRESENCE_SOCKET_EVENTS.updated, {
      userId: remoteUser.user_id,
      presenceId: 'remote-tab',
      boardId: 'not-in-authorized-board-list',
      timestamp: 3_000,
    });
  });
  fireEvent.click(screen.getByText('RP'));
  expect(onUserClick).toHaveBeenCalledTimes(1);
});
