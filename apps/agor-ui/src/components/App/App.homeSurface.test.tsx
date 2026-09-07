/**
 * Home-surface integration tests.
 *
 * Two defects, both of the form "the URL and the rendered surface disagree":
 *
 *   1. Clicking Home with a session open never reached `/`. React Router
 *      commits `navigate()` inside a transition, so `setPendingHomeNavigation`
 *      rendered once at the OLD path with the session already suppressed;
 *      `useUrlState`'s state→URL self-heal read that transitional
 *      (board, session=null) pair as authoritative and `replace()`d the URL
 *      with `/b/<board>/`, cancelling the `/` push. `pendingHomeNavigation`
 *      then stayed armed forever, because its only reset requires already
 *      being at `/`. While armed, the shell renders Home for every non-entity
 *      URL and forces `effectiveSelectedSessionId` to null — so the board
 *      switcher moves the address bar while Home keeps rendering, and Home's
 *      session rows resolve but never select.
 *
 *   2. Settings is a routed *overlay*: `/settings/...` owns the address bar
 *      while the surface it was opened over stays mounted behind the modal.
 *      Deriving the surface from `location.pathname` made opening Settings
 *      over Home read as a navigation away from Home, swapping in the board
 *      canvas underneath before the modal painted.
 *
 * They are written at the App level on purpose: each is an interaction
 * between the route table, `useUrlState`'s two effects, and the shell's
 * surface derivation. No single unit sees it.
 */
import type { Board, Branch, Session, SessionID, User } from '@agor-live/client';
import { sessionPath } from '@agor-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { forwardRef } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasNavigationProvider, useRecenterMap } from '../../contexts/CanvasNavigationContext';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { useSettingsRoute } from '../../hooks/useSettingsRoute';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { App } from './App';

// Surface stand-ins. Each renders the one attribute the assertions read, so
// a test can say "the board canvas is showing Beta" without depending on
// canvas internals.
vi.mock('../SessionCanvas', () => ({
  SessionCanvas: forwardRef((props: { board?: { name?: string } | null }) => (
    <div data-testid="session-canvas" data-board={props.board?.name ?? ''} />
  )),
}));
vi.mock('../SessionPanel', () => ({
  SessionPanel: (props: { session?: { session_id?: string } | null; open?: boolean }) =>
    props.open ? (
      <div data-testid="session-panel" data-session={props.session?.session_id ?? ''} />
    ) : null,
}));
vi.mock('../SessionPanel/PendingToolChoicePanel', () => ({
  PendingToolChoicePanel: () => null,
}));
vi.mock('../EventStreamPanel', () => ({ EventStreamPanel: () => null }));
vi.mock('../BoardTeammatePanel', () => ({
  BoardTeammatePanel: () => null,
  TeammatePanelRail: () => null,
}));
vi.mock('../NewSessionButton', () => ({ NewSessionButton: () => null }));
vi.mock('../SettingsModal', () => ({
  SettingsModal: (props: { open?: boolean }) =>
    props.open ? <div data-testid="settings-modal" /> : null,
  UserSettingsModal: () => null,
}));
vi.mock('../BranchModal', () => ({ BranchModal: () => null }));
vi.mock('../CreateDialog', () => ({ CreateDialog: () => null }));
vi.mock('../NewSessionModal', () => ({ NewSessionModal: () => null }));
vi.mock('../SessionSettingsModal', () => ({ SessionSettingsModal: () => null }));
vi.mock('../TerminalModal', () => ({
  TerminalModal: () => null,
  WEB_TERMINAL_MIN_ROLE: 'member',
}));
vi.mock('../ThemeEditorModal', () => ({ ThemeEditorModal: () => null }));
vi.mock('../EnvironmentLogsModal', () => ({ EnvironmentLogsModal: () => null }));
vi.mock('../../hooks/useTaskCompletionChime', () => ({ useTaskCompletionChime: () => {} }));
// react-resizable-panels needs real layout measurements jsdom cannot provide,
// and throws from the imperative handles App drives in effects.
vi.mock('react-resizable-panels', async () => {
  const React = await import('react');
  const noopHandle = { collapse: () => {}, expand: () => {}, resize: () => {} };
  const Panel = React.forwardRef<unknown, { children?: React.ReactNode }>(({ children }, ref) => {
    React.useImperativeHandle(ref, () => noopHandle, []);
    return <div>{children}</div>;
  });
  return {
    Panel,
    PanelGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    PanelResizeHandle: () => <div />,
  };
});

const USER_ID = '019e6666-0000-7000-8000-000000000001';
const BOARD_A = '019e7777-0000-7000-8000-00000000000a';
const BOARD_B = '019e7777-0000-7000-8000-00000000000b';
const BRANCH_A = '019e8888-0000-7000-8000-00000000000a';
const BRANCH_B = '019e8888-0000-7000-8000-00000000000b';
const SESSION_1 = '019e9999-0000-7000-8000-000000000001';
const SESSION_2 = '019eaaaa-0000-7000-8000-000000000002';

