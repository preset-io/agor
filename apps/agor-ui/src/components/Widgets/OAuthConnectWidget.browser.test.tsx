/**
 * OAuthConnectWidget — real-browser (Playwright + Chromium) validation.
 *
 * jsdom cannot tell the truth about two things this widget depends on:
 *
 *   1. **User activation and `window.open`.** The whole reason the popup is
 *      reserved before the `oauth-start` await is that a real browser blocks a
 *      window opened after it. jsdom has no activation model, so a jsdom test
 *      passes either way. Here the real `window.open` runs, under a real click.
 *   2. **Layout.** The card renders inside a transcript, so the Connect button
 *      and the pending/failure alerts have to stay inside the viewport at phone
 *      width — `position`/wrapping that jsdom does not compute.
 *
 * Runs under `vitest.browser.config.ts` across the desktop/phone/tablet/
 * short-landscape instances that config defines.
 */

import type { AgorClient, WidgetMessageMetadata } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthConnectWidget } from './OAuthConnectWidget';

afterEach(cleanup);

const PARAMS = {
  mcpServerId: 'srv-notion',
  serverName: 'Notion',
  oauthMode: 'per_user' as const,
  reason: 'Read the roadmap page.',
  catalogEntryName: 'com.notion/mcp',
  permissionDisclosure: 'Agor can read and write pages you share with this integration.',
};

function widget(overrides: Partial<WidgetMessageMetadata> = {}): WidgetMessageMetadata {
  return {
    widget_id: 'widget-1' as never,
    widget_type: 'oauth',
    schema_version: 1,
    params: PARAMS,
    status: 'pending',
    requested_at: '2026-09-16T00:00:00.000Z',
    ...overrides,
  } as WidgetMessageMetadata;
}

/**
 * A client whose `oauth-start` never settles, so the widget stays in whatever
 * state the click put it in and the assertions can look at it.
 */
function makeClient(opts: {
  onCall?: (path: string) => void;
  start?: () => Promise<unknown>;
  resolve?: () => Promise<unknown>;
}): AgorClient {
  return {
    service: (path: string) => ({
      // The widget polls the durable attempt through this service. Not mocked
      // at the module level here: this suite runs the REAL
      // `waitForMCPOAuthAttempt`, so the poll is part of what is exercised.
      get: async () => {
        opts.onCall?.(`${path}#get`);
        return { status: 'succeeded' };
      },
      create: async () => {
        opts.onCall?.(path);
        if (path === 'mcp-servers/oauth-start') {
          return (
            opts.start?.() ?? {
              success: true,
              authorizationUrl: 'about:blank#authorize',
              attempt_id: 'attempt-1',
            }
          );
        }
        if (path.endsWith('/oauth-resolve')) {
          return opts.resolve?.() ?? { widget_id: 'widget-1', status: 'submitted' };
        }
        if (path.endsWith('/dismiss')) return { widget_id: 'widget-1', status: 'dismissed' };
        throw new Error(`Unexpected service call: ${path}`);
      },
    }),
  } as unknown as AgorClient;
}

function renderWidget(ui: ReactElement) {
  return render(<AntApp>{ui}</AntApp>);
}

const message = {} as never;

