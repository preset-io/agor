import type { AgorClient } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPSlackRecoveryPage } from './MCPSlackRecoveryPage';

const popup = { close: vi.fn(), navigate: vi.fn(() => true), operationId: 'popup-1' };
vi.mock('@/components/Marketplace/marketplaceOAuthPopup', () => ({
  openMarketplaceOAuthPopup: () => popup,
}));
vi.mock('@/utils/mcpOAuthAttempt', () => ({
  waitForMCPOAuthAttempt: vi.fn(async () => ({ status: 'succeeded' })),
}));

function client(preflight: object, start?: object): AgorClient {
  return {
    service: (path: string) => ({
      create: vi.fn(async () =>
        path === 'mcp-slack-recovery'
          ? preflight
          : (start ?? {
              success: true,
              authorizationUrl: 'https://provider.example/authorize',
              attempt_id: 'attempt-1',
            })
      ),
    }),
  } as unknown as AgorClient;
}

describe('Slack MCP recovery browser surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '#token=signed-token';
  });

  it('shows ambiguous no-replay guidance without topology or secret prose', async () => {
    render(
      <MCPSlackRecoveryPage
        client={client({
          state: 'reconnect_required',
          provider_dispatch: 'ambiguous',
          expires_at: '2026-08-26T12:10:00.000Z',
          return_to_slack_url: 'slack://channel?team=T1&id=C1&message=1.1',
        })}
      />
    );

    expect(await screen.findByRole('button', { name: 'Continue to sign-in' })).toBeVisible();
    expect(window.location.hash).toBe('');
    expect(screen.getByText(/may have started/i)).toBeVisible();
    expect(screen.getByText(/never ask you to paste a broad Slack token/i)).toBeVisible();
    expect(screen.queryByText(/signed-token|server-1|provider\.example/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Return to Slack' })).toHaveAttribute(
      'href',
      'slack://channel?team=T1&id=C1&message=1.1'
    );
  });

  it('uses the canonical OAuth start, preserves explicit no-replay truth, and returns to Slack', async () => {
    const agor = client({
      state: 'reconnect_required',
      provider_dispatch: 'not_started',
      expires_at: '2026-08-26T12:10:00.000Z',
      return_to_slack_url: 'slack://channel?team=T1&id=C1',
    });
    render(
      <StrictMode>
        <MCPSlackRecoveryPage client={agor} />
      </StrictMode>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to sign-in' }));

    await waitFor(() =>
      expect(popup.navigate).toHaveBeenCalledWith(
        'https://provider.example/authorize',
        expect.any(Function)
      )
    );
    expect(await screen.findByText(/interrupted call was not replayed/i)).toBeVisible();
  });

  it('closes an in-flight popup and ignores its response when the client changes', async () => {
    let completeStart!: (result: object) => void;
    const pendingStart = new Promise<object>((resolve) => {
      completeStart = resolve;
    });
    const agor = {
      service: (path: string) => ({
        create: () =>
          path === 'mcp-slack-recovery'
            ? Promise.resolve({ state: 'reconnect_required', provider_dispatch: 'not_started' })
            : pendingStart,
      }),
    } as unknown as AgorClient;
    const view = render(<MCPSlackRecoveryPage client={agor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to sign-in' }));
    view.rerender(<MCPSlackRecoveryPage client={null} />);
    expect(popup.close).toHaveBeenCalled();
    await act(async () => {
      completeStart({
        success: true,
        authorizationUrl: 'https://provider.example/authorize',
        attempt_id: 'old-attempt',
      });
      await pendingStart;
    });
    expect(popup.navigate).not.toHaveBeenCalled();
    expect(screen.getByText('This recovery action is unavailable')).toBeVisible();
  });

  it('fails closed for an expired, used, or mismatched action', async () => {
    const denied = {
      service: () => ({ create: vi.fn(async () => Promise.reject(new Error('provider secret'))) }),
    } as unknown as AgorClient;
    render(<MCPSlackRecoveryPage client={denied} />);
    expect(await screen.findByText('This recovery action is unavailable')).toBeVisible();
    expect(screen.queryByText(/provider secret/i)).not.toBeInTheDocument();
  });
});
