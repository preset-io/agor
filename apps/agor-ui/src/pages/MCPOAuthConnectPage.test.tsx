import type { AgorClient } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPOAuthConnectPage } from './MCPOAuthConnectPage';

const popup = { close: vi.fn(), navigate: vi.fn(() => true), operationId: 'popup-1' };
const openPopup = vi.hoisted(() => vi.fn());
vi.mock('@/components/Marketplace/marketplaceOAuthPopup', () => ({
  openMarketplaceOAuthPopup: openPopup,
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
    openPopup.mockReturnValue(popup);
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

  it('does not claim success when the daemon refuses to resolve the widget', async () => {
    // The provider round-trip succeeded and the daemon would not resolve. The
    // page must not claim success merely because the popup went somewhere —
    // and must not tell this reader nothing was connected either, because the
    // callback may well have persisted their grant.
    const { agor } = client(PREFLIGHT, {
      resolve: () => Promise.reject(new Error('Sign-in has not completed')),
    });
    render(<MCPOAuthConnectPage client={agor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to sign-in' }));
    expect(await screen.findByText('You are signed in — Agor could not finish')).toBeVisible();
    expect(screen.queryByText(/Sign-in has not completed/)).toBeNull();
    expect(screen.queryByText(/nothing was connected/i)).toBeNull();
    // …and the recovery offered is a finish, never a second sign-in.
    expect(screen.getByRole('button', { name: 'Finish connecting' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Continue to sign-in' })).toBeNull();
  });

  it('never resolves the widget when the durable attempt did not succeed', async () => {
    waitForAttempt.mockResolvedValue({ status: 'failed' });
    const { agor, resolveCalls } = client(PREFLIGHT);
    render(<MCPOAuthConnectPage client={agor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to sign-in' }));
    expect(await screen.findByText('The sign-in was not completed')).toBeVisible();
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

  it('names the pop-up block instead of reporting a failed connection', async () => {
    // Slack's mobile in-app browser is the primary client for this link and is
    // exactly where `window.open` is refused. "Return to Slack and ask again"
    // would reproduce the block; the button has to stay live and the copy has
    // to name pop-ups.
    openPopup.mockReturnValue(null);
    const { agor, resolveCalls } = client(PREFLIGHT);
    render(<MCPOAuthConnectPage client={agor} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to sign-in' }));

    expect(await screen.findByText('Your browser blocked the sign-in window')).toBeVisible();
    expect(screen.queryByText('The sign-in was not completed')).toBeNull();
    expect(resolveCalls).toEqual([]);

    // Still startable: allowing pop-ups and tapping again must work.
    openPopup.mockReturnValue(popup);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to sign-in' }));
    await waitFor(() =>
      expect(popup.navigate).toHaveBeenCalledWith(
        'https://provider.example/authorize',
        expect.any(Function)
      )
    );
    expect(await screen.findByText('Notion is connected')).toBeVisible();
  });

  /**
   * B1 — returning to a link whose sign-in already succeeded.
   *
   * The provider callback persists the grant; the attach and the agent's
   * wake-up wait on this page's POST. Closing the tab in between used to leave
   * a real credential behind a pending card, and coming back said "connected"
   * — a milestone nothing had reached.
   */
  describe('returning after the grant landed', () => {
    const FINISH = { ...PREFLIGHT, state: 'finish_required' };

    it('finishes without a second sign-in, and never opens a popup', async () => {
      const { agor, resolveCalls } = client(FINISH);
      render(<MCPOAuthConnectPage client={agor} />);

      expect(await screen.findByText('Notion is connected')).toBeVisible();
      expect(resolveCalls).toEqual(['widgets/widget-1/oauth-resolve']);
      expect(openPopup).not.toHaveBeenCalled();
    });

    it('offers an explicit finish when the automatic one fails, and retries it', async () => {
      let attempts = 0;
      const { agor, resolveCalls } = client(FINISH, {
        resolve: () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error('daemon busy'))
            : Promise.resolve({ status: 'submitted' });
        },
      });
      render(<MCPOAuthConnectPage client={agor} />);

      const finish = await screen.findByRole('button', { name: 'Finish connecting' });
      expect(screen.getByText('You are signed in — Agor could not finish')).toBeVisible();
      fireEvent.click(finish);
      expect(await screen.findByText('Notion is connected')).toBeVisible();
      expect(resolveCalls).toHaveLength(2);
      expect(openPopup).not.toHaveBeenCalled();
    });

    it('still finishes when the link itself lapsed', async () => {
      // `finish_stalled`: the sealed link has expired, so the Slack card no
      // longer carries a button — but this page was opened while it did, and
      // the finish needs nothing from the token but the identity it already
      // proved.
      const { agor, resolveCalls } = client({ ...PREFLIGHT, state: 'finish_stalled' });
      render(<MCPOAuthConnectPage client={agor} />);
      expect(await screen.findByText('Notion is connected')).toBeVisible();
      expect(resolveCalls).toEqual(['widgets/widget-1/oauth-resolve']);
    });

    it('reports an already-finished request as finished', async () => {
      const { agor, resolveCalls } = client({ ...PREFLIGHT, state: 'connected' });
      render(<MCPOAuthConnectPage client={agor} />);
      expect(await screen.findByText('Notion is connected')).toBeVisible();
      expect(screen.getByText(/continuing the conversation in Slack/i)).toBeVisible();
      // Nothing to do: a finished request is not re-POSTed on arrival.
      expect(resolveCalls).toEqual([]);
    });

    it('says who has to attach when the resolver could not', async () => {
      const { agor } = client({ ...PREFLIGHT, state: 'connected_not_attached' });
      render(<MCPOAuthConnectPage client={agor} />);
      expect(await screen.findByText('Notion is connected')).toBeVisible();
      expect(screen.getByText(/session owner or an Agor admin/i)).toBeVisible();
    });

    it('says a replaced request was replaced rather than calling it unavailable', async () => {
      const { agor } = client({ ...PREFLIGHT, state: 'cancelled' });
      render(<MCPOAuthConnectPage client={agor} />);
      expect(await screen.findByText('This request was replaced or cancelled')).toBeVisible();
    });
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
