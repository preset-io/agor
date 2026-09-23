import type { Board, Branch, Session, User } from '@agor-live/client';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { HomeActivitySection } from './HomeActivitySection';
import { HomeBoardsSection } from './HomeBoardsSection';
import { HomeNeedsYouSection } from './HomeNeedsYouSection';
import { HomePage } from './HomePage';
import { HomeSessionsSection } from './HomeSessionsSection';
import { HomeStatsBar } from './HomeStatsBar';

const USER_ID = 'u-1';

const makeSession = (id: string, minutesAgo: number, extra?: Partial<Session>) =>
  ({
    session_id: id,
    title: `Session ${id}`,
    status: 'completed',
    archived: false,
    genealogy: { children: [] },
    agentic_tool: 'claude-code',
    created_by: USER_ID,
    branch_id: 'br-1',
    created_at: new Date(Date.now() - (minutesAgo + 60) * 60_000).toISOString(),
    last_updated: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    ...extra,
  }) as unknown as Session;

const makeBoard = (id: string, name: string) =>
  ({
    board_id: id,
    name,
    slug: id,
    archived: false,
    last_updated: '2026-06-01T00:00:00.000Z',
  }) as unknown as Board;

const branch = {
  branch_id: 'br-1',
  board_id: 'b-1',
  name: 'feature-branch',
  archived: false,
  created_by: USER_ID,
  created_at: '2026-06-01T00:00:00.000Z',
} as unknown as Branch;

const user = { user_id: USER_ID, name: 'Tester', email: 't@example.com' } as unknown as User;

const sessionMap = (sessions: Session[]) => new Map(sessions.map((s) => [s.session_id, s]));

beforeEach(() => {
  localStorage.clear();
  agorStore.setState({ ...EMPTY_MAPS });
});

describe('HomeSessionsSection', () => {
  it('previews the latest sessions and expands to the full, searchable list', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => makeSession(`s-${i}`, i));
    agorStore.setState({ sessionById: sessionMap(sessions) });
    const onSessionClick = vi.fn();

    render(<HomeSessionsSection currentUserId={USER_ID} onSessionClick={onSessionClick} />);

    const rows = () => screen.getAllByRole('button', { name: /^Open session/ });
    expect(rows()).toHaveLength(8);
    expect(screen.queryByPlaceholderText('Filter sessions...')).toBeNull();

    const toggle = screen.getByRole('button', { name: 'View all' });
    toggle.focus();
    fireEvent.click(toggle);
    expect(rows()).toHaveLength(10);
    // The same link becomes "Show less", so keyboard focus survives the toggle.
    expect(document.activeElement?.textContent).toBe('Show less');

    fireEvent.change(screen.getByPlaceholderText('Filter sessions...'), {
      target: { value: 's-7' },
    });
    expect(rows()).toHaveLength(1);

    fireEvent.click(rows()[0]);
    expect(onSessionClick).toHaveBeenCalledWith('s-7');
  });

  it('previews in the saved sort order', () => {
    localStorage.setItem('agor:session-sort', JSON.stringify('oldest'));
    const sessions = Array.from({ length: 10 }, (_, i) => makeSession(`s-${i}`, i));
    agorStore.setState({ sessionById: sessionMap(sessions) });

    render(<HomeSessionsSection currentUserId={USER_ID} onSessionClick={vi.fn()} />);

    const first = screen.getAllByRole('button', { name: /^Open session/ })[0];
    expect(first.getAttribute('aria-label')).toContain('Session s-9');
  });

  it('lists only the current user’s unarchived sessions', () => {
    agorStore.setState({
      sessionById: sessionMap([
        makeSession('mine', 1),
        makeSession('archived', 2, { archived: true }),
        makeSession('theirs', 3, { created_by: 'u-2' }),
      ]),
    });

    render(<HomeSessionsSection currentUserId={USER_ID} onSessionClick={vi.fn()} />);

    const rows = screen.getAllByRole('button', { name: /^Open session/ });
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('aria-label')).toContain('Session mine');
  });
});

