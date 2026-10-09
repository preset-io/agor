import type { AgorClient, Board, Branch, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { makeTeammateBranch } from '../BranchModal/testUtils';

const messageApi = vi.hoisted(() => ({
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));

vi.mock('../../utils/message', () => ({
  useThemedMessage: () => messageApi,
}));

import { BoardTeammatePanel } from './BoardTeammatePanel';

const board = {
  board_id: 'board-1' as Board['board_id'],
  name: 'Board',
  slug: 'board',
  created_at: '2026-08-14T00:00:00.000Z',
  last_updated: '2026-08-14T00:00:00.000Z',
  created_by: 'user-1',
  primary_owner_user_id: 'user-1',
  url: '',
  archived: false,
} satisfies Board;
const teammate: Branch = makeTeammateBranch(
  {
    branch_id: 'teammate-1' as Branch['branch_id'],
    board_id: board.board_id,
    name: 'helper',
  },
  { displayName: 'Helper' }
);

describe('BoardTeammatePanel messages', () => {
  beforeEach(() => {
    messageApi.showSuccess.mockReset();
    messageApi.showError.mockReset();
    agorStore.setState({
      ...EMPTY_MAPS,
      userById: new Map([['user-1', { user_id: 'user-1', role: 'member' } as User]]),
      branchById: new Map([[teammate.branch_id, teammate]]),
    });
  });

  it.each([
    {
      raw: 'You need Board Editor or Manager access to set primary teammate',
      toast:
        "Couldn't assign the teammate. You need edit access to this board. (You need Board Editor or Manager access to set primary teammate)",
    },
    {
      raw: 'Board Editor or Manager access is required to assign a teammate',
      toast:
        "Couldn't assign the teammate. You need edit access to this board. (Board Editor or Manager access is required to assign a teammate)",
    },
    {
      raw: 'This board already has a primary teammate. Reload before assigning.',
      toast:
        "Couldn't assign the teammate. This board already has a teammate, so refresh to see it. (This board already has a primary teammate. Reload before assigning.)",
    },
    {
      raw: 'Board or teammate not found',
      toast:
        "Couldn't assign the teammate. That teammate no longer exists. (Board or teammate not found)",
    },
    {
      raw: 'assignment refused',
      toast: "Couldn't assign the teammate. (assignment refused)",
    },
    {
      raw: 'socket has been disconnected',
      toast:
        "The connection to Agor dropped before this was confirmed. If it didn't go through, try to assign the teammate again once the connection is back. (socket has been disconnected)",
    },
  ])('shows $raw as a plain toast', async ({ raw, toast }) => {
    const setPrimaryTeammate = vi.fn().mockRejectedValue(new Error(raw));
    const client = {
      service: (path: string) => {
        if (path === 'boards') return { setPrimaryTeammate };
        return {};
      },
    } as unknown as AgorClient;

    render(
      <AntApp>
        <BoardTeammatePanel
          board={board}
          currentUserId="user-1"
          activeTab="teammate"
          onTabChange={vi.fn()}
          primaryTeammateInaccessible={false}
          onSessionClick={vi.fn()}
          client={client}
        />
      </AntApp>
    );

    const assign = screen.getByRole('button', { name: 'Assign' });
    await waitFor(() => expect(assign).toBeEnabled());
    fireEvent.click(assign);

    await waitFor(() => expect(messageApi.showError).toHaveBeenCalledWith(toast));
    expect(messageApi.showSuccess).not.toHaveBeenCalled();
  });
  it('assigns an inherited teammate from another board with one atomic request', async () => {
    agorStore.setState({
      branchById: new Map([
        [
          teammate.branch_id,
          {
            ...teammate,
            board_id: 'source-board' as Board['board_id'],
            permission_binding: 'inherit',
          },
        ],
      ]),
    });
    const setPrimaryTeammate = vi.fn().mockResolvedValue(board);
    const patch = vi.fn();
    const client = {
      service: (path: string) => (path === 'boards' ? { setPrimaryTeammate } : { patch }),
    } as unknown as AgorClient;
    render(
      <AntApp>
        <BoardTeammatePanel
          board={board}
          currentUserId="user-1"
          activeTab="teammate"
          onTabChange={vi.fn()}
          primaryTeammateInaccessible={false}
          onSessionClick={vi.fn()}
          client={client}
        />
      </AntApp>
    );
    const assign = screen.getByRole('button', { name: 'Assign' });
    await waitFor(() => expect(assign).toBeEnabled());
    fireEvent.click(assign);
    await waitFor(() => expect(messageApi.showSuccess).toHaveBeenCalledWith('Teammate assigned'));
    expect(setPrimaryTeammate).toHaveBeenCalledWith({
      boardId: board.board_id,
      branchId: teammate.branch_id,
    });
    expect(patch).not.toHaveBeenCalled();
  });
});
