import type { AgorClient, Board, Branch } from '@agor-live/client';
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
      branchById: new Map([[teammate.branch_id, teammate]]),
    });
  });

  it('routes teammate assignment failures through the centralized message wrapper', async () => {
    const setPrimaryTeammate = vi.fn().mockRejectedValue(new Error('assignment refused'));
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

    await waitFor(() =>
      expect(messageApi.showError).toHaveBeenCalledWith(
        'Failed to assign teammate: assignment refused'
      )
    );
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
