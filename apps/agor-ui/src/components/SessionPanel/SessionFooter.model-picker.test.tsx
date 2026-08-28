import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  PermissionMode,
  Session,
  SessionID,
} from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type LatestSessionUpdateRequests,
  runSessionUpdateWithLatestNotification,
} from '../../utils/sessionUpdateNotifications';
import type { ModelConfig } from '../ModelSelector';
import { SessionFooter } from './SessionFooter';

vi.mock('../EffortSelector', () => ({ EffortSelector: () => null }));
vi.mock('../PermissionModeSelector', () => ({ PermissionModeSelector: () => null }));
vi.mock('../Pill', () => ({ TimerPill: () => null }));
vi.mock('./SessionMcpFooterControl', () => ({ SessionMcpFooterControl: () => null }));

const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ConfigProvider>
    <App>{children}</App>
  </ConfigProvider>
);

const exactModel = 'claude-sonnet-4-6-20260101';
const session = {
  session_id: 'session-1',
  branch_id: 'branch-1',
  created_by: 'user-1',
  status: 'idle',
  agentic_tool: 'claude-code',
  model_config: {
    mode: 'exact',
    model: exactModel,
    updated_at: '2026-08-28T00:00:00.000Z',
  },
} as unknown as Session;

const baseProps = {
  session,
  currentUserId: 'user-1',
  footerTimerTask: null,
  tokenBreakdown: {
    total: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cost: 0,
  },
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
  permissionMode: 'default' as PermissionMode,
  codexSandboxMode: 'on' as CodexSandboxMode,
  codexApprovalPolicy: 'auto' as CodexApprovalPolicy,
  queuedTasks: [],
  client: null,
  modelConfig: { mode: 'exact' as const, model: exactModel },
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
  promptInputSlot: <div />,
};

describe('SessionFooter model picker persistence boundary', () => {
  beforeEach(() => localStorage.clear());

  it('persists no rapid typeahead drafts and one completed edit on first open and reopen', async () => {
    const updateSession = vi.fn(async () => session);
    const showSuccess = vi.fn();
    const showError = vi.fn();
    const latestRequests: LatestSessionUpdateRequests = new Map();
    const onModelConfigCommit = vi.fn((modelConfig: ModelConfig) => {
      void runSessionUpdateWithLatestNotification({
        sessionId: session.session_id as SessionID,
        updates: {
          model_config: {
            ...modelConfig,
            updated_at: new Date().toISOString(),
          },
        },
        latestRequests,
        authority: { isCurrent: () => true },
        updateSession,
        showSuccess,
        showError,
      });
    });
    const firstOpen = render(
      <SessionFooter {...baseProps} onModelConfigCommit={onModelConfigCommit} />,
      { wrapper: Wrapper }
    );

    const modelChip = screen.getByTestId('model-chip');
    fireEvent.click(modelChip);
    const input = await screen.findByDisplayValue(exactModel);
    for (const draft of ['c', 'cl', 'claude-fable-5']) {
      fireEvent.change(input, { target: { value: draft } });
    }

    expect(onModelConfigCommit).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(showSuccess).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(onModelConfigCommit).toHaveBeenCalledOnce();
    expect(onModelConfigCommit).toHaveBeenCalledWith({
      mode: 'exact',
      model: 'claude-fable-5',
    });
    await waitFor(() => expect(showSuccess).toHaveBeenCalledOnce());
    expect(updateSession).toHaveBeenCalledOnce();
    expect(showError).not.toHaveBeenCalled();

    // A second blur/outside transition from the same edit is not a second
    // explicit action and must not save again.
    fireEvent.blur(input);
    expect(onModelConfigCommit).toHaveBeenCalledOnce();

    // Close the existing popover, apply the authoritative realtime echo, and
    // reopen the same footer instance. This is the reported failing lifecycle.
    fireEvent.click(modelChip);
    const savedModel = 'claude-fable-5';
    firstOpen.rerender(
      <SessionFooter
        {...baseProps}
        session={
          {
            ...session,
            model_config: {
              mode: 'exact',
              model: savedModel,
              updated_at: '2026-08-28T00:01:00.000Z',
            },
          } as Session
        }
        modelConfig={{ mode: 'exact', model: savedModel }}
        onModelConfigCommit={onModelConfigCommit}
      />
    );

    fireEvent.click(screen.getByTestId('model-chip'));
    const reopenedInput = await screen.findByDisplayValue(savedModel);
    for (const draft of ['g', 'gp', 'gpt-5.6-sol']) {
      fireEvent.change(reopenedInput, { target: { value: draft } });
    }

    expect(onModelConfigCommit).toHaveBeenCalledOnce();
    expect(updateSession).toHaveBeenCalledOnce();
    expect(showSuccess).toHaveBeenCalledOnce();
    fireEvent.blur(reopenedInput);
    expect(onModelConfigCommit).toHaveBeenCalledTimes(2);
    expect(onModelConfigCommit).toHaveBeenLastCalledWith({
      mode: 'exact',
      model: 'gpt-5.6-sol',
    });
    await waitFor(() => expect(showSuccess).toHaveBeenCalledTimes(2));
    expect(updateSession).toHaveBeenCalledTimes(2);
    expect(showError).not.toHaveBeenCalled();
  });

  it('resets an unfinished exact draft when the footer switches sessions', async () => {
    const onModelConfigCommit = vi.fn();
    const view = render(
      <SessionFooter {...baseProps} onModelConfigCommit={onModelConfigCommit} />,
      { wrapper: Wrapper }
    );

    fireEvent.click(screen.getByTestId('model-chip'));
    const input = await screen.findByDisplayValue(exactModel);
    fireEvent.change(input, { target: { value: 'session-a-draft' } });

    const secondModel = 'claude-fable-5';
    view.rerender(
      <SessionFooter
        {...baseProps}
        session={
          {
            ...session,
            session_id: 'session-2',
            model_config: {
              mode: 'exact',
              model: secondModel,
              updated_at: '2026-08-28T00:02:00.000Z',
            },
          } as Session
        }
        modelConfig={{ mode: 'exact', model: secondModel }}
        onModelConfigCommit={onModelConfigCommit}
      />
    );

    const nextInput = await screen.findByDisplayValue(secondModel);
    expect(nextInput).toHaveValue(secondModel);
    fireEvent.blur(nextInput);
    expect(onModelConfigCommit).not.toHaveBeenCalled();
  });
});
