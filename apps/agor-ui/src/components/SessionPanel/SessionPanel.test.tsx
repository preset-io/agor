import type { AgorClient, Branch, Session, Task } from '@agor-live/client';
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const reactive = vi.hoisted(() => {
  const state = { tasks: [] as Task[] };
  return {
    get tasks() {
      return state.tasks;
    },
    set tasks(tasks: Task[]) {
      state.tasks = tasks;
    },
    useSharedReactiveSession: vi.fn(() => ({ state: { tasks: state.tasks } })),
  };
});
vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: reactive.useSharedReactiveSession,
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

function stopIo() {
  const socket = {
    connected: true,
    timeout: vi.fn(() => socket),
    once: vi.fn(),
    off: vi.fn(),
  };
  return socket;
}

function renderPanel({
  onOpenTerminal = vi.fn(),
  onChooseAgenticTool,
  client = null,
  activeSession = session,
  open = true,
}: {
  onOpenTerminal?: ReturnType<typeof vi.fn>;
  onChooseAgenticTool?: ReturnType<typeof vi.fn>;
  client?: AgorClient | null;
  activeSession?: Session;
  open?: boolean;
} = {}) {
  render(
    <ConnectionProvider value={connected}>
      <AppActionsProvider value={{ onOpenTerminal, onChooseAgenticTool }}>
        <AntApp>
          <SessionPanel
            client={client}
            session={activeSession}
            branch={branch}
            open={open}
            onClose={vi.fn()}
          />
        </AntApp>
      </AppActionsProvider>
    </ConnectionProvider>
  );
  return { onOpenTerminal };
}

const findShortcuts = [
  { label: 'Cmd+F', modifiers: { metaKey: true } },
  { label: 'Ctrl+F', modifiers: { ctrlKey: true } },
] as const;

