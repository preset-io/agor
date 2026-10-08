import type { Session, Task } from '@agor-live/client';
import { cleanup, render, screen, within } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { SessionFooter, type SessionFooterProps } from './SessionFooter';

const originalViewport = { width: window.innerWidth, height: window.innerHeight };
beforeEach(() => {
  document.body.style.margin = '0';
  localStorage.setItem(
    'agor-footer-prefs',
    JSON.stringify({
      pinnedItems: ['upload'],
      pinnedChips: ['timer', 'tools', 'model', 'tokens', 'context', 'session-ids'],
    })
  );
});
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await page.viewport(originalViewport.width, originalViewport.height);
});

const noop = vi.fn();
const props: SessionFooterProps = {
  session: {
    session_id: 'composer-session',
    branch_id: 'composer-branch',
    status: 'running',
    agentic_tool: 'claude-code',
    model_config: { model: 'claude-opus-4-8-20251115-with-a-long-pinned-suffix' },
  } as unknown as SessionFooterProps['session'],
  footerTimerTask: {
    task_id: 'composer-task',
    status: 'running',
    created_at: new Date().toISOString(),
  } as unknown as Task,
  latestContextWindow: { used: 4_000, limit: 100_000, taskMetadata: null },
  sessionMcpServerIds: [],
  unauthedMcpServers: [],
  mcpServerById: new Map(),
  userAuthenticatedMcpServerIds: new Set(),
  isRunning: true,
  isStopping: false,
  stopRequestInFlight: false,
  hasInput: true,
  connectionDisabled: false,
  permissionMode: 'default',
  codexSandboxMode: 'workspace-write',
  codexApprovalPolicy: 'on-request',
  queuedTasks: [],
  client: null,
  onModelConfigCommit: noop,
  onSendPrompt: noop,
  onStop: noop,
  onFork: noop,
  onBtwSend: noop,
  onSpawnOpen: noop,
  onAttachFiles: noop,
  onUploadOpen: noop,
  onEffortChange: noop,
  onPermissionModeChange: noop,
  onCodexPermissionChange: noop,
  promptInputSlot: <textarea aria-label="Fixture composer" style={{ width: '100%' }} />,
};

it.each([
  [360, 740, false],
  [390, 844, true],
  [430, 932, false],
  [1280, 900, true],
])('keeps chips and actions on single rows at %dx%d (dark=%s)', async (width, height, dark) => {
  await page.viewport(width, height);
  render(
    <ConfigProvider
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { motion: false },
      }}
    >
      <App>
        <main style={{ paddingInline: 24 }}>
          <SessionFooter
            {...props}
            session={props.session as Session & { agentic_tool: 'claude-code' }}
          />
        </main>
      </App>
    </ConfigProvider>
  );

  const bar = screen.getByTestId('info-bar');
  const chips = [...bar.children].map((chip) => chip.getBoundingClientRect());
  const lineBottom = Math.min(...chips.map((chip) => chip.bottom));
  for (const chip of chips) expect(chip.top).toBeLessThan(lineBottom);
  expect(getComputedStyle(bar).overflowX).toBe('auto');
  expect(screen.getByTestId('model-chip').getBoundingClientRect().width).toBeGreaterThanOrEqual(96);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

  const actions = ['Attach files', 'More options', 'Stop', 'Queue'].map((name) =>
    screen.getByRole('button', { name }).getBoundingClientRect()
  );
  const isMobile = width < 1024;
  for (const action of actions) {
    expect(action.height).toBe(actions[0].height);
    expect(action.right).toBeLessThanOrEqual(window.innerWidth);
    if (isMobile) expect(action.height).toBeGreaterThanOrEqual(MOBILE_TOUCH_TARGET);
  }
  for (const action of actions.slice(2)) expect(action.width).toBe(action.height);

  await userEvent.click(screen.getByRole('button', { name: 'More options' }));
  const menu = await screen.findByRole('group', { name: 'More options' });
  const label = within(menu).getAllByText('Model', { exact: true })[0].getBoundingClientRect();
  const select = menu.querySelector('.ant-select')!.getBoundingClientRect();
  expect(select.left).toBeGreaterThanOrEqual(label.right);
  expect(select.top).toBeLessThan(label.bottom);
  expect(label.top).toBeLessThan(select.bottom);
  const permissions = within(menu).getByText('Permissions', { exact: true });
  const permissionsRow = permissions.closest('fieldset > div')!.getBoundingClientRect();
  const permissionsSelect = permissions
    .closest('fieldset > div')!
    .querySelector('.ant-select')!
    .getBoundingClientRect();
  const center = (rect: DOMRect) => rect.top + rect.height / 2;
  expect(permissionsRow.height).toBe(isMobile ? MOBILE_TOUCH_TARGET : 32);
  expect(
    Math.abs(center(permissions.getBoundingClientRect()) - center(permissionsSelect))
  ).toBeLessThanOrEqual(1);
  for (const text of menu.querySelectorAll<HTMLElement>('span, div, button')) {
    if (
      ![...text.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
      )
    ) {
      continue;
    }
    const style = getComputedStyle(text);
    expect([12, 14, 16, 20]).toContain(Number.parseFloat(style.fontSize));
    expect(style.textTransform).not.toBe('uppercase');
  }
  await page.screenshot({ path: `./.vitest/composer-${width}-${dark ? 'dark' : 'light'}.png` });
});
