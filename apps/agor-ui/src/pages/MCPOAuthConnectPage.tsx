/**
 * Landing page for a Slack-delivered MCP connect link.
 *
 * The Slack counterpart of `OAuthConnectWidget`: same flow, different entry.
 * The widget is already inside an authenticated canvas session and knows its
 * own widget id; this page arrives from a chat message and knows only a sealed
 * token, so the daemon tells it what the card says (server name, reason,
 * disclosure, mode) after proving the token still binds and that the person
 * reading the page is the person it was issued for.
 *
 * The last step is what makes this the connect lane rather than the recovery
 * lane: on a successful durable attempt it POSTs `widgets/:id/oauth-resolve`,
 * which is the same endpoint the canvas widget posts and needs no change for
 * this caller — it takes nothing from the client but identity. The daemon
 * re-reads the persisted grant and decides; a rejection here means the grant
 * is not there, and the widget stays pending so Slack (or the canvas) can
 * offer Connect again.
 *
 * See `docs/internal/slack-mcp-oauth-connect-2026-09-16.md` §7.
 */

import type { AgorClient } from '@agor-live/client';
import { Alert, Button, Spin, Typography } from 'antd';
import {
  SlackOAuthActionShell,
  type SlackOAuthActionState,
  slackOAuthActionIsFinishable,
  slackOAuthActionIsStartable,
  useSlackOAuthAction,
} from './slackOAuthActionPage';

interface ConnectPreflight {
  /**
   * The same state machine the Slack card renders
   * (`mcpSlackConnectRenderedState`), not a second one. Both read the widget
   * row, its delivery record and the persisted grant; answering from one
   * function is what stops the thread and this page disagreeing about which
   * milestone a request has reached.
   */
  state:
    | 'connect_required'
    | 'sign_in_pending'
    | 'finish_required'
    | 'finish_stalled'
    | 'connected'
    | 'connected_not_attached'
    | 'expired'
    | 'cancelled'
    | 'unavailable';
  widget_id: string;
  server_name: string;
  oauth_mode: 'per_user' | 'shared';
  reason: string;
  permission_disclosure?: string;
  expires_at: string;
  return_to_slack_url: string;
}

interface Props {
  client: AgorClient | null;
}

/**
 * Which milestone the request has reached, in the page's vocabulary.
 *
 * Three of them, and they are not interchangeable:
 *
 *  1. the provider grant is persisted — `finish_required` / `finish_stalled`;
 *  2. this widget is resolved and the server attached;
 *  3. the agent has been resumed — both of those are `connected`.
 *
 * Only (1) is completed by the OAuth callback. The mapping used to collapse a
 * persisted grant straight onto `succeeded`, which told a user the
 * conversation was continuing when nothing had resolved and no agent had
 * woken.
 */
function openingState(preflight: ConnectPreflight): SlackOAuthActionState {
  switch (preflight.state) {
    case 'sign_in_pending':
      return 'pending';
    case 'finish_required':
    case 'finish_stalled':
      return 'finalize_required';
    case 'connected':
    case 'connected_not_attached':
      return 'succeeded';
    case 'expired':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'unavailable':
      return 'unavailable';
    default:
      return 'ready';
  }
}

/**
 * Tell the daemon the browser flow finished, and let it decide.
 *
 * Returns false rather than throwing so the page reports "not completed"
 * instead of "something broke": from the user's side those are the same
 * situation, and the recovery is the same too — try Connect again.
 */
async function resolveWidget(client: AgorClient, preflight: ConnectPreflight): Promise<boolean> {
  try {
    await client.service(`widgets/${preflight.widget_id}/oauth-resolve`).create({});
    return true;
  } catch {
    return false;
  }
}

