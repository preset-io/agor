import type { AgorClient, Branch, Session, Task } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import SessionPanel from './SessionPanel';

vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: () => <textarea aria-label="Prompt" />,
}));

vi.mock('../FileUpload', () => ({
  FileUpload: () => null,
  FileUploadButton: (props: { onClick?: () => void; disabled?: boolean }) => (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      Upload Files
    </button>
  ),
}));

vi.mock('../ForkSpawnModal/ForkSpawnModal', () => ({
  ForkSpawnModal: () => null,
}));

vi.mock('../MCPServer', () => ({
  MCPServerPill: () => <span>MCP server</span>,
}));

vi.mock('../metadata', () => ({
  CreatedByTag: () => <span>Created by test user</span>,
}));

vi.mock('../Pill', () => ({
  ContextWindowPill: () => <span>Context window</span>,
  TimerPill: () => <span>Timer</span>,
  TokenCountPill: () => <span>Tokens</span>,
}));

vi.mock('../SessionIds', () => ({
  SessionIdsButton: () => <span>Session IDs</span>,
  SessionIdsList: () => <span>Session IDs List</span>,
}));

vi.mock('../ToolIcon', () => ({
  ToolIcon: () => <span>Tool icon</span>,
}));

vi.mock('./SessionAttachmentsDropdown', () => ({
  SessionAttachmentsDropdown: () => null,
}));

vi.mock('./SessionMcpFooterControl', () => ({
  SessionMcpFooterControl: () => null,
}));

vi.mock('./SessionPanelContent', () => ({
  SessionPanelContent: () => <div>Session content</div>,
}));

vi.mock('./SessionRunSettingsPopover', () => ({
  SessionRunSettingsPopover: () => null,
}));

const reactive = vi.hoisted(() => ({ tasks: [] as Task[] }));
vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: () => ({ state: { tasks: reactive.tasks } }),
}));

const connected = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

const session = {
  session_id: 'session-1',
  branch_id: 'branch-1',
  title: 'Terminal routing session',
  agentic_tool: 'claude-code-cli',
  status: 'idle',
  archived: false,
  created_at: '2026-06-24T00:00:00.000Z',
  last_updated: '2026-06-24T00:00:00.000Z',
} as unknown as Session;

const branch = {
  branch_id: 'branch-1',
  board_id: 'board-1',
  name: 'feature/same-name',
  path: '/tmp/feature-same-name',
  filesystem_status: 'ready',
  archived: false,
} as unknown as Branch;

function renderPanel({
  onOpenTerminal = vi.fn(),
  client = null,
  activeSession = session,
}: {
  onOpenTerminal?: ReturnType<typeof vi.fn>;
  client?: AgorClient | null;
  activeSession?: Session;
} = {}) {
  render(
    <ConnectionProvider value={connected}>
      <AppActionsProvider value={{ onOpenTerminal }}>
        <AntApp>
          <SessionPanel
            client={client}
            session={activeSession}
            branch={branch}
            open
            onClose={vi.fn()}
          />
        </AntApp>
      </AppActionsProvider>
    </ConnectionProvider>
  );
  return { onOpenTerminal };
}

describe('SessionPanel terminal actions', () => {
  afterEach(() => {
    reactive.tasks = [];
    vi.restoreAllMocks();
  });

  it('opens branch terminals with structured branch id routing instead of raw cd input', async () => {
    const { onOpenTerminal } = renderPanel();

    fireEvent.click(screen.getByRole('img', { name: 'ellipsis' }).closest('button')!);
    fireEvent.click(await screen.findByText('Open terminal'));

    expect(onOpenTerminal).toHaveBeenCalledWith([], 'branch-1');
    expect(onOpenTerminal.mock.calls[0][0]).not.toContain(branch.path);
  });

  it('surfaces force-fail errors', async () => {
    reactive.tasks = [
      {
        task_id: '018f0000-0000-7000-8000-000000000001',
        status: 'stopping',
        sdk_failure: { termination: 'unverified' },
      } as Task,
    ];
    const create = vi.fn().mockRejectedValue(new Error('denied'));
    vi.spyOn(window, 'prompt').mockReturnValue('018f00000000700080000000');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPanel({
      client: {
        service: () => ({ create, on: vi.fn(), off: vi.fn() }),
      } as unknown as AgorClient,
      activeSession: { ...session, status: 'stopping', agentic_tool: 'codex' },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(
      await screen.findByText('Failed to force-fail execution. You can try again.')
    ).toBeVisible();
  });
});
