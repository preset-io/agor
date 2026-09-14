import type { AgorClient, Board, Branch, Repo, User } from '@agor-live/client';
import { act, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardTeammatePanel } from './BoardTeammatePanel';

vi.mock('../BranchCard', () => ({
  BranchSessionSections: () => null,
}));

vi.mock('../BranchHeaderPill', () => ({
  BranchHeaderPill: () => <div data-testid="branch-header-pill" />,
}));

const board = { board_id: 'board-1', name: 'Board', slug: 'board' } as Board;
const repo = { repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo;

const branchOne = {
  branch_id: 'branch-1',
  repo_id: 'repo-1',
  name: 'teammate',
  filesystem_status: 'ready',
  created_by: 'user-creator',
  primary_owner_user_id: 'user-alice',
} as Branch;

const branchTwo = {
  ...branchOne,
  branch_id: 'branch-2',
  primary_owner_user_id: 'user-bob',
} as Branch;

const creator = { user_id: 'user-creator', name: 'creator', role: 'member' } as User;
const alice = { user_id: 'user-alice', name: 'alice', role: 'member' } as User;
const bob = { user_id: 'user-bob', name: 'bob', role: 'member' } as User;
const service = vi.fn(() => ({}));
const client = { service } as unknown as AgorClient;

function renderPanel(branch: Branch = branchOne) {
  return render(
    <AntApp>
      <BoardTeammatePanel
        board={board}
        activeTab="teammate"
        onTabChange={vi.fn()}
        primaryTeammateBranch={branch}
        primaryTeammateRepo={repo}
        primaryTeammateInaccessible={false}
        currentUserId="user-viewer"
        onSessionClick={vi.fn()}
        client={client}
      />
    </AntApp>
  );
}

describe('BoardTeammatePanel primary owner badge', () => {
  beforeEach(() => {
    service.mockClear();
    agorStore.setState({
      ...EMPTY_MAPS,
      userById: new Map([
        [creator.user_id, creator],
        [alice.user_id, alice],
        [bob.user_id, bob],
      ]),
    });
  });

  it('renders the immutable primary owner from the branch row', async () => {
    renderPanel();

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.queryByText('creator')).not.toBeInTheDocument();
    expect(service).not.toHaveBeenCalled();
  });

  it('uses created_by only as a compatibility fallback for an old branch payload', async () => {
    renderPanel({ ...branchOne, primary_owner_user_id: undefined } as Branch);

    expect(await screen.findByText('creator')).toBeInTheDocument();
  });

  it('does not invent an owner when the referenced user is unavailable', () => {
    agorStore.setState({ ...EMPTY_MAPS, userById: new Map() });
    renderPanel();

    expect(screen.queryByText('alice')).not.toBeInTheDocument();
    expect(screen.queryByText('creator')).not.toBeInTheDocument();
  });

  it('does not retain the previous primary owner when the teammate branch changes', async () => {
    const { rerender } = renderPanel();
    expect(await screen.findByText('alice')).toBeInTheDocument();

    rerender(
      <AntApp>
        <BoardTeammatePanel
          board={board}
          activeTab="teammate"
          onTabChange={vi.fn()}
          primaryTeammateBranch={branchTwo}
          primaryTeammateRepo={repo}
          primaryTeammateInaccessible={false}
          currentUserId="user-viewer"
          onSessionClick={vi.fn()}
          client={client}
        />
      </AntApp>
    );

    expect(screen.queryByText('alice')).not.toBeInTheDocument();
    expect(await screen.findByText('bob')).toBeInTheDocument();
  });

  it('resolves the primary owner when the user directory hydrates later', async () => {
    agorStore.setState({ ...EMPTY_MAPS, userById: new Map() });
    renderPanel();
    expect(screen.queryByText('alice')).not.toBeInTheDocument();

    act(() => {
      agorStore.setState({ userById: new Map([[alice.user_id, alice]]) });
    });

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(service).not.toHaveBeenCalled();
  });
});
