import { AGENTIC_TOOL_CAPABILITIES } from '@agor/agentic-tools';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  MCPServer,
  PermissionMode,
  Session,
} from '@agor-live/client';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFooterPreferences } from '../../hooks/useFooterPreferences';
import { SessionFooter } from './SessionFooter';

// ModelSelector makes async network calls — replace with a stub
vi.mock('../ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector-stub" />,
}));
vi.mock('../EffortSelector', () => ({
  EffortSelector: ({ value }: { value?: EffortLevel }) => (
    <div data-testid="effort-selector-stub">{value ?? 'Inherited'}</div>
  ),
}));

// TimerPill uses complex internal state not needed for footer layout tests
vi.mock('../Pill', () => ({
  TimerPill: () => <span data-testid="timer-pill-stub" />,
}));

const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ConfigProvider>
    <App>{children}</App>
  </ConfigProvider>
);

const baseSession: Session = {
  session_id: 'test-session-123',
  status: 'idle' as Session['status'],
  agentic_tool: 'claude-code',
  model_config: undefined,
} as unknown as Session;

const baseTokenBreakdown = {
  total: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  cost: 0,
};

const baseProps = {
  session: baseSession,
  footerTimerTask: null,
  tokenBreakdown: baseTokenBreakdown,
  latestContextWindow: null,
  footerGradient: undefined,
  sessionMcpServerIds: [] as string[],
  unauthedMcpServers: [],
  mcpServerById: new Map(),
  userAuthenticatedMcpServerIds: new Set<string>(),
  isRunning: false,
  isStopping: false,
  stopRequestInFlight: false,
  hasInput: false,
  connectionDisabled: false,
  effortLevel: 'high' as EffortLevel,
  permissionMode: 'default' as PermissionMode,
  codexSandboxMode: 'on' as CodexSandboxMode,
  codexApprovalPolicy: 'auto' as CodexApprovalPolicy,
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

describe('SessionFooter', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('Send button is disabled when there is no input', () => {
    render(<SessionFooter {...baseProps} hasInput={false} />, { wrapper: Wrapper });
    const sendBtn = screen.getByRole('button', { name: /send/i });
    expect(sendBtn).toBeDisabled();
  });

  it('Send button is enabled when there is input', () => {
    render(<SessionFooter {...baseProps} hasInput={true} isRunning={false} />, {
      wrapper: Wrapper,
    });
    const sendBtn = screen.getByRole('button', { name: /send/i });
    expect(sendBtn).not.toBeDisabled();
  });

  it('Send button shows "Queue" label when session is running and there is input', () => {
    render(<SessionFooter {...baseProps} hasInput={true} isRunning={true} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByRole('button', { name: /queue/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^send$/i })).not.toBeInTheDocument();
  });

  it('Stop button is not rendered when session is not running', () => {
    render(<SessionFooter {...baseProps} isRunning={false} stopRequestInFlight={false} />, {
      wrapper: Wrapper,
    });
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
  });

  it('Stop button is rendered when session is running', () => {
    render(<SessionFooter {...baseProps} isRunning={true} />, { wrapper: Wrapper });
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('disables Stop while the daemon connection is unavailable', () => {
    const { container } = render(
      <SessionFooter {...baseProps} isRunning={true} connectionDisabled={true} />,
      { wrapper: Wrapper }
    );
    expect(container.querySelector('button.ant-btn-dangerous')).toBeDisabled();
  });

  it('shows stopping feedback immediately while the Stop request is in flight', () => {
    const { container } = render(
      <SessionFooter {...baseProps} isRunning={true} stopRequestInFlight={true} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByRole('button', { name: /stop/i })).toBeDisabled();
    expect(container.querySelector('.ant-spin')).toBeInTheDocument();
    expect(container.querySelector('[data-icon="stop"]')).not.toBeInTheDocument();
  });

  it('Model chip is hidden when no model is resolvable (tool without a static default)', () => {
    render(
      <SessionFooter
        {...baseProps}
        // opencode has no static default model and needs a provider/model pair,
        // so a fresh session with no model_config resolves to nothing.
        session={
          {
            ...baseSession,
            agentic_tool: 'opencode',
            model_config: undefined,
          } as unknown as Session
        }
        tokenBreakdown={{ ...baseTokenBreakdown, total: 0 }}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.queryByTestId('model-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tokens-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stats-chip')).not.toBeInTheDocument();
  });

  it('Model chip renders and is clickable on a brand-new session before any model change', async () => {
    // A fresh session persists no model into model_config — the model is
    // resolved from tool defaults at runtime. The chip must still render and
    // open its click-to-change popover (regression: it used to only appear
    // after the user changed the model via Session Settings).
    render(
      <SessionFooter
        {...baseProps}
        session={
          {
            ...baseSession,
            agentic_tool: 'claude-code',
            model_config: undefined,
          } as unknown as Session
        }
      />,
      { wrapper: Wrapper }
    );
    const chip = screen.getByTestId('model-chip');
    expect(chip).toBeInTheDocument();
    expect(chip.style.cursor).toBe('pointer');

    // Clicking opens the model-picker popover (ModelSelector is stubbed).
    fireEvent.click(chip);
    expect(await screen.findByTestId('model-selector-stub')).toBeInTheDocument();
  });

  it('Context chip shows warning styling when context usage is above 80%', () => {
    render(
      <SessionFooter
        {...baseProps}
        latestContextWindow={{ used: 85_000, limit: 100_000, taskMetadata: {} }}
      />,
      { wrapper: Wrapper }
    );
    const chip = screen.getByTestId('context-chip');
    expect(chip).toBeInTheDocument();
    expect(chip.getAttribute('data-warning')).toBe('true');
  });

  it('Individual model chip renders when model is present', () => {
    render(
      <SessionFooter
        {...baseProps}
        session={
          {
            ...baseSession,
            model_config: { model: 'claude-sonnet-4-6', mode: 'alias' },
          } as unknown as Session
        }
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByTestId('model-chip')).toBeInTheDocument();
  });

  it('Model chip truncates a long provider/model id instead of overflowing its border', () => {
    render(
      <SessionFooter
        {...baseProps}
        session={
          {
            ...baseSession,
            agentic_tool: 'opencode',
            model_config: {
              model: 'kimi-for-coding-highspeed',
              provider: 'kimi-for-coding',
              mode: 'exact',
            },
          } as unknown as Session
        }
      />,
      { wrapper: Wrapper }
    );
    const chip = screen.getByTestId('model-chip');
    const label = 'kimi-for-coding/kimi-for-coding-highspeed';
    // Full id stays reachable on hover even when the chip has to ellipsize.
    expect(chip).toHaveAttribute('title', label);
    expect(chip.style.maxWidth).toBe('100%');
    expect(within(chip).getByText(label).style.textOverflow).toBe('ellipsis');
  });

  it('Timer chip renders as a plain div when footerTimerTask is present', () => {
    const timerTask = {
      task_id: 't1',
      status: 'running',
      created_at: new Date().toISOString(),
      message_range: null,
      duration_ms: null,
      last_executor_heartbeat_at: null,
      completed_at: null,
    };
    render(<SessionFooter {...baseProps} footerTimerTask={timerTask as never} />, {
      wrapper: Wrapper,
    });
    const timerChip = screen.getByTestId('timer-chip');
    expect(timerChip).toBeInTheDocument();
    expect(timerChip.tagName.toLowerCase()).toBe('div');
  });

  it('MCP chip shows 0 count when no MCP servers are attached', () => {
    render(<SessionFooter {...baseProps} sessionMcpServerIds={[]} />, { wrapper: Wrapper });
    const chip = screen.getByRole('button', {
      name: 'MCP servers. No MCP servers attached. Open to add or change MCP servers.',
    });
    expect(chip).toBeInTheDocument();
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.textContent).toContain('0');
  });

  it('MCP chip shows the server count when MCP servers are attached', () => {
    render(<SessionFooter {...baseProps} sessionMcpServerIds={['a', 'b', 'c']} />, {
      wrapper: Wrapper,
    });
    // IDs not in mcpServerById are counted as "missing" → "need attention" tooltip
    const chip = screen.getByTitle(/3 MCP servers need attention/);
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toContain('3');
  });

  it('names the disconnected server in the MCP disclosure control', () => {
    const oauthServer = {
      mcp_server_id: 'oauth-server-id',
      name: 'oauth-server',
      display_name: 'OAuth Server',
      transport: 'http',
      scope: 'session',
      enabled: true,
      auth: { type: 'oauth' },
    } as MCPServer;

    render(
      <SessionFooter
        {...baseProps}
        sessionMcpServerIds={[oauthServer.mcp_server_id]}
        mcpServerById={new Map([[oauthServer.mcp_server_id, oauthServer]])}
      />,
      { wrapper: Wrapper }
    );

    const disclosure = screen.getByRole('button', {
      name: 'MCP servers. OAuth Server isn’t connected. Open to connect.',
    });
    act(() => disclosure.focus());
    expect(disclosure).toHaveFocus();
  });

  it('exposes dialog popup state and restores disclosure focus when Escape dismisses it', () => {
    render(<SessionFooter {...baseProps} client={{} as never} />, { wrapper: Wrapper });
    const disclosure = screen.getByRole('button', {
      name: 'MCP servers. No MCP servers attached. Open to add or change MCP servers.',
    });

    expect(disclosure).toHaveAttribute('aria-haspopup', 'dialog');
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    act(() => disclosure.focus());
    fireEvent.click(disclosure);

    const popup = screen.getByRole('dialog', { name: 'Session MCP servers' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(disclosure).toHaveAttribute('aria-controls', popup.id);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    const selector = within(popup).getByRole('combobox');
    act(() => selector.focus());
    expect(selector).toHaveFocus();
    fireEvent.keyDown(selector, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Session MCP servers' })).not.toBeInTheDocument();
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(disclosure).toHaveFocus();
  });

  it('tones the MCP badge count as a warning (not an error) when servers need attention', () => {
    const { result } = renderHook(() => theme.useToken(), { wrapper: Wrapper });
    const warningProbe = document.createElement('div');
    warningProbe.style.backgroundColor = result.current.token.colorWarningBg;
    const errorProbe = document.createElement('div');
    errorProbe.style.backgroundColor = result.current.token.colorErrorBg;

    render(<SessionFooter {...baseProps} sessionMcpServerIds={['a', 'b', 'c']} />, {
      wrapper: Wrapper,
    });
    const count = within(screen.getByTitle(/3 MCP servers need attention/)).getByText('3');

    expect(count.style.backgroundColor).toBe(warningProbe.style.backgroundColor);
    expect(count.style.backgroundColor).not.toBe(errorProbe.style.backgroundColor);
  });

  it('centers the MCP count chip against the label instead of its baseline', () => {
    render(<SessionFooter {...baseProps} sessionMcpServerIds={['a', 'b', 'c']} />, {
      wrapper: Wrapper,
    });
    const count = within(screen.getByTitle(/3 MCP servers need attention/)).getByText('3');

    // Without a flex line on antd's content span the chip falls back to
    // `vertical-align` against the label's baseline and renders visibly high.
    const content = count.parentElement;
    expect(content?.style.display).toBe('inline-flex');
    expect(content?.style.alignItems).toBe('center');
    expect(count.style.alignItems).toBe('center');
  });

  it('opens session settings from the final footer overflow action', async () => {
    const onOpenSessionSettings = vi.fn();
    render(<SessionFooter {...baseProps} onOpenSessionSettings={onOpenSessionSettings} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const overflowOptions = await screen.findByRole('group', { name: 'More options' });
    const settingsButton = await screen.findByRole('button', { name: 'Session settings' });
    const overflowButtons = within(overflowOptions).getAllByRole('button');

    expect(overflowButtons[overflowButtons.length - 1]).toBe(settingsButton);
    fireEvent.click(settingsButton);
    expect(onOpenSessionSettings).toHaveBeenCalledWith('test-session-123');
  });

  it('does not expose session settings from the MCP control', async () => {
    render(<SessionFooter {...baseProps} onOpenSessionSettings={vi.fn()} />, {
      wrapper: Wrapper,
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: 'MCP servers. No MCP servers attached. Open to add or change MCP servers.',
      })
    );

    expect(await screen.findByText('Session MCP servers')).toBeInTheDocument();
    expect(screen.queryByText('Open session settings')).not.toBeInTheDocument();
  });

  const mcpServer = (id: string, displayName: string) =>
    ({
      mcp_server_id: id,
      name: id,
      display_name: displayName,
    }) as unknown as (typeof baseProps)['unauthedMcpServers'][number];

  it('shows a dismissable warning notice when MCP servers are disconnected', () => {
    render(
      <SessionFooter
        {...baseProps}
        unauthedMcpServers={[mcpServer('a', 'Alpha'), mcpServer('b', 'Beta')]}
      />,
      { wrapper: Wrapper }
    );
    const notice = screen.getByTestId('mcp-disconnected-notice');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveAttribute('aria-live', 'polite');
    expect(notice).toHaveAttribute('aria-atomic', 'true');
    expect(notice).toHaveTextContent(/2 MCP servers aren.t connected/);
    expect(notice).toHaveTextContent(/Open the MCP badge/);
    expect(
      screen.getByRole('button', { name: 'Dismiss MCP connection notice' })
    ).toBeInTheDocument();
  });

  it('reveals the advertised MCP recovery badge while Tools is unpinned', () => {
    const disconnected = {
      ...mcpServer('a', 'Alpha'),
      transport: 'http',
      scope: 'session',
      enabled: true,
      auth: { type: 'oauth' },
    } as MCPServer;
    localStorage.setItem('agor-footer-prefs', JSON.stringify({ pinnedChips: ['model'] }));

    render(
      <SessionFooter
        {...baseProps}
        sessionMcpServerIds={[disconnected.mcp_server_id]}
        unauthedMcpServers={[disconnected]}
        mcpServerById={new Map([[disconnected.mcp_server_id, disconnected]])}
      />,
      { wrapper: Wrapper }
    );

    expect(screen.getByRole('status')).toHaveTextContent(/Open the MCP badge/);
    const disclosure = screen.getByRole('button', {
      name: 'MCP servers. Alpha isn’t connected. Open to connect.',
    });
    fireEvent.click(disclosure);
    expect(screen.getByRole('dialog', { name: 'Session MCP servers' })).toBeInTheDocument();
  });

  it('hides the notice after dismissal and keeps it hidden across re-renders', () => {
    const props = {
      ...baseProps,
      unauthedMcpServers: [mcpServer('a', 'Alpha'), mcpServer('b', 'Beta')],
    };
    const { rerender } = render(<SessionFooter {...props} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss MCP connection notice' }));
    expect(screen.queryByTestId('mcp-disconnected-notice')).not.toBeInTheDocument();

    rerender(<SessionFooter {...props} />);
    expect(screen.queryByTestId('mcp-disconnected-notice')).not.toBeInTheDocument();
  });

  it('re-surfaces the notice when a different server disconnects after dismissal', () => {
    const { rerender } = render(
      <SessionFooter {...baseProps} unauthedMcpServers={[mcpServer('a', 'Alpha')]} />,
      { wrapper: Wrapper }
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss MCP connection notice' }));
    expect(screen.queryByTestId('mcp-disconnected-notice')).not.toBeInTheDocument();

    rerender(
      <SessionFooter
        {...baseProps}
        unauthedMcpServers={[mcpServer('a', 'Alpha'), mcpServer('c', 'Gamma')]}
      />
    );
    expect(screen.getByTestId('mcp-disconnected-notice')).toBeInTheDocument();
  });

  it('shows inherited reasoning effort for Codex in session settings', async () => {
    render(
      <SessionFooter
        {...baseProps}
        session={{ ...baseSession, agentic_tool: 'codex' } as Session}
        toolCaps={AGENTIC_TOOL_CAPABILITIES.codex}
        effortLevel={undefined}
      />,
      { wrapper: Wrapper }
    );

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const overflowOptions = await screen.findByRole('group', { name: 'More options' });
    expect(within(overflowOptions).getByText('Effort')).toBeInTheDocument();
    expect(within(overflowOptions).getByText('Inherited')).toBeInTheDocument();
  });
});

describe('useFooterPreferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('returns the default preferences when nothing is stored', () => {
    const { result } = renderHook(() => useFooterPreferences());
    const [prefs] = result.current;
    expect(prefs.showToolsChip).toBe(true);
    expect(prefs.showStatsChip).toBe(true);
    expect(prefs.showForkInBar).toBe(true);
    expect(prefs.showUploadInBar).toBe(true);
  });

  it('defaults include pinnedItems with fork and upload pinned', () => {
    const { result } = renderHook(() => useFooterPreferences());
    const [prefs] = result.current;
    expect(prefs.pinnedItems).toEqual(['fork', 'upload']);
  });

  it('defaults include pinnedChips with all chips visible', () => {
    const { result } = renderHook(() => useFooterPreferences());
    const [prefs] = result.current;
    expect(prefs.pinnedChips).toEqual(['timer', 'tools', 'model', 'tokens', 'context']);
  });

  it('persists updated preferences to localStorage', () => {
    const { result } = renderHook(() => useFooterPreferences());
    act(() => {
      result.current[1]({ showToolsChip: false });
    });
    const stored = JSON.parse(localStorage.getItem('agor-footer-prefs') ?? '{}');
    expect(stored.showToolsChip).toBe(false);
    // Other prefs remain at their defaults
    expect(stored.showStatsChip).toBe(true);
  });

  it('persists pinnedItems to localStorage', () => {
    const { result } = renderHook(() => useFooterPreferences());
    act(() => {
      result.current[1]({ pinnedItems: ['btw-fork'] });
    });
    const stored = JSON.parse(localStorage.getItem('agor-footer-prefs') ?? '{}');
    expect(stored.pinnedItems).toEqual(['btw-fork']);
  });
});

describe('SessionFooter pinned items', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('shows BTW fork button in action bar when pinned', () => {
    localStorage.setItem('agor-footer-prefs', JSON.stringify({ pinnedItems: ['btw-fork'] }));
    render(<SessionFooter {...baseProps} hasInput={true} />, { wrapper: Wrapper });
    expect(screen.getByTestId('btw-fork-bar-btn')).toBeInTheDocument();
  });

  it('labels and disables upload action buttons while attachments upload', () => {
    localStorage.setItem(
      'agor-footer-prefs',
      JSON.stringify({ pinnedItems: ['upload', 'advanced-upload'] })
    );

    render(<SessionFooter {...baseProps} composerAttachmentUploading={true} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByTestId('upload-bar-btn')).toBeDisabled();
    expect(screen.getByTitle('Advanced upload')).toBeDisabled();
  });
});
