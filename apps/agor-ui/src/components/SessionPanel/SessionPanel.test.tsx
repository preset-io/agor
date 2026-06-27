import type { Branch, Session } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
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

function renderPanel(onOpenTerminal = vi.fn()) {
  render(
    <ConnectionProvider value={connected}>
      <AppActionsProvider value={{ onOpenTerminal }}>
        <AntApp>
          <SessionPanel client={null} session={session} branch={branch} open onClose={vi.fn()} />
        </AntApp>
      </AppActionsProvider>
    </ConnectionProvider>
  );
  return { onOpenTerminal };
}

describe('SessionPanel terminal actions', () => {
  it('opens branch terminals with structured branch id routing instead of raw cd input', async () => {
    const { onOpenTerminal } = renderPanel();

    fireEvent.click(screen.getByRole('img', { name: 'ellipsis' }).closest('button')!);
    fireEvent.click(await screen.findByText('Open terminal'));

    expect(onOpenTerminal).toHaveBeenCalledWith([], 'branch-1');
    expect(onOpenTerminal.mock.calls[0][0]).not.toContain(branch.path);
  });
});
