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
      expect(screen.getByTestId('composer-working-label')).toHaveTextContent('Stopping');
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
    // Attach is pinned on desktop, and on phones by default; a crowded phone row folds it first.
    const upload = screen.queryByTestId('upload-bar-btn');
    if (!isMobile) expect(upload).not.toBeNull();
    const row = [plus, ...(upload ? [upload] : []), modelChip, circle];
    const rects = row.map((control) => control.getBoundingClientRect());
    rects.forEach((rect, index) => {
      expect(rect.height).toBe(size);
      expect(Math.abs(center(rect) - center(rects[0]))).toBeLessThanOrEqual(1);
      expect(rect.left).toBeGreaterThanOrEqual(card.left);
      expect(rect.right).toBeLessThanOrEqual(card.right);
      if (index > 0) expect(rect.left).toBeGreaterThanOrEqual(rects[index - 1].right);
    });
    // Running with text, the row ends with the labelled Queue pill.
    expect(circle).toHaveTextContent('Queue');
    expect(rects.at(-1)!.width).toBeGreaterThan(size);
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

    // The info sits in the one row above the card, beside the working status, on one line.
    const infoLine = screen.getByTestId('composer-info-line');
    expect(infoLine).toHaveTextContent('4%');
    // Usage is lazy: no snapshot yet, so no usage segment.
    expect(infoLine).not.toHaveTextContent(/Usage|tokens/);
    const info = infoLine.getBoundingClientRect();
    expect(info.bottom).toBeLessThanOrEqual(card.top);
    expect(info.right).toBeLessThanOrEqual(window.innerWidth);
    const statusRow = screen.getByTestId('composer-status-row').getBoundingClientRect();
    expect(statusRow.height).toBe(
      isMobile ? MOBILE_TOUCH_TARGET : theme.getDesignToken().controlHeightSM
    );
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
      name: 'Unpin Attach files from the composer',
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

function rowFooter(width?: number, state: Partial<SessionFooterProps> = {}) {
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <main style={{ paddingInline: 24, width, boxSizing: 'border-box' }}>
          <SessionFooter {...props} {...state} />
        </main>
      </App>
    </ConfigProvider>
  );
}

