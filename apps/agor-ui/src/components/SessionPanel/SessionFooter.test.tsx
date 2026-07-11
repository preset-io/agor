import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  PermissionMode,
  Session,
} from '@agor-live/client';
import { act, render, renderHook, screen } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFooterPreferences } from '../../hooks/useFooterPreferences';
import { SessionFooter } from './SessionFooter';

// ModelSelector makes async network calls — replace with a stub
vi.mock('../ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector-stub" />,
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
  onModelConfigChange: vi.fn(),
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

  it('Model chip is hidden when no model is present', () => {
    render(
      <SessionFooter
        {...baseProps}
        session={{ ...baseSession, model_config: undefined } as unknown as Session}
        tokenBreakdown={{ ...baseTokenBreakdown, total: 0 }}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.queryByTestId('model-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tokens-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stats-chip')).not.toBeInTheDocument();
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
    const chip = screen.getByTitle(/No MCP servers attached/);
    expect(chip).toBeInTheDocument();
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

  it('labels and disables upload action buttons while the composer sends', () => {
    localStorage.setItem(
      'agor-footer-prefs',
      JSON.stringify({ pinnedItems: ['upload', 'advanced-upload'] })
    );

    render(<SessionFooter {...baseProps} composerBusy />, {
      wrapper: Wrapper,
    });

    expect(screen.getByTestId('upload-bar-btn')).toBeDisabled();
    expect(screen.getByTitle('Advanced upload')).toBeDisabled();
  });
});
