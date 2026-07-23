import type { Board, Branch, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { forwardRef } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { App } from './App';

// SessionCanvas is mocked to surface the quick-start entry point as a button so
// the test can drive `onCreateSessionForBranch` (the real "Add session" action)
// without a full canvas.
vi.mock('../SessionCanvas', () => ({
  SessionCanvas: forwardRef(
    (props: { onCreateSessionForBranch?: (branchId: string) => void }, _ref) => (
      <button
        type="button"
        data-testid="quick-start"
        onClick={() => props.onCreateSessionForBranch?.('wt-1')}
      >
        add session
      </button>
    )
  ),
}));
// The picker renders in place of the session panel when a tool can't be
// resolved. The stand-in exposes the tile as a button wired to `onChoose` so
// tests can drive the create flow.
vi.mock('../SessionPanel/PendingToolChoicePanel', () => ({
  PendingToolChoicePanel: ({ onChoose }: { onChoose: (tool: string) => void }) => (
    <button type="button" data-testid="tool-picker" onClick={() => onChoose('claude-code')}>
      tool picker
    </button>
  ),
}));

vi.mock('../AppHeader', () => ({ AppHeader: () => null }));
vi.mock('../BoardTeammatePanel', () => ({ BoardTeammatePanel: () => null }));
vi.mock('../HomePage', () => ({ HomePage: () => null }));
// SessionPanel is mocked to surface both its identity (`session-panel`) and the
// in-drawer "Switch tool" affordance, which drives `onChooseAgenticTool` with a
// `replacingSessionId` — the second entry point into the create→store handoff.
vi.mock('../SessionPanel', async () => {
  const { useAppActions } = await import('../../contexts/AppActionsContext');
  return {
    SessionPanel: ({
      session,
      onClose,
    }: {
      session?: { session_id?: string } | null;
      onClose: () => void;
    }) => {
      const { onChooseAgenticTool } = useAppActions();
      return (
        <div data-testid="session-panel">
          <button
            type="button"
            data-testid="switch-tool"
            onClick={() => onChooseAgenticTool?.('wt-1', 'codex', session?.session_id)}
          >
            switch tool
          </button>
          <button type="button" data-testid="session-close" onClick={onClose}>
            close
          </button>
          <span data-testid="session-id">{session?.session_id}</span>
        </div>
      );
    },
  };
});
vi.mock('../EventStreamPanel', () => ({ EventStreamPanel: () => null }));
vi.mock('../NewSessionButton', () => ({ NewSessionButton: () => null }));
vi.mock('../SettingsModal', () => ({ SettingsModal: () => null, UserSettingsModal: () => null }));
vi.mock('../BranchModal', () => ({ BranchModal: () => null }));
vi.mock('../CreateDialog', () => ({ CreateDialog: () => null }));
vi.mock('../NewSessionModal', () => ({ NewSessionModal: () => null }));
vi.mock('../SessionSettingsModal', () => ({ SessionSettingsModal: () => null }));
vi.mock('../TerminalModal', () => ({ TerminalModal: () => null, WEB_TERMINAL_MIN_ROLE: 'member' }));
vi.mock('../ThemeEditorModal', () => ({ ThemeEditorModal: () => null }));
vi.mock('../EnvironmentLogsModal', () => ({ EnvironmentLogsModal: () => null }));
vi.mock('../../hooks/useTaskCompletionChime', () => ({ useTaskCompletionChime: () => {} }));
// Records the session drawer Panel's mount lifecycle. The real
// `<Panel id="session-panel">` renders only while `sessionPanelTargetOpen` is
// true, so it unmounts for any frame where neither a session nor the picker is
// targeted — exactly the create→select flash. Tests assert it never unmounts
// during the handoff. Hoisted so both the mock factory and the tests can reach
// it.
const drawerPanel = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock('react-resizable-panels', async () => {
  const React = await import('react');
  const noopHandle = { collapse: () => {}, expand: () => {}, resize: () => {} };
  const Panel = React.forwardRef<unknown, { children?: React.ReactNode; id?: string }>(
    ({ children, id }, ref) => {
      React.useImperativeHandle(ref, () => noopHandle, []);
      React.useEffect(() => {
        if (id !== 'session-panel') return;
        drawerPanel.mounts += 1;
        return () => {
          drawerPanel.unmounts += 1;
        };
      }, [id]);
      return (
        <div data-testid={id === 'session-panel' ? 'drawer-panel' : undefined}>{children}</div>
      );
    }
  );
  return {
    Panel,
    PanelGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    PanelResizeHandle: () => <div />,
  };
});

const BOARD_ID = 'board-1';
const board = { board_id: BOARD_ID, name: 'Board', slug: BOARD_ID } as unknown as Board;
const branch = {
  branch_id: 'wt-1',
  repo_id: 'repo-1',
  board_id: BOARD_ID,
  name: 'feature',
} as unknown as Branch;

const AVAILABLE_AGENTS = [
  { id: 'claude-code', name: 'Claude Code', icon: '🤖', description: '' },
  { id: 'codex', name: 'Codex', icon: '💻', description: '' },
] as never[];

const USER = {
  user_id: 'u1',
  name: 'User',
  email: 'u@example.test',
  preferences: {},
} as unknown as User;

// Hex UUIDs so a session URL's short id resolves back to it once seeded
// (short-id matching is hex-only).
const SESSION_A = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f';
const SESSION_B = '01944f5b-8c9a-7d46-b907-ae3f2d5c6b7a';

/** Additive insert into `sessionById`, mirroring the real create seam: the
 *  authoritative row (via `sessionCreated`) is in the store before the id is
 *  returned, so URL→store selection resolves with no propagation gap. */
function insertSession(sessionId: string) {
  const next = new Map(agorStore.getState().sessionById);
  next.set(sessionId, { session_id: sessionId, branch_id: 'wt-1', board_id: BOARD_ID } as never);
  agorStore.setState({ sessionById: next as never });
}

/** Remove a session from the store, modelling the realtime `removed` event that
 *  lands after the switch-tool RPC (production ordering: after navigation). */
function removeSession(sessionId: string) {
  const next = new Map(agorStore.getState().sessionById);
  next.delete(sessionId);
  agorStore.setState({ sessionById: next as never });
}

/** onCreateSession stand-in: optimistically inserts each id then returns it,
 *  exactly like the production create seam. Repeats the last id if called more
 *  times than ids given. */
function optimisticCreate(...ids: string[]) {
  let call = 0;
  return vi.fn(async () => {
    const id = ids[Math.min(call, ids.length - 1)];
    call += 1;
    insertSession(id);
    return id;
  });
}

function seedStore() {
  agorStore.setState({
    ...EMPTY_MAPS,
    boardById: new Map([[board.board_id, board]]),
    branchById: new Map([[branch.branch_id, branch]]),
    boardObjectsByBoardId: new Map([
      [BOARD_ID, [{ board_object_id: 'bo-1', board_id: BOARD_ID, branch_id: branch.branch_id }]],
    ]) as never,
  });
}

// Captures the router's navigate so tests can simulate browser Back.
let testNavigate: ReturnType<typeof useNavigate> | null = null;
function NavProbe() {
  testNavigate = useNavigate();
  return null;
}

function renderShell(
  user: User,
  onCreateSession = vi.fn(async () => 'new-session-id'),
  client: unknown = null
) {
  // Mirror the real router: the same App element is mounted at the board,
  // session, and branch paths, so navigating between them preserves App state
  // instead of remounting. Without the session route, goToSession would leave
  // no matching route and unmount App entirely.
  const appElement = (
    <App
      client={client as never}
      user={user}
      connected={true}
      availableAgents={AVAILABLE_AGENTS}
      initialBoardId={BOARD_ID}
      onCreateSession={onCreateSession}
    />
  );
  render(
    <AntApp>
      <MemoryRouter initialEntries={[`/b/${BOARD_ID}/`]}>
        <NavProbe />
        <Routes>
          <Route path="/b/:boardParam/" element={appElement} />
          <Route path="/s/:sessionShortId/" element={appElement} />
          <Route path="/w/:branchShortId/" element={appElement} />
        </Routes>
      </MemoryRouter>
    </AntApp>
  );
  return { onCreateSession };
}

describe('App quick-start — always shows the tool picker', () => {
  beforeEach(() => {
    seedStore();
    drawerPanel.mounts = 0;
    drawerPanel.unmounts = 0;
  });

  it('opens the tile picker without creating a session', async () => {
    const { onCreateSession } = renderShell(USER);

    fireEvent.click(await screen.findByTestId('quick-start'));

    await waitFor(() => expect(screen.getByTestId('tool-picker')).toBeInTheDocument());
    expect(onCreateSession).not.toHaveBeenCalled();
  });

  it('keeps the session drawer mounted across the pick→open transition (no flash)', async () => {
    // Exercises the REAL selection path, not a seeded shortcut: optimisticCreate
    // inserts the session exactly as the create seam does, and `useUrlState`
    // (wired inside App) derives `selectedSessionId` from the navigation — the
    // test never sets selection directly. The drawer Panel must stay mounted the
    // whole time. With URL-only selection there is a one-render frame where
    // pending is cleared but `selectedSessionId` hasn't caught up, so the Panel
    // unmounts and fades back in (the reported flash); this asserts it doesn't.
    const onCreateSession = optimisticCreate(SESSION_A);
    renderShell(USER, onCreateSession);

    fireEvent.click(await screen.findByTestId('quick-start'));
    await screen.findByTestId('tool-picker');
    // Picker up → drawer Panel mounted once.
    expect(screen.getByTestId('drawer-panel')).toBeInTheDocument();
    const mountsWhilePicking = drawerPanel.mounts;

    await act(async () => {
      fireEvent.click(screen.getByTestId('tool-picker'));
    });

    await waitFor(() => expect(screen.getByTestId('session-panel')).toBeInTheDocument());
    expect(screen.getByTestId('session-id')).toHaveTextContent(SESSION_A);
    expect(onCreateSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('tool-picker')).not.toBeInTheDocument();
    // The drawer Panel never unmounted/remounted during the handoff.
    expect(drawerPanel.unmounts).toBe(0);
    expect(drawerPanel.mounts).toBe(mountsWhilePicking);
    expect(screen.getByTestId('drawer-panel')).toBeInTheDocument();
  });

  it('does not resurrect the picker on Back after the session is shown', async () => {
    const onCreateSession = optimisticCreate(SESSION_A);
    renderShell(USER, onCreateSession);

    fireEvent.click(await screen.findByTestId('quick-start'));
    await act(async () => {
      fireEvent.click(await screen.findByTestId('tool-picker'));
    });
    await waitFor(() => expect(screen.getByTestId('session-panel')).toBeInTheDocument());

    // Pending is cleared at create; nothing shadow-holds a picker. Back drops
    // the session URL segment → the drawer just closes, no phantom picker.
    await act(async () => {
      testNavigate?.(-1);
    });

    await waitFor(() => expect(screen.queryByTestId('session-panel')).not.toBeInTheDocument());
    expect(screen.queryByTestId('tool-picker')).not.toBeInTheDocument();
  });

  it('hands off from the replaced session to the new one on switch-tool', async () => {
    const removeCalls: string[] = [];
    const client = {
      service: () => ({
        remove: (id: string) => {
          removeCalls.push(id);
          return Promise.resolve();
        },
      }),
    };
    const onCreateSession = optimisticCreate(SESSION_A, SESSION_B);
    renderShell(USER, onCreateSession, client);

    // Open session A via the picker.
    fireEvent.click(await screen.findByTestId('quick-start'));
    await act(async () => {
      fireEvent.click(await screen.findByTestId('tool-picker'));
    });
    await waitFor(() => expect(screen.getByTestId('session-id')).toHaveTextContent(SESSION_A));

    // Switch tools (replacingSessionId = A). B is inserted + selected before
    // remove(A) is awaited, so the drawer never loses its SessionPanel.
    await act(async () => {
      fireEvent.click(screen.getByTestId('switch-tool'));
    });
    await waitFor(() => expect(removeCalls).toEqual([SESSION_A]));
    expect(screen.getByTestId('session-panel')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('session-id')).toHaveTextContent(SESSION_B));

    // The replaced session's removal event lands after navigation (production
    // ordering). B is already selected, so the drawer stays on SessionPanel.
    act(() => {
      removeSession(SESSION_A);
    });
    expect(screen.getByTestId('session-panel')).toBeInTheDocument();
    expect(screen.getByTestId('session-id')).toHaveTextContent(SESSION_B);
    // The drawer Panel stayed mounted across pick→A and switch A→B — no flash.
    expect(drawerPanel.unmounts).toBe(0);
  });

  it('shows the picker when Add session is used while a session is open', async () => {
    const onCreateSession = optimisticCreate(SESSION_A);
    renderShell(USER, onCreateSession);

    fireEvent.click(await screen.findByTestId('quick-start'));
    await act(async () => {
      fireEvent.click(await screen.findByTestId('tool-picker'));
    });
    await waitFor(() => expect(screen.getByTestId('session-panel')).toBeInTheDocument());

    // Add session routes away from the open session, then shows the picker.
    await act(async () => {
      fireEvent.click(screen.getByTestId('quick-start'));
    });
    await waitFor(() => expect(screen.getByTestId('tool-picker')).toBeInTheDocument());
    expect(screen.queryByTestId('session-panel')).not.toBeInTheDocument();
  });

  it('keeps the picker interactive when create fails', async () => {
    // createSession returns null → no session, no navigation. Pending stays set
    // so the picker remains for a retry.
    const onCreateSession = vi.fn(async () => null);
    renderShell(USER, onCreateSession);

    fireEvent.click(await screen.findByTestId('quick-start'));
    await act(async () => {
      fireEvent.click(await screen.findByTestId('tool-picker'));
    });
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));

    expect(screen.getByTestId('tool-picker')).toBeInTheDocument();
    expect(screen.queryByTestId('session-panel')).not.toBeInTheDocument();
  });
});