/** The status row: one line directly above the card, never scrolling, nothing under the card. */
function expectStatusRowAboveCard() {
  const row = screen.getByTestId('composer-status-row');
  const box = screen.getByTestId('composer-card').getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  expect(rowRect.bottom).toBeLessThanOrEqual(box.top);
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  const controls = [...row.querySelectorAll('button, [role="status"]')].map((control) =>
    control.getBoundingClientRect()
  );
  for (const rect of controls) {
    expect(Math.abs(center(rect) - center(rowRect))).toBeLessThanOrEqual(1);
    expect(rect.left).toBeGreaterThanOrEqual(rowRect.left);
    expect(rect.right).toBeLessThanOrEqual(rowRect.right);
  }
  for (const element of row.parentElement!.querySelectorAll('*')) {
    const rect = element.getBoundingClientRect();
    if (rect.height > 0) expect(rect.top).toBeLessThan(box.bottom);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  return row;
}

it.each([360, 390, 430])(
  'puts the working status, Stop and info in one row above the phone card at %ipx',
  async (width) => {
    await page.viewport(width, 800);
    render(rowFooter());
    const row = expectStatusRowAboveCard();
    const stop = screen.getByRole('button', { name: 'Stop the agent' });
    const info = screen.getByTestId('composer-info-line');
    expect(row).toContainElement(screen.getByRole('status', { name: 'Agent is working' }));
    expect(row).toContainElement(stop);
    expect(stop.getBoundingClientRect().height).toBe(MOBILE_TOUCH_TARGET);
    // Status on the left with Stop 8px after it; info on the right.
    const status = screen.getByRole('status', { name: 'Agent is working' }).getBoundingClientRect();
    expect(stop.getBoundingClientRect().left - status.right).toBeCloseTo(
      theme.getDesignToken().marginXS,
      0
    );
    expect(stop.getBoundingClientRect().right).toBeLessThanOrEqual(
      info.getBoundingClientRect().left
    );
    // The context ring sits 4px from its number.
    const ring = within(info)
      .getByRole('button', { name: /^Context 4% used/ })
      .querySelector('.ant-progress')!;
    const number = document.createRange();
    number.selectNodeContents(ring.nextSibling!);
    expect(number.getBoundingClientRect().left - ring.getBoundingClientRect().right).toBeCloseTo(
      theme.getDesignToken().marginXXS,
      0
    );
    // Crowded or not, the context ring and Session details stay.
    expect(within(info).getByRole('button', { name: /^Context 4% used/ })).toBeVisible();
    expect(within(info).getByRole('button', { name: 'Session details' })).toBeVisible();
  }
);

it.each([340, 357])(
  'keeps the status row on one line in a %ipx panel, with the ring and "›"',
  async (width) => {
    await page.viewport(1280, 900);
    render(rowFooter(width));
    const info = screen.getByTestId('composer-info-line');
    await waitFor(expectStatusRowAboveCard);
    expect(screen.getByRole('button', { name: 'Stop the agent' })).toBeVisible();
    expect(within(info).getByRole('button', { name: /^Context 4% used/ })).toBeVisible();
    expect(within(info).getByRole('button', { name: 'Session details' })).toBeVisible();
    // Everything that fits shows; only a crowded row folds the rest away.
    if (!info.hasAttribute('data-folded')) {
      expect(within(info).getByRole('button', { name: /^Session ID / })).toBeVisible();
    }
  }
);

it('folds a crowded status row into Session details, keeping the ring, and unfolds with room', async () => {
  await page.viewport(1280, 900);
  const view = render(rowFooter(280));
  const info = screen.getByTestId('composer-info-line');
  await waitFor(() => expect(info).toHaveAttribute('data-folded', 'true'));
  expectStatusRowAboveCard();
  expect(screen.getByRole('button', { name: 'Stop the agent' })).toBeVisible();
  expect(within(info).queryByRole('button', { name: /^Session ID / })).toBeNull();
  expect(within(info).getByRole('button', { name: /^Context 4% used/ })).toBeVisible();
  expect(within(info).getByRole('button', { name: 'Session details' })).toBeVisible();
  // Idle, with room again, the full set comes back; the left side is empty.
  view.rerender(rowFooter(900, { isRunning: false, hasInput: false }));
  await waitFor(() => expect(info).not.toHaveAttribute('data-folded'));
  expect(screen.queryByTestId('composer-working-line')).toBeNull();
  expect(within(info).getByRole('button', { name: /^Session ID / })).toBeVisible();
  expectStatusRowAboveCard();
});

it.each([
  [340, 'auto', false],
  [357, 'auto', false],
  [340, 'plan', false],
  [357, 'acceptEdits', false],
  [340, 'acceptEdits', false],
  [340, 'auto', true],
  [357, 'auto', true],
  [340, 'acceptEdits', true],
  [357, 'plan', true],
] as const)(
  'keeps the row on one line in a %ipx panel (permissions %s, queue %s)',
  async (width, permissionMode, queue) => {
    localStorage.removeItem('agor-footer-prefs');
    await page.viewport(1280, 900);
    const state = {
      session: { ...props.session, model_config: { model: 'claude-opus-5-5' } },
      permissionMode,
      // Idle with text shows the Send circle; running with text shows the Queue pill.
      isRunning: queue,
      hasInput: true,
    };
    const view = render(rowFooter(width, state));
    const card = screen.getByTestId('composer-card');
    const modelChip = screen.getByTestId('model-chip');
    const circle = screen.getByTestId('composer-circle');
    // The narrow row drops the effort: just the model.
    expect(modelChip).toHaveTextContent(/^Opus 5\.5$/);
    const permissionChip = screen.queryByTestId('permission-chip');
    expect(!!permissionChip).toBe(permissionMode !== 'auto');
    const expectRowFits = () => {
      const box = card.getBoundingClientRect();
      const controls = [...card.querySelectorAll('button')].filter(
        (button) => !button.closest('textarea')
      );
      const top = controls[0].getBoundingClientRect().top;
      for (const control of controls) {
        const rect = control.getBoundingClientRect();
        expect(rect.top).toBe(top);
        expect(rect.left).toBeGreaterThanOrEqual(box.left);
        expect(rect.right).toBeLessThanOrEqual(box.right);
      }
      // No chip text is clipped, and nothing scrolls sideways.
      for (const chip of [modelChip, permissionChip]) {
        const text = chip?.querySelector('.ant-typography');
        if (text) expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
      }
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    };
    await waitFor(expectRowFits);
    const pins = ['upload-bar-btn', 'fork-bar-btn', 'mcp-bar-btn'].map((id) =>
      screen.queryByTestId(id)
    );
    // Pins fold from the end: whatever stays is Attach, then Fork, then MCP.
    const shown = pins.findIndex((pin) => !pin);
    for (const pin of pins.slice(shown === -1 ? pins.length : shown)) expect(pin).toBeNull();
    if (queue) {
      // The label stays; pins give way first.
      expect(circle).toHaveTextContent('Queue');
      expect(circle.getBoundingClientRect().height).toBe(theme.getDesignToken().controlHeight);
    } else {
      expect(circle.getBoundingClientRect().width).toBe(theme.getDesignToken().controlHeight);
      expect(screen.getByTestId('upload-bar-btn')).toBeVisible();
      expect(screen.getByTestId('fork-bar-btn')).toBeVisible();
    }
    if (!permissionChip && !queue) {
      // All 3 default pins stay one click away.
      expect(screen.getByTestId('mcp-bar-btn')).toBeVisible();
    } else if (!screen.queryByTestId('mcp-bar-btn')) {
      // The last pin folds into "+", which says so.
      await userEvent.click(screen.getByRole('button', { name: 'Add files and actions' }));
      const menu = await screen.findByRole('dialog', { name: 'Add files and actions' });
      expect(
        within(menu).getByText('MCP tools stays in here until the panel is wider.')
      ).toBeVisible();
      await closeMenu('Add files and actions');
      // With room again, the pins come back.
      view.rerender(rowFooter(600, state));
      await waitFor(() => expect(screen.getByTestId('mcp-bar-btn')).toBeVisible());
      expect(screen.getByTestId('upload-bar-btn')).toBeVisible();
    }
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