const boardA = { board_id: BOARD_A, name: 'Alpha', slug: 'alpha', archived: false } as Board;
const boardB = { board_id: BOARD_B, name: 'Beta', slug: 'beta', archived: false } as Board;
const branchA = {
  branch_id: BRANCH_A,
  repo_id: 'repo-1',
  board_id: BOARD_A,
  name: 'orbit',
  archived: false,
} as unknown as Branch;
const branchB = {
  branch_id: BRANCH_B,
  repo_id: 'repo-1',
  board_id: BOARD_B,
  name: 'signal',
  archived: false,
} as unknown as Branch;
const session1 = {
  session_id: SESSION_1,
  branch_id: BRANCH_A,
  created_by: USER_ID,
  title: 'Orbit standup',
  status: 'idle',
  archived: false,
  genealogy: {},
  agentic_tool: 'codex',
  last_updated: '2026-08-25T12:00:00.000Z',
} as unknown as Session;
const session2 = {
  session_id: SESSION_2,
  branch_id: BRANCH_B,
  created_by: USER_ID,
  title: 'Signal triage',
  status: 'idle',
  archived: false,
  genealogy: {},
  agentic_tool: 'codex',
  last_updated: '2026-08-25T11:00:00.000Z',
} as unknown as Session;
const user = {
  user_id: USER_ID,
  name: 'Tester',
  email: 'tester@example.test',
  role: 'admin',
} as unknown as User;

function seedStore() {
  agorStore.setState({
    ...EMPTY_MAPS,
    boardById: new Map([
      [BOARD_A, boardA],
      [BOARD_B, boardB],
    ]),
    branchById: new Map([
      [BRANCH_A, branchA],
      [BRANCH_B, branchB],
    ]),
    sessionById: new Map([
      [SESSION_1, session1],
      [SESSION_2, session2],
    ]),
    sessionsByBranch: new Map([
      [BRANCH_A, [session1]],
      [BRANCH_B, [session2]],
    ]),
    userById: new Map([[user.user_id, user]]),
  } as never);
}

let currentPath = '';
function PathSpy() {
  currentPath = useLocation().pathname;
  return null;
}

/** Drives the real settings-route open path — the same call the gear menu
 *  makes — so the test exercises `openSettings`'s history-state contract
 *  rather than a hand-rolled navigate. */
function SettingsOpener() {
  const { openSettings } = useSettingsRoute();
  return (
    <button type="button" data-testid="open-settings" onClick={() => openSettings()}>
      settings
    </button>
  );
}

/** Cross-board recenter — the one flow that moves App's board state with
 *  no `navigate()` behind it, leaving the state→URL self-heal to carry the
 *  address bar across. Stands in for a search hit / notification on another
 *  board; SessionCanvas itself is mocked. */
function CrossBoardRecenter() {
  const recenterMap = useRecenterMap();
  return (
    <button
      type="button"
      data-testid="recenter-cross-board"
      onClick={() => recenterMap(BRANCH_B, { boardId: BOARD_B })}
    >
      recenter
    </button>
  );
}

/** Route table mirrors `apps/agor-ui/src/App.tsx` — the bugs live in how
 *  these paths resolve, so an approximation would not reproduce them. */
function renderApp(initialPath: string) {
  const el = (
    <App client={null} user={user} connected={true} availableAgents={[]} initialBoardId="" />
  );
  return render(
    <ThemeProvider>
      <AntApp>
        <MemoryRouter initialEntries={[initialPath]}>
          <CanvasNavigationProvider>
            <PathSpy />
            <SettingsOpener />
            <CrossBoardRecenter />
            <Routes>
              <Route path="/b/:boardParam/" element={el} />
              <Route path="/s/:sessionShortId/" element={el} />
              <Route path="/w/:branchShortId/" element={el} />
              <Route path="/a/:artifactShortId/" element={el} />
              <Route path="/*" element={el} />
            </Routes>
          </CanvasNavigationProvider>
        </MemoryRouter>
      </AntApp>
    </ThemeProvider>
  );
}

/** Let the router transition, both URL⇄state effects, and the deferred
 *  recenter timer all settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

const homeIsShowing = () => !!screen.queryByText(/Hi, Tester/);
const canvasBoardName = () =>
  screen.queryByTestId('session-canvas')?.getAttribute('data-board') ?? null;
const openSessionId = () =>
  screen.queryByTestId('session-panel')?.getAttribute('data-session') ?? null;

function clickHomeButton() {
  fireEvent.click(document.querySelector('[aria-label="Go to Home"]') as HTMLElement);
}

/** Open the navbar board switcher and choose a board by name. */
async function pickBoardFromSwitcher(name: string) {
  const trigger = document
    .querySelector('[data-current-board-name]')
    ?.closest('button') as HTMLElement;
  fireEvent.click(trigger);
  await settle();
  const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) =>
    el.textContent?.includes(name)
  );
  if (!item) throw new Error(`board "${name}" not offered by the switcher`);
  fireEvent.click(item);
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  seedStore();
});

