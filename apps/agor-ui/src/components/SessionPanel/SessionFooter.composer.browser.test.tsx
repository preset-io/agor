import { SessionStatus, type Task, TaskStatus } from '@agor-live/client';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { makeSession } from '../../test/harness';
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
// Not a known model family, so the chip shows the raw ID unshortened.
const LONG_MODEL = 'frontier-reasoner-2026-10-preview-with-a-very-long-pinned-suffix';
const props: SessionFooterProps = {
  session: {
    ...makeSession('composer-session', 'composer-branch', {
      status: SessionStatus.RUNNING,
      model_config: { model: LONG_MODEL },
    }),
    agentic_tool: 'claude-code',
  },
  footerTimerTask: {
    task_id: 'composer-task',
    status: TaskStatus.RUNNING,
    created_at: new Date().toISOString(),
  } as Task,
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

const center = (rect: DOMRect) => rect.top + rect.height / 2;
// Desktop menus use 36px rows; phone bottom sheets use 44px touch rows.
const menuRowHeight = (isMobile: boolean) =>
  isMobile ? MOBILE_TOUCH_TARGET : theme.getDesignToken().controlHeightLG - 4;

/** Opens a composer menu: a popover dialog on desktop, a bottom sheet on phones. */
async function openMenu(trigger: HTMLElement, title: string) {
  await userEvent.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: title });
  await waitFor(() => expect(dialog).toBeVisible());
  return dialog.querySelector<HTMLElement>('.ant-drawer-body') ?? dialog;
}

async function closeMenu(title: string) {
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).toBeNull());
}

/** Menu copy stays at 12/14px sentence case, and the menu stays on screen. */
function expectMenuType(menu: HTMLElement) {
  for (const text of menu.querySelectorAll<HTMLElement>('span, div, button')) {
    if (
      ![...text.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
      )
    ) {
      continue;
    }
    const style = getComputedStyle(text);
    expect([12, 14]).toContain(Number.parseFloat(style.fontSize));
    expect(style.textTransform).not.toBe('uppercase');
  }
  const bounds = menu.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
}

it.each([
  [390, true],
  [390, false],
  [1280, true],
  [1280, false],
])(
  'keeps Stop stable through shutdown and recovery at %dpx (draft=%s)',
  async (width, hasInput) => {
    await page.viewport(width, 900);
    const onStop = vi.fn();
    const footer = (state: Partial<SessionFooterProps> = {}) => (
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
        <App>
          <main style={{ paddingInline: 24 }}>
            <SessionFooter {...props} hasInput={hasInput} {...state} onStop={onStop} />
          </main>
        </App>
      </ConfigProvider>
    );
    const view = render(footer());
    const circle = screen.getByTestId('composer-circle');
    // With a draft the circle queues it and Stop moves to the working line;
    // with an empty box the circle itself is Stop.
    expect(circle).toHaveAccessibleName(hasInput ? 'Queue message' : 'Stop');
    const stop = hasInput ? screen.getByRole('button', { name: 'Stop the agent' }) : circle;
    if (!hasInput) expect(screen.queryByRole('button', { name: 'Stop the agent' })).toBeNull();
    const circleBounds = circle.getBoundingClientRect().toJSON();
    const stopRight = stop.getBoundingClientRect().right;
    if (width < 1024) {
      for (const control of [stop, circle]) {
        expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(MOBILE_TOUCH_TARGET);
      }
    }
    expect(stop).toBeEnabled();
    expect(stop).not.toHaveAttribute('aria-disabled');
    await userEvent.click(stop);
    expect(onStop).toHaveBeenCalledOnce();

    const states: Partial<SessionFooterProps>[] = [
      { stopRequestInFlight: true },
      ...(['user_stop', 'heartbeat_lost'] as const).map((cause) => ({
        isStopping: true,
        session: { ...props.session, status: SessionStatus.STOPPING },
        recoveryTask: {
          ...props.footerTimerTask,
          status: TaskStatus.STOPPING,
          termination_request: { cause, requested_at: '2026-01-01T00:00:00Z' },
        } as Task,
      })),
    ];
    let busyBounds: ReturnType<DOMRect['toJSON']> | undefined;
    for (const state of states) {
      view.rerender(footer(state));
      expect(screen.getByTestId('composer-circle')).toBe(circle);
      if (hasInput) {
        expect(screen.getByRole('button', { name: 'Stop the agent' })).toBe(stop);
        expect(stop).toBeDisabled();
      } else {
        // The circle never takes the disabled attribute, so it keeps focus and its tooltip.
        expect(stop).toHaveAttribute('aria-disabled', 'true');
      }
      expect(screen.getByTestId('composer-working-line')).toHaveTextContent('Stopping');
      expect(stop).toHaveAttribute('aria-busy', 'true');
      expect(stop.querySelector('[data-icon="loading"]')).toBeVisible();
      const bounds = stop.getBoundingClientRect().toJSON();
      busyBounds ??= bounds;
      expect(bounds).toEqual(busyBounds);
      expect(bounds.right).toBe(stopRight);
      expect(circle.getBoundingClientRect().toJSON()).toEqual(circleBounds);
      stop.click();
      expect(onStop).toHaveBeenCalledOnce();
    }
  }
);

