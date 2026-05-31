import type { Board, Branch, Repo, Session } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

describe('BoardSessionList', () => {
  it('renders a compact, non-interactive BranchPill for session branches', () => {
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

    const pillText = screen.getByText('feature/panel-management');
    expect(pillText).toBeInTheDocument();
    expect(pillText.closest('.ant-tag')).toHaveAttribute(
      'title',
      'preset-io/agor / feature/panel-management'
    );
    expect(pillText.closest('button,a')).toBeNull();
  });
});
