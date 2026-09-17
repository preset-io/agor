/**
 * The shape both Slack-delivered MCP OAuth landing pages share.
 *
 * A person taps a link in a Slack thread and lands here with a sealed token in
 * the URL fragment. Whichever lane sent them, the page then does the same six
 * things in the same order, and the order is the interesting part:
 *
 *  1. Read the token from the fragment and immediately clear the fragment, so
 *     it never survives into history, a copied URL, or a `Referer`.
 *  2. Preflight it against an authenticated, secret-free daemon service. The
 *     page renders nothing about the action until the daemon says the token is
 *     still good *and* the signed-in account is the one it was issued for.
 *  3. On click, reserve the popup **synchronously**, while the click still
 *     carries user activation. Opening it after the `oauth-start` await is
 *     what gets it blocked — this is the single most load-bearing line here.
 *  4. Start the canonical OAuth flow, handing the daemon the sealed token
 *     rather than a server id. The destination is pinned server-side.
 *  5. Poll the durable attempt. The popup navigating somewhere is not success.
 *  6. Only on `succeeded`, run the lane's finalize step.
 *
 * Generalizing rather than forking matters most at (3) and (6): a fork would
 * be two places for the activation ordering to rot, and two places to decide
 * what counts as success.
 */

import type { AgorClient, MCPOAuthStartFailure } from '@agor-live/client';
import { Button, Card, Flex, Typography, theme } from 'antd';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  type MarketplaceOAuthPopup,
  openMarketplaceOAuthPopup,
} from '@/components/Marketplace/marketplaceOAuthPopup';
import { waitForMCPOAuthAttempt } from '@/utils/mcpOAuthAttempt';

export type SlackOAuthActionState =
  | 'checking'
  | 'ready'
  | 'starting'
  | 'pending'
  | 'succeeded'
  /** The browser refused the sign-in window. Distinct from `failed`: see below. */
  | 'blocked'
  | 'failed'
  | 'unavailable';

/** Field on `mcp-servers/oauth-start` that carries this lane's sealed token. */
export type SlackOAuthStartTokenField = 'slack_recovery_token' | 'connect_token';

export interface SlackOAuthActionOptions<TPreflight> {
  client: AgorClient | null;
  /** Authenticated, secret-free preflight service for this lane. */
  preflightService: string;
  startTokenField: SlackOAuthStartTokenField;
  /** Map the preflight response onto the page's opening state. */
  initialState: (preflight: TPreflight) => SlackOAuthActionState;
  /**
   * Lane-specific completion, run only after the DURABLE attempt reports
   * success. Returning false lands on `failed`: the provider round-trip
   * happened, but this lane's own definition of done did not.
   */
  finalize?: (client: AgorClient, preflight: TPreflight) => Promise<boolean>;
}

export interface SlackOAuthAction<TPreflight> {
  state: SlackOAuthActionState;
  preflight: TPreflight | null;
  start: () => Promise<void>;
}

/** States from which pressing the primary action starts a flow. */
export function slackOAuthActionIsStartable(state: SlackOAuthActionState): boolean {
  return state === 'ready' || state === 'blocked';
}

function fragmentToken(): string | null {
  const value = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
  return value?.trim() || null;
}

