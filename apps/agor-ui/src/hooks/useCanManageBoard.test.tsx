import type { AgorClient, Board, User } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCanManageBoard } from './useCanManageBoard';

const connectionState = vi.hoisted(() => ({ authGeneration: 1 }));
vi.mock('../contexts/ConnectionContext', () => ({
  useConnectionState: () => connectionState,
}));

const member = {
  user_id: 'user-2',
  role: 'member',
} as User;

const board = {
  board_id: 'board-1',
  primary_owner_user_id: 'user-1',
  archived: false,
  objects: {},
} as Board;

afterEach(() => {
  connectionState.authGeneration = 1;
});

describe('useCanManageBoard', () => {
  it('ignores object patches but refetches effective access after authenticated reconnect', async () => {
    let resolveReconnect: ((access: { capabilities: string[] }) => void) | undefined;
    const reconnectAccess = new Promise<{ capabilities: string[] }>((resolve) => {
      resolveReconnect = resolve;
    });
    const find = vi
      .fn()
      .mockResolvedValueOnce({ capabilities: ['board.view', 'board.edit'] })
      .mockReturnValueOnce(reconnectAccess);
    const service = vi.fn((path: string) => {
      expect(path).toBe('boards/:id/effective-access');
      return { find };
    });
    const client = { service } as unknown as AgorClient;

    const { result, rerender } = renderHook(
      ({ currentBoard }) => useCanManageBoard(client, currentBoard, member),
      { initialProps: { currentBoard: board } }
    );

    await waitFor(() => expect(result.current).toBe(true));
    expect(find).toHaveBeenCalledTimes(1);

    rerender({
      currentBoard: {
        ...board,
        objects: {
          'zone-1': {
            type: 'zone',
            x: 10,
            y: 20,
            width: 300,
            height: 200,
            label: 'Review',
          },
        },
      } as Board,
    });

    expect(result.current).toBe(true);
    expect(find).toHaveBeenCalledTimes(1);

    act(() => {
      connectionState.authGeneration += 1;
      rerender({ currentBoard: board });
    });

    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    expect(result.current).toBe(false);

    resolveReconnect?.({ capabilities: ['board.view'] });
    await waitFor(() => expect(result.current).toBe(false));
  });
});
