import type { AgorClient } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPOAuthConnectPage } from './MCPOAuthConnectPage';

const popup = { close: vi.fn(), navigate: vi.fn(() => true), operationId: 'popup-1' };
vi.mock('@/components/Marketplace/marketplaceOAuthPopup', () => ({
  openMarketplaceOAuthPopup: () => popup,
}));
const waitForAttempt = vi.hoisted(() => vi.fn(async () => ({ status: 'succeeded' })));
vi.mock('@/utils/mcpOAuthAttempt', () => ({ waitForMCPOAuthAttempt: waitForAttempt }));

const PREFLIGHT = {
  state: 'connect_required',
  widget_id: 'widget-1',
  server_name: 'Notion',
  oauth_mode: 'per_user',
  reason: 'Read the roadmap page.',
  permission_disclosure: 'Agor will read and write pages you share with it.',
  expires_at: '2026-09-16T12:10:00.000Z',
  return_to_slack_url: 'slack://channel?team=T1&id=C1&message=1.1',
};

function client(
  preflight: object,
  overrides: { start?: object; resolve?: () => Promise<unknown> } = {}
): { agor: AgorClient; resolveCalls: string[] } {
  const resolveCalls: string[] = [];
  const agor = {
    service: (path: string) => ({
      create: vi.fn(async () => {
        if (path === 'mcp-oauth-connect') return preflight;
        if (path.endsWith('/oauth-resolve')) {
          resolveCalls.push(path);
          return overrides.resolve ? overrides.resolve() : { status: 'submitted' };
        }
        return (
          overrides.start ?? {
            success: true,
            authorizationUrl: 'https://provider.example/authorize',
            attempt_id: 'attempt-1',
          }
        );
      }),
    }),
  } as unknown as AgorClient;
  return { agor, resolveCalls };
}

describe('Slack MCP connect browser surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    waitForAttempt.mockResolvedValue({ status: 'succeeded' });
    window.location.hash = '#token=signed-connect-token';
  });

  it('renders the pinned server, reason, and disclosure without leaking the token', async () => {
    render(<MCPOAuthConnectPage client={client(PREFLIGHT).agor} />);

    expect(await screen.findByRole('button', { name: 'Continue to sign-in' })).toBeVisible();
    // The fragment is cleared on mount so the sealed token never survives into
    // history, a copied URL, or a Referer.
    expect(window.location.hash).toBe('');
    expect(screen.getByRole('heading', { name: 'Connect Notion' })).toBeVisible();
    expect(screen.getByText('Read the roadmap page.')).toBeVisible();
    expect(screen.getByText(/read and write pages you share/i)).toBeVisible();
    expect(screen.queryByText(/signed-connect-token|widget-1|provider\.example/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Return to Slack' })).toHaveAttribute(
      'href',
      'slack://channel?team=T1&id=C1&message=1.1'
    );
  });

  it('names a shared-mode connection as workspace-wide', async () => {
    render(<MCPOAuthConnectPage client={client({ ...PREFLIGHT, oauth_mode: 'shared' }).agor} />);
    expect(await screen.findByText(/everyone in this Agor workspace/i)).toBeVisible();
  });

  it('starts the canonical flow, then resolves the pinned widget', async () => {
    const { agor, resolveCalls } = client(PREFLIGHT);
    render(
      <StrictMode>
        <MCPOAuthConnectPage client={agor} />
      </StrictMode>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to sign-in' }));

    await waitFor(() =>
      expect(popup.navigate).toHaveBeenCalledWith(
        'https://provider.example/authorize',
        expect.any(Function)
      )
    );
    expect(await screen.findByText('Notion is connected')).toBeVisible();
    // The widget id comes from the daemon's preflight, never from the client.
    expect(resolveCalls).toEqual(['widgets/widget-1/oauth-resolve']);
  });

  it('reports failure when the daemon refuses to resolve the widget', async () => {
    // The grant did not land, so the daemon rejects. The page must not claim
    // success merely because the popup went somewhere.
    const { agor } = client(PREFLIGHT, {
      resolve: () => Promise.reject(new Error('Sign-in has not completed')),
    });
    render(<MCPOAuthConnectPage client={agor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to sign-in' }));
    expect(await screen.findByText('The connection was not completed')).toBeVisible();
    expect(screen.queryByText(/Sign-in has not completed/)).toBeNull();
  });

  it('never resolves the widget when the durable attempt did not succeed', async () => {
    waitForAttempt.mockResolvedValue({ status: 'failed' });
    const { agor, resolveCalls } = client(PREFLIGHT);
    render(<MCPOAuthConnectPage client={agor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to sign-in' }));
    expect(await screen.findByText('The connection was not completed')).toBeVisible();
    expect(resolveCalls).toEqual([]);
  });

  it('closes an in-flight popup and ignores its response when the client changes', async () => {
    let completeStart!: (result: object) => void;
    const pendingStart = new Promise<object>((resolve) => {
      completeStart = resolve;
    });
    const agor = {
      service: (path: string) => ({
        create: () => (path === 'mcp-oauth-connect' ? Promise.resolve(PREFLIGHT) : pendingStart),
      }),
    } as unknown as AgorClient;
    const view = render(<MCPOAuthConnectPage client={agor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to sign-in' }));
    view.rerender(<MCPOAuthConnectPage client={null} />);
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
    expect(screen.getByText('This connect action is unavailable')).toBeVisible();
  });

  it('fails closed for an expired, used, superseded, or mismatched action', async () => {
    const denied = {
      service: () => ({ create: vi.fn(async () => Promise.reject(new Error('provider secret'))) }),
    } as unknown as AgorClient;
    render(<MCPOAuthConnectPage client={denied} />);
    expect(await screen.findByText('This connect action is unavailable')).toBeVisible();
    expect(screen.queryByText(/provider secret/i)).not.toBeInTheDocument();
  });
});
