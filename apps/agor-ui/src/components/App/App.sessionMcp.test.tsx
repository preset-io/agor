import type { MCPServer, User } from '@agor-live/client';
import { sessionPath } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import {
  CONNECTED,
  deferred,
  fakeFeathersClient,
  makeBoard,
  makeBranch,
  makeSession,
  withTestAuthority,
} from '../../test/harness';
import { SessionPage } from '../mobile/SessionPage';
import { App } from './App';

// Keep the complete read -> App/SessionPage -> SessionPanel -> SessionFooter ->
// SessionMcpFooterControl chain real. Only unrelated surfaces/transport are stubbed.
vi.mock('../SessionCanvas', () => ({ SessionCanvas: () => null }));
vi.mock('../AppHeader', () => ({ AppHeader: () => null }));
vi.mock('../BoardTeammatePanel', () => ({
  BoardTeammatePanel: () => null,
  TeammatePanelRail: () => null,
}));
vi.mock('../HomePage', () => ({ HomePage: () => null }));
vi.mock('../EventStreamPanel', () => ({ EventStreamPanel: () => null }));
vi.mock('../SettingsModal', () => ({ SettingsModal: () => null, UserSettingsModal: () => null }));
vi.mock('../BranchModal', () => ({ BranchModal: () => null }));
vi.mock('../CreateModals', () => ({ CreateModals: () => null }));
vi.mock('../NewSessionModal', () => ({ NewSessionModal: () => null }));
vi.mock('../SessionSettingsModal', () => ({ SessionSettingsModal: () => null }));
vi.mock('../TerminalModal', () => ({ TerminalModal: () => null, WEB_TERMINAL_MIN_ROLE: 'member' }));
vi.mock('../ThemeEditorModal', () => ({ ThemeEditorModal: () => null }));
vi.mock('../EnvironmentLogsModal', () => ({ EnvironmentLogsModal: () => null }));
vi.mock('../../hooks/useTaskCompletionChime', () => ({ useTaskCompletionChime: () => {} }));
vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: () => ({ state: null, handle: null }),
}));
vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({ isAdmin: true, role: 'admin', hasRole: () => true }),
}));
const viewport = vi.hoisted(() => ({ isMobile: false }));
vi.mock('../../hooks/useIsMobileViewport', () => ({
  useIsMobileViewport: () => viewport.isMobile,
}));
vi.mock('../SessionPanel/SessionPanelContent', () => ({ SessionPanelContent: () => null }));
vi.mock('../SessionPanel/SessionAttachmentsDropdown', () => ({
  SessionAttachmentsDropdown: () => null,
}));
vi.mock('../SessionPanel/SessionRunSettingsPopover', () => ({
  SessionRunSettingsPopover: () => null,
}));
vi.mock('../AutocompleteTextarea', () => ({ AutocompleteTextarea: () => null }));
vi.mock('../ForkSpawnModal/ForkSpawnModal', () => ({ ForkSpawnModal: () => null }));
vi.mock('../FileUpload', () => ({ FileUpload: () => null, FileUploadButton: () => null }));
vi.mock('react-resizable-panels', async () => {
  const React = await import('react');
  const Panel = React.forwardRef<unknown, { children?: React.ReactNode }>(({ children }, ref) => {
    React.useImperativeHandle(ref, () => ({ collapse() {}, expand() {}, resize() {} }), []);
    return <div>{children}</div>;
  });
  return {
    Panel,
    PanelGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    PanelResizeHandle: () => null,
  };
});

const sessionId = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f';
const user = { user_id: 'admin', role: 'admin', name: 'Admin', preferences: {} } as User;
const board = makeBoard();
const branch = makeBranch('branch-a');
const session = makeSession(sessionId, branch.branch_id, {
  agentic_tool: 'codex',
  created_by: user.user_id,
});
const server = {
  mcp_server_id: '01900000-0000-7000-8000-000000000021',
  name: 'shared-tools',
  display_name: 'Shared tools',
  transport: 'http',
  scope: 'session',
  enabled: true,
  auth: { type: 'none' },
} as MCPServer;

