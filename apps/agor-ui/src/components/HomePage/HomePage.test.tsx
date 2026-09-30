import type { AgorClient, Board, BoardComment, Branch, Session, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { Profiler, useLayoutEffect, useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { buildSessionMaps, EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import {
  OPEN_BOARD_SWITCHER_EVENT,
  OPEN_GLOBAL_SEARCH_EVENT,
  onShellPicker,
} from '../../utils/shellEvents';
import { HomePage, type HomePageProps } from './HomePage';

/** Renders the current route state, so a test can see Home clear it. */
function RouteStateProbe() {
  const { state } = useLocation();
  return <output aria-label="route state">{JSON.stringify(state)}</output>;
}

// HomePage's body is the only caller; counting it counts HomePage renders.
// Its effect counts HomePage mounts.
const homeRenders = vi.hoisted(() => ({ count: 0, mounts: 0 }));
vi.mock('../../hooks/useIdleReady', async () => {
  const { useEffect } = await import('react');
  return {
    useIdleReady: () => {
      homeRenders.count += 1;
      useEffect(() => {
        homeRenders.mounts += 1;
      }, []);
      return true;
    },
  };
});

// Counts title reads per session: every session row render reads its title once.
const titleReads = vi.hoisted(() => new Map<string, number>());
vi.mock('../../utils/sessionTitle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/sessionTitle')>();
  return {
    ...actual,
    getSessionDisplayTitle: (...args: Parameters<typeof actual.getSessionDisplayTitle>) => {
      const id = args[0].session_id;
      titleReads.set(id, (titleReads.get(id) ?? 0) + 1);
      return actual.getSessionDisplayTitle(...args);
    },
  };
});

/** Wide viewport: every media query matches, so Home renders at desktop density. */
const asDesktop = () =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }) as unknown as MediaQueryList
  );

const ME = 'user-me';
const user = {
  user_id: ME,
  name: 'Kasia Designer',
  email: 'k@example.test',
  role: 'member',
} as User;
const recent = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const session = (id: string, extra: Partial<Session> = {}) =>
  ({
    session_id: id,
    title: `Session ${id}`,
    status: 'idle',
    archived: false,
    created_by: ME,
    branch_id: 'branch-1',
    genealogy: { children: [] },
    scheduled_from_branch: false,
    ready_for_prompt: false,
    agentic_tool: 'claude-code',
    last_updated: recent(5),
    ...extra,
  }) as unknown as Session;

const comment = (id: string, extra: Partial<BoardComment> = {}) =>
  ({
    comment_id: id,
    board_id: 'board-1',
    created_by: 'someone',
    content: '@"Kasia Designer" can you look?',
    resolved: false,
    created_at: recent(2),
    ...extra,
  }) as unknown as BoardComment;

const teammate = (id: string, boardId: string) =>
  ({
    branch_id: id,
    name: id,
    board_id: boardId,
    created_by: 'owner-1',
    archived: false,
    custom_context: { teammate: { kind: 'teammate', displayName: `Teammate ${id}` } },
  }) as unknown as Branch;

function seed({
  sessions = [],
  comments = [],
  branches = [],
  boards = [],
  hydrated = true,
}: {
  sessions?: Session[];
  comments?: BoardComment[];
  branches?: Branch[];
  boards?: Board[];
  hydrated?: boolean;
}) {
  agorStore.setState({
    ...EMPTY_MAPS,
    ...buildSessionMaps(sessions),
    commentById: new Map(comments.map((c) => [c.comment_id, c])),
    branchById: new Map(branches.map((b) => [b.branch_id, b])),
    boardById: new Map(boards.map((b) => [b.board_id, b])),
    userById: new Map([[ME, user]]),
    sessionsHydrated: hydrated,
    branchesHydrated: hydrated,
  } as never);
}

const stableProps: HomePageProps = {
  client: null,
  currentUser: user,
  onBoardClick: () => {},
  onBranchClick: () => {},
  onSessionClick: () => {},
  onCreateSession: async () => null,
};

