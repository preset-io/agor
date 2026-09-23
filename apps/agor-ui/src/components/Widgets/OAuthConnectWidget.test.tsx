/**
 * OAuthConnectWidget — transcript widget tests.
 *
 * The behaviours that matter here are ordering and honesty:
 *
 *   - the popup is reserved BEFORE the oauth-start await, or the browser
 *     blocks the sign-in window
 *   - `/oauth-resolve` is only called after the durable attempt reports
 *     success, and carries the attempt id for correlation
 *   - a failed attempt, a blocked popup, or a daemon refusal all leave the
 *     card retryable rather than pretending to have connected
 *   - terminal states render the DURABLE outcome, including the case where the
 *     grant landed but the attach was refused
 */

import type { AgorClient, WidgetMessageMetadata } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '@/store/agorStore';
import { OAuthConnectWidget } from './OAuthConnectWidget';

/** The last-observed grant snapshot the card reads to pick its button. */
function setSignedInServers(ids: string[]) {
  agorStore
    .getState()
    .applyMaps((prev) => ({ ...prev, userAuthenticatedMcpServerIds: new Set(ids) }));
}

/** Wrap with Ant Design's App so `useThemedMessage` finds a message instance. */
function renderWidget(ui: ReactElement) {
  return render(<AntApp>{ui}</AntApp>);
}

const popup = { close: vi.fn(), navigate: vi.fn(() => true), operationId: 'popup-1' };
let popupOpens = true;
vi.mock('@/components/Marketplace/marketplaceOAuthPopup', () => ({
  openMarketplaceOAuthPopup: () => (popupOpens ? popup : null),
}));

const waitForAttempt = vi.fn(async () => ({ status: 'succeeded' }) as { status: string });
vi.mock('@/utils/mcpOAuthAttempt', () => ({
  waitForMCPOAuthAttempt: (...args: unknown[]) =>
    (waitForAttempt as unknown as (...a: unknown[]) => unknown)(...args),
  oauthAttemptFailureMessage: (status: string) => `OAuth sign-in ${status}. Start a new sign-in.`,
}));

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

interface ClientOpts {
  startResult?: unknown;
  resolveError?: Error;
  onCall?: (path: string, body: unknown) => void;
}

function makeClient(opts: ClientOpts = {}): AgorClient {
  return {
    service: (path: string) => ({
      create: vi.fn(async (body: unknown) => {
        opts.onCall?.(path, body);
        if (path === 'mcp-servers/oauth-start') {
          return (
            opts.startResult ?? {
              success: true,
              authorizationUrl: 'https://provider.example/authorize',
              attempt_id: 'attempt-1',
            }
          );
        }
        if (path.endsWith('/oauth-resolve')) {
          if (opts.resolveError) throw opts.resolveError;
          return { widget_id: 'widget-1', status: 'submitted', auto_resume_queued: true };
        }
        if (path.endsWith('/dismiss')) return { widget_id: 'widget-1', status: 'dismissed' };
        throw new Error(`Unexpected service call: ${path}`);
      }),
    }),
  } as unknown as AgorClient;
}

const message = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  popupOpens = true;
  waitForAttempt.mockResolvedValue({ status: 'succeeded' });
  setSignedInServers([]);
});

