import type { Board, BoardComment, Branch, Session, User } from '@agor-live/client';
import { act, render, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { forwardRef } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { App } from './App';

// The shell's own render count. The mocked AppHeader is a plain (un-memoized)
// function component rendered unconditionally by App, so its invocation count
// is a faithful proxy for how many times the shell rendered.
let shellRenders = 0;

vi.mock('../AppHeader', () => ({
  AppHeader: () => {
    shellRenders += 1;
    return null;
  },
}));
vi.mock('../BoardTeammatePanel', () => ({
  BoardTeammatePanel: () => null,
}));
vi.mock('../HomePage', () => ({
  HomePage: () => null,
}));
vi.mock('../SessionCanvas', () => ({
  SessionCanvas: forwardRef(() => null),
}));
vi.mock('../SessionPanel', () => ({
  SessionPanel: () => null,
}));
vi.mock('../EventStreamPanel', () => ({
  EventStreamPanel: () => null,
}));
vi.mock('../NewSessionButton', () => ({
  NewSessionButton: () => null,
}));
vi.mock('../SettingsModal', () => ({
  SettingsModal: () => null,
  UserSettingsModal: () => null,
}));
vi.mock('../BranchModal', () => ({
  BranchModal: () => null,
}));
vi.mock('../CreateDialog', () => ({
  CreateDialog: () => null,
}));
vi.mock('../NewSessionModal', () => ({
  NewSessionModal: () => null,
}));
vi.mock('../SessionSettingsModal', () => ({
  SessionSettingsModal: () => null,
}));
vi.mock('../TerminalModal', () => ({
  TerminalModal: () => null,
  WEB_TERMINAL_MIN_ROLE: 'member',
}));
vi.mock('../ThemeEditorModal', () => ({
  ThemeEditorModal: () => null,
}));
vi.mock('../EnvironmentLogsModal', () => ({
  EnvironmentLogsModal: () => null,
}));
// Chime hook subscribes to socket events / audio — irrelevant here.
vi.mock('../../hooks/useTaskCompletionChime', () => ({
  useTaskCompletionChime: () => {},
}));
// react-resizable-panels needs real layout measurements (jsdom has none) and
// throws from the imperative expand/resize handles App drives in effects.
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

const BOARD_ID = 'board-1';
const board = { board_id: BOARD_ID, name: 'Board', slug: BOARD_ID } as unknown as Board;

// A branch that lives on the CURRENT board (via board_objects) and one that
// does not — patches touching the latter's entities must not wake the shell.
const onBoardBranch = {
  branch_id: 'wt-on-board',
  repo_id: 'repo-1',
  board_id: BOARD_ID,
  name: 'on-board',
} as unknown as Branch;
const offBoardBranch = {
  branch_id: 'wt-off-board',
  repo_id: 'repo-1',
  board_id: 'board-other',
  name: 'off-board',
} as unknown as Branch;

const user = { user_id: 'u1', name: 'User', email: 'u@example.test' } as unknown as User;

function makeSession(id: string, branchId: string, status = 'idle'): Session {
  return {
    session_id: id,
    branch_id: branchId,
    status,
    archived: false,
  } as unknown as Session;
}

function seedStore() {
  agorStore.setState({
    ...EMPTY_MAPS,
    boardById: new Map([[board.board_id, board]]),
    branchById: new Map([
      [onBoardBranch.branch_id, onBoardBranch],
      [offBoardBranch.branch_id, offBoardBranch],
    ]),
    boardObjectsByBoardId: new Map([
      [
        BOARD_ID,
        [
          {
            board_object_id: 'bo-1',
            board_id: BOARD_ID,
            branch_id: onBoardBranch.branch_id,
          },
        ],
      ],
    ]) as never,
    sessionById: new Map([['s-off', makeSession('s-off', offBoardBranch.branch_id)]]),
    sessionsByBranch: new Map([
      [offBoardBranch.branch_id, [makeSession('s-off', offBoardBranch.branch_id)]],
    ]),
  });
}

function renderShell() {
  return render(
    <AntApp>
      <MemoryRouter initialEntries={[`/b/${BOARD_ID}/`]}>
        <Routes>
          <Route
            path="/b/:boardParam/*"
            element={
              <App
                client={null}
                user={user}
                connected={true}
                availableAgents={[]}
                initialBoardId={BOARD_ID}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </AntApp>
  );
}

describe('App shell re-render isolation on a board view', () => {
  beforeEach(() => {
    shellRenders = 0;
    seedStore();
  });

  it('an irrelevant session patch does not re-render the shell', async () => {
    renderShell();
    await waitFor(() => {
      expect(shellRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = shellRenders;

    // Patch a session on a branch that is NOT on the current board — the
    // shell holds no whole-map subscription, so it must stay quiet.
    act(() => {
      const next = new Map(agorStore.getState().sessionById);
      next.set('s-off', makeSession('s-off', offBoardBranch.branch_id, 'running'));
      const nextByBranch = new Map(agorStore.getState().sessionsByBranch);
      nextByBranch.set(offBoardBranch.branch_id, [
        makeSession('s-off', offBoardBranch.branch_id, 'running'),
      ]);
      agorStore.setState({ sessionById: next, sessionsByBranch: nextByBranch });
    });

    expect(shellRenders).toBe(baseline);
  });

  it('an irrelevant (other-board) comment patch does not re-render the shell', async () => {
    renderShell();
    await waitFor(() => {
      expect(shellRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = shellRenders;

    act(() => {
      const comment = {
        comment_id: 'c-other',
        board_id: 'board-other',
        content: 'hello @User',
        resolved: false,
      } as unknown as BoardComment;
      agorStore.setState({ commentById: new Map([[comment.comment_id, comment]]) });
    });

    expect(shellRenders).toBe(baseline);
  });

  it('a current-board unresolved comment DOES re-render the shell (badge count)', async () => {
    // Contrast case proving the narrow comment subscription is live — the
    // isolation above is meaningful, not a dead subscription.
    renderShell();
    await waitFor(() => {
      expect(shellRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = shellRenders;

    act(() => {
      const comment = {
        comment_id: 'c-here',
        board_id: BOARD_ID,
        content: 'needs attention',
        resolved: false,
      } as unknown as BoardComment;
      agorStore.setState({ commentById: new Map([[comment.comment_id, comment]]) });
    });

    await waitFor(() => {
      expect(shellRenders).toBeGreaterThan(baseline);
    });
  });

  it('a patch to a branch ON the current board re-renders the shell (canvas data)', async () => {
    // Second contrast: boardBranches (shallow-compared derived selector)
    // must fire when a member branch's identity changes.
    renderShell();
    await waitFor(() => {
      expect(shellRenders).toBeGreaterThanOrEqual(1);
    });
    const baseline = shellRenders;

    act(() => {
      const next = new Map(agorStore.getState().branchById);
      next.set(onBoardBranch.branch_id, { ...onBoardBranch, name: 'renamed' } as Branch);
      agorStore.setState({ branchById: next });
    });

    await waitFor(() => {
      expect(shellRenders).toBeGreaterThan(baseline);
    });
  });
});