it.each([
  [360, 740, false],
  [390, 844, true],
  [430, 932, false],
  [1280, 900, false],
  [1280, 900, true],
])(
  'keeps the composer row and info line on single rows at %dx%d (dark=%s)',
  async (width, height, dark) => {
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
            <SessionFooter {...props} />
          </main>
        </App>
      </ConfigProvider>
    );

    const isMobile = width < 1024;
    const size = isMobile ? MOBILE_TOUCH_TARGET : theme.getDesignToken().controlHeight;
    const card = screen.getByTestId('composer-card').getBoundingClientRect();
    const plus = screen.getByRole('button', { name: 'Add files and actions' });
    const modelChip = screen.getByTestId('model-chip');
    const circle = screen.getByTestId('composer-circle');
    // Desktop pins Attach files here; phone pins are kept separately and start empty.
    if (isMobile) expect(screen.queryByTestId('upload-bar-btn')).toBeNull();
    const row = [
      plus,
      ...(isMobile ? [] : [screen.getByTestId('upload-bar-btn')]),
      modelChip,
      circle,
    ];
    const rects = row.map((control) => control.getBoundingClientRect());
    rects.forEach((rect, index) => {
      expect(rect.height).toBe(size);
      expect(Math.abs(center(rect) - center(rects[0]))).toBeLessThanOrEqual(1);
      expect(rect.left).toBeGreaterThanOrEqual(card.left);
      expect(rect.right).toBeLessThanOrEqual(card.right);
      if (index > 0) expect(rect.left).toBeGreaterThanOrEqual(rects[index - 1].right);
    });
    // The circle is a circle, and the row ends with it.
    expect(rects.at(-1)!.width).toBe(size);
    expect(card.right).toBeLessThanOrEqual(window.innerWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

    const modelLabel = within(modelChip).getByText(LONG_MODEL);
    // The row reads as secondary to the prompt: 12px in the secondary text colour.
    const rowTokens = theme.getDesignToken({
      algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    });
    const probe = document.createElement('span');
    probe.style.color = rowTokens.colorTextSecondary;
    document.body.append(probe);
    const secondary = getComputedStyle(probe).color;
    probe.remove();
    expect(getComputedStyle(modelLabel).fontSize).toBe(`${rowTokens.fontSizeSM}px`);
    expect(getComputedStyle(modelChip).color).toBe(secondary);
    if (isMobile) {
      // Phones clip the long name inside the chip rather than pushing the circle off.
      expect(modelLabel.scrollWidth).toBeGreaterThan(modelLabel.clientWidth);
    } else {
      expect(modelLabel.scrollWidth).toBeLessThanOrEqual(modelLabel.clientWidth);
    }

    // The info line sits under the card on one line, with phone-sized targets.
    const infoLine = screen.getByTestId('composer-info-line');
    expect(infoLine).toHaveTextContent('4%');
    // Usage is lazy: no snapshot yet, so no usage segment.
    expect(infoLine).not.toHaveTextContent(/Usage|tokens/);
    const info = infoLine.getBoundingClientRect();
    expect(info.top).toBeGreaterThanOrEqual(card.bottom);
    expect(info.right).toBeLessThanOrEqual(window.innerWidth);
    const infoButtons = within(infoLine)
      .getAllByRole('button')
      .map((button) => button.getBoundingClientRect());
    expect(infoButtons.length).toBeGreaterThan(0);
    for (const button of infoButtons) {
      expect(button.top).toBe(infoButtons[0].top);
      expect(button.height).toBe(
        isMobile ? MOBILE_TOUCH_TARGET : theme.getDesignToken().controlHeightSM
      );
    }

    const rowHeight = menuRowHeight(isMobile);
    const plusMenu = await openMenu(plus, 'Add files and actions');
    const attach = within(plusMenu).getByText('Attach files', { exact: true }).closest('button')!;
    expect(attach.getBoundingClientRect().height).toBeGreaterThanOrEqual(rowHeight);
    const pin = within(plusMenu).getByRole('button', {
      name: isMobile ? 'Pin Attach files to the composer' : 'Unpin Attach files from the composer',
    });
    expect(pin.getBoundingClientRect().height).toBe(rowHeight);
    expect(pin.getBoundingClientRect().width).toBe(rowHeight);
    expectMenuType(plusMenu);
    await closeMenu('Add files and actions');

    const modelMenu = await openMenu(modelChip, 'Model');
    expect(within(modelMenu).getByRole('radiogroup', { name: 'Model' })).toBeVisible();
    const permissionsRow = within(modelMenu)
      .getByText('Permissions', { exact: true })
      .closest('button')!;
    expect(permissionsRow.getBoundingClientRect().height).toBeGreaterThanOrEqual(rowHeight);
    expectMenuType(modelMenu);
    await userEvent.click(permissionsRow);
    const back = await within(modelMenu).findByRole('button', { name: 'Back to model' });
    expect(back.getBoundingClientRect().height).toBe(rowHeight);
    const permissions = within(modelMenu).getByRole('radiogroup', { name: 'Permissions' });
    for (const radio of within(permissions).getAllByRole('radio')) {
      expect(radio.getBoundingClientRect().height).toBeGreaterThanOrEqual(rowHeight);
    }
    expect(within(permissions).getByRole('radio', { checked: true })).toBeVisible();
    expectMenuType(modelMenu);
    await page.screenshot({ path: `./.vitest/composer-${width}-${dark ? 'dark' : 'light'}.png` });
  }
);

