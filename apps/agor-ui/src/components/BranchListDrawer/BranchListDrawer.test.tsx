import type { Board, Branch, Repo, Session } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { boardScopeKey } from '../../store/scopeMerge';
import { boardCoverage } from '../../test/userScopeCoverage';

vi.mock('../../utils/sessionTitle', () => ({
  getSessionDisplayTitle: (session: { title?: string }) => session.title ?? 'Untitled session',
}));

import { BoardSessionList } from './BranchListDrawer';

const board = {
  board_id: 'board-1',
  name: 'Board 1',
} as Board;

const repo = {
  repo_id: 'repo-1',
  slug: 'preset-io/agor',
} as Repo;

const branch = {
  branch_id: 'branch-1',
  board_id: 'board-1',
  repo_id: 'repo-1',
  name: 'feature/panel-management',
} as Branch;

const session = {
  session_id: 'session-1',
  branch_id: 'branch-1',
  title: 'Improve panels',
  description: '',
  agentic_tool: 'codex',
  status: 'idle',
  last_updated: '2026-05-31T00:00:00.000Z',
} as unknown as Session;

const setPartition = (status: 'loading' | 'loaded' | 'error') =>
  agorStore.getState().setCoverage(boardScopeKey(board.board_id), boardCoverage(status));

const renderEmptyList = () =>
  render(
    <BoardSessionList
      board={board}
      currentBoardId={board.board_id}
      branchById={new Map([[branch.branch_id, branch]])}
      repoById={new Map()}
      sessionsByBranch={new Map()}
      onSessionClick={vi.fn()}
    />
  );

describe('BoardSessionList', () => {
  beforeEach(() => setPartition('loaded'));
  afterEach(() => agorStore.getState().reset());

  it.each([
    { status: 'loading', text: 'Loading sessions…', count: false },
    { status: 'loaded', text: 'No sessions on this board yet.', count: true },
  ] as const)('says "$text" for an empty $status board', ({ status, text, count }) => {
    setPartition(status);
    renderEmptyList();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText('0 sessions') !== null).toBe(count);
  });

  it('claims no empty board when its partition failed to load', () => {
    setPartition('error');
    renderEmptyList();
    expect(screen.queryByText('No sessions on this board yet.')).toBeNull();
    expect(screen.queryByText('Loading sessions…')).toBeNull();
  });

  it('names the query when a search matches nothing', async () => {
    render(
      <BoardSessionList
        board={board}
        currentBoardId={board.board_id}
        branchById={new Map([[branch.branch_id, branch]])}
        repoById={new Map()}
        sessionsByBranch={new Map([[branch.branch_id, [session]]])}
        onSessionClick={vi.fn()}
      />
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'zebra' } });
    expect(await screen.findByText('No results for “zebra”.')).toBeInTheDocument();
  });

  it('shows the branch as quiet metadata on the session row', () => {
    render(
      <BoardSessionList
        board={board}
        currentBoardId={board.board_id}
        branchById={new Map([[branch.branch_id, branch]])}
        repoById={new Map([[repo.repo_id, repo]])}
        sessionsByBranch={new Map([[branch.branch_id, [session]]])}
        onSessionClick={vi.fn()}
      />
    );

    const branchText = screen.getByText('feature/panel-management');
    const metadata = branchText.closest('[title]')!;
    expect(metadata).toHaveAttribute('title', 'preset-io/agor / feature/panel-management');
    expect(branchText.closest('.ant-tag')).toBeNull();
    // One row control; the branch is part of its accessible name, not a separate target.
    const row = screen.getByRole('button', { name: /^Open session / });
    expect(row).toHaveAccessibleName(/branch preset-io\/agor \/ feature\/panel-management/);
    expect(row).toContainElement(branchText);
  });

  it('lists a remote-created session once, at its own branch when that branch is on the board', () => {
    const creator = { ...branch, branch_id: 'branch-creator', name: 'creator' } as Branch;
    const target = { ...session, session_id: 'remote-1', title: 'Remote child' } as Session;
    // Same id under the creator's branch, as buildSessionMaps projects it for the card tree.
    const surrogate = {
      ...target,
      branch_id: creator.branch_id,
      remote_surrogate: {
        source_session_id: 'creator-session',
        source_branch_id: creator.branch_id,
        target_branch_id: branch.branch_id,
      },
    } as unknown as Session;
    const renderList = (branches: Branch[]) =>
      render(
        <BoardSessionList
          board={board}
          currentBoardId={board.board_id}
          branchById={new Map(branches.map((b) => [b.branch_id, b]))}
          repoById={new Map()}
          sessionsByBranch={
            new Map([
              [creator.branch_id, [surrogate]],
              [branch.branch_id, [target]],
            ])
          }
          onSessionClick={vi.fn()}
        />
      );

    const { unmount } = renderList([creator, branch]);
    const rows = screen.getAllByRole('button', { name: /^Open session Remote child/ });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAccessibleName(/branch feature\/panel-management/);
    expect(screen.getByText('1 session', { exact: false })).toBeInTheDocument();
    unmount();

    // The home branch is on another board: the surrogate is its only row here.
    renderList([creator, { ...branch, board_id: 'board-2' } as Branch]);
    expect(screen.getByRole('button', { name: /^Open session Remote child/ })).toHaveAccessibleName(
      /branch creator/
    );
  });
});
