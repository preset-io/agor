import type { AgorClient, Session, TenantAgenticToolSettings } from '@agor-live/client';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider, Form, theme } from 'antd';
import type React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { agorStore } from '../../store/agorStore';
import { AgenticConfigChipRow } from '../AgenticConfigChipRow/AgenticConfigChipRow';
import { SessionFooter, type SessionFooterProps } from './SessionFooter';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
      <App>
        <main>{children}</main>
      </App>
    </ConfigProvider>
  );
}
beforeEach(() => {
  document.body.style.margin = '0';
  localStorage.clear();
  agorStore.getState().setAgenticToolSettings([]);
});
afterEach(cleanup);
function footerProps(managed: boolean, tool = 'gemini'): SessionFooterProps {
  return {
    session: {
      session_id: 'qa-session',
      branch_id: 'qa-branch',
      created_by: 'qa-user',
      status: 'idle',
      agentic_tool: tool,
      agentic_tool_preset_id: managed ? 'qa-preset' : undefined,
    } as Session & { agentic_tool: 'gemini' },
    currentUserId: 'qa-user',
    footerTimerTask: null,
    latestContextWindow: null,
    sessionMcpServerIds: [],
    unauthedMcpServers: [],
    mcpServerById: new Map(),
    userAuthenticatedMcpServerIds: new Set(),
    isRunning: false,
    isStopping: false,
    stopRequestInFlight: false,
    hasInput: false,
    connectionDisabled: false,
    permissionMode: 'default',
    codexSandboxMode: 'workspace-write',
    codexApprovalPolicy: 'on-request',
    queuedTasks: [],
    client: null,
    onModelConfigCommit: vi.fn(),
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
    promptInputSlot: <textarea aria-label="Fixture composer" />,
  };
}
it('actual SessionFooter legacy Manual warning fits its permissions row', async () => {
  const props = footerProps(true);
  render(
    <Shell>
      <SessionFooter {...props} />
    </Shell>
  );
  await userEvent.click(screen.getByRole('button', { name: 'More options' }));
  const warning = await screen.findByText(/ask a workspace admin to update the preset/);
  await waitFor(() => expect(warning).toBeVisible());
  const row = screen.getByText('Permissions', { exact: true }).parentElement!;
  const select = screen.getByText('Manual (unavailable)').closest('.ant-select')!;
  expect(warning.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    row.getBoundingClientRect().top - 1
  );
  expect(select.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    row.getBoundingClientRect().bottom + 1
  );
});
it('actual SessionFooter non-Gemini permissions can change', async () => {
  const props = footerProps(false, 'claude-code');
  render(
    <Shell>
      <SessionFooter {...props} />
    </Shell>
  );
  await userEvent.click(screen.getByRole('button', { name: 'More options' }));
  const manual = await screen.findByText('Manual', { exact: true });
  await userEvent.click(within(manual.closest('.ant-select') as HTMLElement).getByRole('combobox'));
  const popup = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')!;
  await userEvent.click(within(popup as HTMLElement).getByText('Accept edits'));
  expect(props.onPermissionModeChange).toHaveBeenCalledTimes(1);
  expect(vi.mocked(props.onPermissionModeChange).mock.calls[0][0]).toBe('acceptEdits');
});
it('admin-only preset creation chip provides Gemini recovery guidance', async () => {
  agorStore.getState().setAgenticToolSettings([
    {
      tool: 'gemini',
      enabled: true,
      deployment_available: true,
      inline_configuration_allowed: false,
      resolution_policy: 'user_preferred',
      connection: {},
    } as TenantAgenticToolSettings,
  ]);
  const client = {
    service: () => ({
      find: async () => [
        {
          preset_id: 'qa-preset',
          tool: 'gemini',
          name: 'Legacy QA preset',
          configuration: { permissionMode: 'default' },
          is_default: true,
        },
      ],
      on: vi.fn(),
      off: vi.fn(),
    }),
  } as unknown as AgorClient;
  render(
    <Shell>
      <Form initialValues={{ agenticToolPresetId: 'qa-preset' }}>
        <AgenticConfigChipRow tool="gemini" client={client} mcpServerById={new Map()} />
      </Form>
    </Shell>
  );
  const chip = await screen.findByTestId('permission-chip');
  await waitFor(() => expect(chip).toHaveTextContent('Manual (unavailable)'));
  await userEvent.click(chip);
  await waitFor(() => expect(screen.getByText(/workspace admin/)).toBeVisible());
  expect(screen.getByText(/Switch to Accept edits or Bypass/)).toBeVisible();
  expect(chip).toHaveTextContent('Manual (unavailable)');
});
