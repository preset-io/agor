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
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFooterPreferences } from '../../hooks/useFooterPreferences';
import { agorStore } from '../../store/agorStore';
import type { ModelSelectorProps } from '../ModelSelector';
import { SessionFooter, type SessionFooterProps } from './SessionFooter';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { user_id: 'footer-user', role: 'member' } }),
}));

// The real picker fetches live model lists; the stub renders the rows the composer asks for.
vi.mock('../ModelSelector', () => ({
  ModelSelector: ({ renderRows, onCommit }: ModelSelectorProps) =>
    renderRows ? (
      renderRows({
        options: [
          {
            value: 'opus',
            label: 'Opus',
            description: 'Most capable',
            isDefault: true,
            accountDependent: false,
          },
          {
            value: 'sonnet',
            label: 'Sonnet',
            description: 'Fast',
            isDefault: false,
            accountDependent: false,
          },
        ],
        currentModel: 'opus',
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

  it('shows stopping feedback and blocks a second stop while the request is in flight', () => {
    const onStop = vi.fn();
    renderFooter({ isRunning: true, stopRequestInFlight: true, onStop });
    expect(circle()).toHaveAttribute('aria-busy', 'true');
    expect(circle()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(circle());
    expect(onStop).not.toHaveBeenCalled();
    expect(screen.getByTestId('composer-working-line')).toHaveTextContent('Stopping');
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
    expect(onModelConfigCommit).toHaveBeenCalledWith({ mode: 'alias', model: 'sonnet' });
    fireEvent.click(within(menu).getByText('Low'));
    expect(onEffortChange).toHaveBeenCalledWith('low');
    fireEvent.click(within(menu).getByRole('button', { name: /Permissions/ }));
    expect(within(menu).getByRole('radiogroup', { name: 'Permissions' })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('button', { name: 'Back to model' }));
    expect(within(menu).getByRole('radiogroup', { name: 'Model' })).toBeInTheDocument();
  });
});

describe('"+" menu and pins', () => {
  it('shows the desktop default pins, Attach files and Fork session', () => {
    renderFooter();
    expect(screen.getByTestId('upload-bar-btn')).toBeInTheDocument();
    expect(screen.getByTestId('fork-bar-btn')).toBeInTheDocument();
  });

  it('pins an action into the row from the "+" menu', async () => {
    renderFooter({ hasInput: true });
    fireEvent.click(screen.getByRole('button', { name: 'Add files and actions' }));
    const menu = await screen.findByRole('dialog', { name: 'Add files and actions' });
    expect(within(menu).getByText('Add to message')).toBeInTheDocument();
    expect(within(menu).getByText('Session')).toBeInTheDocument();
    const pin = within(menu).getByRole('button', { name: 'Pin BTW fork' });
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pin);
    expect(screen.getByTestId('btw-fork-bar-btn')).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: 'Unpin BTW fork' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
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

describe('phone pins', () => {
  beforeEach(() => setWidth(390));

  it('start empty and ignore desktop pins', () => {
    renderFooter();
    expect(screen.queryByTestId('upload-bar-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fork-bar-btn')).not.toBeInTheDocument();
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
    expect(within(sheet).getByLabelText('Pin BTW fork')).toBeDisabled();
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
    expect(screen.queryByRole('button', { name: /^Context 86% used/ })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('agor-footer-prefs') ?? '{}').pinnedChips).not.toContain(
      'context'
    );
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
  it('defaults: desktop pins Attach and Fork, phone pins empty, context shown', () => {
    const { result } = renderHook(() => useFooterPreferences());
    expect(result.current[0].pinnedItems).toEqual(['fork', 'upload']);
    expect(result.current[0].pinnedItemsCompact).toEqual([]);
    expect(result.current[0].pinnedChips).toContain('context');
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
