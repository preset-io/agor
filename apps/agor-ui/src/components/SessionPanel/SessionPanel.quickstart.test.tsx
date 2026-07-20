// biome-ignore-all lint/plugin/noHardcodedColorLiteral: pins AgentSelectionCard's selected-tile border color to verify the switch-tool highlight
import type { Branch, Session } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import type { AgenticToolOption } from '../../types';
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

const connected = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

const branch = {
  branch_id: 'branch-1',
  board_id: 'board-1',
  name: 'feature/same-name',
  path: '/tmp/feature-same-name',
  filesystem_status: 'ready',
  archived: false,
} as unknown as Branch;

const availableAgents: AgenticToolOption[] = [
  { id: 'claude-code', name: 'Claude Code', icon: '🤖', description: 'Anthropic' },
  { id: 'codex', name: 'Codex', icon: '💻', description: 'OpenAI' },
];

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'session-1',
    branch_id: 'branch-1',
    agentic_tool: 'claude-code',
    status: 'idle',
    archived: false,
    tasks: [],
    created_at: '2026-06-24T00:00:00.000Z',
    last_updated: '2026-06-24T00:00:00.000Z',
    ...overrides,
  } as unknown as Session;
}

function renderPanel(
  session: Session,
  actions: {
    onUpdateSession?: ReturnType<typeof vi.fn>;
    onChooseAgenticTool?: ReturnType<typeof vi.fn>;
  } = {}
) {
  render(
    <ConnectionProvider value={connected}>
      <AppActionsProvider
        value={{
          onUpdateSession: actions.onUpdateSession,
          onChooseAgenticTool: actions.onChooseAgenticTool,
          availableAgents,
        }}
      >
        <AntApp>
          <SessionPanel client={null} session={session} branch={branch} open onClose={vi.fn()} />
        </AntApp>
      </AppActionsProvider>
    </ConnectionProvider>
  );
}

describe('SessionPanel inline title edit', () => {
  it('shows the "Untitled session" placeholder for a session with no title or description', () => {
    renderPanel(makeSession());
    expect(screen.getByText('Untitled session')).toBeInTheDocument();
  });

  it('click-to-edit saves a new title on Enter', () => {
    const onUpdateSession = vi.fn();
    renderPanel(makeSession(), { onUpdateSession });

    fireEvent.click(screen.getByText('Untitled session'));
    const input = screen.getByPlaceholderText('Untitled session');
    fireEvent.change(input, { target: { value: 'My renamed session' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onUpdateSession).toHaveBeenCalledWith('session-1', { title: 'My renamed session' });
  });

  it('Escape cancels without saving', () => {
    const onUpdateSession = vi.fn();
    renderPanel(makeSession({ title: 'Original title' }), { onUpdateSession });

    fireEvent.click(screen.getByText('Original title'));
    const input = screen.getByDisplayValue('Original title');
    fireEvent.change(input, { target: { value: 'Discard me' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onUpdateSession).not.toHaveBeenCalled();
    expect(screen.getByText('Original title')).toBeInTheDocument();
  });
});

describe('SessionPanel switch-tool affordance', () => {
  it('offers "Switch tool…" for a session with zero tasks and creates via the chosen tile', async () => {
    const onChooseAgenticTool = vi.fn();
    renderPanel(makeSession({ tasks: [] }), { onChooseAgenticTool });

    fireEvent.click(screen.getAllByRole('img', { name: 'ellipsis' })[0].closest('button')!);
    fireEvent.click(await screen.findByText('Switch tool…'));

    fireEvent.click(await screen.findByText('Codex'));
    expect(onChooseAgenticTool).toHaveBeenCalledWith('branch-1', 'codex', 'session-1');
  });

  it('hides "Switch tool…" once the session has a task', async () => {
    renderPanel(makeSession({ tasks: ['task-1'] as unknown as Session['tasks'] }), {
      onChooseAgenticTool: vi.fn(),
    });

    fireEvent.click(screen.getAllByRole('img', { name: 'ellipsis' })[0].closest('button')!);
    await screen.findByText('Archive session');
    expect(screen.queryByText('Switch tool…')).not.toBeInTheDocument();
  });

  it("highlights the tile just clicked (not the session's old tool) while the switch is in flight", async () => {
    let resolveChoose: (() => void) | undefined;
    const onChooseAgenticTool = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveChoose = () => resolve('new-session-id');
        })
    );
    // Session's current tool is Claude Code — the old (wrong) behavior
    // highlighted this tile during the switch instead of the one clicked.
    renderPanel(makeSession({ tasks: [], agentic_tool: 'claude-code' }), { onChooseAgenticTool });

    fireEvent.click(screen.getAllByRole('img', { name: 'ellipsis' })[0].closest('button')!);
    fireEvent.click(await screen.findByText('Switch tool…'));
    fireEvent.click(await screen.findByText('Codex'));

    // jsdom's cssstyle can't parse antd's `border` shorthand CSS-variable
    // value alongside a discrete `borderColor` override (unrelated to this
    // fix), so read the raw inline style attribute instead of `toHaveStyle`.
    const codexCard = screen.getByText('Codex').closest('.ant-card') as HTMLElement;
    const claudeCard = screen.getByText('Claude Code').closest('.ant-card') as HTMLElement;
    // token.colorPrimary in the default antd v5 theme (#1677ff).
    expect(codexCard.getAttribute('style')).toContain('border-color: rgb(22, 119, 255)');
    expect(claudeCard.getAttribute('style')).not.toContain('border-color: rgb(22, 119, 255)');

    resolveChoose?.();
    await waitFor(() => expect(onChooseAgenticTool).toHaveBeenCalled());
  });
});