describe('OAuthConnectWidget — pending', () => {
  it('shows the reason and the catalog disclosure up front', () => {
    renderWidget(<OAuthConnectWidget message={message} widget={widget()} client={makeClient()} />);
    expect(screen.getByText(/Connect "Notion"/)).toBeVisible();
    expect(screen.getByText('Read the roadmap page.')).toBeVisible();
    expect(screen.getByTestId('oauth-widget-disclosure')).toHaveTextContent(
      'Agor can read and write pages you share'
    );
  });

  it('warns that a shared connection is used by the whole workspace', () => {
    const { container } = renderWidget(
      <OAuthConnectWidget
        message={message}
        widget={widget({ params: { ...PARAMS, oauthMode: 'shared' } })}
        client={makeClient()}
      />
    );
    expect(screen.getByText(/everyone in this Agor workspace/i)).toBeVisible();
    // Not colour alone. This one line is what separates a personal sign-in
    // from handing the whole workspace an account, and `type="warning"` says
    // so only in the text colour.
    expect(container.querySelector('.anticon-warning')).not.toBeNull();
  });

  /**
   * Nothing about this flow is synchronous: the user clicks, a popup opens, a
   * provider round-trip happens, and the card rewrites itself. Without live
   * regions a screen-reader user hears none of it.
   */
  it('announces progress politely and failure assertively', async () => {
    let release: (v: { status: string }) => void = () => {};
    waitForAttempt.mockReturnValue(
      new Promise<{ status: string }>((resolve) => {
        release = resolve;
      })
    );
    const { container } = renderWidget(
      <OAuthConnectWidget message={message} widget={widget()} client={makeClient()} />
    );
    // Scoped to the card: the toast this flow also raises is its own live
    // region, and the claim here is about the card announcing itself. Both
    // regions are visually hidden — the visible copy is the Alerts, which hand
    // their role over so a failure is not announced twice.
    const progress = () => container.querySelector('[role="status"]');
    const failureRegion = () => container.querySelector('[role="alert"]');

    // Both regions exist BEFORE anything happens. A live region created in the
    // same commit as its content is the case assistive technology misses.
    expect(progress()).not.toBeNull();
    expect(failureRegion()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(progress()).toHaveTextContent(/Sign-in to Notion is pending/i));
    // The visible alert says the same thing and stays out of the a11y tree.
    expect(screen.getByText(/Sign-in is pending/i)).toBeVisible();

    release({ status: 'failed' });
    await waitFor(() =>
      expect(failureRegion()).toHaveTextContent(/Sign-in to Notion was not completed/i)
    );
    // The progress region empties rather than leaving a stale "pending" for a
    // screen reader to re-read next time it changes.
    expect(progress()).toHaveTextContent('');
  });

  it('runs start → popup → poll → oauth-resolve, in that order', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    renderWidget(
      <OAuthConnectWidget
        message={message}
        widget={widget()}
        client={makeClient({ onCall: (path, body) => calls.push({ path, body }) })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByText(/Connected "Notion"/)).toBeVisible());
    expect(calls.map((c) => c.path)).toEqual([
      'mcp-servers/oauth-start',
      'widgets/widget-1/oauth-resolve',
    ]);
    expect(calls[0].body).toEqual({ mcp_server_id: 'srv-notion' });
    // Correlation only — the daemon re-reads the grant regardless.
    expect(calls[1].body).toEqual({ attempt_id: 'attempt-1' });
    expect(popup.navigate).toHaveBeenCalledWith(
      'https://provider.example/authorize',
      expect.any(Function)
    );
  });

  it('shows the pending state while the provider window is open', async () => {
    let release: (v: { status: string }) => void = () => {};
    waitForAttempt.mockReturnValue(
      new Promise<{ status: string }>((resolve) => {
        release = resolve;
      })
    );
    renderWidget(<OAuthConnectWidget message={message} widget={widget()} client={makeClient()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.getByText(/Sign-in is pending/i)).toBeVisible());

    release({ status: 'succeeded' });
    await waitFor(() => expect(screen.getByText(/Connected "Notion"/)).toBeVisible());
  });

  it('never calls oauth-resolve when the durable attempt did not succeed', async () => {
    waitForAttempt.mockResolvedValue({ status: 'failed' });
    const calls: string[] = [];
    renderWidget(
      <OAuthConnectWidget
        message={message}
        widget={widget()}
        client={makeClient({ onCall: (path) => calls.push(path) })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByText(/Sign-in was not completed/i)).toBeVisible());
    expect(calls).toEqual(['mcp-servers/oauth-start']);
    // Retryable, not terminal.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('surfaces a blocked popup as an actionable message and calls nothing', async () => {
    popupOpens = false;
    const calls: string[] = [];
    renderWidget(
      <OAuthConnectWidget
        message={message}
        widget={widget()}
        client={makeClient({ onCall: (path) => calls.push(path) })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/blocked the sign-in window/i)
    );
    expect(calls).toEqual([]);
  });

  it('surfaces an oauth-start refusal and closes the reserved popup', async () => {
    renderWidget(
      <OAuthConnectWidget
        message={message}
        widget={widget()}
        client={makeClient({
          startResult: { success: false, error: 'OAuth requires an enabled, saved MCP server.' },
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /OAuth requires an enabled, saved MCP server/
      )
    );
    expect(popup.close).toHaveBeenCalled();
  });

  it('stays retryable when the daemon refuses to resolve — the grant is what decides', async () => {
    renderWidget(
      <OAuthConnectWidget
        message={message}
        widget={widget()}
        client={makeClient({
          resolveError: new Error('Sign-in to "Notion" has not completed.'),
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    // The text lands in both the card's Alert and the transient toast.
    await waitFor(() =>
      expect(screen.getAllByText(/has not completed/i).length).toBeGreaterThan(0)
    );
    expect(screen.queryByText(/Connected "Notion"/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('dismisses through the shared dismiss endpoint', async () => {
    const calls: string[] = [];
    renderWidget(
      <OAuthConnectWidget
        message={message}
        widget={widget()}
        client={makeClient({ onCall: (path) => calls.push(path) })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(screen.getByText(/Declined to connect "Notion"/)).toBeVisible());
    expect(calls).toEqual(['widgets/widget-1/dismiss']);
  });
});

describe('OAuthConnectWidget — terminal states', () => {
  it('reports the connected + attached outcome', () => {
    renderWidget(
      <OAuthConnectWidget
        message={message}
        widget={widget({
          status: 'submitted',
          result_meta: {
            mcp_server_id: 'srv-notion',
            name: 'Notion',
            oauth_mode: 'per_user',
            attached: true,
          },
        })}
        client={makeClient()}
      />
    );
    expect(screen.getByText(/Connected "Notion" — attached to this session/)).toBeVisible();
  });

  it('says plainly when the grant landed but the attach was refused', () => {
    renderWidget(
      <OAuthConnectWidget
        message={message}
        widget={widget({
          status: 'submitted',
          result_meta: {
            mcp_server_id: 'srv-notion',
            name: 'Notion',
            oauth_mode: 'per_user',
            attached: false,
          },
        })}
        client={makeClient()}
      />
    );
    expect(screen.getByText(/only the session owner or an admin/i)).toBeVisible();
  });

  it('renders the already-connected short-circuit without a button', () => {
    renderWidget(
      <OAuthConnectWidget
        message={message}
        widget={widget({ status: 'already_present' })}
        client={makeClient()}
      />
    );
    expect(screen.getByText(/was already connected/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('does not claim an already-connected server was attached when it was not (D6)', () => {
    renderWidget(
      <OAuthConnectWidget
        message={message}
        widget={widget({
          status: 'already_present',
          result_meta: {
            mcp_server_id: 'srv-notion',
            name: 'Notion',
            oauth_mode: 'per_user',
            attached: false,
          },
        })}
        client={makeClient()}
      />
    );
    expect(screen.getByText(/was already connected/i)).toBeVisible();
    expect(screen.getByText(/only the session owner or an admin/i)).toBeVisible();
    expect(screen.queryByText(/attached to this session/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('renders a durable dismissal', () => {
    renderWidget(
      <OAuthConnectWidget
        message={message}
        widget={widget({ status: 'dismissed' })}
        client={makeClient()}
      />
    );
    expect(screen.getByText(/Declined to connect "Notion"/)).toBeVisible();
  });
});

/**
 * B1 — the card when the grant is already on file.
 *
 * The provider callback persists the grant; this widget resolves only when a
 * browser POSTs. A reload in between, or a sign-in completed from the Slack
 * card, leaves a real credential behind a card that still says Connect — and
 * pressing it used to run a full re-authorization of an account that was
 * already connected.
 */
describe('OAuthConnectWidget — finishing a sign-in that already happened', () => {
  it('offers a finish, and completes it without any provider round-trip', async () => {
    setSignedInServers(['srv-notion']);
    const calls: string[] = [];
    const client = makeClient({ onCall: (path) => calls.push(path) });
    renderWidget(<OAuthConnectWidget widget={widget()} client={client} message={message} />);

    expect(screen.getByText('You are already signed in')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }));

    await waitFor(() => expect(calls).toEqual(['widgets/widget-1/oauth-resolve']));
    expect(popup.navigate).not.toHaveBeenCalled();
    expect(await screen.findByText(/Connected "Notion"/)).toBeVisible();
  });

  it('falls back to a real sign-in when the daemon disagrees with the snapshot', async () => {
    // The snapshot is a hint, never the decision: a revoked grant still reads
    // as connected here until the next refresh, and the card must not leave a
    // button that can only fail.
    setSignedInServers(['srv-notion']);
    const client = makeClient({ resolveError: new Error('Sign-in has not completed') });
    renderWidget(<OAuthConnectWidget widget={widget()} client={client} message={message} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }));
    expect(await screen.findByText('Sign-in was not completed')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Finish connecting' })).toBeNull();
    // Nothing is claimed: the widget stays pending and the ordinary flow works.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(popup.navigate).toHaveBeenCalledWith(
        'https://provider.example/authorize',
        expect.any(Function)
      )
    );
  });

  it('leaves a card with no grant on file exactly as it was', () => {
    renderWidget(<OAuthConnectWidget widget={widget()} client={makeClient()} message={message} />);
    expect(screen.getByRole('button', { name: 'Connect' })).toBeVisible();
    expect(screen.queryByText('You are already signed in')).toBeNull();
  });
});