describe('OAuthConnectWidget in a real browser', () => {
  it('opens the provider window from the click itself, before awaiting oauth-start', async () => {
    // Record the real `window.open` calls and the point in the sequence they
    // happen. In a real browser, an open that lands after the await would be
    // rejected as unrequested — this is the ordering jsdom cannot check.
    const sequence: string[] = [];
    const realOpen = window.open.bind(window);
    const openSpy = vi.fn((...args: Parameters<typeof window.open>) => {
      sequence.push('window.open');
      return realOpen(...args);
    });
    window.open = openSpy as typeof window.open;

    let releaseStart: (v: unknown) => void = () => {};
    const client = makeClient({
      onCall: (path) => sequence.push(path),
      start: () =>
        new Promise((resolve) => {
          releaseStart = resolve;
        }),
    });

    try {
      renderWidget(<OAuthConnectWidget message={message} widget={widget()} client={client} />);
      const connect = screen.getByRole('button', { name: 'Connect' });
      fireEvent.click(connect);

      await waitFor(() => expect(openSpy).toHaveBeenCalled());
      expect(sequence[0]).toBe('window.open');
      expect(sequence[1]).toBe('mcp-servers/oauth-start');
      // A same-origin blank intermediate with its opener severed, per
      // `openMarketplaceOAuthPopup`.
      expect(openSpy.mock.calls[0][0]).toBe('about:blank');

      releaseStart({ success: false, error: 'stopping here' });
      await waitFor(() => expect(screen.getByText(/Sign-in was not completed/i)).toBeVisible());
    } finally {
      window.open = realOpen;
      // Close anything the widget left open so the next instance starts clean.
      for (const call of openSpy.mock.results) {
        (call.value as Window | null)?.close?.();
      }
    }
  });

  it('keeps the card, its disclosure, and both actions inside the viewport', async () => {
    const { container } = renderWidget(
      <OAuthConnectWidget message={message} widget={widget()} client={makeClient({})} />
    );

    const card = container.querySelector('.ant-card') as HTMLElement | null;
    expect(card).not.toBeNull();
    const bounds = card!.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
    expect(bounds.height).toBeGreaterThan(0);

    // The disclosure is what the user is consenting to, so it must be laid out
    // and legible, not clipped to zero height.
    const disclosure = screen.getByTestId('oauth-widget-disclosure');
    expect(disclosure.getBoundingClientRect().height).toBeGreaterThan(0);

    for (const name of ['Connect', 'Not now']) {
      const button = screen.getByRole('button', { name });
      const rect = button.getBoundingClientRect();
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth + 1);
    }
  });

  it('shows a laid-out pending state while the provider window is open', async () => {
    // A synthetic `fireEvent.click` carries no user activation, so headless
    // Chromium refuses the real `window.open` — which the previous test
    // already exercises for ordering. This test is about the LAYOUT of the
    // pending alert in a real engine, so the window itself is stubbed with the
    // minimum surface `openMarketplaceOAuthPopup` touches.
    const realOpen = window.open.bind(window);
    window.open = (() => {
      const stub = {
        opener: null,
        closed: false,
        document: { title: '', body: null },
        location: { replace: () => {} },
        close: () => {},
      };
      return stub as unknown as Window;
    }) as typeof window.open;

    let releaseResolve: (v: unknown) => void = () => {};
    const client = makeClient({
      resolve: () =>
        new Promise((resolve) => {
          releaseResolve = resolve;
        }),
    });

    try {
      renderWidget(<OAuthConnectWidget message={message} widget={widget()} client={client} />);
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

      const pending = await screen.findByText(/Sign-in is pending/i);
      expect(pending.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(pending.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);

      releaseResolve({ widget_id: 'widget-1', status: 'submitted' });
      await waitFor(() => expect(screen.getByText(/Connected "Notion"/)).toBeVisible());
    } finally {
      window.open = realOpen;
    }
  });

  it('renders a blocked-popup refusal without calling the daemon', async () => {
    const realOpen = window.open.bind(window);
    // Exactly what a real pop-up blocker does: return null.
    window.open = (() => null) as typeof window.open;
    const calls: string[] = [];

    try {
      renderWidget(
        <OAuthConnectWidget
          message={message}
          widget={widget()}
          client={makeClient({ onCall: (path) => calls.push(path) })}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

      // The visible copy specifically: the card also carries a persistent
      // visually-hidden live region that repeats it for a screen reader.
      const alert = await screen.findByText(/blocked the sign-in window/i, {
        selector: '.ant-alert-description',
      });
      expect(alert.getBoundingClientRect().height).toBeGreaterThan(0);
      // ...and that live region really is out of the layout, in a real engine
      // rather than by jsdom's say-so — it is rendered whether or not there is
      // anything to announce, so a box would be a permanent gap in every card.
      const announcement = document.querySelector('[role="alert"][aria-atomic="true"]');
      expect(announcement).not.toBeNull();
      expect((announcement as HTMLElement).getBoundingClientRect().height).toBeLessThanOrEqual(1);
      expect(calls).toEqual([]);
      // Still retryable, and the button still fits.
      const retry = screen.getByRole('button', { name: 'Try again' });
      expect(retry.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
    } finally {
      window.open = realOpen;
    }
  });
});