export function useSlackOAuthAction<TPreflight>(
  options: SlackOAuthActionOptions<TPreflight>
): SlackOAuthAction<TPreflight> {
  const { client, preflightService, startTokenField, initialState, finalize } = options;
  const token = useMemo(fragmentToken, []);
  const [state, setState] = useState<SlackOAuthActionState>('checking');
  const [preflight, setPreflight] = useState<TPreflight | null>(null);
  // Bumped whenever the operation's owner changes (new client/token, unmount).
  // Every async continuation checks it, so a response that arrives after the
  // page moved on can neither navigate a popup nor rewrite the state.
  const operationOwner = useRef(0);
  const activePopup = useRef<MarketplaceOAuthPopup | null>(null);
  const pollAbort = useRef<AbortController | null>(null);
  // Keep the latest lane callbacks without making them effect dependencies:
  // an inline arrow in a caller's JSX would otherwise re-run the preflight on
  // every render.
  const initialStateRef = useRef(initialState);
  initialStateRef.current = initialState;
  const finalizeRef = useRef(finalize);
  finalizeRef.current = finalize;

  useEffect(() => {
    if (token && window.location.hash) {
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${window.location.search}`
      );
    }
  }, [token]);

  useEffect(() => {
    const owner = ++operationOwner.current;
    setPreflight(null);
    setState('checking');
    if (!client || !token) {
      setState('unavailable');
      return;
    }
    let cancelled = false;
    client
      .service(preflightService)
      .create({ token })
      .then((result) => {
        if (cancelled) return;
        const value = result as TPreflight;
        setPreflight(value);
        setState(initialStateRef.current(value));
      })
      .catch(() => !cancelled && setState('unavailable'));
    return () => {
      cancelled = true;
      if (operationOwner.current === owner) operationOwner.current++;
      pollAbort.current?.abort();
      activePopup.current?.close();
      activePopup.current = null;
    };
  }, [client, token, preflightService]);

  const start = async () => {
    if (!client || !token || !slackOAuthActionIsStartable(state)) return;
    // Reserve the popup synchronously while the click still has user activation.
    const popup = openMarketplaceOAuthPopup();
    if (!popup) {
      // NOT `failed`. Nothing was attempted, and the two states want opposite
      // advice: `failed` says "ask again", which reproduces a block exactly.
      // This is also the likeliest outcome on the lane's primary client —
      // Slack's mobile in-app browser blocks `window.open` — so the page has
      // to name pop-ups rather than report a connection that "was not
      // completed". `ready` is kept underneath so the button stays live and a
      // second tap, after the user allows pop-ups, works.
      setState('blocked');
      return;
    }
    const owner = operationOwner.current;
    const isCurrent = () => operationOwner.current === owner;
    activePopup.current = popup;
    setState('starting');
    try {
      const result = (await client
        .service('mcp-servers/oauth-start')
        .create({ [startTokenField]: token })) as
        | { success: true; authorizationUrl: string; attempt_id: string }
        | MCPOAuthStartFailure;
      if (!isCurrent()) return;
      if (!result.success || !result.authorizationUrl || !result.attempt_id) {
        popup.close();
        setState('failed');
        return;
      }
      if (!popup.navigate(result.authorizationUrl, isCurrent)) {
        setState('failed');
        return;
      }
      setState('pending');
      pollAbort.current?.abort();
      pollAbort.current = new AbortController();
      const attempt = await waitForMCPOAuthAttempt(client, result.attempt_id, {
        signal: pollAbort.current.signal,
      });
      if (!isCurrent()) return;
      if (attempt.status !== 'succeeded') {
        setState('failed');
        return;
      }
      const done = finalizeRef.current
        ? await finalizeRef.current(client, preflight as TPreflight)
        : true;
      if (!isCurrent()) return;
      setState(done ? 'succeeded' : 'failed');
    } catch {
      popup.close();
      if (isCurrent()) setState('failed');
    }
  };

  return { state, preflight, start };
}

export interface SlackOAuthActionShellProps {
  titleId: string;
  title: string;
  subtitle: string;
  status: ReactNode;
  /** Rendered only when the action is startable. */
  primaryAction?: ReactNode;
  returnToSlackUrl?: string;
  footnote: ReactNode;
}

/**
 * One card, one heading, one status region, one action row.
 *
 * The heading takes focus on mount and the body is `aria-live="polite"`, so a
 * screen-reader user who arrives from Slack is told where they are and then
 * hears each state change without having to hunt for it.
 */
export function SlackOAuthActionShell({
  titleId,
  title,
  subtitle,
  status,
  primaryAction,
  returnToSlackUrl,
  footnote,
}: SlackOAuthActionShellProps) {
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const { token: designToken } = theme.useToken();

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <main
      style={{
        minHeight: '100dvh',
        width: '100%',
        padding: `max(${designToken.padding}px, env(safe-area-inset-top)) max(${designToken.padding}px, env(safe-area-inset-right)) max(${designToken.padding}px, env(safe-area-inset-bottom)) max(${designToken.padding}px, env(safe-area-inset-left))`,
        boxSizing: 'border-box',
        overflowX: 'hidden',
        display: 'grid',
        placeItems: 'center',
        background: designToken.colorBgLayout,
      }}
      aria-labelledby={titleId}
    >
      <Card style={{ width: '100%', maxWidth: 560, overflowWrap: 'anywhere' }}>
        <Flex vertical gap={20} aria-live="polite">
          <div>
            <Typography.Title
              ref={titleRef}
              id={titleId}
              level={2}
              tabIndex={-1}
              style={{ marginBottom: designToken.marginXS, outline: 'none' }}
            >
              {title}
            </Typography.Title>
            <Typography.Text type="secondary">{subtitle}</Typography.Text>
          </div>
          {status}
          <Flex gap={12} wrap>
            {primaryAction}
            {returnToSlackUrl && (
              <Button size="large" href={returnToSlackUrl}>
                Return to Slack
              </Button>
            )}
          </Flex>
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            {footnote}
          </Typography.Paragraph>
        </Flex>
      </Card>
    </main>
  );
}
