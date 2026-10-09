import type { AgorClient, Board, BoardComment, Branch, Session, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { recentBoardsStorageKey } from '../../hooks/useRecentBoards';
import { buildSessionMaps, EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { userScopeCoverage } from '../../test/userScopeCoverage';
import { resetAccessCacheForTests } from '../../utils/accessCache';
import { MobileApp } from './MobileApp';

// The real shared HomePage; only the other phone pages are stand-ins.
vi.mock('./MobileBoardPage', () => ({
  MobileBoardPage: () => {
    const { boardId } = useParams();
    return <div data-testid="board-page">{boardId}</div>;
  },
}));
vi.mock('./SessionPage', () => ({
  SessionPage: () => {
    const { sessionId } = useParams();
    return <div data-testid="session-page">{sessionId}</div>;
  },
}));
vi.mock('../BranchModal', () => ({ BranchModal: () => null }));
vi.mock('../../hooks/useIdleReady', () => ({ useIdleReady: () => false }));

const ME = 'user-1';
const user = { user_id: ME, name: 'Kasia Designer', role: 'member' } as User;

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
    last_updated: new Date().toISOString(),
    ...extra,
  }) as unknown as Session;

const mention = (id: string, extra: Partial<BoardComment> = {}) =>
  ({
    comment_id: id,
    board_id: 'board-1',
    created_by: 'someone',
    content: '@"Kasia Designer" can you look?',
    resolved: false,
    created_at: new Date().toISOString(),
    ...extra,
  }) as unknown as BoardComment;

function seed({
  sessions = [],
  comments = [],
  branches = [],
}: {
  sessions?: Session[];
  comments?: BoardComment[];
  branches?: Branch[];
}) {
  agorStore.setState({
    ...EMPTY_MAPS,
    ...buildSessionMaps(sessions),
    commentById: new Map(comments.map((c) => [c.comment_id, c])),
    branchById: new Map([
      ['branch-1', { branch_id: 'branch-1', name: 'feature', board_id: 'board-1' } as Branch],
      ...branches.map((b) => [b.branch_id, b] as const),
    ]),
    boardById: new Map([
      ['board-1', { board_id: 'board-1', name: 'Launch', archived: false } as Board],
      ['board-2', { board_id: 'board-2', name: 'Ops', archived: false } as Board],
    ]),
    userById: new Map([[ME, user]]),
    coverage: userScopeCoverage({ sessions: true, references: true, teammates: true }),
  } as never);
}

const patch = vi.fn(async () => ({}));
const client = {
  service: () => ({
    getPrimaryTeammate: async () => null,
    find: async () => [],
    findAll: async () => [],
    get: () => new Promise(() => {}),
    patch,
    on: () => {},
    off: () => {},
    removeListener: () => {},
  }),
} as unknown as AgorClient;

const history = { back: () => {} };
/** Shows the path and lets a test go Back, so it can see what the bell left in history. */
function HistoryProbe() {
  const navigate = useNavigate();
  history.back = () => navigate(-1);
  return <output aria-label="path">{useLocation().pathname}</output>;
}

function renderPhoneHome(entries = ['/m']) {
  return render(
    <ThemeProvider>
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration: 1,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <AntApp>
          <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
            <HistoryProbe />
            <Routes>
              <Route
                path="/m/*"
                element={
                  <MobileApp
                    client={client}
                    user={user}
                    authGeneration={1}
                    onCreateSession={vi.fn(async () => null)}
                    onForkSession={vi.fn(async () => {})}
                    onBtwForkSession={vi.fn(async () => {})}
                    onSpawnSession={vi.fn(async () => {})}
                    onUpdateSession={vi.fn()}
                    onDeleteSession={vi.fn()}
                    onSendComment={vi.fn()}
                    onOpenWorkspaceSettings={vi.fn()}
                    onOpenUserSettings={vi.fn()}
                  />
                }
              />
            </Routes>
          </MemoryRouter>
        </AntApp>
      </ConnectionProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  patch.mockClear();
  agorStore.getState().reset();
  resetAccessCacheForTests();
});

/** Comments and mentions now live in More (the header bell is gone). */
async function openCommentsFromMore() {
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  fireEvent.click(await screen.findByRole('button', { name: /^Comments and mentions/ }));
}