function wrap(node: React.ReactNode, route: string | object = '/', connected = true) {
  return (
    <ConnectionProvider
      value={{
        connected,
        connecting: false,
        authGeneration: 1,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      <AntApp>
        <MemoryRouter initialEntries={[route as string]}>
          {node}
          <RouteStateProbe />
        </MemoryRouter>
      </AntApp>
    </ConnectionProvider>
  );
}

function renderHome(
  props: Partial<HomePageProps> = {},
  onRender = () => {},
  route?: object,
  connected = true
) {
  return render(
    wrap(
      <Profiler id="home" onRender={onRender}>
        <HomePage {...stableProps} {...props} />
      </Profiler>,
      route,
      connected
    )
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  homeRenders.count = 0;
  homeRenders.mounts = 0;
  agorStore.getState().reset();
  vi.restoreAllMocks();
});

describe('HomePage', () => {
  it('shows rows before hydration but never “all caught up” or counts', () => {
    seed({ sessions: [session('idle')], hydrated: false });
    renderHome();
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeInTheDocument();
    expect(screen.queryByText(/caught up/i)).not.toBeInTheDocument();
    expect(screen.getByText('Session idle')).toBeInTheDocument();

    act(() => agorStore.setState({ sessionsHydrated: true, branchesHydrated: true }));
    expect(screen.getByText('You’re all caught up.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /All caught up/ })).toBeInTheDocument();
  });

  it('hides Needs you and the status line for new users', () => {
    seed({});
    renderHome();
    expect(screen.queryByRole('heading', { name: 'Needs you' })).not.toBeInTheDocument();
    expect(screen.queryByText(/caught up/i)).not.toBeInTheDocument();
  });

  it('greets the user with what needs them and what is running', () => {
    seed({
      sessions: [
        session('perm', { status: 'awaiting_permission' }),
        session('run', { status: 'running' }),
      ],
      comments: [comment('c1')],
    });
    renderHome();
    expect(
      screen.getByRole('heading', { name: /^Good (morning|afternoon|evening), Kasia$/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 need you' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 running' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'All' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Session perm, Waiting for your permission' })
    ).toBeInTheDocument();
  });

  it('shows three needs, expands in place and focuses the first new row', async () => {
    seed({
      sessions: Array.from({ length: 5 }, (_, i) =>
        session(`p${i}`, { status: 'awaiting_permission', last_updated: recent(i + 1) })
      ),
    });
    renderHome();
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(needs.querySelectorAll('[data-home-row]')).toHaveLength(3);
    const toggle = within(needs).getByRole('button', { name: '2 more · 2 permission requests' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(needs.querySelectorAll('[data-home-row]')).toHaveLength(5));
    await waitFor(() =>
      expect(document.activeElement).toBe(needs.querySelectorAll('[data-home-row]')[3])
    );
    expect(within(needs).getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('says what the collapsed rows are, in Needs you order, for the current filter', () => {
    seed({
      sessions: [
        session('p1', { status: 'awaiting_permission' }),
        session('p2', { status: 'awaiting_permission' }),
        session('f1', { status: 'failed', branch_id: 'b-f' }),
        session('d1', { ready_for_prompt: true, branch_id: 'b-d1' }),
        session('d2', { ready_for_prompt: true, branch_id: 'b-d2' }),
      ],
      comments: Array.from({ length: 5 }, (_, i) => comment(`c${i}`)),
    });
    renderHome();
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(
      within(needs).getByRole('button', { name: '7 more · 4 comments, 1 failed, 2 finished' })
    ).toBeInTheDocument();
    fireEvent.click(within(needs).getByRole('radio', { name: 'Comments 5' }));
    expect(within(needs).getByRole('button', { name: '2 more · 2 comments' })).toBeInTheDocument();
  });

  it('offers starter chips to new users only', () => {
    seed({});
    const { unmount } = renderHome();
    expect(screen.getByRole('button', { name: 'What can you do?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up a board' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use Slack' })).toBeInTheDocument();
    unmount();

    seed({ sessions: [session('a')] });
    renderHome();
    for (const name of ['What can you do?', 'Find my work']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('marks only finished sessions the user started as read, from the row menu on phones', async () => {
    const patch = vi.fn(() => Promise.resolve());
    const client = {
      service: () => ({
        patch,
        find: async () => [],
        get: () => new Promise(() => {}),
        getPrimaryTeammate: async () => null,
      }),
    } as unknown as AgorClient;
    seed({
      sessions: [
        session('done', { ready_for_prompt: true }),
        session('perm', { status: 'awaiting_permission' }),
      ],
    });
    renderHome({ client });
    const menus = screen.getAllByRole('button', { name: 'More actions' });
    expect(menus).toHaveLength(1);
    fireEvent.click(menus[0]);
    fireEvent.click(await screen.findByText('Mark as read'));
    expect(patch).toHaveBeenCalledWith('done', { ready_for_prompt: false });
  });

  it('says what a permission request asks for, from the latest task', async () => {
    const task = {
      permission_request: { tool_name: 'Bash', tool_input: { command: 'git push origin qa' } },
    };
    const client = {
      service: () => ({
        get: async () => task,
        find: async () => [],
        getPrimaryTeammate: async () => null,
      }),
    } as unknown as AgorClient;
    seed({
      sessions: [session('perm', { status: 'awaiting_permission', tasks: ['t1'] } as never)],
    });
    renderHome({ client });
    expect(await screen.findByText(/Wants to run git push origin qa/)).toBeInTheDocument();
    expect(screen.getByText(/^waiting /)).toBeInTheDocument();
  });

  it('lands on the comments filter from route state (the phone bell), then clears it', async () => {
    seed({
      sessions: [session('perm', { status: 'awaiting_permission' })],
      comments: [comment('c1')],
    });
    renderHome({}, undefined, { pathname: '/', state: { needsFilter: 'comments' } });
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(within(needs).getAllByRole('button', { name: /mentioned you/ })).toHaveLength(1);
    expect(within(needs).queryByRole('button', { name: /Session perm/ })).not.toBeInTheDocument();
    // Back to this entry must not apply the filter again.
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'route state' })).toHaveTextContent('null')
    );
  });

  it('stays on All when the bell lands with no comments for you', async () => {
    seed({ sessions: [session('perm', { status: 'awaiting_permission' })] });
    renderHome({}, undefined, { pathname: '/', state: { needsFilter: 'comments' } });
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(
      within(needs).getByRole('button', { name: 'Session perm, Waiting for your permission' })
    ).toBeInTheDocument();
    expect(screen.queryByText('You’re all caught up.')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'route state' })).toHaveTextContent('null')
    );
  });

  it('hides the ask box for people who cannot start sessions', async () => {
    seed({
      sessions: [session('idle')],
      branches: [teammate('t', 'b')],
      boards: [{ board_id: 'b', name: 'B', archived: false } as Board],
    });
    renderHome({ onCreateSession: undefined });
    await screen.findByText('Teammate t');
    expect(screen.queryByRole('textbox', { name: /Ask/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Teammate t, open B' })).toBeInTheDocument();
  });

  it('mounts once on desktop, so its effects fire once', async () => {
    asDesktop();
    seed({ sessions: [session('idle')] });
    renderHome();
    await screen.findByText('Session idle');
    expect(homeRenders.mounts).toBe(1);
  });

  it('keeps quiet counters: no “0 running”, no “more in Needs you” row', () => {
    seed({ sessions: [session('done', { ready_for_prompt: true }), session('idle')] });
    renderHome();
    expect(screen.getByRole('button', { name: '1 need you' })).toBeInTheDocument();
    expect(screen.queryByText(/running/)).not.toBeInTheDocument();
    expect(screen.queryByText(/more in Needs you/)).not.toBeInTheDocument();
  });

  it('groups finished results per branch behind the latest, and marks them all as read', async () => {
    asDesktop();
    const patch = vi.fn(() => Promise.resolve());
    const client = {
      service: () => ({ patch, find: async () => [], getPrimaryTeammate: async () => null }),
    } as unknown as AgorClient;
    seed({
      sessions: [1, 2, 3].map((i) =>
        session(`r${i}`, { ready_for_prompt: true, last_updated: recent(i) })
      ),
      branches: [{ branch_id: 'branch-1', name: 'nightly' } as Branch],
    });
    renderHome({ client });
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(within(needs).getByText('3 finished on nightly')).toBeInTheDocument();
    fireEvent.click(within(needs).getByRole('button', { name: 'Show 3' }));
    expect(within(needs).getByText('Session r3')).toBeInTheDocument();
    expect(within(needs).getByText('Session r1')).toBeInTheDocument();
    fireEvent.click(within(needs).getByRole('button', { name: 'Mark all as read' }));
    expect(patch.mock.calls.map(([id]) => id).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('puts row actions in the ⋯ menu on phones, so times stay in one column', async () => {
    seed({
      sessions: [1, 2].map((i) =>
        session(`r${i}`, { ready_for_prompt: true, last_updated: recent(i) })
      ),
      branches: [{ branch_id: 'branch-1', name: 'nightly' } as Branch],
    });
    renderHome();
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(within(needs).queryByRole('button', { name: 'Show 2' })).not.toBeInTheDocument();
    fireEvent.click(within(needs).getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByText('Show all 2'));
    expect(within(needs).getByText('Session r1')).toBeInTheDocument();
  });

  it('lists 20 sessions in My work, then more on request', () => {
    seed({
      sessions: Array.from({ length: 25 }, (_, i) => session(`w${i}`, { last_updated: recent(i) })),
    });
    renderHome();
    const work = screen.getByRole('region', { name: 'My work' });
    expect(work.querySelectorAll('[data-home-row]')).toHaveLength(20);
    const more = within(work).getByRole('button', { name: 'Show 5 more' });
    expect(more).not.toHaveAttribute('aria-expanded');
    fireEvent.click(more);
    expect(work.querySelectorAll('[data-home-row]')).toHaveLength(25);
    expect(within(work).queryByRole('button', { name: /more$/ })).not.toBeInTheDocument();
  });

  it('skips the branch line when it repeats the board, and the agent logo when all agree', () => {
    seed({
      sessions: [
        session('a', { branch_id: 'rexy', branch_board_id: 'b-rexy' } as Partial<Session>),
        session('b', { branch_id: 'rexy', branch_board_id: 'b-rexy' } as Partial<Session>),
      ],
      branches: [teammate('rexy', 'b-rexy')],
      boards: [{ board_id: 'b-rexy', name: 'Teammate Rexy!', archived: false } as Board],
    });
    renderHome({ currentUser: { ...user, preferences: { homeWorkView: 'board' } } as User });
    const work = screen.getByRole('region', { name: 'My work' });
    expect(within(work).getAllByText(/Teammate rexy/i)).toHaveLength(1);
    expect(within(work).queryAllByAltText(/logo$/)).toHaveLength(0);
  });

  it('on phones keeps the toolbar to one row and puts View in the Filters sheet', async () => {
    seed({ sessions: [session('idle')] });
    renderHome();
    const toolbar = document.querySelector<HTMLElement>('[data-home-toolbar]') as HTMLElement;
    expect(within(toolbar).getByRole('textbox', { name: 'Filter sessions' })).toBeTruthy();
    expect(within(toolbar).queryByRole('combobox', { name: 'View' })).not.toBeInTheDocument();
    expect(within(toolbar).queryByText('1')).not.toBeInTheDocument();
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Filters' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(sheet).getByRole('combobox', { name: 'View' })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Only sessions I started' }));
    expect(within(toolbar).getByText('1')).toBeInTheDocument();
  });

  it('keeps “Only sessions I started” per user', async () => {
    seed({ sessions: [session('idle')] });
    const { unmount } = renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Only sessions I started' }));
    unmount();

    renderHome({ currentUser: { ...user, user_id: 'someone-else' } as User });
    const toolbar = document.querySelector<HTMLElement>('[data-home-toolbar]') as HTMLElement;
    expect(within(toolbar).queryByText('1')).not.toBeInTheDocument();
  });

  it('shows View in the toolbar, defaults to List, and counts only filters', () => {
    asDesktop();
    seed({
      sessions: [session('a', { branch_board_id: 'b-a' } as Partial<Session>)],
      boards: [{ board_id: 'b-a', name: 'Launch board', archived: false } as Board],
    });
    renderHome();
    const toolbar = document.querySelector<HTMLElement>('[data-home-toolbar]') as HTMLElement;
    const view = within(toolbar).getByRole('combobox', { name: 'View' });
    expect(view.closest('.ant-select')).toHaveTextContent('List');
    expect(within(toolbar).queryByText('1')).not.toBeInTheDocument();
    const work = screen.getByRole('region', { name: 'My work' });
    expect(
      within(work).queryByRole('button', { name: 'Open Launch board' })
    ).not.toBeInTheDocument();
  });

  it('saves the view to the user preferences and reads it back per user', async () => {
    asDesktop();
    seed({
      sessions: [session('a', { branch_board_id: 'b-a' } as Partial<Session>)],
      boards: [{ board_id: 'b-a', name: 'Launch board', archived: false } as Board],
    });
    const patch = vi.fn(async () => ({}));
    const client = {
      service: (name: string) =>
        name === 'users'
          ? { get: async () => ({ ...user, preferences: { audio: { enabled: true } } }), patch }
          : { find: async () => [], on: () => {}, off: () => {}, removeListener: () => {} },
    } as unknown as AgorClient;
    const { unmount } = renderHome({ client });
    const work = screen.getByRole('region', { name: 'My work' });
    fireEvent.mouseDown(within(work).getByRole('combobox', { name: 'View' }));
    fireEvent.click(await screen.findByTitle('By board'));
    expect(within(work).getByRole('button', { name: 'Open Launch board' })).toBeInTheDocument();
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(ME, {
        preferences: { audio: { enabled: true }, homeWorkView: 'board' },
      })
    );
    unmount();

    renderHome({ currentUser: { ...user, preferences: { homeWorkView: 'board' } } as User });
    expect(screen.getByRole('button', { name: 'Open Launch board' })).toBeInTheDocument();
  });

  it('falls back to the boards of the latest sessions when there is no visit history', () => {
    seed({
      sessions: [session('a', { branch_board_id: 'b-a' } as Partial<Session>)],
      boards: [{ board_id: 'b-a', name: 'Launch board', archived: false } as Board],
    });
    renderHome();
    const recentBoards = screen.getByRole('group', { name: 'Recent boards' });
    expect(within(recentBoards).getByRole('button', { name: 'Launch board' })).toBeInTheDocument();
  });

  it('falls back too when every visited board is gone or archived', () => {
    seed({
      sessions: [session('a', { branch_board_id: 'b-a' } as Partial<Session>)],
      boards: [
        { board_id: 'b-a', name: 'Launch board', archived: false } as Board,
        { board_id: 'b-old', name: 'Old board', archived: true } as Board,
      ],
    });
    renderHome({ recentBoardIds: ['b-deleted', 'b-old'] });
    const recentBoards = screen.getByRole('group', { name: 'Recent boards' });
    expect(within(recentBoards).getByRole('button', { name: 'Launch board' })).toBeInTheDocument();
    expect(
      within(recentBoards).queryByRole('button', { name: 'Old board' })
    ).not.toBeInTheDocument();
  });

  it('always offers All boards, even with no boards to show', () => {
    seed({});
    renderHome();
    const recentBoards = screen.getByRole('group', { name: 'Recent boards' });
    expect(
      within(recentBoards)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['All boards']);
  });

  it('counts only filtered running sessions, and says when a filter hides them all', async () => {
    seed({
      sessions: Array.from({ length: 25 }, (_, i) =>
        session(`r${i}`, {
          status: 'running',
          title: i < 3 ? `alpha ${i}` : `beta ${i}`,
          last_updated: recent(i),
        })
      ),
    });
    renderHome();
    const work = screen.getByRole('region', { name: 'My work' });
    fireEvent.click(within(work).getByRole('radio', { name: 'Running 25' }));
    expect(within(work).getByRole('button', { name: 'Show 5 more' })).toBeInTheDocument();

    const filter = within(work).getByRole('textbox', { name: 'Filter sessions' });
    fireEvent.change(filter, { target: { value: 'alpha' } });
    await waitFor(() => expect(work.querySelectorAll('[data-home-row]')).toHaveLength(3));
    expect(within(work).queryByRole('button', { name: /more$/ })).not.toBeInTheDocument();

    fireEvent.change(filter, { target: { value: 'gamma' } });
    expect(await within(work).findByText(/No running sessions match “gamma”/)).toBeInTheDocument();
    fireEvent.click(within(work).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(work.querySelectorAll('[data-home-row]')).toHaveLength(20));
  });

  it('marks all as read a few at a time, with one summary error, and not while offline', async () => {
    asDesktop();
    let inFlight = 0;
    let peak = 0;
    const patch = vi.fn(async (id: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      if (id === 'd1' || id === 'd2') throw new Error('forbidden');
    });
    const client = {
      service: () => ({ patch, find: async () => [], getPrimaryTeammate: async () => null }),
    } as unknown as AgorClient;
    const sessions = Array.from({ length: 8 }, (_, i) =>
      session(`d${i}`, { ready_for_prompt: true, branch_id: `b-${i}` })
    );
    seed({ sessions });
    const { unmount } = renderHome({ client }, undefined, undefined, false);
    // A text query: jsdom cannot compute styles for AntD's disabled link buttons.
    expect(screen.getByText('Mark all as read').closest('button')).toBeDisabled();
    unmount();

    seed({ sessions });
    renderHome({ client });
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    expect(await screen.findByText('Couldn’t mark 2 of 8 as read')).toBeInTheDocument();
    expect(patch).toHaveBeenCalledTimes(8);
    expect(peak).toBeLessThanOrEqual(4);
    expect(screen.getAllByText(/Couldn’t mark/)).toHaveLength(1);
  });

  it('does not send twice while a send is in flight', async () => {
    let finish!: (result: { sessionId: string }) => void;
    const onCreateSession = vi.fn(
      () => new Promise<{ sessionId: string }>((resolve) => (finish = resolve))
    );
    const primary = teammate('primary', 'b-primary');
    seed({ sessions: [session('idle')], branches: [primary] });
    const client = {
      service: () => ({ getPrimaryTeammate: async () => primary, find: async () => [] }),
    } as unknown as AgorClient;
    renderHome({ client, onCreateSession });
    const input = await screen.findByRole('textbox', { name: 'Ask Teammate primary' });
    fireEvent.change(input, { target: { value: 'Once please' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCreateSession).toHaveBeenCalledTimes(1);
    await act(async () => finish({ sessionId: 'new' }));
  });

  it('asks the header for search on Sessions and for the board switcher', () => {
    seed({
      sessions: [session('a', { branch_board_id: 'b-a' } as Partial<Session>)],
      boards: [{ board_id: 'b-a', name: 'Launch board', archived: false } as Board],
    });
    const search = vi.fn();
    const boards = vi.fn();
    const off = [
      onShellPicker(OPEN_GLOBAL_SEARCH_EVENT, search),
      onShellPicker(OPEN_BOARD_SWITCHER_EVENT, boards),
    ];
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'See all sessions' }));
    expect(search).toHaveBeenCalledExactlyOnceWith('session');
    const recentBoards = screen.getByRole('group', { name: 'Recent boards' });
    fireEvent.click(within(recentBoards).getByRole('button', { name: 'All boards' }));
    expect(boards).toHaveBeenCalledExactlyOnceWith(undefined);
    for (const unsubscribe of off) unsubscribe();
  });

  it('shows onboarding only before the first session, and only steps the caller can do', () => {
    seed({ boards: [{ board_id: 'b', name: 'B', archived: false } as Board] });
    const { unmount } = renderHome({ onOpenSettings: () => {} });
    expect(screen.getByText('Connect a repository')).toBeInTheDocument();
    expect(screen.queryByText('Configure MCP tools')).not.toBeInTheDocument();
    expect(screen.queryByText('Invite a teammate')).not.toBeInTheDocument();
    unmount();
    renderHome({ onOpenSettings: () => {}, currentUser: { ...user, role: 'admin' } as User });
    expect(screen.getByText('Configure MCP tools')).toBeInTheDocument();
    cleanupAndSeedSession();
  });

  it('starts from the ask box on phones, and hides the step for people who cannot start sessions', () => {
    seed({ boards: [{ board_id: 'b', name: 'B', archived: false } as Board] });
    const { unmount } = renderHome({ onOpenSettings: () => {} });
    const step = screen.getByText('Launch an AI session').parentElement as HTMLElement;
    fireEvent.click(within(step).getByRole('button', { name: 'Start' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /^Ask / }));
    unmount();

    renderHome({ onOpenSettings: () => {}, onCreateSession: undefined });
    expect(screen.getByText('Connect a repository')).toBeInTheDocument();
    expect(screen.queryByText('Launch an AI session')).not.toBeInTheDocument();
  });
});

function cleanupAndSeedSession() {
  act(() => seed({ sessions: [session('first')] }));
  expect(screen.queryByText('Connect a repository')).not.toBeInTheDocument();
}

describe('HomePage teammates', () => {
  const primary = teammate('primary', 'b-primary');
  const client = (can: Record<string, string>) =>
    ({
      service: (name: string) =>
        name === 'branches/:id/effective-access'
          ? {
              find: async ({ route }: { route: { id: string } }) => ({
                can: can[route.id] ?? 'view',
                is_owner: false,
                source: 'others',
              }),
            }
          : { getPrimaryTeammate: async () => primary, find: async () => [] },
    }) as unknown as AgorClient;
  const seedTeammates = () =>
    seed({
      sessions: [session('idle')],
      branches: [primary, teammate('t', 'b'), teammate('v', 'b-view')],
      boards: [
        { board_id: 'b-primary', name: 'Teammate primary', archived: false } as Board,
        { board_id: 'b', name: 'Board B', archived: false } as Board,
        { board_id: 'b-view', name: 'Board V', archived: false } as Board,
      ],
    });

  it('opens a teammate’s board from its card and marks view-only access', async () => {
    seedTeammates();
    const onBoardClick = vi.fn();
    renderHome({ client: client({ t: 'session' }), onBoardClick });
    expect(await screen.findAllByText(/View only · ask/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Teammate t, open Board B' }));
    expect(onBoardClick).toHaveBeenCalledWith('b');
  });

  it('opens the directory through the shell’s "See all", and hides the link without one', async () => {
    seedTeammates();
    const onSeeAllTeammates = vi.fn();
    const { unmount } = renderHome({ client: client({}), onSeeAllTeammates });
    fireEvent.click(await screen.findByRole('button', { name: 'See all 3' }));
    expect(onSeeAllTeammates).toHaveBeenCalledOnce();
    unmount();

    renderHome({ client: client({}) });
    await screen.findByText('Teammate t');
    expect(screen.queryByRole('button', { name: /^See all \d/ })).not.toBeInTheDocument();
  });

  it('asks the primary by default, sends to a teammate picked from the phone sheet, then resets', async () => {
    seedTeammates();
    const onCreateSession = vi.fn(async () => ({ sessionId: 'new' }));
    renderHome({ client: client({ t: 'session' }), onCreateSession });
    await screen.findByRole('textbox', { name: 'Ask Teammate primary' });

    fireEvent.click(screen.getByRole('button', { name: 'Teammate to ask: Teammate primary' }));
    const sheet = await screen.findByRole('dialog', { name: 'Ask' });
    await within(sheet).findByText('Teammate t');
    expect(within(sheet).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(sheet).queryByText('Teammate v')).not.toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Teammate t' }));

    const input = await screen.findByRole('textbox', { name: 'Ask Teammate t' });
    fireEvent.change(input, { target: { value: 'Status please' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send( in background)?$/ }));
    await waitFor(() => expect(onCreateSession).toHaveBeenCalled());
    expect(onCreateSession.mock.calls[0][0]).toMatchObject({ branch_id: 't' });
    expect(
      await screen.findByRole('textbox', { name: 'Ask Teammate primary' })
    ).toBeInTheDocument();
  });

  it('sends on Enter, adds a line on Shift+Enter, and opens on Ctrl+Enter', async () => {
    seedTeammates();
    const onCreateSession = vi.fn(async () => ({ sessionId: 'new' }));
    const onSessionClick = vi.fn();
    renderHome({ client: client({}), onCreateSession, onSessionClick });
    const input = await screen.findByRole('textbox', { name: 'Ask Teammate primary' });
    fireEvent.change(input, { target: { value: 'First line' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onCreateSession).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onSessionClick).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'Open this one' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onSessionClick).toHaveBeenCalledWith('new'));
  });

  it('sends from one split button on phones, with Send & open in its menu', async () => {
    seedTeammates();
    const onCreateSession = vi.fn(async () => ({ sessionId: 'new' }));
    const onSessionClick = vi.fn();
    renderHome({ client: client({}), onCreateSession, onSessionClick });
    const input = await screen.findByRole('textbox', { name: 'Ask Teammate primary' });
    const toolbar = document.querySelector<HTMLElement>('[data-home-ask-toolbar]') as HTMLElement;
    expect(within(toolbar).getByRole('button', { name: 'Send in background' })).toBeInTheDocument();
    expect(within(toolbar).queryByRole('button', { name: 'Send & open' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Open it' } });
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More send options' }));
    fireEvent.click(await screen.findByText('Send & open'));
    await waitFor(() => expect(onSessionClick).toHaveBeenCalledWith('new'));
  });

  it('puts both send buttons in the toolbar on desktop, primary last', async () => {
    asDesktop();
    seedTeammates();
    renderHome({ client: client({}) });
    await screen.findByRole('textbox', { name: 'Ask Teammate primary' });
    const toolbar = document.querySelector<HTMLElement>('[data-home-ask-toolbar]') as HTMLElement;
    const names = within(toolbar)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names.slice(-2)).toEqual(['Send & open', 'Send in background']);
  });

  it('searches on desktop, one line per teammate, with the board only when it says more', async () => {
    asDesktop();
    seedTeammates();
    renderHome({ client: client({ t: 'session' }) });
    const picker = await screen.findByRole('combobox', { name: 'Teammate to ask' });
    expect(picker).not.toHaveAttribute('readonly');
    fireEvent.mouseDown(picker);
    const popup = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.ant-select-dropdown');
      expect(found && within(found).queryByText('Teammate t')).toBeTruthy();
      return found as HTMLElement;
    });
    expect(within(popup).getByText('📋 Board B')).toBeInTheDocument();
    expect(within(popup).queryByText(/Board primary/)).not.toBeInTheDocument();
  });

  it('asks to pick an assistant when there is no primary', async () => {
    seedTeammates();
    const none = {
      service: () => ({ getPrimaryTeammate: async () => null, find: async () => [] }),
    } as unknown as AgorClient;
    renderHome({ client: none });
    expect(await screen.findByRole('button', { name: 'Pick an assistant' })).toBeInTheDocument();
  });
});

describe('HomePage privacy for superadmins', () => {
  const superadmin = { ...user, role: 'superadmin' } as User;
  const policyClient = (sharing: Record<string, 'shared' | 'private'>) =>
    ({
      service: (name: string) =>
        name === 'boards/:id/permissions'
          ? {
              find: async ({ route }: { route: { id: string } }) => ({
                primary_owner_user_id: 'owner-1',
                board_access: {
                  policy_kind: 'board_access',
                  sharing_mode: sharing[route.id],
                  entries: [],
                  others: {
                    preset: 'viewer',
                    capabilities: sharing[route.id] === 'shared' ? ['board.view'] : [],
                    fs_access: 'none',
                  },
                },
              }),
            }
          : name === 'group-memberships' || name === 'groups'
            ? { findAll: async () => [] }
            : {
                getPrimaryTeammate: async () => null,
                find: async () => ({ can: 'view' }),
                get: () => new Promise(() => {}),
              },
    }) as unknown as AgorClient;

  it('never lists teammates or comments from boards private to others', async () => {
    seed({
      sessions: [session('idle')],
      comments: [
        comment('shared-c', { board_id: 'b-shared' }),
        comment('private-c', { board_id: 'b-private', content: '@"Kasia Designer" secret' }),
      ],
      branches: [teammate('open', 'b-shared'), teammate('hidden', 'b-private')],
      boards: [
        { board_id: 'b-shared', name: 'S', archived: false } as Board,
        { board_id: 'b-private', name: 'P', archived: false } as Board,
      ],
    });
    renderHome({
      currentUser: superadmin,
      client: policyClient({ 'b-shared': 'shared', 'b-private': 'private' }),
    });
    expect(await screen.findByText('Teammate open')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /can you look/ })).toBeInTheDocument();
    expect(screen.queryByText('Teammate hidden')).not.toBeInTheDocument();
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });
});

describe('HomePage re-render isolation', () => {
  const mine = session('mine');
  const theirs = session('theirs', { created_by: 'someone-else' });

  function renderCounting() {
    seed({ sessions: [mine, theirs], comments: [comment('c1')], branches: [teammate('t', 'b')] });
    const commits = { count: 0 };
    renderHome({}, () => {
      commits.count += 1;
    });
    commits.count = 0;
    return commits;
  }

  it('re-renders nothing for a session patch outside its previews', () => {
    const commits = renderCounting();
    act(() => {
      agorStore.setState(buildSessionMaps([mine, { ...theirs, title: 'streamed token' }]));
    });
    expect(commits.count).toBe(0);
    act(() => {
      agorStore.setState(buildSessionMaps([{ ...mine, title: 'Renamed' }, theirs]));
    });
    expect(commits.count).toBeGreaterThan(0);
    expect(screen.getByText('Renamed')).toBeInTheDocument();
  });

  it('re-renders nothing for comment or branch patches that change nothing shown', () => {
    const commits = renderCounting();
    act(() => {
      const commentById = new Map(agorStore.getState().commentById);
      commentById.set('other', comment('other', { content: 'unrelated', created_by: 'x' }));
      agorStore.setState({ commentById });
    });
    act(() => {
      const branchById = new Map(agorStore.getState().branchById);
      branchById.set('unrelated', { branch_id: 'unrelated', name: 'u' } as Branch);
      agorStore.setState({ branchById });
    });
    expect(commits.count).toBe(0);
  });

  it('re-renders only the preview row whose session changed', () => {
    const others = ['b', 'c'].map((id) => session(id, { last_updated: recent(10) }));
    seed({ sessions: [mine, ...others] });
    renderHome();
    titleReads.clear();
    act(() => {
      agorStore.setState(buildSessionMaps([{ ...mine, title: 'Renamed' }, ...others]));
    });
    expect(screen.getByText('Renamed')).toBeInTheDocument();
    expect(titleReads.get('mine')).toBeGreaterThan(0);
    expect(titleReads.get('b')).toBeUndefined();
    expect(titleReads.get('c')).toBeUndefined();
  });

  it('bails out of a parent re-render when its props are stable', () => {
    seed({ sessions: [mine] });
    let bump = () => {};
    function Parent() {
      const [, setTick] = useState(0);
      useLayoutEffect(() => {
        bump = () => setTick((t) => t + 1);
      });
      return <HomePage {...stableProps} />;
    }
    render(wrap(<Parent />));
    const baseline = homeRenders.count;
    act(() => bump());
    expect(homeRenders.count).toBe(baseline);
  });

  it('stays quiet on a 7k-session tenant when someone else streams', () => {
    const sessions = Array.from({ length: 7000 }, (_, i) =>
      session(`s${i}`, {
        created_by: i % 10 ? `user-${i % 20}` : ME,
        branch_id: `b-${i % 400}`,
        status: i % 9 === 0 ? 'running' : 'idle',
        last_updated: recent(i),
      })
    );
    seed({ sessions });
    const commits = { count: 0 };
    renderHome({}, () => {
      commits.count += 1;
    });
    commits.count = 0;
    const patched = buildSessionMaps(
      sessions.map((s, i) => (i === 3 ? { ...s, title: 'streamed token' } : s))
    );
    const started = performance.now();
    act(() => agorStore.setState(patched));
    const elapsed = performance.now() - started;
    console.info(`[home-perf] 7k-session store patch → Home commit: ${elapsed.toFixed(1)}ms`);
    expect(commits.count).toBe(0);
  });
});
