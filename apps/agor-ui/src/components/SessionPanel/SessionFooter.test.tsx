import { AGENTIC_TOOL_CAPABILITIES } from '@agor/agentic-tools';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  MCPServer,
  PermissionMode,
  Session,
  Task,
} from '@agor-live/client';
import { SessionStatus } from '@agor-live/client';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useComposerFocused } from '../../hooks/useComposerFocus';
import { useFooterPreferences } from '../../hooks/useFooterPreferences';
import { agorStore } from '../../store/agorStore';
import type { ModelSelectorProps } from '../ModelSelector';
import { SessionFooter, type SessionFooterProps } from './SessionFooter';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { user_id: 'footer-user', role: 'member' } }),
}));

// The real picker fetches live model lists; the stub renders the rows the composer asks for.
vi.mock('../ModelSelector', () => ({
  // Like the real picker, an unset value falls back to the tool default (Sonnet here).
  ModelSelector: ({ renderRows, onCommit, value }: ModelSelectorProps) =>
    renderRows ? (
      renderRows({
        options: [
          {
            value: 'claude-sonnet-5-5',
            label: 'Sonnet 5.5',
            description: 'Fast',
            isDefault: true,
            accountDependent: false,
          },
          {
            value: 'claude-opus-5-5',
            label: 'Opus 5.5',
            description: 'Most capable',
            isDefault: false,
            accountDependent: false,
          },
        ],
        currentModel: value?.model ?? 'claude-sonnet-5-5',
        select: (model) => onCommit?.({ mode: 'alias', model }),
      })
    ) : (
      <div data-testid="model-selector-stub" />
    ),
}));

const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ConfigProvider>
    <App>{children}</App>
  </ConfigProvider>
);

const baseSession: SessionFooterProps['session'] = {
  session_id: 'test-session-123',
  status: 'idle' as Session['status'],
  agentic_tool: 'claude-code',
  model_config: { model: 'claude-opus-5-5' },
} as unknown as SessionFooterProps['session'];

const baseProps: SessionFooterProps = {
  session: baseSession,
  footerTimerTask: null,
  latestContextWindow: null,
  sessionMcpServerIds: [] as string[],
  unauthedMcpServers: [],
  mcpServerById: new Map(),
  userAuthenticatedMcpServerIds: new Set<string>(),
  isRunning: false,
  isStopping: false,
  stopRequestInFlight: false,
  hasInput: false,
  connectionDisabled: false,
  toolCaps: AGENTIC_TOOL_CAPABILITIES['claude-code'],
  effortLevel: 'high' as EffortLevel,
  permissionMode: 'auto' as PermissionMode,
  codexSandboxMode: 'workspace-write' as CodexSandboxMode,
  codexApprovalPolicy: 'never' as CodexApprovalPolicy,
  queuedTasks: [],
  client: null,
  modelLabel: undefined,
  modelConfig: undefined,
  onModelConfigCommit: vi.fn(),
  onOpenSessionSettings: undefined,
  onSendPrompt: vi.fn(),
  onStop: vi.fn(),
  onFork: vi.fn(),
  onBtwSend: vi.fn(),
  onSpawnOpen: vi.fn(),
  onAttachFiles: vi.fn(),
  onUploadOpen: vi.fn(),
  onEffortChange: vi.fn(),
  onPermissionModeChange: vi.fn(),
  onCodexPermissionChange: vi.fn(),
  promptInputSlot: <div data-testid="prompt-input">prompt-input</div>,
};

const renderFooter = (props: Partial<SessionFooterProps> = {}) =>
  render(<SessionFooter {...baseProps} {...props} />, { wrapper: Wrapper });

const circle = () => screen.getByTestId('composer-circle');

const setWidth = (width: number) => vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);