it('keeps the advisor and exact-version picker one drill-in from the model chip', async () => {
  await page.viewport(1280, 900);
  const onModelConfigCommit = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <main style={{ paddingInline: 24, paddingTop: 600 }}>
          <SessionFooter
            {...props}
            isRunning={false}
            hasInput={false}
            modelConfig={{ mode: 'alias', model: 'claude-opus-5-5' }}
            onModelConfigCommit={onModelConfigCommit}
          />
        </main>
      </App>
    </ConfigProvider>
  );
  await userEvent.click(screen.getByTestId('model-chip'));
  const menu = await screen.findByRole('dialog', { name: 'Model' });
  await userEvent.click(within(menu).getByRole('button', { name: /Advisor and exact version/ }));
  expect(await within(menu).findByText('Advisor model')).toBeVisible();
  expect(within(menu).getByRole('button', { name: /Pin a specific version/ })).toBeVisible();
  // A dropdown opened inside the menu must not close the menu.
  await userEvent.click(within(menu).getAllByRole('combobox')[0]);
  const options = await waitFor(() => {
    const visible = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')];
    expect(visible.length).toBeGreaterThan(1);
    return visible;
  });
  const other = options.find(
    (option) => !option.classList.contains('ant-select-item-option-selected')
  )!;
  await userEvent.click(other);
  await waitFor(() => expect(onModelConfigCommit).toHaveBeenCalledOnce());
  expect(screen.getByRole('dialog', { name: 'Model' })).toBeVisible();
  await userEvent.click(within(menu).getByRole('button', { name: 'Back to model' }));
  expect(await within(menu).findByRole('radiogroup', { name: 'Model' })).toBeVisible();
});
