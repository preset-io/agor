/**
 * Real-Chromium checks jsdom cannot make for the Slack connect landing page.
 *
 * Two things matter here and neither is observable in jsdom: the card has to
 * fit a phone viewport (this page is reached from the Slack mobile app more
 * often than from a desktop), and the Connect button has to open a popup while
 * the click still carries user activation — the ordering the shared hook
 * exists to keep in one place.
 */

import type { AgorClient } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPOAuthConnectPage } from './MCPOAuthConnectPage';

afterEach(cleanup);

const PREFLIGHT = {
  state: 'connect_required',
  widget_id: 'widget-1',
  server_name: 'Notion',
  oauth_mode: 'per_user',
  reason: 'Read the roadmap page.',
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  return_to_slack_url: 'slack://channel?team=T1&id=C1&message=1.1',
};

describe('Slack MCP connect responsive layout', () => {
  it('keeps the authenticated connect action visible and within the mobile viewport', async () => {
    window.location.hash = '#token=browser-signed-connect-token';
    const client = {
      service: () => ({ create: async () => PREFLIGHT }),
    } as unknown as AgorClient;

    const { container } = render(<MCPOAuthConnectPage client={client} />);
    const action = await screen.findByRole('button', { name: 'Continue to sign-in' });
    await waitFor(() => expect(action.getBoundingClientRect().height).toBeGreaterThan(0));
    const card = container.querySelector('.ant-card');
    expect(card).not.toBeNull();
    const bounds = card!.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
    expect(screen.getByRole('link', { name: 'Return to Slack' })).toBeVisible();
    expect(screen.getByText('Read the roadmap page.')).toBeVisible();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Connect Notion' }));
    expect((container.querySelector('main') as HTMLElement).style.minHeight).toBe('100dvh');
  });

  it('opens the sign-in window synchronously on the real click', async () => {
    window.location.hash = '#token=browser-signed-connect-token';
    // A real browser only honours window.open inside a user-activated task.
    // Opening it after the oauth-start await would be silently blocked here,
    // which is exactly what this asserts against.
    const opened: string[] = [];
    const nativeOpen = window.open;
    window.open = vi.fn((url?: string | URL) => {
      opened.push(String(url ?? ''));
      return { closed: false, close: () => {}, location: { href: '' } } as unknown as Window;
    }) as typeof window.open;
    const client = {
      service: (path: string) => ({
        create: async () =>
          path === 'mcp-oauth-connect'
            ? PREFLIGHT
            : new Promise(() => {
                /* never settles: the popup must already exist by now */
              }),
      }),
    } as unknown as AgorClient;

    try {
      render(<MCPOAuthConnectPage client={client} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Continue to sign-in' }));
      await waitFor(() => expect(opened.length).toBe(1));
      // Same-origin blank placeholder, not the provider URL: the daemon has
      // not even been asked for one yet.
      expect(opened[0]).not.toContain('provider');
    } finally {
      window.open = nativeOpen;
    }
  });
});
