/**
 * Tests for the branch modal's default board resolution in useCreateFlows:
 * the current board when on one, else the user's accessible main board.
 */

import type { Board, User } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../store/agorMaps';
import { agorStore } from '../store/agorStore';
import { type UseCreateFlowsOptions, useCreateFlows } from './useCreateFlows';

function board(id: string): Board {
  return { board_id: id, name: id, archived: false } as unknown as Board;
}

const wrapper = ({ children }: { children: React.ReactNode }) => <AntdApp>{children}</AntdApp>;

function baseOptions(overrides: Partial<UseCreateFlowsOptions> = {}): UseCreateFlowsOptions {
  return {
    client: null,
    availableAgents: [],
    navigation: { goToBranch: vi.fn(), goToBoard: vi.fn(), goToSession: vi.fn() },
    onCreateRepo: vi.fn(),
    onCreateLocalRepo: vi.fn(),
    ...overrides,
  };
}

function user(mainBoardId?: string): User {
  return { user_id: 'u1', preferences: mainBoardId ? { mainBoardId } : {} } as unknown as User;
}

describe('useCreateFlows — branch default board', () => {
  it('defaults to the current board when the user is on one', () => {
    agorStore.setState({ ...EMPTY_MAPS, boardById: new Map([['board-1', board('board-1')]]) });
    const { result } = renderHook(
      () =>
        useCreateFlows(baseOptions({ currentBoardId: 'board-1', currentUser: user('board-9') })),
      { wrapper }
    );
    expect(result.current.createModalsProps.branchDefaultBoardId).toBe('board-1');
  });

  it('falls back to the accessible main board when not on a board', () => {
    agorStore.setState({
      ...EMPTY_MAPS,
      boardById: new Map([['main-board', board('main-board')]]),
    });
    const { result } = renderHook(
      () =>
        useCreateFlows(baseOptions({ currentBoardId: undefined, currentUser: user('main-board') })),
      { wrapper }
    );
    expect(result.current.createModalsProps.branchDefaultBoardId).toBe('main-board');
  });

  it('leaves the default empty when the main board is not accessible', () => {
    agorStore.setState({ ...EMPTY_MAPS, boardById: new Map([['other', board('other')]]) });
    const { result } = renderHook(
      () => useCreateFlows(baseOptions({ currentBoardId: undefined, currentUser: user('gone') })),
      { wrapper }
    );
    expect(result.current.createModalsProps.branchDefaultBoardId).toBeUndefined();
  });
});

describe('useCreateFlows — teammate target board', () => {
  it('names the current board when adding a teammate to it, and clears it for a fresh create', () => {
    agorStore.setState({ ...EMPTY_MAPS, boardById: new Map([['board-1', board('board-1')]]) });
    const { result } = renderHook(
      () => useCreateFlows(baseOptions({ currentBoardId: 'board-1' })),
      { wrapper }
    );

    act(() => result.current.openCreateBoardTeammate());
    expect(result.current.createModalsProps.teammateTargetBoardName).toBe('board-1');

    act(() => result.current.openCreate('teammate'));
    expect(result.current.createModalsProps.teammateTargetBoardName).toBeUndefined();
  });
});
