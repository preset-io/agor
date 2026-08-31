import type { AgorClient } from '@agor-live/client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MCPSlackRecoveryPage } from './MCPSlackRecoveryPage';

afterEach(cleanup);

describe('Slack MCP recovery responsive layout', () => {
  it('keeps the authenticated recovery action visible and within the mobile viewport', async () => {
    window.location.hash = '#token=browser-signed-token';
    const client = {
      service: () => ({
        create: async () => ({
          state: 'reconnect_required',
          provider_dispatch: 'ambiguous',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          return_to_slack_url: 'slack://channel?team=T1&id=C1&message=1.1',
        }),
      }),
    } as unknown as AgorClient;

    const { container } = render(<MCPSlackRecoveryPage client={client} />);
    const action = await screen.findByRole('button', { name: 'Continue to sign-in' });
    await waitFor(() => expect(action.getBoundingClientRect().height).toBeGreaterThan(0));
    const card = container.querySelector('.ant-card');
    expect(card).not.toBeNull();
    const bounds = card!.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
    expect(screen.getByRole('link', { name: 'Return to Slack' })).toBeVisible();
    expect(screen.getByText(/may have started/i)).toBeVisible();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Reconnect MCP' }));
    expect((container.querySelector('main') as HTMLElement).style.minHeight).toBe('100dvh');
  });
});