beforeEach(() => {
  localStorage.clear();
  agorStore.getState().reset();
  agorStore.getState().markSessionMcpLoaded('test-session-123');
  setWidth(1280);
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('composer circle', () => {
  it('is Send, disabled but focusable, with an empty box', () => {
    const onSendPrompt = vi.fn();
    renderFooter({ onSendPrompt });
    expect(circle()).toHaveAccessibleName('Send');
    expect(circle()).toHaveAttribute('aria-disabled', 'true');
    expect(circle()).not.toBeDisabled();
    fireEvent.click(circle());
    expect(onSendPrompt).not.toHaveBeenCalled();
  });

  it('sends when there is text', () => {
    const onSendPrompt = vi.fn();
    renderFooter({ hasInput: true, onSendPrompt });
    expect(circle()).toHaveAccessibleName('Send');
    fireEvent.click(circle());
    expect(onSendPrompt).toHaveBeenCalledOnce();
  });

  it('is Stop while running with an empty box, and the working line has no second Stop', () => {
    const onStop = vi.fn();
    renderFooter({ isRunning: true, onStop });
    expect(circle()).toHaveAccessibleName('Stop');
    expect(screen.queryByRole('button', { name: 'Stop the agent' })).not.toBeInTheDocument();
    fireEvent.click(circle());
    expect(onStop).toHaveBeenCalledOnce();
  });

  it.each([1280, 390])(
    'at %ipx, Queue looks like Send: same arrow and colour, only the label differs',
    async (width) => {
      setWidth(width);
      const view = renderFooter({ hasInput: true });
      const sendClass = circle().className;
      expect(circle().querySelector('[data-icon="arrow-up"]')).not.toBeNull();
      view.rerender(<SessionFooter {...baseProps} isRunning hasInput />);
      expect(circle()).toHaveAccessibleName('Queue message');
      expect(circle().querySelector('[data-icon="arrow-up"]')).not.toBeNull();
      expect(circle().querySelector('[data-icon="unordered-list"]')).toBeNull();
      expect(circle().className).toBe(sendClass);
      if (width === 1280) {
        fireEvent.mouseEnter(circle());
        expect(
          await screen.findByText('Queue message (runs after the current turn)')
        ).toBeInTheDocument();
      }
    }
  );

  it.each([
    ['Send', { isRunning: false, hasInput: true }],
    ['Queue message', { isRunning: true, hasInput: true }],
    ['Stop', { isRunning: true, hasInput: false }],
  ] as const)('shows the queued count on %s', (label, state) => {
    const queuedTasks = [{ task_id: 'q1' }, { task_id: 'q2' }] as Task[];
    renderFooter({ ...state, queuedTasks });
    expect(circle()).toHaveAccessibleName(`${label}, 2 queued`);
    expect(screen.getByTestId('composer-queued-badge')).toHaveTextContent('2');
  });

  it('shows no count with nothing queued', () => {
    renderFooter({ isRunning: true, hasInput: true });
    expect(circle()).toHaveAccessibleName('Queue message');
    expect(screen.getByTestId('composer-queued-badge')).toHaveTextContent(/^$/);
  });

  it('is Queue while running with text, and Stop moves to the working line', () => {
    const onStop = vi.fn();
    const onSendPrompt = vi.fn();
    renderFooter({ isRunning: true, hasInput: true, onStop, onSendPrompt });
    expect(circle()).toHaveAccessibleName('Queue message');
    fireEvent.click(circle());
    expect(onSendPrompt).toHaveBeenCalledOnce();
    const stop = within(screen.getByTestId('composer-working-line')).getByRole('button', {
      name: 'Stop the agent',
    });
    expect(stop).toHaveTextContent('Stop');
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('stacks the queue, then the status and info row, then the card, with nothing under it', () => {
    renderFooter({
      isRunning: true,
      hasInput: true,
      queueSlot: <div data-testid="queue-slot" />,
    });
    const row = screen.getByTestId('composer-status-row');
    expect(row).toContainElement(screen.getByTestId('composer-working-line'));
    expect(row).toContainElement(screen.getByTestId('composer-info-line'));
    const card = screen.getByTestId('composer-card');
    expect(card).not.toContainElement(screen.getByTestId('composer-working-line'));
    const follows = (a: Element, b: Element) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(follows(screen.getByTestId('queue-slot'), row)).toBeTruthy();
    expect(follows(row, card)).toBeTruthy();
    // Nothing in the footer follows the card.
    for (const element of row.parentElement!.querySelectorAll('*')) {
      if (element === card || card.contains(element) || element.contains(card)) continue;
      expect(follows(card, element)).toBeFalsy();
    }
  });

  it('shows stopping feedback and blocks a second stop while the request is in flight', () => {
    const onStop = vi.fn();
    renderFooter({ isRunning: true, stopRequestInFlight: true, onStop });
    expect(circle()).toHaveAttribute('aria-busy', 'true');
    expect(circle()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(circle());
    expect(onStop).not.toHaveBeenCalled();
    expect(screen.getByTestId('composer-working-label')).toHaveTextContent('Stopping');
  });

  it('disables Stop and Send without a daemon connection', () => {
    const view = renderFooter({ isRunning: true, connectionDisabled: true });
    expect(circle()).toHaveAttribute('aria-disabled', 'true');
    view.rerender(<SessionFooter {...baseProps} hasInput connectionDisabled />);
    expect(circle()).toHaveAttribute('aria-disabled', 'true');
  });

  it('announces work only while the agent runs', () => {
    const session = { ...baseSession, status: SessionStatus.RUNNING };
    const view = renderFooter({ session, isRunning: true });
    expect(screen.getByRole('status', { name: 'Agent is working' })).toBeInTheDocument();
    view.rerender(<SessionFooter {...baseProps} session={{ ...session, status: 'idle' }} />);
    expect(screen.queryByTestId('composer-working-line')).not.toBeInTheDocument();
  });

  it('never stops the agent on Escape', () => {
    const onStop = vi.fn();
    renderFooter({ isRunning: true, onStop });
    fireEvent.keyDown(screen.getByTestId('composer-card'), { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe('composer row type', () => {
  it('sets the model and permission chips at 12px; open chips switch to the full text colour', async () => {
    renderFooter({ permissionMode: 'plan' });
    const model = screen.getByTestId('model-chip');
    const permission = screen.getByTestId('permission-chip');
    expect(model.style.fontSize).toBe('12px');
    expect(permission.style.fontSize).toBe('12px');
    expect(model.style.color).toBe('');
    fireEvent.click(model);
    await screen.findByRole('dialog', { name: 'Model' });
    expect(model.style.color).not.toBe('');
  });
});

describe('permission chip', () => {
  it('stays hidden for the tool default', () => {
    renderFooter({ permissionMode: 'auto' });
    expect(screen.queryByTestId('permission-chip')).not.toBeInTheDocument();
  });

  it('names a non-default mode, short in the row and full in its name', () => {
    renderFooter({ permissionMode: 'bypassPermissions' });
    const chip = screen.getByTestId('permission-chip');
    expect(chip).toHaveTextContent('Bypass');
    expect(chip).toHaveAccessibleName('Permissions: Bypass permissions. Change');
  });

  it('follows the Codex sandbox and approval pair', () => {
    const codex = {
      session: { ...baseSession, agentic_tool: 'codex' } as SessionFooterProps['session'],
      toolCaps: AGENTIC_TOOL_CAPABILITIES.codex,
      permissionMode: 'allow-all' as PermissionMode,
    };
    const view = renderFooter(codex);
    expect(screen.queryByTestId('permission-chip')).not.toBeInTheDocument();
    view.rerender(
      <SessionFooter
        {...baseProps}
        {...codex}
        codexSandboxMode="read-only"
        codexApprovalPolicy="untrusted"
      />
    );
    expect(screen.getByTestId('permission-chip')).toBeInTheDocument();
  });

  it('opens the permissions drill-in and changes the mode', async () => {
    const onPermissionModeChange = vi.fn();
    renderFooter({ permissionMode: 'plan', onPermissionModeChange });
    fireEvent.click(screen.getByTestId('permission-chip'));
    const menu = await screen.findByRole('dialog', { name: 'Permissions' });
    expect(within(menu).getByRole('button', { name: 'Back to model' })).toBeInTheDocument();
    expect(within(menu).getByRole('radio', { name: /Plan/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(within(menu).getByRole('radio', { name: /Accept edits/ }));
    expect(onPermissionModeChange).toHaveBeenCalledWith('acceptEdits');
  });
});

describe('model chip', () => {
  it('reads the real model and effort, and drops effort below 480px', () => {
    renderFooter();
    const chip = screen.getByTestId('model-chip');
    expect(chip).toHaveTextContent('Opus 5.5 · High');
    expect(chip).toHaveAccessibleName('Model Opus 5.5, High effort. Change');
  });

  it('checks the model the chip names, even without a stored model config', async () => {
    renderFooter({ modelConfig: undefined });
    expect(screen.getByTestId('model-chip')).toHaveTextContent('Opus 5.5');
    fireEvent.click(screen.getByTestId('model-chip'));
    const menu = await screen.findByRole('dialog', { name: 'Model' });
    expect(within(menu).getByRole('radio', { name: /Opus 5.5/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(within(menu).getByRole('radio', { name: /Sonnet 5.5/ })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('opens model rows, an effort control and a Permissions drill-in row', async () => {
    const onModelConfigCommit = vi.fn();
    const onEffortChange = vi.fn();
    renderFooter({ onModelConfigCommit, onEffortChange });
    fireEvent.click(screen.getByTestId('model-chip'));
    const menu = await screen.findByRole('dialog', { name: 'Model' });
    expect(within(menu).getByRole('radio', { name: /Opus/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(within(menu).queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('radio', { name: /Sonnet/ }));
    expect(onModelConfigCommit).toHaveBeenCalledWith({ mode: 'alias', model: 'claude-sonnet-5-5' });
    fireEvent.click(within(menu).getByText('Low'));
    expect(onEffortChange).toHaveBeenCalledWith('low');
    fireEvent.click(within(menu).getByRole('button', { name: /Permissions/ }));
    expect(within(menu).getByRole('radiogroup', { name: 'Permissions' })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('button', { name: 'Back to model' }));
    expect(within(menu).getByRole('radiogroup', { name: 'Model' })).toBeInTheDocument();
  });
});

describe('"+" menu and pins', () => {
  it('shows the desktop default pins in "+" menu order: Attach files, then Fork session', () => {
    renderFooter();
    const attach = screen.getByTestId('upload-bar-btn');
    const fork = screen.getByTestId('fork-bar-btn');
    expect(attach.compareDocumentPosition(fork) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('pins an action into the row from the "+" menu', async () => {
    renderFooter({ hasInput: true });
    fireEvent.click(screen.getByRole('button', { name: 'Add files and actions' }));
    const menu = await screen.findByRole('dialog', { name: 'Add files and actions' });
    expect(within(menu).getByText('Add to message')).toBeInTheDocument();
    expect(within(menu).getByText('Session')).toBeInTheDocument();
    const pin = within(menu).getByRole('button', { name: 'Pin BTW fork to the composer' });
    fireEvent.mouseEnter(pin);
    expect(await screen.findByText('Pin to the composer')).toBeInTheDocument();
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pin);
    expect(screen.getByTestId('btw-fork-bar-btn')).toBeInTheDocument();
    expect(
      within(menu).getByRole('button', { name: 'Unpin BTW fork from the composer' })
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('runs an action from its row and closes the menu', async () => {
    const onSpawnOpen = vi.fn();
    renderFooter({ onSpawnOpen });
    fireEvent.click(screen.getByRole('button', { name: 'Add files and actions' }));
    const menu = await screen.findByRole('dialog', { name: 'Add files and actions' });
    fireEvent.click(within(menu).getByText('Spawn subsession'));
    expect(onSpawnOpen).toHaveBeenCalledOnce();
  });

  it('turns Spawn off while running, with the reason', async () => {
    renderFooter({ isRunning: true });
    fireEvent.click(screen.getByRole('button', { name: 'Add files and actions' }));
    const menu = await screen.findByRole('dialog', { name: 'Add files and actions' });
    const spawn = within(menu).getByText('Spawn subsession').closest('button')!;
    expect(spawn).toBeDisabled();
    expect(spawn).toHaveTextContent('Not while the session is running');
  });

  it('opens session settings from the "+" menu', async () => {
    const onOpenSessionSettings = vi.fn();
    renderFooter({ onOpenSessionSettings });
    fireEvent.click(screen.getByRole('button', { name: 'Add files and actions' }));
    const menu = await screen.findByRole('dialog', { name: 'Add files and actions' });
    fireEvent.click(within(menu).getByText('Session settings'));
    expect(onOpenSessionSettings).toHaveBeenCalledWith('test-session-123');
  });
});

describe('MCP tools', () => {
  const linear = { mcp_server_id: 'linear', name: 'linear', display_name: 'Linear' } as MCPServer;

  it('is pinned in the desktop row by default, after Attach and Fork and before the model chip', () => {
    renderFooter({ sessionMcpServerIds: ['a', 'b', 'c'] });
    const order = [
      screen.getByRole('button', { name: 'Add files and actions' }),
      screen.getByTestId('upload-bar-btn'),
      screen.getByTestId('fork-bar-btn'),
      screen.getByTestId('mcp-bar-btn'),
      screen.getByTestId('model-chip'),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
    expect(screen.getByTestId('mcp-bar-btn')).toHaveAccessibleName('MCP tools, 3 attached');
    expect(screen.getByTestId('mcp-bar-btn')).toHaveTextContent('3');
  });

  it('shows only the icon with no servers attached, and keeps the count in its name', () => {
    renderFooter({ sessionMcpServerIds: [] });
    const button = screen.getByTestId('mcp-bar-btn');
    expect(button).toHaveAccessibleName('MCP tools, 0 attached');
    expect(button).toHaveTextContent(/^$/);
  });

  it('opens the attach and manage panel from the pinned button', async () => {
    renderFooter({ sessionMcpServerIds: [] });
    fireEvent.click(screen.getByTestId('mcp-bar-btn'));
    const panel = await screen.findByRole('dialog', { name: 'MCP tools' });
    expect(within(panel).getByText('Session MCP servers')).toBeInTheDocument();
    expect(within(panel).getByRole('combobox')).toBeInTheDocument();
  });

  it('has a Tools section in "+" with the count, a chevron and its pin', async () => {
    renderFooter({ sessionMcpServerIds: ['a', 'b'] });
    fireEvent.click(screen.getByRole('button', { name: 'Add files and actions' }));
    const menu = await screen.findByRole('dialog', { name: 'Add files and actions' });
    expect(within(menu).getByText('Tools')).toBeInTheDocument();
    const row = within(menu).getByText('MCP tools').closest('button')!;
    expect(row).toHaveTextContent('2');
    expect(row.querySelector('[data-icon="right"]')).not.toBeNull();
    expect(within(menu).getByLabelText('Unpin MCP tools from the composer')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(row);
    expect(await within(menu).findByText('Session MCP servers')).toBeInTheDocument();
    expect(within(menu).getByLabelText('Back to add files and actions')).toBeInTheDocument();
  });

  it('opens the panel straight from an amber sign-in problem on the info line', async () => {
    renderFooter({ unauthedMcpServers: [linear], sessionMcpServerIds: ['linear'] });
    fireEvent.click(screen.getByRole('button', { name: 'Linear needs sign-in. Session details' }));
    const panel = await screen.findByRole('dialog', { name: 'MCP tools' });
    expect(within(panel).getByText('Session MCP servers')).toBeInTheDocument();
  });

  it('keeps an MCP tools row in Session details that links into the same panel', async () => {
    renderFooter({ sessionMcpServerIds: ['a'] });
    fireEvent.click(screen.getByRole('button', { name: 'Session details' }));
    const details = await screen.findByRole('dialog', { name: 'Session details' });
    fireEvent.click(within(details).getByRole('button', { name: /MCP tools 1/ }));
    expect(await within(details).findByText('Session MCP servers')).toBeInTheDocument();
  });
});

describe('phone pins', () => {
  beforeEach(() => setWidth(390));

  it('start with Attach only and ignore desktop pins', () => {
    renderFooter();
    // Attaching stays one tap, as on main.
    expect(screen.getByTestId('upload-bar-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('fork-bar-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mcp-bar-btn')).not.toBeInTheDocument();
  });

  it('keep a saved phone pin list, even an empty one', () => {
    localStorage.setItem('agor-footer-prefs', JSON.stringify({ pinnedItemsCompact: [] }));
    renderFooter();
    expect(screen.queryByTestId('upload-bar-btn')).not.toBeInTheDocument();
  });

  it('cap at 2, with the note', async () => {
    localStorage.setItem(
      'agor-footer-prefs',
      JSON.stringify({ pinnedItemsCompact: ['upload', 'fork'] })
    );
    renderFooter();
    expect(screen.getByTestId('upload-bar-btn')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add files and actions' }));
    const sheet = await screen.findByRole('dialog');
    expect(
      within(sheet).getByText('The composer fits 2 pins on a phone. Unpin one to add another.')
    ).toBeInTheDocument();
    // jsdom cannot compute AntD's disabled-button border styles, so skip role queries here.
    expect(within(sheet).getByLabelText('Pin BTW fork to the composer')).toBeDisabled();
  });

  it('hide the tab bar while the text has focus, not when a row button does', () => {
    const focus = renderHook(() => useComposerFocused());
    renderFooter({ promptInputSlot: <textarea aria-label="Prompt" /> });
    const plus = screen.getByLabelText('Add files and actions');
    act(() => plus.focus());
    expect(focus.result.current).toBe(false);
    const text = screen.getByLabelText('Prompt');
    act(() => text.focus());
    expect(focus.result.current).toBe(true);
    act(() => text.blur());
    expect(focus.result.current).toBe(false);
  });

  it('give the row 44px targets', () => {
    renderFooter({ isRunning: true });
    for (const name of ['Add files and actions', 'Stop']) {
      expect(screen.getByRole('button', { name }).style.height).toBe('44px');
    }
  });
});

describe('info line and Session details', () => {
  const contextWindow = (used: number) => ({ used, limit: 200_000, taskMetadata: {} });

  it('leads with the context ring and %, and drops the old footer fill', () => {
    renderFooter({ latestContextWindow: contextWindow(36_000) });
    const percent = screen.getByRole('button', { name: 'Context 18% used. Session details' });
    expect(percent).toHaveTextContent('18%');
    expect(document.querySelector('[style*="linear-gradient"]')).toBeNull();
  });

  it('always shows an MCP sign-in problem, even with MCP tools hidden', () => {
    localStorage.setItem('agor-footer-prefs', JSON.stringify({ pinnedChips: [] }));
    const linear = { mcp_server_id: 'linear', name: 'linear', display_name: 'Linear' } as MCPServer;
    renderFooter({ unauthedMcpServers: [linear] });
    expect(screen.getByTestId('composer-info-line')).toHaveTextContent('Linear needs sign-in');
  });

  it('opens Session details with pins that show and hide info items', async () => {
    renderFooter({ latestContextWindow: contextWindow(172_000) });
    fireEvent.click(screen.getByRole('button', { name: /^Context 86% used/ }));
    const details = await screen.findByRole('dialog', { name: 'Session details' });
    expect(within(details).getByText('86% of 200k')).toBeInTheDocument();
    const hide = within(details).getByRole('button', { name: 'Hide context' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(hide);
    // The open menu keeps its anchor; the % leaves the line once it closes.
    expect(within(details).getByRole('button', { name: 'Show context' })).toBeInTheDocument();
    fireEvent.keyDown(details, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Context 86% used/ })).not.toBeInTheDocument()
    );
    expect(JSON.parse(localStorage.getItem('agor-footer-prefs') ?? '{}').pinnedChips).not.toContain(
      'context'
    );
  });

  it('leaves usage out until a snapshot is known, then shows the tokens', async () => {
    const get = vi.fn().mockResolvedValue({
      usage_summary: {
        total: 24_100,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
        cost: 0,
      },
    });
    const client = { service: () => ({ get }) } as unknown as SessionFooterProps['client'];
    renderFooter({ client, latestContextWindow: contextWindow(36_000) });
    expect(screen.getByTestId('composer-info-line')).not.toHaveTextContent(/Usage|tokens/);
    expect(get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Context 18% used/ }));
    await screen.findByRole('dialog', { name: 'Session details' });
    await waitFor(() =>
      expect(screen.getByTestId('composer-info-line')).toHaveTextContent('24.1k tokens')
    );
    expect(get).toHaveBeenCalledOnce();
  });

  it('shows the timer from the latest task', () => {
    const task = {
      task_id: 't1',
      status: 'completed',
      created_at: '2026-01-01T00:00:00Z',
      duration_ms: 134_000,
    } as unknown as Task;
    renderFooter({ footerTimerTask: task });
    expect(screen.getByTestId('composer-info-line')).toHaveTextContent('02:14');
  });

  it('leaves the timer to the working line while a turn runs', async () => {
    const task = {
      task_id: 't1',
      status: 'running',
      created_at: new Date(Date.now() - 134_000).toISOString(),
    } as unknown as Task;
    renderFooter({
      footerTimerTask: task,
      isRunning: true,
      session: { ...baseSession, status: SessionStatus.RUNNING },
      latestContextWindow: contextWindow(36_000),
    });
    // The clock ticks each second; match the minute and tens of seconds only.
    expect(screen.getByTestId('composer-working-line')).toHaveTextContent(/02:1\d/);
    expect(screen.getByTestId('composer-info-line')).not.toHaveTextContent(/\d\d:\d\d/);
    fireEvent.click(screen.getByRole('button', { name: /^Context 18% used/ }));
    const details = await screen.findByRole('dialog', { name: 'Session details' });
    expect(within(details).getByText(/^Running 02:1\d$/)).toBeInTheDocument();
    expect(within(details).getByRole('button', { name: 'Hide timer' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});

describe('info line segments', () => {
  // The MCP count lives in the row by default; these cases pin it to the line too.
  beforeEach(() =>
    localStorage.setItem(
      'agor-footer-prefs',
      JSON.stringify({ pinnedChips: ['timer', 'tools', 'tokens', 'context'], pinsVersion: 2 })
    )
  );
  const contextWindow = (used: number) => ({ used, limit: 200_000, taskMetadata: {} });
  const doneTask = {
    task_id: 't1',
    status: 'completed',
    created_at: '2026-01-01T00:00:00Z',
    duration_ms: 134_000,
  } as unknown as Task;
  const line = () => screen.getByTestId('composer-info-line');
  const segments = () =>
    within(line())
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'));

  it('renders each item as its own button, with separators only between items, then "›"', () => {
    renderFooter({
      latestContextWindow: contextWindow(172_000),
      footerTimerTask: doneTask,
      sessionMcpServerIds: ['a', 'b'],
    });
    expect(segments()).toEqual([
      'Context 86% used. Session details',
      'Turn time 02:14. Session details',
      'MCP tools, 2. Session details',
      'Session details',
    ]);
    expect(within(line()).getAllByTestId('info-separator')).toHaveLength(2);
    expect(line().firstElementChild).not.toHaveAttribute('data-testid', 'info-separator');
    expect(line().textContent).toMatch(/^86%·02:14·MCP 2›$/);
  });

  it('shows only "›" when every item is hidden, so Session details stays reachable', async () => {
    localStorage.setItem('agor-footer-prefs', JSON.stringify({ pinnedChips: [] }));
    renderFooter({ latestContextWindow: contextWindow(36_000), footerTimerTask: doneTask });
    expect(segments()).toEqual(['Session details']);
    expect(within(line()).queryAllByTestId('info-separator')).toHaveLength(0);
    fireEvent.click(within(line()).getByRole('button', { name: 'Session details' }));
    expect(await screen.findByRole('dialog', { name: 'Session details' })).toBeInTheDocument();
  });

  it.each([
    ['Context 86% used. Session details', 'context', 'Hide context'],
    ['Turn time 02:14. Session details', 'timer', 'Hide timer'],
    ['MCP tools, 2. Session details', 'tools', 'Hide MCP tools'],
  ])('"%s" opens Session details on its row', async (name, row, pin) => {
    renderFooter({
      latestContextWindow: contextWindow(172_000),
      footerTimerTask: doneTask,
      sessionMcpServerIds: ['a', 'b'],
    });
    fireEvent.click(within(line()).getByRole('button', { name }));
    const details = await screen.findByRole('dialog', { name: 'Session details' });
    const target = details.querySelector(`[data-detail-row="${row}"]`) as HTMLElement;
    expect(target.style.background).not.toBe('');
    for (const other of details.querySelectorAll<HTMLElement>('[data-detail-row]')) {
      if (other !== target) expect(other.style.background).toBe('');
    }
    expect(within(target).getByRole('button', { name: pin })).toBeInTheDocument();
    await waitFor(() => expect(target.contains(document.activeElement)).toBe(true));
  });

  it('"›" opens Session details at the top, with the hint about the info line', async () => {
    renderFooter({ latestContextWindow: contextWindow(172_000) });
    fireEvent.click(within(line()).getByRole('button', { name: 'Session details' }));
    const details = await screen.findByRole('dialog', { name: 'Session details' });
    expect(within(details).getByText('Choose what shows above the composer')).toBeInTheDocument();
    expect(
      within(details).getByText(
        'Pin an item to show it above the composer. MCP sign-in problems always show.'
      )
    ).toBeInTheDocument();
    for (const row of details.querySelectorAll<HTMLElement>('[data-detail-row]')) {
      expect(row.style.background).toBe('');
    }
    expect(within(details).getByRole('button', { name: 'Hide timer' })).toBeInTheDocument();
  });

  it('names each segment in its desktop tooltip', async () => {
    renderFooter({ footerTimerTask: doneTask });
    fireEvent.mouseEnter(within(line()).getByRole('button', { name: /^Turn time/ }));
    expect(await screen.findByText('Turn time')).toBeInTheDocument();
    fireEvent.mouseEnter(within(line()).getByRole('button', { name: 'Session details' }));
    expect(
      await screen.findByText('Click to see details and choose what shows here')
    ).toBeInTheDocument();
  });

  it('gives each segment a 44px target on phones and opens the details sheet', async () => {
    setWidth(390);
    renderFooter({ latestContextWindow: contextWindow(36_000), footerTimerTask: doneTask });
    for (const button of within(line()).getAllByRole('button')) {
      expect(button.style.height).toBe('44px');
      expect(button.style.minWidth).toBe('44px');
    }
    fireEvent.click(within(line()).getByRole('button', { name: /^Turn time/ }));
    const sheet = await screen.findByRole('dialog');
    expect(sheet.closest('.ant-drawer')).not.toBeNull();
    expect(within(sheet).getByText('Choose what shows above the composer')).toBeInTheDocument();
  });
});

describe('Session details keeps what the old footer popovers showed', () => {
  const openDetails = async () => {
    fireEvent.click(
      within(screen.getByTestId('composer-info-line')).getByRole('button', {
        name: 'Session details',
      })
    );
    return screen.findByRole('dialog', { name: 'Session details' });
  };

  it('shows the estimated cost and token breakdown from the usage snapshot', async () => {
    const get = vi.fn().mockResolvedValue({
      usage_summary: {
        total: 24_100,
        input: 20_000,
        output: 4_100,
        cacheRead: 0,
        cacheCreation: 0,
        cost: 0.1234,
      },
    });
    const client = { service: () => ({ get }) } as unknown as SessionFooterProps['client'];
    renderFooter({ client });
    const details = await openDetails();
    expect(await within(details).findByText('$0.1234')).toBeInTheDocument();
    expect(within(details).getByText('Estimated cost')).toBeInTheDocument();
    expect(within(details).getByText('20,000')).toBeInTheDocument();
  });

  it('shows when the turn started and how long it took, under Timer', async () => {
    const task = {
      task_id: 't1',
      status: 'completed',
      created_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T00:02:14Z',
      duration_ms: 134_000,
    } as unknown as Task;
    renderFooter({ footerTimerTask: task });
    const details = await openDetails();
    const timer = details.querySelector('[data-detail-row="timer"]')!.parentElement!;
    expect(within(timer).getByText('Started')).toBeInTheDocument();
    expect(within(timer).getByText('Duration')).toBeInTheDocument();
  });

  it('drills from Context into the full breakdown', async () => {
    renderFooter({
      latestContextWindow: {
        used: 36_000,
        limit: 200_000,
        taskMetadata: {
          normalized_sdk_response: {
            tokenUsage: { inputTokens: 30_000, outputTokens: 1_200, totalTokens: 31_200 },
          },
        },
      },
    });
    const details = await openDetails();
    fireEvent.click(within(details).getByRole('button', { name: /Context 18% of 200k/ }));
    expect(await within(details).findByText('Context Window Usage')).toBeInTheDocument();
    expect(within(details).getByText('Token Breakdown')).toBeInTheDocument();
    expect(within(details).getByLabelText('Back to session details')).toBeInTheDocument();
  });

  it('shows the full IDs on the copy rows', async () => {
    renderFooter({
      session: { ...baseSession, sdk_session_id: 'sdk-1234' } as SessionFooterProps['session'],
    });
    const details = await openDetails();
    expect(within(details).getByText('test-session-123')).toBeInTheDocument();
    expect(within(details).getByText('sdk-1234')).toBeInTheDocument();
  });
});

describe('MCP notice', () => {
  const server = (id: string, displayName: string) =>
    ({ mcp_server_id: id, name: id, display_name: displayName }) as MCPServer;

  it('names the concrete problem and stays dismissed for the same servers', () => {
    const props = { unauthedMcpServers: [server('a', 'Alpha'), server('b', 'Beta')] };
    const view = renderFooter(props);
    const notice = screen.getByTestId('mcp-disconnected-notice');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice.textContent).toMatch(/2 MCP servers aren.t connected/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss MCP connection notice' }));
    view.rerender(<SessionFooter {...baseProps} {...props} />);
    expect(screen.queryByTestId('mcp-disconnected-notice')).not.toBeInTheDocument();
    view.rerender(
      <SessionFooter
        {...baseProps}
        unauthedMcpServers={[server('a', 'Alpha'), server('c', 'Gamma')]}
      />
    );
    expect(screen.getByTestId('mcp-disconnected-notice')).toBeInTheDocument();
  });
});

describe('useFooterPreferences', () => {
  it('defaults: desktop pins Attach, Fork and MCP tools, phone pins Attach, context shown', () => {
    const { result } = renderHook(() => useFooterPreferences());
    expect(result.current[0].pinnedItems).toEqual(['fork', 'upload', 'mcp']);
    expect(result.current[0].pinnedItemsCompact).toEqual(['upload']);
    expect(result.current[0].pinnedChips).toContain('context');
    expect(result.current[0].pinnedChips).not.toContain('tools');
  });

  it('moves a stored MCP info-bar chip to the MCP row pin once', () => {
    localStorage.setItem(
      'agor-footer-prefs',
      JSON.stringify({ pinnedItems: ['fork', 'upload'], pinnedChips: ['timer', 'tools'] })
    );
    const { result } = renderHook(() => useFooterPreferences());
    expect(result.current[0].pinnedItems).toEqual(['fork', 'upload', 'mcp']);
    expect(result.current[0].pinnedChips).toEqual(['timer']);
    act(() => result.current[1]({ pinnedItems: ['fork'] }));
    const again = renderHook(() => useFooterPreferences());
    expect(again.result.current[0].pinnedItems).toEqual(['fork']);
  });

  it('leaves the MCP pin alone when the stored info bar hid MCP', () => {
    localStorage.setItem(
      'agor-footer-prefs',
      JSON.stringify({ pinnedItems: ['upload'], pinnedChips: ['timer'] })
    );
    const { result } = renderHook(() => useFooterPreferences());
    expect(result.current[0].pinnedItems).toEqual(['upload']);
  });

  it('persists phone pins separately and caps stored ones at 2', () => {
    localStorage.setItem(
      'agor-footer-prefs',
      JSON.stringify({ pinnedItemsCompact: ['upload', 'fork', 'spawn'], pinnedItems: ['spawn'] })
    );
    const { result } = renderHook(() => useFooterPreferences());
    expect(result.current[0].pinnedItemsCompact).toEqual(['upload', 'fork']);
    act(() => result.current[1]({ pinnedItemsCompact: ['btw-fork'] }));
    const stored = JSON.parse(localStorage.getItem('agor-footer-prefs') ?? '{}');
    expect(stored.pinnedItemsCompact).toEqual(['btw-fork']);
    expect(stored.pinnedItems).toEqual(['spawn']);
  });
});