describe('Settings opens as an overlay, not a navigation', () => {
  it('keeps Home rendered behind the settings modal', async () => {
    renderApp('/');
    await settle();
    expect(homeIsShowing()).toBe(true);

    fireEvent.click(screen.getByTestId('open-settings'));
    await settle();

    expect(screen.getByTestId('settings-modal')).toBeTruthy();
    // The reported symptom: Home tore down and the board canvas appeared
    // behind the modal before it could open.
    expect(homeIsShowing()).toBe(true);
    expect(screen.queryByTestId('session-canvas')).toBeNull();
  });

  it('keeps the board canvas rendered behind the settings modal', async () => {
    renderApp('/b/alpha/');
    await settle();
    expect(canvasBoardName()).toBe('Alpha');

    fireEvent.click(screen.getByTestId('open-settings'));
    await settle();

    // Anti-overreach: reading the surface from the recorded origin must not
    // turn every settings route into Home.
    expect(screen.getByTestId('settings-modal')).toBeTruthy();
    expect(canvasBoardName()).toBe('Alpha');
    expect(homeIsShowing()).toBe(false);
  });

  it('falls back to the pathname for a cold-loaded settings URL', async () => {
    // Shared link / hard refresh: no recorded origin in history state, so
    // there is no prior surface to preserve.
    renderApp('/settings/boards/');
    await settle();

    expect(screen.getByTestId('settings-modal')).toBeTruthy();
    expect(screen.queryByTestId('session-canvas')).toBeTruthy();
    expect(homeIsShowing()).toBe(false);
  });
});

describe('Home navigation with a session open', () => {
  it('reaches "/" instead of being replaced by the board URL', async () => {
    renderApp(sessionPath(SESSION_1 as SessionID));
    await settle();
    expect(openSessionId()).toBe(SESSION_1);

    clickHomeButton();
    await settle();

    // Before the fix this settled on `/b/alpha/`: the self-heal saw the
    // transitional (board, session=null) pair and cancelled the `/` push.
    expect(currentPath).toBe('/');
    expect(homeIsShowing()).toBe(true);
  });

  it('leaves the board switcher working afterwards', async () => {
    renderApp(sessionPath(SESSION_1 as SessionID));
    await settle();
    clickHomeButton();
    await settle();

    await pickBoardFromSwitcher('Beta');

    // Reported symptom: the URL changed but the view stayed on Home,
    // because `pendingHomeNavigation` was still armed.
    expect(currentPath).toBe('/b/beta/');
    expect(canvasBoardName()).toBe('Beta');
    expect(homeIsShowing()).toBe(false);
  });

  it('leaves Home session rows selectable afterwards', async () => {
    renderApp(sessionPath(SESSION_1 as SessionID));
    await settle();
    clickHomeButton();
    await settle();

    fireEvent.click(await screen.findByText('Signal triage'));
    await settle();

    // Reported symptom: the row click resolved and the URL changed, but
    // nothing selected, because the wedged flag nulled the effective
    // selection.
    expect(currentPath).toBe(sessionPath(SESSION_2 as SessionID));
    expect(openSessionId()).toBe(SESSION_2);
  });

  it('does not wedge when another navigation supersedes the Home click', async () => {
    renderApp(sessionPath(SESSION_1 as SessionID));
    await settle();
    // Pre-open the switcher so the board can be chosen in the same tick as
    // the Home click. The Home transition loses the race, and the pending
    // flag must not survive landing somewhere that is not `/`.
    const trigger = document
      .querySelector('[data-current-board-name]')
      ?.closest('button') as HTMLElement;
    fireEvent.click(trigger);
    await settle();
    const betaItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes('Beta')
    ) as HTMLElement;

    clickHomeButton();
    fireEvent.click(betaItem);
    await settle();

    expect(currentPath).toBe('/b/beta/');
    expect(canvasBoardName()).toBe('Beta');
    expect(homeIsShowing()).toBe(false);
  });

  it('still lets state heal the URL when no navigation is in flight', async () => {
    renderApp('/b/alpha/');
    await settle();
    expect(canvasBoardName()).toBe('Alpha');

    // Cross-board recenter asks App to switch boards through the canvas
    // navigation channel — board state moves with no `navigate()` behind
    // it, so the state→URL self-heal is the only thing that can carry the
    // address bar across. Suspending it unconditionally would strand the
    // URL on the old board.
    fireEvent.click(screen.getByTestId('recenter-cross-board'));
    await settle();

    expect(canvasBoardName()).toBe('Beta');
    expect(currentPath).toBe('/b/beta/');
  });
});