describe('HomeNeedsYouSection', () => {
  it('renders nothing when no session is waiting', () => {
    agorStore.setState({ sessionById: sessionMap([makeSession('s-1', 1)]) });
    const { container } = render(
      <HomeNeedsYouSection currentUserId={USER_ID} onSessionClick={vi.fn()} />
    );
    expect(container.textContent).toBe('');
  });

  it('lists waiting sessions with their state, capped with a remainder count', () => {
    const waiting = Array.from({ length: 7 }, (_, i) =>
      makeSession(`w-${i}`, i, { status: 'awaiting_input' } as Partial<Session>)
    );
    agorStore.setState({ sessionById: sessionMap([...waiting, makeSession('idle', 1)]) });
    const onSessionClick = vi.fn();

    render(<HomeNeedsYouSection currentUserId={USER_ID} onSessionClick={onSessionClick} />);

    const section = screen.getByRole('region', { name: 'Needs you' });
    const rows = within(section).getAllByRole('button', { name: /^Open session/ });
    expect(rows).toHaveLength(5);
    expect(within(section).getAllByText('Awaiting input')).toHaveLength(5);
    expect(within(section).getByText('and 2 more')).toBeTruthy();

    fireEvent.click(rows[0]);
    expect(onSessionClick).toHaveBeenCalledWith(expect.stringMatching(/^w-/));
  });
});

describe('HomeBoardsSection', () => {
  it('shows the first boards as tiles and reveals the rest with View all', () => {
    const boards = Array.from({ length: 10 }, (_, i) => makeBoard(`b-${i}`, `Board ${i}`));
    agorStore.setState({ boardById: new Map(boards.map((b) => [b.board_id, b])) });
    const onBoardClick = vi.fn();
    const onOpenCreateDialog = vi.fn();

    render(
      <HomeBoardsSection onBoardClick={onBoardClick} onOpenCreateDialog={onOpenCreateDialog} />
    );

    const tiles = () => screen.getAllByRole('button', { name: /^Open board/ });
    expect(tiles()).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'View all 10' }));
    expect(tiles()).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(tiles()).toHaveLength(8);

    fireEvent.click(tiles()[0]);
    expect(onBoardClick).toHaveBeenCalledWith(expect.stringMatching(/^b-/));

    fireEvent.click(screen.getByRole('button', { name: /New board/ }));
    expect(onOpenCreateDialog).toHaveBeenCalledWith('board');
  });

  it('offers to create the first board when there are none', () => {
    const onOpenCreateDialog = vi.fn();
    render(<HomeBoardsSection onBoardClick={vi.fn()} onOpenCreateDialog={onOpenCreateDialog} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create your first board' }));
    expect(onOpenCreateDialog).toHaveBeenCalledWith('board');
  });
});

