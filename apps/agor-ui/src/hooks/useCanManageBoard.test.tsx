import type { AgorClient, Board, User } from '@agor-live/client';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetAuthConfigForTests, __setAuthConfigForTests } from './useAuthConfig';
import { useCanManageBoard } from './useCanManageBoard';

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
  __resetAuthConfigForTests();
});

describe('useCanManageBoard', () => {
  it('preserves member editing and skips policy requests when RBAC is disabled', async () => {
    __setAuthConfigForTests({ requireAuth: true }, { branchRbac: false });
    const service = vi.fn(() => {
      throw new Error('permission service must not be called');
    });
    const client = { service } as unknown as AgorClient;

    const { result } = renderHook(() => useCanManageBoard(client, board, member));

    await waitFor(() => expect(result.current).toBe(true));
    expect(service).not.toHaveBeenCalled();
  });

  it('uses effective access once and ignores ordinary board object patches', async () => {
    __setAuthConfigForTests({ requireAuth: true }, { branchRbac: true });
    const find = vi.fn().mockResolvedValue({ capabilities: ['board.view', 'board.edit'] });
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
  });
});
