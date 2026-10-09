import type { Board, BoardComment, Branch, Session, User } from '@agor-live/client';
import { render } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { Profiler } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { buildSessionMaps, EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { userScopeCoverage } from '../../test/userScopeCoverage';
import { resetAccessCacheForTests } from '../../utils/accessCache';
import { HomePage, type HomePageProps } from './HomePage';

/** Renders the current route state, so a test can see Home clear it. */
function RouteStateProbe() {
  const { state, search, hash } = useLocation();
  return (
    <>
      <output aria-label="route state">{JSON.stringify(state)}</output>
      <output aria-label="route url">{`${search}${hash}`}</output>
    </>
  );
}

/** Wide viewport: every media query matches, so Home renders at desktop density. */
export const asDesktop = () =>
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

export const ME = 'user-me';
export const user = {
  user_id: ME,
  name: 'Kasia Designer',
  email: 'k@example.test',
  role: 'member',
} as User;
export const recent = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const session = (id: string, extra: Partial<Session> = {}) =>
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

export const comment = (id: string, extra: Partial<BoardComment> = {}) =>
  ({
    comment_id: id,
    board_id: 'board-1',
    created_by: 'someone',
    content: '@"Kasia Designer" can you look?',
    resolved: false,
    created_at: recent(2),
    ...extra,
  }) as unknown as BoardComment;

export const teammate = (id: string, boardId: string) =>
  ({
    branch_id: id,
    name: id,
    board_id: boardId,
    created_by: 'owner-1',
    archived: false,
    custom_context: { teammate: { kind: 'teammate', displayName: `Teammate ${id}` } },
  }) as unknown as Branch;

export function seed({
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
    coverage: userScopeCoverage({ sessions: hydrated, references: hydrated, teammates: hydrated }),
  } as never);
}

export const stableProps: HomePageProps = {
  client: null,
  currentUser: user,
  onBoardClick: () => {},
  onBranchClick: () => {},
  onSessionClick: () => {},
  onCreateSession: async () => null,
};

/** `connected`, or the connection flags to override on a connected default. */
type TestConnection = boolean | { connected?: boolean; connecting?: boolean; outOfSync?: boolean };

export function wrap(
  node: React.ReactNode,
  route: string | object = '/',
  connection: TestConnection = true
) {
  return (
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        authGeneration: 1,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
        ...(typeof connection === 'boolean' ? { connected: connection } : connection),
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

export function renderHome(
  props: Partial<HomePageProps> = {},
  onRender = () => {},
  route?: object,
  connection: TestConnection = true
) {
  return render(
    wrap(
      <Profiler id="home" onRender={onRender}>
        <HomePage {...stableProps} {...props} />
      </Profiler>,
      route,
      connection
    )
  );
}

/** Per-test reset shared by the HomePage test files. */
export function resetHome() {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  agorStore.getState().reset();
  resetAccessCacheForTests();
  vi.restoreAllMocks();
}