describe('HomeActivitySection', () => {
  it('keeps every activity link: session, branch and board', () => {
    const board = makeBoard('b-1', 'Alpha');
    agorStore.setState({
      boardById: new Map([[board.board_id, board]]),
      branchById: new Map([[branch.branch_id, branch]]),
      sessionById: sessionMap([makeSession('s-1', 1)]),
      userById: new Map([[USER_ID, user]]),
    });
    const onSessionClick = vi.fn();
    const onBranchClick = vi.fn();
    const onBoardClick = vi.fn();

    render(
      <HomeActivitySection
        onSessionClick={onSessionClick}
        onBranchClick={onBranchClick}
        onBoardClick={onBoardClick}
      />
    );

    const sessionRow = screen.getByRole('button', { name: /^Open session Session s-1/ });
    fireEvent.click(sessionRow);
    expect(onSessionClick).toHaveBeenCalledWith('s-1');

    // Branch and board links appear beside the row on hover.
    fireEvent.mouseEnter(sessionRow.parentElement as HTMLElement);
    const sessionRowLinks = within(sessionRow.parentElement as HTMLElement);
    fireEvent.click(sessionRowLinks.getByRole('button', { name: 'Open branch feature-branch' }));
    expect(onBranchClick).toHaveBeenCalledWith('br-1');
    fireEvent.click(sessionRowLinks.getByRole('button', { name: 'Open board Alpha' }));
    expect(onBoardClick).toHaveBeenCalledWith('b-1');

    // The branch-created event opens its branch, and links to its board.
    const branchRow = screen.getByRole('button', { name: /^Open branch feature-branch;/ });
    fireEvent.click(branchRow);
    expect(onBranchClick).toHaveBeenLastCalledWith('br-1');
    onBoardClick.mockClear();
    const branchRowLinks = within(branchRow.parentElement as HTMLElement);
    fireEvent.click(branchRowLinks.getByRole('button', { name: 'Open board Alpha' }));
    expect(onBoardClick).toHaveBeenCalledWith('b-1');
  });

  it('keeps row links in the accessibility tree and reveals them on keyboard focus', () => {
    const board = makeBoard('b-1', 'Alpha');
    agorStore.setState({
      boardById: new Map([[board.board_id, board]]),
      sessionById: sessionMap([makeSession('s-1', 1)]),
      branchById: new Map([[branch.branch_id, branch]]),
    });

    render(
      <HomeActivitySection
        onSessionClick={vi.fn()}
        onBranchClick={vi.fn()}
        onBoardClick={vi.fn()}
      />
    );

    const sessionRow = screen.getByRole('button', { name: /^Open session Session s-1/ });
    const rowLinks = within(sessionRow.parentElement as HTMLElement);
    const branchLink = rowLinks.getByRole('button', { name: 'Open branch feature-branch' });
    // Mounted for screen readers, visually hidden until the row is hovered or focused.
    expect((branchLink.parentElement as HTMLElement).style.position).toBe('absolute');

    act(() => {
      sessionRow.focus();
    });
    expect((branchLink.parentElement as HTMLElement).style.position).toBe('');
  });

  it('previews the latest events and expands with Show more', () => {
    agorStore.setState({
      sessionById: sessionMap(Array.from({ length: 9 }, (_, i) => makeSession(`s-${i}`, i))),
    });

    render(
      <HomeActivitySection
        onSessionClick={vi.fn()}
        onBranchClick={vi.fn()}
        onBoardClick={vi.fn()}
      />
    );

    const rows = () => screen.getAllByRole('button', { name: /^Open session/ });
    expect(rows()).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(rows()).toHaveLength(9);
  });
});

describe('HomeStatsBar', () => {
  it('summarizes the workspace in one line', () => {
    agorStore.setState({
      sessionById: sessionMap([
        makeSession('s-1', 1, { status: 'running' } as Partial<Session>),
        makeSession('s-2', 2),
      ]),
    });

    render(<HomeStatsBar currentUserId={USER_ID} />);

    expect(screen.getByText('1 running now')).toBeTruthy();
    expect(screen.getByText('2 sessions active this week')).toBeTruthy();
    expect(screen.getByText('1 teammate active this week')).toBeTruthy();
  });
});

describe('HomePage onboarding', () => {
  it('opens the teammate flow from "Launch an AI session" with the default type', () => {
    const board = makeBoard('b-1', 'Alpha');
    agorStore.setState({ boardById: new Map([[board.board_id, board]]) });
    const onOpenCreateDialog = vi.fn();

    render(
      <MemoryRouter>
        <HomePage
          client={null}
          currentUserId={USER_ID}
          onBoardClick={vi.fn()}
          onBranchClick={vi.fn()}
          onSessionClick={vi.fn()}
          onOpenCreateDialog={onOpenCreateDialog}
          onOpenSettings={vi.fn()}
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start →' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('New AI teammate')).toBeTruthy();

    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start AI teammate' }));
    });
    // Before the fix the click event leaked in as the create type.
    expect(onOpenCreateDialog).toHaveBeenCalledWith('teammate', 'b-1');
  });
});
