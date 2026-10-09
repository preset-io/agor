/**
 * A primary teammate that lives on another board: its sessions come with
 * that board's partition (loaded in the background), so the teammate tab
 * works with the store's session map empty (Step 3).
 */
import type { Board, Branch, Repo, Session, User } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { beforeEach, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { getDisplayedBoardId } from '../../store/boardPartitions';
import {
  fakeFeathersClient,
  makeBoard,
  makeBranch,
  makeSession,
  withTestAuthority,
} from '../../test/harness';
import { BoardTeammatePanel } from './BoardTeammatePanel';

vi.mock('../BranchCard', () => ({
  BranchSessionSections: ({ sessions }: { sessions: Session[] }) => (
    <ul>
      {sessions.map((s) => (
        <li key={s.session_id}>{s.title}</li>
      ))}
    </ul>
  ),
}));

const board = makeBoard('board-1', {
  name: 'Shown',
  primary_teammate_id: 'mate',
} as Partial<Board>);
const otherBoard = makeBoard('board-2', { name: 'Home of the teammate' });
const teammate = makeBranch('mate', {
  board_id: 'board-2',
  repo_id: 'repo-1',
  filesystem_status: 'ready',
} as Partial<Branch>);
const repo = { repo_id: 'repo-1', slug: 'acme/app' } as Repo;
const session = makeSession('s1', 'mate', { title: 'Teammate task' });

withTestAuthority('user-1:member:1');
beforeEach(() => {
  agorStore.getState().setMap(
    'boardById',
    new Map([
      [board.board_id, board],
      [otherBoard.board_id, otherBoard],
    ])
  );
  agorStore
    .getState()
    .setMap('userById', new Map([['user-1', { user_id: 'user-1', role: 'member' } as User]]));
});

it("loads the teammate's board in the background and lists its sessions", async () => {
  const { client } = fakeFeathersClient({
    sessions: { findAll: () => [session] },
    branches: { findAll: () => [teammate] },
    boards: { get: () => ({ ...otherBoard, objects: {} }) },
  });
  render(
    <AntApp>
      <BoardTeammatePanel
        board={board}
        activeTab="teammate"
        onTabChange={vi.fn()}
        primaryTeammateBranch={teammate}
        primaryTeammateRepo={repo}
        primaryTeammateInaccessible={false}
        currentUserId="user-1"
        onSessionClick={vi.fn()}
        client={client}
      />
    </AntApp>
  );
  expect(screen.getByTestId('board-partition-skeleton')).toBeInTheDocument();
  expect(await screen.findByText('Teammate task')).toBeInTheDocument();
  expect(getDisplayedBoardId()).toBeUndefined();
});
