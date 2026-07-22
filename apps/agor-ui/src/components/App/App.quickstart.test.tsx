import type { Board, Branch, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { forwardRef } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
// resolved. A lightweight stand-in lets us assert it did (or did not) appear.
vi.mock('../SessionPanel/PendingToolChoicePanel', () => ({
  PendingToolChoicePanel: () => <div data-testid="tool-picker" />,
}));

vi.mock('../AppHeader', () => ({ AppHeader: () => null }));
vi.mock('../BoardTeammatePanel', () => ({ BoardTeammatePanel: () => null }));
vi.mock('../HomePage', () => ({ HomePage: () => null }));
vi.mock('../SessionPanel', () => ({ SessionPanel: () => null }));
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

function renderShell(user: User, onCreateSession = vi.fn(async () => 'new-session-id')) {
  render(
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
                availableAgents={AVAILABLE_AGENTS}
                initialBoardId={BOARD_ID}
                onCreateSession={onCreateSession}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </AntApp>
  );
  return { onCreateSession };
}

describe('App quick-start — always shows the tool picker', () => {
  beforeEach(() => {
    seedStore();
  });

  it('opens the tile picker without creating a session', async () => {
    const user = {
      user_id: 'u1',
      name: 'User',
      email: 'u@example.test',
      preferences: {},
    } as unknown as User;
    const { onCreateSession } = renderShell(user);

    fireEvent.click(await screen.findByTestId('quick-start'));

    await waitFor(() => expect(screen.getByTestId('tool-picker')).toBeInTheDocument());
    expect(onCreateSession).not.toHaveBeenCalled();
  });
});
