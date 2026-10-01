import type { AgorClient, Board, Branch, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { makeTeammateBranch } from '../BranchModal/testUtils';
import { BoardTeammatePanel } from './BoardTeammatePanel';

const board = {
  board_id: 'board-1' as Board['board_id'],
  name: 'Board',
  slug: 'board',
  created_at: '2026-10-01T00:00:00.000Z',
  last_updated: '2026-10-01T00:00:00.000Z',
  created_by: 'user-1',
  primary_owner_user_id: 'user-1',
  url: '',
  archived: false,
} satisfies Board;
const teammate: Branch = makeTeammateBranch(
  { branch_id: 'teammate-1' as Branch['branch_id'], board_id: board.board_id, name: 'helper' },
  { displayName: 'Helper' }
);
const client = { service: () => ({}) } as unknown as AgorClient;

function renderPanel(onCreateTeammate?: () => void) {
  return render(
    <AntApp>
      <BoardTeammatePanel
        board={board}
        currentUserId="user-1"
        activeTab="teammate"
        onTabChange={vi.fn()}
        primaryTeammateInaccessible={false}
        onSessionClick={vi.fn()}
        onCreateTeammate={onCreateTeammate}
        client={client}
      />
    </AntApp>
  );
}

function setBranches(branches: Branch[]) {
  agorStore.setState({
    ...EMPTY_MAPS,
    userById: new Map([['user-1', { user_id: 'user-1', role: 'member' } as User]]),
    branchById: new Map(branches.map((branch) => [branch.branch_id, branch])),
  });
}

describe('BoardTeammatePanel empty state', () => {
  beforeEach(() => setBranches([]));

  // #2941: a board left without a teammate had no self-serve way to get one.
  it('offers creating a teammate when there is nothing to assign', () => {
    const onCreateTeammate = vi.fn();
    renderPanel(onCreateTeammate);

    fireEvent.click(screen.getByRole('button', { name: /create ai teammate/i }));

    expect(onCreateTeammate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull();
    expect(screen.queryByText(/no existing teammates/i)).toBeNull();
  });

  it('keeps assigning an existing teammate as the secondary option', () => {
    setBranches([teammate]);
    renderPanel(vi.fn());

    expect(screen.getByRole('button', { name: /create ai teammate/i })).toBeInTheDocument();
    expect(screen.getByText('Or assign an existing teammate')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument();
  });

  it('keeps the assign-only empty state when creation is unavailable', () => {
    renderPanel();

    expect(screen.queryByRole('button', { name: /create ai teammate/i })).toBeNull();
    expect(screen.getByText('Assign an existing teammate')).toBeInTheDocument();
    expect(screen.getByText(/no existing teammates are available/i)).toBeInTheDocument();
  });
});
