import { type Session, SessionStatus } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type {} from '@vitest/browser-playwright';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import globalCss from '../../index.css?raw';
import { isMobileViewport, MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import SessionPanel from './SessionPanel';

// Keep the actual panel and composer layout; substitute only transcript data
// with a long scrollable history so the test needs no daemon or live agent.
vi.mock('./SessionPanelContent', () => ({
  SessionPanelContent: () => (
    <div data-testid="history" style={{ flex: 1, overflow: 'auto' }}>
      {Array.from({ length: 100 }, (_, i) => `Conversation message ${i + 1}`).map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  ),
}));
vi.mock('../ForkSpawnModal/ForkSpawnModal', () => ({ ForkSpawnModal: () => null }));

const session = {
  session_id: 'footer-layout-session',
  branch_id: 'footer-layout-branch',
  agentic_tool: 'codex',
  title: 'Conversation controls',
  status: SessionStatus.RUNNING,
} as Session;
const noop = () => {};
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
const bottomInset = theme.getDesignToken().sizeUnit * 2;

beforeEach(async () => {
  localStorage.clear();
  // Usage shows only once fetched; pin Session IDs so the info line has content.
  localStorage.setItem(
    'agor-footer-prefs',
    JSON.stringify({ pinnedChips: ['timer', 'tools', 'tokens', 'context', 'session-ids'] })
  );
  document.body.style.margin = '0';
  // The browser suite's 1000px desktop fixture is below the mobile-shell
  // breakpoint. Also exercise the actual desktop composer, including embeds.
  if (originalViewport.width === 1000) await page.viewport(1280, 900);
});
afterEach(async () => {
  cleanup();
  await cdp().send('Emulation.setEmulatedMedia', { features: [] });
  await page.viewport(originalViewport.width, originalViewport.height);
});

function panel(status: Session['status'], embedded: boolean, height = window.innerHeight) {
  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      {/* Apply the app's actual reduced-motion rules without fetching web fonts. */}
      <style>{globalCss.replace(/@import[^;]+;/g, '')}</style>
      <App>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            authGeneration: 1,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <AppActionsProvider value={{}}>
            <div
              data-testid="panel"
              style={{
                width: embedded ? Math.min(420, window.innerWidth) : '100%',
                height,
                overflow: 'hidden',
                borderRadius: 12,
              }}
            >
              <SessionPanel client={null} session={{ ...session, status }} open onClose={noop} />
            </div>
          </AppActionsProvider>
        </ConnectionProvider>
      </App>
    </ConfigProvider>
  );
}

const circle = () => screen.getByTestId('composer-circle');
const card = () => screen.getByTestId('composer-card');
const center = (rect: DOMRect) => rect.top + rect.height / 2;
/** The working dot pulses through a pseudo-element; reduced motion stills it. */
const dotAnimation = (dot: Element) => getComputedStyle(dot, '::after').animationName;

it.each([false, true])(
  'keeps padded controls and activity visible while reading older messages (embedded=%s)',
  async (embedded) => {
    const view = render(panel(SessionStatus.RUNNING, embedded));
    const history = screen.getByTestId('history');
    // Running with an empty box: the one circle is Stop.
    const stop = circle();
    expect(stop).toHaveAccessibleName('Stop');
    const plus = screen.getByRole('button', { name: 'Add files and actions' });
    const activity = screen.getByRole('status', { name: 'Agent is working' });
    const dot = activity.previousElementSibling!;
    const bounds = screen.getByTestId('panel').getBoundingClientRect();
    await waitFor(() => expect(history.scrollHeight).toBeGreaterThan(history.clientHeight));

    const buttonBounds = stop.getBoundingClientRect();
    const size = isMobileViewport() ? MOBILE_TOUCH_TARGET : theme.getDesignToken().controlHeight;
    for (const control of [stop, plus, activity]) {
      const rect = control.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      expect(rect.right).toBeLessThanOrEqual(bounds.right);
      expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom - bottomInset);
      expect(rect.top).toBeGreaterThanOrEqual(bounds.top);
      expect(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      ).toSatisfy((element: Element | null) => !!element && control.contains(element));
    }
    for (const control of [stop, plus]) expect(control.getBoundingClientRect().height).toBe(size);
    // The working status and the info share one row above the card; the card ends the footer.
    const statusRow = screen.getByTestId('composer-status-row');
    expect(statusRow).toContainElement(activity);
    expect(card()).not.toContainElement(activity);
    const infoLine = screen.getByTestId('composer-info-line').getBoundingClientRect();
    expect(statusRow.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      card().getBoundingClientRect().top
    );
    expect(
      Math.abs(center(infoLine) - center(activity.getBoundingClientRect()))
    ).toBeLessThanOrEqual(1);
    expect(bounds.bottom - card().getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
      bottomInset
    );
    const expectCenteredActivity = () => {
      expect(dot).toBeVisible();
      const indicator = dot.getBoundingClientRect();
      expect(
        Math.abs(center(indicator) - center(activity.getBoundingClientRect()))
      ).toBeLessThanOrEqual(1);
    };
    expectCenteredActivity();
    expect(stop).not.toHaveAttribute('aria-disabled');

    history.scrollTop = history.scrollHeight;
    history.scrollTop = 0;
    expect(history.scrollTop).toBe(0);
    expect(stop.getBoundingClientRect().toJSON()).toEqual(buttonBounds.toJSON());
    expect(activity).toBeVisible();
    await page.screenshot({
      path: `./.vitest/footer-running-${window.innerWidth}-${embedded}.png`,
    });

    // The shared reduced-motion rule keeps the visible status, without the pulse.
    expect(dotAnimation(dot)).not.toBe('none');
    await cdp().send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await waitFor(() => expect(dotAnimation(dot)).toBe('none'));
    expect(activity).toBeVisible();
    expectCenteredActivity();

    // Stopping keeps the same Stop circle, busy, and never shifts it.
    view.rerender(panel(SessionStatus.STOPPING, embedded));
    expect(circle()).toBe(stop);
    expect(stop).toHaveAccessibleName('Stop');
    expect(stop).toHaveAttribute('aria-disabled', 'true');
    expect(stop).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('status', { name: 'Agent is working' })).toBeNull();
    expect(screen.getByTestId('composer-working-label')).toHaveTextContent('Stopping');
    expect(stop.getBoundingClientRect().toJSON()).toEqual(buttonBounds.toJSON());

    // Idle: the same circle becomes Send, unavailable until there is a draft.
    view.rerender(panel(SessionStatus.COMPLETED, embedded));
    expect(screen.queryByRole('status', { name: 'Agent is working' })).toBeNull();
    expect(screen.queryByTestId('composer-working-line')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(circle()).toBe(stop);
    expect(stop).toHaveAccessibleName('Send');
    expect(stop).toHaveAttribute('aria-disabled', 'true');
    expect(stop.getBoundingClientRect().right).toBe(buttonBounds.right);
    expect(stop.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom - bottomInset);
    await page.screenshot({ path: `./.vitest/footer-idle-${window.innerWidth}-${embedded}.png` });
  }
);

