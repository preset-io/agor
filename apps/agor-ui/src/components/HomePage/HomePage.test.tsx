import type { AgorClient, Board, Branch, Session, User } from '@agor-live/client';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionMaps } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import {
  OPEN_BOARD_SWITCHER_EVENT,
  OPEN_GLOBAL_SEARCH_EVENT,
  onShellPicker,
} from '../../utils/shellEvents';
import {
  asDesktop,
  comment,
  ME,
  recent,
  renderHome,
  resetHome,
  seed,
  session,
  teammate,
  user,
} from './testUtils';

// The side rail mounts at once.
vi.mock('../../hooks/useIdleReady', () => ({ useIdleReady: () => true }));

beforeEach(resetHome);

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

  it('keeps an opened failure out of Needs you through a rename, until the session runs again', async () => {
    const failed = session('f1', {
      status: 'failed',
      created_at: recent(120),
      title: 'Broken run',
    });
    seed({ sessions: [failed] });
    const onSessionClick = vi.fn();
    renderHome({ onSessionClick });
    const needs = screen.getByRole('region', { name: 'Needs you' });
    fireEvent.click(within(needs).getByText('Broken run'));
    expect(onSessionClick).toHaveBeenCalledWith('f1');
    await waitFor(() => expect(within(needs).queryByText('Broken run')).not.toBeInTheDocument());

    act(() => agorStore.setState(buildSessionMaps([{ ...failed, last_updated: recent(0) }])));
    expect(within(needs).queryByText('Broken run')).not.toBeInTheDocument();

    const hex = (Date.now() + 60_000).toString(16).padStart(12, '0');
    const task = `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
    act(() =>
      agorStore.setState(buildSessionMaps([{ ...failed, last_updated: recent(0), tasks: [task] }]))
    );
    await waitFor(() => expect(within(needs).getByText('Broken run')).toBeInTheDocument());
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

  it('lands on the comments filter from route state (the phone bell), then clears only it', async () => {
    seed({
      sessions: [session('perm', { status: 'awaiting_permission' })],
      comments: [comment('c1')],
    });
    renderHome({}, undefined, {
      pathname: '/',
      search: '?from=bell',
      hash: '#needs',
      state: { needsFilter: 'comments' },
    });
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(within(needs).getAllByRole('button', { name: /mentioned you/ })).toHaveLength(1);
    expect(within(needs).queryByRole('button', { name: /Session perm/ })).not.toBeInTheDocument();
    // Back to this entry must not apply the filter again.
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'route state' })).toHaveTextContent('null')
    );
    expect(screen.getByRole('status', { name: 'route url' })).toHaveTextContent('?from=bell#needs');
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
      sessions: Array.from({ length: 21 }, (_, i) => session(`w${i}`, { last_updated: recent(i) })),
    });
    renderHome();
    const work = screen.getByRole('region', { name: 'My work' });
    expect(work.querySelectorAll('[data-home-row]')).toHaveLength(20);
    const more = within(work).getByRole('button', { name: 'Show 1 more' });
    expect(more).not.toHaveAttribute('aria-expanded');
    fireEvent.click(more);
    expect(work.querySelectorAll('[data-home-row]')).toHaveLength(21);
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

  it('keeps filters only in memory until there is a signed-in user', async () => {
    seed({ sessions: [session('idle')] });
    renderHome({ currentUser: null });
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Only sessions I started' }));
    expect(within(sheet).getByRole('checkbox', { name: 'Only sessions I started' })).toBeChecked();
    expect(Object.keys(localStorage).filter((key) => key.includes('anonymous'))).toEqual([]);
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

  it('counts only filtered running sessions, exactly past a page', async () => {
    seed({
      sessions: Array.from({ length: 22 }, (_, i) =>
        session(`r${i}`, {
          status: 'running',
          title: i < 1 ? `alpha ${i}` : `beta ${i}`,
          last_updated: recent(i),
        })
      ),
    });
    renderHome();
    const work = screen.getByRole('region', { name: 'My work' });
    fireEvent.click(within(work).getByRole('radio', { name: 'Running 22' }));
    expect(within(work).getByRole('button', { name: 'Show 2 more' })).toBeInTheDocument();

    const filter = within(work).getByRole('textbox', { name: 'Filter sessions' });
    fireEvent.change(filter, { target: { value: 'beta' } });
    expect(await within(work).findByRole('button', { name: 'Show 1 more' })).toBeInTheDocument();

    fireEvent.change(filter, { target: { value: 'alpha' } });
    await waitFor(() => expect(work.querySelectorAll('[data-home-row]')).toHaveLength(1));
    expect(within(work).queryByRole('button', { name: /more$/ })).not.toBeInTheDocument();
  });

  it('says when a filter hides every running session, and clears it', async () => {
    seed({
      sessions: ['alpha', 'beta'].map((title, i) =>
        session(title, { status: 'running', title, last_updated: recent(i) })
      ),
    });
    renderHome();
    const work = screen.getByRole('region', { name: 'My work' });
    fireEvent.click(within(work).getByRole('radio', { name: 'Running 2' }));
    const filter = within(work).getByRole('textbox', { name: 'Filter sessions' });
    fireEvent.change(filter, { target: { value: 'gamma' } });
    expect(await within(work).findByText(/No running sessions match “gamma”/)).toBeInTheDocument();
    fireEvent.click(within(work).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(work.querySelectorAll('[data-home-row]')).toHaveLength(2));
    expect(filter).toHaveValue('');
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

  it('waits for hydration before offering onboarding, so returning users never see it flash', () => {
    seed({ boards: [{ board_id: 'b', name: 'B', archived: false } as Board], hydrated: false });
    renderHome({ onOpenSettings: () => {} });
    expect(screen.queryByText('Connect a repository')).not.toBeInTheDocument();
    act(() => seed({ sessions: [session('returning')] }));
    expect(screen.queryByText('Connect a repository')).not.toBeInTheDocument();
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