describe('MobileApp Home wiring', () => {
  it('badges Home with the "need you" count and More with unread comments', async () => {
    seed({
      sessions: [
        session('run', { status: 'running' }),
        session('perm', { status: 'awaiting_permission' }),
      ],
      comments: [mention('c1')],
    });
    renderPhoneHome();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    await waitFor(() =>
      expect(within(nav).getByRole('button', { name: 'More' })).toHaveTextContent('1')
    );
    expect(screen.getByText(/need you/).textContent).toBe('2 need you');
    expect(within(nav).getByRole('button', { name: 'Home' })).toHaveTextContent('2');
    fireEvent.click(within(nav).getByRole('button', { name: 'More' }));
    expect(
      await screen.findByRole('button', { name: 'Comments and mentions, 1 unread' })
    ).toBeInTheDocument();
  });

  it('shows one "need you" number on the badge and Home across the 7-day failure window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const settled = Date.now() - (7 * 24 * 60 - 1) * 60 * 1000;
      seed({
        sessions: [
          session('failed', { status: 'failed', last_updated: new Date(settled).toISOString() }),
        ],
      });
      // The shell starts on a board while the failure is still inside the window...
      renderPhoneHome(['/m/board/board-1']);
      const nav = screen.getByRole('navigation', { name: 'Primary' });
      expect(within(nav).getByRole('button', { name: 'Home' })).toHaveTextContent('1');
      // ...and Home opens after it has left it: both judge it by the shell's clock.
      vi.setSystemTime(Date.now() + 2 * 60 * 1000);
      fireEvent.click(within(nav).getByRole('button', { name: 'Home' }));
      expect(await screen.findByText(/need you/)).toHaveTextContent('1 need you');
      expect(within(nav).getByRole('button', { name: 'Home' })).toHaveTextContent('1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens Needs you on Comments from More', async () => {
    seed({
      sessions: [session('perm', { status: 'awaiting_permission' })],
      comments: [mention('c1')],
    });
    renderPhoneHome();
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(within(needs).getByRole('button', { name: /Session perm/ })).toBeInTheDocument();

    await openCommentsFromMore();
    await waitFor(() =>
      expect(within(needs).queryByRole('button', { name: /Session perm/ })).not.toBeInTheDocument()
    );
    expect(within(needs).getByRole('button', { name: /mentioned you/ })).toBeInTheDocument();
    expect(within(needs).getByRole('radio', { name: 'Comments 1' })).toBeChecked();
  });

  it('keeps Back leaving Home when comments are opened on Home', async () => {
    seed({ sessions: [session('idle')], comments: [mention('c1')] });
    renderPhoneHome(['/m/search', '/m']);
    await openCommentsFromMore();
    expect(
      await within(screen.getByRole('region', { name: 'Needs you' })).findByRole('radio', {
        name: 'Comments 1',
      })
    ).toBeChecked();
    act(() => history.back());
    expect(screen.getByRole('status', { name: 'path' })).toHaveTextContent('/m/search');
  });

  it('opens a branch comment on its board', async () => {
    seed({ sessions: [session('idle')], comments: [mention('c1', { branch_id: 'branch-1' })] });
    renderPhoneHome();
    fireEvent.click(await screen.findByRole('button', { name: /mentioned you/ }));
    expect(await screen.findByTestId('board-page')).toHaveTextContent('board-1');
  });

  it('opens a comment on a branch not loaded yet on the comment’s board', async () => {
    seed({
      sessions: [session('idle')],
      comments: [mention('c1', { branch_id: 'branch-unloaded', board_id: 'board-2' })],
    });
    // Before the user scope resolves it, a comment's branch may not be in the store yet.
    agorStore.setState({ coverage: userScopeCoverage({ sessions: true, teammates: true }) });
    renderPhoneHome();
    fireEvent.click(await screen.findByRole('button', { name: /mentioned you/ }));
    expect(await screen.findByTestId('board-page')).toHaveTextContent('board-2');
  });

  it('shows the signed-in user’s visited boards and opens them', async () => {
    localStorage.setItem(recentBoardsStorageKey(ME), JSON.stringify(['board-2']));
    localStorage.setItem(recentBoardsStorageKey('someone-else'), JSON.stringify(['board-1']));
    seed({ sessions: [session('idle')] });
    renderPhoneHome();
    const recent = screen.getByRole('group', { name: 'Recent boards' });
    expect(within(recent).queryByRole('button', { name: 'Launch' })).not.toBeInTheDocument();
    fireEvent.click(within(recent).getByRole('button', { name: 'Ops' }));
    expect(await screen.findByTestId('board-page')).toHaveTextContent('board-2');
  });

  it('clears a finished result’s flag when it is opened', async () => {
    seed({ sessions: [session('done', { ready_for_prompt: true })] });
    renderPhoneHome();
    const needs = screen.getByRole('region', { name: 'Needs you' });
    await act(async () => {
      fireEvent.click(within(needs).getByRole('button', { name: /^Session done/ }));
    });
    expect(await screen.findByTestId('session-page')).toHaveTextContent('done');
    expect(patch).toHaveBeenCalledWith('done', { ready_for_prompt: false });
  });

  it('renders the teammates directory at /m/teammates/ with a back arrow to Home', async () => {
    const scout = {
      branch_id: 'scout',
      name: 'scout',
      board_id: 'board-1',
      created_by: 'someone-else',
      archived: false,
      custom_context: { teammate: { kind: 'teammate', displayName: 'Scout' } },
    } as unknown as Branch;
    seed({ branches: [scout] });
    const { unmount } = renderPhoneHome(['/m/teammates/']);
    expect(screen.getByText('AI teammates')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Scout, open Launch' }));
    expect(await screen.findByTestId('board-page')).toHaveTextContent('board-1');
    unmount();

    renderPhoneHome(['/m/teammates']);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText(/Good (morning|afternoon|evening), Kasia/)).toBeInTheDocument();
  });
});