it.each([360, 390, 430])(
  'keeps the phone Send and Queue fills inside the card at %ipx with 44px targets',
  async (width) => {
    await page.viewport(width, 700);
    render(panel(SessionStatus.RUNNING, false));
    await userEvent.type(screen.getByPlaceholderText(/^Queue a follow-up/), 'next step');
    await waitFor(() => expect(circle()).toHaveAccessibleName('Queue message'));
    const target = circle().getBoundingClientRect();
    const box = card().getBoundingClientRect();
    // Queue is a labelled pill: 44px tall, as wide as its label needs.
    expect(circle()).toHaveTextContent('Queue');
    expect(target.width).toBeGreaterThan(MOBILE_TOUCH_TARGET);
    expect(target.height).toBe(MOBILE_TOUCH_TARGET);
    // The fill is the content box: 36px tall, inset from the 44px target.
    const style = getComputedStyle(circle());
    expect(style.backgroundClip).toBe('content-box');
    const inset = Number.parseFloat(style.paddingRight);
    expect(target.height - 2 * inset).toBe(36);
    expect(box.right - (target.right - inset)).toBeGreaterThanOrEqual(10);
    expect(box.bottom - (target.bottom - inset)).toBeGreaterThanOrEqual(10);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  }
);

it('opens desktop menus above the card, anchored to their trigger', async () => {
  await page.viewport(1280, 800);
  render(panel(SessionStatus.IDLE, false));
  for (const [trigger, name] of [
    [() => screen.getByRole('button', { name: 'Add files and actions' }), 'Add files and actions'],
    [() => screen.getByTestId('model-chip'), 'Model'],
  ] as const) {
    const button = trigger();
    await userEvent.click(button);
    const menu = await screen.findByRole('dialog', { name });
    await waitFor(
      () => {
        const popup = menu.closest('.ant-popover')!.getBoundingClientRect();
        expect(popup.bottom).toBeLessThanOrEqual(card().getBoundingClientRect().top);
        // Still anchored to its trigger: left edges line up.
        expect(Math.abs(popup.left - button.getBoundingClientRect().left)).toBeLessThanOrEqual(1);
        // The popover realigns after it measures the card; allow for a loaded CI runner.
      },
      { timeout: 5000 }
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name })).toBeNull());
  }
});