describe('session footer MCP read recovery through its owning surfaces', () => {
  withTestAuthority('admin:admin:1');
  beforeEach(() => {
    localStorage.clear();
    agorStore.setState({
      boardById: new Map([[board.board_id, board]]),
      branchById: new Map([[branch.branch_id, branch]]),
      sessionById: new Map([[sessionId, session]]),
      sessionsByBranch: new Map([[branch.branch_id, [session]]]),
      userById: new Map([[user.user_id, user]]),
      mcpServerById: new Map([[server.mcp_server_id, server]]),
    });
  });

  async function expectRecovery(surface: 'desktop App/SessionPanel' | 'mobile SessionPage') {
    viewport.isMobile = surface === 'mobile SessionPage';
    const retryRead = deferred<Array<{ session_id: string; mcp_server_id: string }>>();
    const findLinks = vi
      .fn()
      .mockRejectedValueOnce(new Error('read unavailable'))
      .mockReturnValueOnce(retryRead.promise);
    const fake = fakeFeathersClient({
      'session-mcp-servers': { find: findLinks },
      [`sessions/${sessionId}/mcp-servers`]: { find: () => [server] },
    });
    const path = viewport.isMobile ? `/m/session/${sessionId}` : sessionPath(session.session_id);
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <AntApp>
          <ConnectionProvider value={CONNECTED}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route
                  path="/s/:sessionShortId/"
                  element={
                    <App
                      client={fake.client}
                      user={user}
                      connected
                      availableAgents={[]}
                      initialBoardId={board.board_id}
                    />
                  }
                />
                <Route
                  path="/m/session/:sessionId"
                  element={
                    <SessionPage
                      client={fake.client}
                      sessionById={agorStore.getState().sessionById}
                      branchById={agorStore.getState().branchById}
                      boardById={agorStore.getState().boardById}
                      currentUser={user}
                      onForkSession={vi.fn()}
                      onBtwForkSession={vi.fn()}
                      onSpawnSession={vi.fn()}
                      onUpdateSession={vi.fn()}
                      onDeleteSession={vi.fn()}
                    />
                  }
                />
              </Routes>
            </MemoryRouter>
          </ConnectionProvider>
        </AntApp>
      </ConfigProvider>
    );
    fireEvent.click(await screen.findByRole('button', { name: /^MCP servers\./ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Session MCP servers' }));
    const retry = await dialog.findByRole('button', { name: 'Retry' });
    expect(dialog.getByText('MCP servers unavailable')).toBeInTheDocument();
    expect(dialog.getByRole('combobox')).toBeDisabled();
    expect(agorStore.getState().sessionMcpLoaded.has(sessionId)).toBe(false);
    fireEvent.keyDown(dialog.getByRole('combobox'), { key: 'Enter' });
    expect(fake.callsTo(`sessions/${sessionId}/mcp-servers`, 'create')).toHaveLength(0);
    expect(fake.callsTo(`sessions/${sessionId}/mcp-servers`, 'remove')).toHaveLength(0);

    fireEvent.click(retry);
    await waitFor(() => expect(findLinks).toHaveBeenCalledTimes(2));
    expect(fake.queries('session-mcp-servers', 'find')).toEqual([
      { session_id: sessionId },
      { session_id: sessionId },
    ]);
    expect(dialog.getByRole('combobox')).toBeDisabled();
    expect(agorStore.getState().sessionMcpLoaded.has(sessionId)).toBe(false);
    await act(async () => {
      retryRead.resolve([{ session_id: sessionId, mcp_server_id: server.mcp_server_id }]);
    });
    await waitFor(() => expect(dialog.getByRole('combobox')).not.toBeDisabled());
    expect(dialog.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(agorStore.getState().sessionMcpLoaded.has(sessionId)).toBe(true);
    expect(agorStore.getState().sessionMcpServerIds.get(sessionId)).toEqual([server.mcp_server_id]);
    expect(fake.callsTo(`sessions/${sessionId}/mcp-servers`, 'create')).toHaveLength(0);
    expect(fake.callsTo(`sessions/${sessionId}/mcp-servers`, 'remove')).toHaveLength(0);
  }

  // These mount the shell plus the real Ant Design composer/picker, not just
  // one control. Allow for their cold-mount cost on loaded CI workers.
  it('desktop App/SessionPanel shows footer Retry after a rejected MCP read, blocks edits and recovers', async () => {
    await expectRecovery('desktop App/SessionPanel');
  }, 30_000);

  it('mobile SessionPage shows footer Retry after a rejected MCP read, blocks edits and recovers', async () => {
    await expectRecovery('mobile SessionPage');
  }, 30_000);
});
