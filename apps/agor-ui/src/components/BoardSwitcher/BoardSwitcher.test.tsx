import type { Board, Branch, Session } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeBranch } from '../BranchModal/testUtils';
import { BoardSwitcher } from './BoardSwitcher';

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    board_id: 'board-1',
    name: 'Board One',
    archived: false,
    ...overrides,
  } as unknown as Board;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'session-1',
    branch_id: 'br-1',
    archived: false,
    ready_for_prompt: false,
    ...overrides,
  } as unknown as Session;
}

function renderSwitcher(
  boards: Board[],
  branches: Branch[],
  currentBoardId?: string,
  sessions: Session[] = []
) {
  const branchById = new Map(branches.map((b) => [b.branch_id, b]));
  const sessionById = new Map(sessions.map((s) => [s.session_id, s]));
  return render(
    <BoardSwitcher
      boards={boards}
      currentBoardId={currentBoardId}
      onBoardChange={() => {}}
      branchById={branchById}
      sessionById={sessionById}
    />
  );
}

function openDropdown() {
  // The closed trigger shows the current board (or Home) name.
  fireEvent.click(screen.getByRole('button'));
}

describe('BoardSwitcher attention indicators', () => {
  it('shows an attention badge on boards with branches needing attention', () => {
    const boards = [
      makeBoard({ board_id: 'board-1', name: 'Alpha' }),
      makeBoard({ board_id: 'board-2', name: 'Beta' }),
    ];
    const branches = [
      makeBranch({
        branch_id: 'br-1',
        board_id: 'board-1',
        needs_attention: true,
      } as Partial<Branch>),
      makeBranch({
        branch_id: 'br-2',
        board_id: 'board-1',
        needs_attention: true,
      } as Partial<Branch>),
      makeBranch({
        branch_id: 'br-3',
        board_id: 'board-2',
        needs_attention: false,
      } as Partial<Branch>),
    ];

    renderSwitcher(boards, branches, 'board-2');
    openDropdown();

    expect(screen.getByTitle('2 branches need attention')).toBeInTheDocument();
    expect(screen.queryByTitle(/branch needs attention/)).not.toBeInTheDocument();
    // Branch-count badges also carry explicit hover text.
    expect(screen.getByTitle('2 branches on this board')).toBeInTheDocument();
    expect(screen.getByTitle('1 branch on this board')).toBeInTheDocument();
  });

  it('counts branches whose active sessions are ready for prompt', () => {
    const boards = [makeBoard({ board_id: 'board-1', name: 'Alpha' })];
    const branches = [
      makeBranch({
        branch_id: 'br-1',
        board_id: 'board-1',
        needs_attention: false,
      } as Partial<Branch>),
    ];
    const sessions = [
      makeSession({ session_id: 's-1', branch_id: 'br-1', ready_for_prompt: true }),
    ];

    renderSwitcher(boards, branches, 'board-1', sessions);
    openDropdown();

    expect(screen.getByTitle('1 branch needs attention')).toBeInTheDocument();
  });

  it('ignores archived sessions and archived branches', () => {
    const boards = [makeBoard({ board_id: 'board-1', name: 'Alpha' })];
    const branches = [
      makeBranch({
        branch_id: 'br-1',
        board_id: 'board-1',
        needs_attention: false,
      } as Partial<Branch>),
      makeBranch({
        branch_id: 'br-2',
        board_id: 'board-1',
        needs_attention: true,
        archived: true,
      } as Partial<Branch>),
    ];
    const sessions = [
      makeSession({
        session_id: 's-1',
        branch_id: 'br-1',
        ready_for_prompt: true,
        archived: true,
      }),
    ];

    renderSwitcher(boards, branches, 'board-1', sessions);
    openDropdown();

    expect(screen.queryByTitle(/attention/)).not.toBeInTheDocument();
  });

  it('shows a dot on the trigger only when a non-current board needs attention', () => {
    const boards = [
      makeBoard({ board_id: 'board-1', name: 'Alpha' }),
      makeBoard({ board_id: 'board-2', name: 'Beta' }),
    ];
    const branches = [
      makeBranch({
        branch_id: 'br-1',
        board_id: 'board-2',
        needs_attention: true,
      } as Partial<Branch>),
    ];

    const { unmount } = renderSwitcher(boards, branches, 'board-1');
    expect(screen.getByTitle('Another board has branches needing attention')).toBeInTheDocument();
    unmount();

    // Same attention state, but viewing the board that owns it — no dot.
    renderSwitcher(boards, branches, 'board-2');
    expect(
      screen.queryByTitle('Another board has branches needing attention')
    ).not.toBeInTheDocument();
  });

  it('renders no attention indicators when nothing needs attention', () => {
    const boards = [makeBoard({ board_id: 'board-1', name: 'Alpha' })];
    const branches = [
      makeBranch({
        branch_id: 'br-1',
        board_id: 'board-1',
        needs_attention: false,
      } as Partial<Branch>),
    ];

    renderSwitcher(boards, branches, 'board-1');
    openDropdown();

    expect(screen.queryByTitle(/attention/)).not.toBeInTheDocument();
  });
});