it.each([
  [120, 360, true],
  [300, 180, false],
])(
  'keeps Session details below a %ipx app header, scrolling inside a %ipx panel (above the card: %s)',
  async (header, height, aboveCard) => {
    if (isMobileViewport()) return;
    await page.viewport(1280, 480);
    render(<div style={{ paddingTop: header }}>{panel(SessionStatus.IDLE, false, height)}</div>);
    await userEvent.click(screen.getByRole('button', { name: 'Session details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Session details' });
    const popover = dialog.closest<HTMLElement>('.ant-popover')!;
    const bounds = document.querySelector('[data-composer-bounds]')!.getBoundingClientRect();
    const minHeight = (theme.getDesignToken().controlHeightLG - theme.getDesignToken().sizeXXS) * 4;
    await waitFor(() => {
      // Measure the settled popover, not its scaled-down zoom-in.
      expect(popover.className).not.toMatch(/-appear/);
      expect(popover.getAnimations({ subtree: true })).toHaveLength(0);
      const popup = popover.getBoundingClientRect();
      const cardTop = card().getBoundingClientRect().top;
      expect(popup.top).toBeGreaterThanOrEqual(bounds.top);
      // With room, it sits above the card; without, it keeps a usable height over the card.
      if (aboveCard) expect(popup.bottom).toBeLessThanOrEqual(cardTop);
      else expect(popup.bottom).toBeGreaterThan(cardTop);
      expect(dialog.clientHeight).toBeGreaterThanOrEqual(minHeight);
    });
    // The rows scroll inside the capped popover.
    expect(dialog.scrollHeight).toBeGreaterThan(dialog.clientHeight);
    expect(getComputedStyle(dialog).overflowY).toBe('auto');
  }
);

it('retains the bottom inset when resizing from mobile to desktop', async () => {
  await page.viewport(390, 700);
  render(panel(SessionStatus.RUNNING, false));
  await page.viewport(1280, 700);
  await waitFor(() => {
    const bounds = screen.getByTestId('panel').getBoundingClientRect();
    // Desktop controls are back to 32px, so the layout has switched.
    expect(circle().getBoundingClientRect().height).toBe(theme.getDesignToken().controlHeight);
    expect(bounds.bottom - card().getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
      bottomInset
    );
    expect(bounds.bottom - circle().getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
      bottomInset
    );
  });
});

it.each([
  [1280, 390],
  [390, 1280],
])('keeps the typed draft and focus when resizing from %ipx to %ipx', async (from, to) => {
  await page.viewport(from, 700);
  render(panel(SessionStatus.IDLE, false));
  const input = screen.getByPlaceholderText(/^Prompt here…/);
  await userEvent.click(input);
  await userEvent.keyboard('unsaved draft');
  // Resize before the draft's debounced save can run, then wait for React to
  // render the new layout: phones use 44px controls, desktop 32px.
  await page.viewport(to, 700);
  await waitFor(() =>
    expect(circle().getBoundingClientRect().height).toBe(
      to < 1024 ? MOBILE_TOUCH_TARGET : theme.getDesignToken().controlHeight
    )
  );
  // Same element: crossing the breakpoint must not remount the composer.
  expect(screen.getByPlaceholderText(/^Prompt here…/)).toBe(input);
  expect(input).toHaveValue('unsaved draft');
  expect(input).toHaveFocus();
  expect(circle()).toHaveAccessibleName('Send');
  expect(circle()).not.toHaveAttribute('aria-disabled');
});

it('tabs from the desktop input to the first toolbar control', async () => {
  await page.viewport(1280, 700);
  render(panel(SessionStatus.IDLE, false));
  await userEvent.click(screen.getByPlaceholderText(/^Prompt here…/));
  await userEvent.tab();
  expect(screen.getByRole('button', { name: 'Add files and actions' })).toHaveFocus();
});

it('puts the phone composer in one card whose text grows to five lines above the control row', async () => {
  await page.viewport(390, 700);
  render(panel(SessionStatus.RUNNING, false));
  const input = screen.getByPlaceholderText('Queue a follow-up');
  const buttons = [
    screen.getByRole('button', { name: 'Add files and actions' }),
    screen.getByTestId('model-chip'),
    circle(),
  ];
  const panelBounds = screen.getByTestId('panel').getBoundingClientRect();
  const expectRowBelowText = () => {
    const field = input.getBoundingClientRect();
    const cardBounds = card().getBoundingClientRect();
    expect(field.left).toBeGreaterThanOrEqual(cardBounds.left);
    expect(field.right).toBeLessThanOrEqual(cardBounds.right);
    const first = buttons[0].getBoundingClientRect();
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      expect(rect.height).toBe(MOBILE_TOUCH_TARGET);
      expect(rect.top).toBeGreaterThanOrEqual(field.bottom);
      expect(Math.abs(center(rect) - center(first))).toBeLessThanOrEqual(1);
      expect(rect.bottom).toBeLessThanOrEqual(cardBounds.bottom);
    }
    expect(panelBounds.bottom - cardBounds.bottom).toBeGreaterThanOrEqual(bottomInset);
    return field.height;
  };
  const singleLine = expectRowBelowText();
  // Not focused: the info line shows above the card.
  expect(screen.getByTestId('composer-info-line')).toBeVisible();

  await userEvent.fill(input, Array.from({ length: 8 }, (_, i) => `Line ${i + 1}`).join('\n'));
  await waitFor(() => expect(input.scrollHeight).toBeGreaterThan(input.clientHeight));
  const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight);
  const grown = expectRowBelowText();
  expect(grown).toBeGreaterThan(singleLine + lineHeight * 3);
  expect(grown).toBeLessThanOrEqual(singleLine + lineHeight * 4 + 1);
  // While the text has focus the keyboard is up: the info line steps aside and
  // the card keeps the bottom inset itself.
  expect(input).toHaveFocus();
  await waitFor(() => expect(screen.queryByTestId('composer-info-line')).toBeNull());
  expect(panelBounds.bottom - card().getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
    bottomInset
  );
  // A row button taking focus is not the keyboard, so the info line returns.
  act(() => buttons[0].focus());
  await waitFor(() => expect(screen.getByTestId('composer-info-line')).toBeVisible());
});
