import { type Session, SessionStatus } from '@agor-live/client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type {} from '@vitest/browser-playwright';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import globalCss from '../../index.css?raw';
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

function panel(status: Session['status'], embedded: boolean) {
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
                height: window.innerHeight,
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

it.each([false, true])(
  'keeps padded controls and activity visible while reading older messages (embedded=%s)',
  async (embedded) => {
    const view = render(panel(SessionStatus.RUNNING, embedded));
    const history = screen.getByTestId('history');
    const stop = screen.getByRole('button', { name: 'Stop' });
    const send = screen.getByRole('button', { name: 'Send' });
    const activity = screen.getByRole('status', { name: 'Agent is working' });
    const bounds = screen.getByTestId('panel').getBoundingClientRect();
    await waitFor(() => expect(history.scrollHeight).toBeGreaterThan(history.clientHeight));

    const buttonBounds = send.getBoundingClientRect();
    for (const control of [stop, send, activity]) {
      const rect = control.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      expect(rect.right).toBeLessThanOrEqual(bounds.right);
      expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom - bottomInset);
      expect(rect.top).toBeGreaterThanOrEqual(bounds.top);
      expect(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      ).toSatisfy((element: Element | null) => !!element && control.contains(element));
    }
    expect(activity.getBoundingClientRect().right).toBeLessThan(stop.getBoundingClientRect().left);
    expect(activity.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      stop.getBoundingClientRect().top
    );
    expect(send).toBeDisabled();

    history.scrollTop = history.scrollHeight;
    history.scrollTop = 0;
    expect(history.scrollTop).toBe(0);
    expect(send.getBoundingClientRect().toJSON()).toEqual(buttonBounds.toJSON());
    expect(activity).toBeVisible();
    await page.screenshot({
      path: `./.vitest/footer-running-${window.innerWidth}-${embedded}.png`,
    });

    // The shared reduced-motion rule retains the visible status, without rotation.
    expect(getComputedStyle(activity.querySelector('.ant-spin-dot-spin')!).animationName).not.toBe(
      'none'
    );
    await cdp().send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await waitFor(() =>
      expect(getComputedStyle(activity.querySelector('.ant-spin-dot-spin')!).animationName).toBe(
        'none'
      )
    );
    expect(activity).toBeVisible();

    // Stopping retains both buttons; removing activity must not shift either.
    const stopBounds = stop.getBoundingClientRect();
    view.rerender(panel(SessionStatus.STOPPING, embedded));
    expect(screen.queryByRole('status', { name: 'Agent is working' })).toBeNull();
    for (const [control, previous] of [
      [send, buttonBounds],
      [stop, stopBounds],
    ] as const) {
      const current = control.getBoundingClientRect();
      expect(current.left).toBe(previous.left);
      expect(current.width).toBe(previous.width);
      // Stop's own existing icon-to-Spin swap can change inline rounding.
      expect(Math.abs(current.top - previous.top)).toBeLessThanOrEqual(1);
    }

    view.rerender(panel(SessionStatus.COMPLETED, embedded));
    expect(screen.queryByRole('status', { name: 'Agent is working' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(send.getBoundingClientRect().right).toBe(buttonBounds.right);
    expect(send.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom - bottomInset);
    await page.screenshot({ path: `./.vitest/footer-idle-${window.innerWidth}-${embedded}.png` });
  }
);

it('retains the bottom inset when resizing from mobile to desktop', async () => {
  await page.viewport(390, 700);
  render(panel(SessionStatus.RUNNING, false));
  await page.viewport(1280, 700);
  await waitFor(() => {
    const bounds = screen.getByTestId('panel').getBoundingClientRect();
    const send = screen.getByRole('button', { name: 'Send' }).getBoundingClientRect();
    expect(bounds.bottom - send.bottom).toBeGreaterThanOrEqual(bottomInset);
  });
});
