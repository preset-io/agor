import { GEMINI_MANUAL_MESSAGE } from '@agor/core/utils/permission-mode-mapper';
import type { AgorClient, Session, TenantAgenticToolSettings } from '@agor-live/client';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider, Form, theme } from 'antd';
import type React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
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
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
afterEach(async () => {
  cleanup();
  await page.viewport(originalViewport.width, originalViewport.height);
});
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
it('actual SessionFooter legacy Manual warning fits its permissions drill-in', async () => {
  const props = footerProps(true);
  render(
    <Shell>
      <SessionFooter {...props} />
    </Shell>
  );
  // Legacy Manual differs from Gemini's default, so the permission chip shows
  // and opens the model menu straight on its Permissions page.
  const chip = screen.getByTestId('permission-chip');
  expect(chip).toHaveTextContent('Manual (unavailable)');
  expect(chip).toHaveAccessibleName('Permissions: Manual (unavailable). Change');
  await userEvent.click(chip);
  const menu = await screen.findByRole('dialog', { name: 'Permissions' });
  const warning = await within(menu).findByText((text) => text.startsWith(GEMINI_MANUAL_MESSAGE));
  expect(warning).toHaveTextContent('ask a workspace admin to update the preset');
  await waitFor(() => expect(warning).toBeVisible());
  expect(within(menu).getByText(/Managed by preset/)).toBeVisible();
  expect(within(menu).getByRole('button', { name: 'Back to model' })).toBeVisible();
  const group = within(menu).getByRole('radiogroup', { name: 'Permissions' });
  const rows = within(group).getAllByRole('radio');
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining('Accept edits'),
    expect.stringContaining('Bypass permissions'),
  ]);
  // A preset owns the setting, and legacy Manual is not one of the choices.
  for (const row of rows) {
    expect(row).toBeDisabled();
    expect(row).toHaveAttribute('aria-checked', 'false');
  }
  await userEvent.click(rows[0], { force: true });
  expect(props.onPermissionModeChange).not.toHaveBeenCalled();
  // The note sits above the choices, and the whole page stays on screen.
  expect(warning.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    group.getBoundingClientRect().top + 1
  );
  await waitFor(() => {
    const panel = (menu.closest('.ant-drawer-content') ?? menu).getBoundingClientRect();
    for (const element of [warning, ...rows]) {
      const bounds = element.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(Math.max(0, panel.left) - 1);
      expect(bounds.right).toBeLessThanOrEqual(Math.min(window.innerWidth, panel.right) + 1);
    }
    expect(panel.top).toBeGreaterThanOrEqual(0);
    expect(panel.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
  });
});
it('actual SessionFooter non-Gemini permissions can change', async () => {
  const props = footerProps(false, 'claude-code');
  render(
    <Shell>
      <SessionFooter {...props} />
    </Shell>
  );
  // Permissions live behind the model chip's drill-in.
  await userEvent.click(screen.getByTestId('model-chip'));
  const menu = await screen.findByRole('dialog', { name: 'Model' });
  await userEvent.click(
    within(menu).getByText('Permissions', { exact: true }).closest('button') as HTMLElement
  );
  const group = await within(menu).findByRole('radiogroup', { name: 'Permissions' });
  expect(within(group).getByRole('radio', { checked: true })).toHaveTextContent('Manual');
  await userEvent.click(
    within(group).getByText('Accept edits', { exact: true }).closest('button') as HTMLElement
  );
  expect(props.onPermissionModeChange).toHaveBeenCalledTimes(1);
  expect(vi.mocked(props.onPermissionModeChange).mock.calls[0][0]).toBe('acceptEdits');
  // Back returns to the model page within the same menu.
  await userEvent.click(within(menu).getByRole('button', { name: 'Back to model' }));
  expect(await within(menu).findByRole('radiogroup', { name: 'Model' })).toBeVisible();
});
it.each([
  [320, 568],
  [390, 844],
  [1280, 900],
])(
  'admin-only preset creation chip keeps Gemini recovery in view at %dx%d',
  async (width, height) => {
    await page.viewport(width, height);
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
    const guidance = await screen.findByText(/workspace admin/);
    await waitFor(() => expect(guidance).toBeVisible());
    // Visibility alone does not detect recovery text clipped outside the viewport.
    const popup = guidance.closest('.ant-popover')!;
    await waitFor(() => {
      const bounds = popup.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
    });
    expect(screen.getByText(/Switch to Accept edits or Bypass/)).toBeVisible();
    expect(chip).toHaveTextContent('Manual (unavailable)');
  }
);
