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
 *
 * Steps 4-6 are also reachable WITHOUT 3: a preflight can report that the
 * provider round-trip already finished and only the lane's own step 6 is
 * outstanding, which is what happens when the page that started it went away
 * before it could POST. That arrival runs `finalize` alone — see
 * `autoFinalize` and `finish` — because the sign-in is not the thing missing.
 */

import type { AgorClient, MCPOAuthStartFailure } from '@agor-live/client';
import { Button } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type MarketplaceOAuthPopup,
  openMarketplaceOAuthPopup,
} from '@/components/Marketplace/marketplaceOAuthPopup';
import { waitForMCPOAuthAttempt } from '@/utils/mcpOAuthAttempt';
import { ActionPageShell, type ActionPageShellProps } from './ActionPageShell';

export type SlackOAuthActionState =
  | 'checking'
  | 'ready'
  | 'starting'
  | 'pending'
  | 'succeeded'
  /** The browser refused the sign-in window. Distinct from `failed`: see below. */
  | 'blocked'
  | 'failed'
  | 'unavailable'
  /**
   * The provider round-trip is DONE and this lane's own finish is not.
   *
   * A separate state from `pending` and from `failed`, because it is the only
   * one whose recovery is "press this, no sign-in needed" — and because both
   * of the others tell the reader something false about it. It exists at all
   * because the grant is persisted by the daemon's own callback, while the
   * steps after it wait on this page: closing the tab in between leaves a
   * usable credential and an unfinished request.
   */
  | 'finalize_required'
  /** The finish is in flight. */
  | 'finalizing'
  /** The finish did not complete. The sign-in is still done; nothing was lost. */
  | 'finalize_failed'
  /** The request was replaced by a newer one, or declined. */
  | 'cancelled';

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
   * Lane-specific completion, run after the DURABLE attempt reports success —
   * or, through `finish`, on its own for a round-trip that already finished.
   * Returning false lands on `finalize_failed`: the provider round-trip
   * happened, but this lane's own definition of done did not. It must NOT say
   * "nothing was connected", because by then something was.
   */
  finalize?: (client: AgorClient, preflight: TPreflight) => Promise<boolean>;
  /**
   * Should the page run `finalize` as soon as the preflight lands?
   *
   * For the arrival this whole recovery exists for — the user returning to a
   * link whose sign-in already succeeded — the finish needs no decision from
   * them: they made it at the provider, and the daemon re-reads that grant
   * before it acts on anything. Asking for a second click would only add a
   * step that can be abandoned in exactly the same way. The button remains for
   * when this fails.
   */
  autoFinalize?: (preflight: TPreflight) => boolean;
}

export interface SlackOAuthAction<TPreflight> {
  state: SlackOAuthActionState;
  preflight: TPreflight | null;
  start: () => Promise<void>;
  /**
   * Run this lane's finish step on its own, with no provider round-trip.
   *
   * The recovery action: idempotent on the daemon side, so pressing it when
   * the work is already done answers success rather than an error.
   */
  finish: () => Promise<void>;
}

/** States from which pressing the primary action starts a flow. */
export function slackOAuthActionIsStartable(state: SlackOAuthActionState): boolean {
  return state === 'ready' || state === 'blocked';
}

/** States from which pressing the primary action finishes one already begun. */
export function slackOAuthActionIsFinishable(state: SlackOAuthActionState): boolean {
  return state === 'finalize_required' || state === 'finalize_failed';
}

function fragmentToken(): string | null {
  const value = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
  return value?.trim() || null;
}

export function useSlackOAuthAction<TPreflight>(
  options: SlackOAuthActionOptions<TPreflight>
): SlackOAuthAction<TPreflight> {
  const { client, preflightService, startTokenField, initialState, finalize, autoFinalize } =
    options;
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
  const autoFinalizeRef = useRef(autoFinalize);
  autoFinalizeRef.current = autoFinalize;
  const preflightRef = useRef<TPreflight | null>(null);

  /**
   * Run the lane's finish step against a preflight we hold, with no provider
   * round-trip.
   *
   * Takes the value rather than reading component state so the preflight
   * effect can call it in the same tick it received one.
   */
  const runFinalize = async (value: TPreflight) => {
    if (!client || !finalizeRef.current) return;
    const owner = operationOwner.current;
    setState('finalizing');
    let done = false;
    try {
      done = await finalizeRef.current(client, value);
    } catch {
      done = false;
    }
    if (operationOwner.current !== owner) return;
    setState(done ? 'succeeded' : 'finalize_failed');
  };
  // Held in a ref for the same reason the lane callbacks are: the preflight
  // effect calls it, and making it a dependency would re-run the preflight on
  // every render.
  const runFinalizeRef = useRef(runFinalize);
  runFinalizeRef.current = runFinalize;

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
        preflightRef.current = value;
        setState(initialStateRef.current(value));
        // The arrival this recovery exists for: the sign-in already succeeded
        // and only this page's own POST is outstanding.
        if (autoFinalizeRef.current?.(value)) void runFinalizeRef.current(value);
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
      if (!finalizeRef.current) {
        setState('succeeded');
        return;
      }
      // NOT `failed`. The provider round-trip succeeded and the daemon holds
      // the grant; what did not happen is this lane's own finish, whose
      // recovery is a button rather than another sign-in.
      const done = await finalizeRef.current(
        client,
        preflightRef.current ?? (preflight as TPreflight)
      );
      if (!isCurrent()) return;
      setState(done ? 'succeeded' : 'finalize_failed');
    } catch {
      popup.close();
      if (isCurrent()) setState('failed');
    }
  };

  const finish = async () => {
    const value = preflightRef.current;
    if (!value || !slackOAuthActionIsFinishable(state)) return;
    await runFinalize(value);
  };

  return { state, preflight, start, finish };
}

export interface SlackOAuthActionShellProps extends Omit<ActionPageShellProps, 'secondaryAction'> {
  returnToSlackUrl?: string;
}

/** {@link ActionPageShell} with the Slack flows' "Return to Slack" secondary action. */
export function SlackOAuthActionShell({ returnToSlackUrl, ...props }: SlackOAuthActionShellProps) {
  return (
    <ActionPageShell
      {...props}
      secondaryAction={
        returnToSlackUrl ? (
          <Button size="large" href={returnToSlackUrl}>
            Return to Slack
          </Button>
        ) : undefined
      }
    />
  );
}