export function MCPOAuthConnectPage({ client }: Props) {
  const { state, preflight, start, finish } = useSlackOAuthAction<ConnectPreflight>({
    client,
    preflightService: 'mcp-oauth-connect',
    startTokenField: 'connect_token',
    initialState: openingState,
    finalize: resolveWidget,
    // Arriving on a grant that already landed means the only thing left is
    // this page's POST, which the daemon answers by re-reading that grant.
    // Nothing is decided here that the user has not already decided at the
    // provider, so it runs on arrival; the button below is the retry.
    autoFinalize: (value) => value.state === 'finish_required' || value.state === 'finish_stalled',
  });

  const serverName = preflight?.server_name;
  const shared = preflight?.oauth_mode === 'shared';
  const status = (() => {
    if (state === 'checking' || state === 'starting') {
      return (
        <Spin
          description={state === 'checking' ? 'Checking this connect action…' : 'Opening sign-in…'}
        />
      );
    }
    if (state === 'unavailable') {
      return (
        <Alert
          type="warning"
          showIcon
          title="This connect action is unavailable"
          description="It may have expired, been used already, been replaced by a newer request, or no longer match your Agor account. Ask again in Slack if you still want to connect."
        />
      );
    }
    if (state === 'blocked') {
      // The one refusal that must not say "ask again": asking again reproduces
      // it. Slack's mobile in-app browser is where this happens, and it is the
      // primary client for this link.
      return (
        <Alert
          type="warning"
          showIcon
          title="Your browser blocked the sign-in window"
          description="Allow pop-ups for Agor and tap Continue to sign-in again. If you opened this link inside Slack, opening it in your usual browser also works."
        />
      );
    }
    if (state === 'failed') {
      return (
        <Alert
          type="error"
          showIcon
          title="The sign-in was not completed"
          description="Agor has no usable connection for this request. Return to Slack and ask again, or connect from the Agor canvas instead."
        />
      );
    }
    if (state === 'cancelled') {
      return (
        <Alert
          type="info"
          showIcon
          title="This request was replaced or cancelled"
          description="Nothing was connected. Ask again in the Slack thread if you still want to."
        />
      );
    }
    if (state === 'finalizing') {
      return <Spin description="Finishing the connection…" />;
    }
    if (state === 'finalize_failed') {
      // The one piece of copy this page most needed to get right. The sign-in
      // DID complete and the grant is stored; what did not happen is the
      // attach and the agent's wake-up. Telling this reader "nothing was
      // connected" sends them to redo a provider flow they already hold the
      // result of.
      return (
        <Alert
          type="warning"
          showIcon
          title="You are signed in — Agor could not finish"
          description={`Your ${serverName ?? 'account'} sign-in is saved: you will not have to do it again. Agor still has to attach it to the conversation and wake the assistant. Use Finish connecting to try that again, or ask in the Slack thread and Agor will finish it there.`}
        />
      );
    }
    if (state === 'finalize_required') {
      return (
        <Alert
          type="info"
          showIcon
          title="Finishing up"
          description={`You are signed in to ${serverName ?? 'the provider'}. Agor is attaching it to the conversation and waking the assistant.`}
        />
      );
    }
    if (state === 'succeeded') {
      const attachPending = preflight?.state === 'connected_not_attached';
      return (
        <Alert
          type={attachPending ? 'warning' : 'success'}
          showIcon
          title={serverName ? `${serverName} is connected` : 'Connected'}
          description={
            attachPending
              ? `Your account is connected. Attaching it to this session needs the session owner or an Agor admin — ask one of them to attach ${serverName ?? 'it'}, then continue in Slack.`
              : "Agor is continuing the conversation in Slack. The tools become available on the agent's next turn."
          }
        />
      );
    }
    return (
      <Alert
        type={state === 'pending' ? 'info' : 'warning'}
        showIcon
        title={
          state === 'pending'
            ? 'Sign-in is pending'
            : serverName
              ? `Connect ${serverName}`
              : 'Sign-in is required'
        }
        description={
          <>
            {preflight?.reason && (
              <Typography.Paragraph style={{ marginBottom: 8 }}>
                {preflight.reason}
              </Typography.Paragraph>
            )}
            {preflight?.permission_disclosure && (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                {preflight.permission_disclosure}
              </Typography.Paragraph>
            )}
            {shared && (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                This is a shared workspace connection: everyone in this Agor workspace uses the
                account you sign in with.
              </Typography.Paragraph>
            )}
          </>
        }
      />
    );
  })();

  return (
    <SlackOAuthActionShell
      titleId="mcp-connect-title"
      title={serverName ? `Connect ${serverName}` : 'Connect an account'}
      subtitle="Sign in with your current Agor account, then return to the originating Slack thread."
      status={status}
      primaryAction={
        slackOAuthActionIsStartable(state) ? (
          <Button type="primary" size="large" onClick={start}>
            Continue to sign-in
          </Button>
        ) : slackOAuthActionIsFinishable(state) ? (
          // Deliberately not "Connect": this button asks the daemon to finish
          // something already signed in for, and never opens a provider
          // window. It is idempotent — pressing it after it worked answers
          // that it is done.
          <Button type="primary" size="large" onClick={finish}>
            Finish connecting
          </Button>
        ) : undefined
      }
      returnToSlackUrl={preflight?.return_to_slack_url}
      footnote="Agor never sees the account password, and the access token never reaches this page. Slack app tokens and MCP authorization are separate — Agor will never ask you to paste a broad Slack token here."
    />
  );
}