function pressFind(target: Window | Element, modifiers: { metaKey?: boolean; ctrlKey?: boolean }) {
  const event = createEvent.keyDown(target, {
    key: 'f',
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  const notCancelled = fireEvent(target, event);
  return { event, notCancelled };
}

function getSearchRow() {
  return screen.getByPlaceholderText('Search session...').closest('div[style*="max-height"]');
}

describe.each(findShortcuts)('SessionPanel native $label behavior', ({ modifiers }) => {
  afterEach(() => {
    reactive.tasks = [];
    vi.restoreAllMocks();
  });

  it('does not prevent or replace browser Find while the panel is open', () => {
    renderPanel();
    const searchInput = screen.getByPlaceholderText('Search session...');

    const { event, notCancelled } = pressFind(window, modifiers);

    expect(notCancelled).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(getSearchRow()).toHaveStyle({ maxHeight: '0px' });
    expect(searchInput).not.toHaveFocus();
  });

  it('does not prevent browser Find while the panel is closed', () => {
    renderPanel({ open: false });

    const { event, notCancelled } = pressFind(window, modifiers);

    expect(notCancelled).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not prevent or replace browser Find from the focused composer', () => {
    renderPanel({ activeSession: { ...session, agentic_tool: 'codex' } });
    const composer = screen.getByRole('textbox', { name: 'Prompt' });
    const searchInput = screen.getByPlaceholderText('Search session...');
    composer.focus();

    const { event, notCancelled } = pressFind(composer, modifiers);

    expect(notCancelled).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(getSearchRow()).toHaveStyle({ maxHeight: '0px' });
    expect(searchInput).not.toHaveFocus();
  });

  it('does not prevent browser Find when conversation search is already open', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Search session' }));
    const searchInput = screen.getByPlaceholderText('Search session...');
    await waitFor(() => expect(searchInput).toHaveFocus());

    const { event, notCancelled } = pressFind(searchInput, modifiers);

    expect(notCancelled).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(getSearchRow()).toHaveStyle({ maxHeight: '36px' });
  });

  it('does not prevent or replace browser Find while a modal is open', async () => {
    renderPanel({
      activeSession: { ...session, agentic_tool: 'codex' },
      onChooseAgenticTool: vi.fn(),
    });
    fireEvent.click(screen.getAllByRole('img', { name: 'ellipsis' })[0].closest('button')!);
    fireEvent.click(await screen.findByText('Switch tool…'));
    const dialog = await screen.findByRole('dialog', { name: 'Switch tool' });
    const searchInput = screen.getByPlaceholderText('Search session...');

    const { event, notCancelled } = pressFind(dialog, modifiers);

    expect(notCancelled).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(getSearchRow()).toHaveStyle({ maxHeight: '0px' });
    expect(searchInput).not.toHaveFocus();
  });
});

describe('SessionPanel search control', () => {
  afterEach(() => {
    reactive.tasks = [];
    vi.restoreAllMocks();
  });

  it('keeps session search accessible through its visible native button', async () => {
    renderPanel();
    const searchButton = screen.getByRole('button', { name: 'Search session' });
    expect(searchButton.tagName).toBe('BUTTON');

    searchButton.focus();
    expect(searchButton).toHaveFocus();
    fireEvent.click(searchButton, { detail: 0 });

    expect(getSearchRow()).toHaveStyle({ maxHeight: '36px' });
    const searchInput = screen.getByPlaceholderText('Search session...');
    await waitFor(() => expect(searchInput).toHaveFocus());

    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect(getSearchRow()).toHaveStyle({ maxHeight: '0px' });
  });

  it('retains the same lazy reactive-session cache key as ConversationView', () => {
    renderPanel();

    expect(reactive.useSharedReactiveSession).toHaveBeenLastCalledWith(null, session.session_id, {
      enabled: true,
      reactiveOptions: { taskHydration: 'lazy' },
    });
  });
});

describe('SessionPanel historical runtime handling and terminal actions', () => {
  afterEach(() => {
    reactive.tasks = [];
    vi.restoreAllMocks();
  });

  it('keeps removed-runtime history visible without a prompt composer', () => {
    renderPanel();

    expect(screen.getByText('Historical session — runtime removed')).toBeVisible();
    expect(screen.getByText(/stored conversation remains readable/i)).toBeVisible();
    expect(screen.queryByLabelText('Prompt')).not.toBeInTheDocument();
    expect(screen.getByText('Session content')).toBeVisible();
  });

  it('opens branch terminals with structured branch id routing instead of raw cd input', async () => {
    const { onOpenTerminal } = renderPanel();

    fireEvent.click(screen.getByRole('img', { name: 'ellipsis' }).closest('button')!);
    fireEvent.click(await screen.findByText('Open terminal'));

    expect(onOpenTerminal).toHaveBeenCalledWith([], 'branch-1');
    expect(onOpenTerminal.mock.calls[0][0]).not.toContain(branch.path);
  });

  it('surfaces an initial Stop request failure as retryable', async () => {
    reactive.tasks = [
      {
        task_id: '018f0000-0000-7000-8000-000000000010',
        session_id: session.session_id,
        status: 'running',
      } as Task,
    ];
    const create = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('database scope missing'), { code: 500 }));
    const get = vi.fn().mockRejectedValue(new Error('task read unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPanel({
      client: {
        io: stopIo(),
        service: (path: string) =>
          path === 'tasks'
            ? ({ get, on: vi.fn(), off: vi.fn() } as never)
            : ({
                create,
                find: vi.fn().mockResolvedValue({ data: [] }),
                on: vi.fn(),
                off: vi.fn(),
              } as never),
      } as unknown as AgorClient,
      activeSession: { ...session, status: 'running', agentic_tool: 'codex' },
    });

    fireEvent.click(await screen.findByRole('button', { name: /stop/i }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        expected_task_id: '018f0000-0000-7000-8000-000000000010',
      })
    );
    expect(get).not.toHaveBeenCalled();
    expect(await screen.findByText('Failed to stop execution. You can try again.')).toBeVisible();
  });

  it('reconciles a committed Stop when the Socket.IO acknowledgement is lost without retrying', async () => {
    const taskId = '018f0000-0000-7000-8000-000000000012';
    reactive.tasks = [
      {
        task_id: taskId,
        session_id: session.session_id,
        status: 'running',
      } as Task,
    ];
    const create = vi.fn().mockRejectedValue(new Error('socket disconnected before ack'));
    const get = vi.fn().mockResolvedValue({
      task_id: taskId,
      session_id: session.session_id,
      status: 'stopping',
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-08-29T00:00:00.000Z',
      },
    } as Task);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPanel({
      client: {
        io: stopIo(),
        service: (path: string) =>
          path === 'tasks'
            ? ({ get, on: vi.fn(), off: vi.fn() } as never)
            : ({ create, on: vi.fn(), off: vi.fn() } as never),
      } as unknown as AgorClient,
      activeSession: { ...session, status: 'running', agentic_tool: 'codex' },
    });

    fireEvent.click(await screen.findByRole('button', { name: /stop/i }));

    expect(
      await screen.findByText('Stop was accepted; waiting for executor termination.')
    ).toBeVisible();
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ expected_task_id: taskId });
    expect(get).toHaveBeenCalledWith(taskId);
    expect(
      screen.queryByText('Failed to stop execution. You can try again.')
    ).not.toBeInTheDocument();
  });

  it('distinguishes accepted-but-pending Stop from an initial request failure', async () => {
    reactive.tasks = [
      {
        task_id: '018f0000-0000-7000-8000-000000000011',
        session_id: session.session_id,
        status: 'running',
      } as Task,
    ];
    const create = vi.fn().mockResolvedValue({
      success: false,
      reason: 'Waiting for the daemon that owns the local executor process handle.',
    });
    renderPanel({
      client: {
        io: stopIo(),
        service: () => ({
          create,
          find: vi.fn().mockResolvedValue({ data: [] }),
          on: vi.fn(),
          off: vi.fn(),
        }),
      } as unknown as AgorClient,
      activeSession: { ...session, status: 'running', agentic_tool: 'codex' },
    });

    fireEvent.click(await screen.findByRole('button', { name: /stop/i }));

    expect(
      await screen.findByText('Waiting for the daemon that owns the local executor process handle.')
    ).toBeVisible();
    expect(
      screen.queryByText('Failed to stop execution. You can try again.')
    ).not.toBeInTheDocument();
  });

  it('surfaces force-fail errors', async () => {
    reactive.tasks = [
      {
        task_id: '018f0000-0000-7000-8000-000000000001',
        status: 'stopping',
        sdk_failure: { termination: 'unverified' },
        termination_request: {
          cause: 'user_stop',
          requested_at: '2026-06-24T00:00:01.000Z',
        },
      } as Task,
    ];
    const create = vi.fn().mockRejectedValue(new Error('denied'));
    const nativePrompt = vi.spyOn(window, 'prompt');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPanel({
      client: {
        service: () => ({ create, on: vi.fn(), off: vi.fn() }),
      } as unknown as AgorClient,
      activeSession: { ...session, status: 'stopping', agentic_tool: 'codex' },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    expect(await screen.findByRole('dialog', { name: 'Force-fail task?' })).toBeInTheDocument();
    expect(screen.getByText('Executor termination is unverified')).toBeInTheDocument();
    expect(screen.getByText(/cannot prove or guarantee process termination/i)).toBeInTheDocument();
    const forceFail = screen.getByRole('button', { name: 'Force fail' });
    expect(forceFail).toBeDisabled();
    const confirmation = screen.getByRole('textbox', {
      name: 'Type STOP to confirm force-fail',
    });
    await waitFor(() => expect(confirmation).toHaveFocus());
    fireEvent.change(confirmation, { target: { value: 'STOP' } });
    expect(forceFail).toBeEnabled();
    fireEvent.keyDown(confirmation, { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith({
      force_unverified: true,
      confirmation: 'STOP',
      task_id: '018f0000-0000-7000-8000-000000000001',
      termination_requested_at: '2026-06-24T00:00:01.000Z',
    });
    expect(nativePrompt).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Failed to force-fail execution. You can try again.')
    ).toBeVisible();
  });
});
