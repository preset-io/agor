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
  useSlackOAuthAction,
} from './slackOAuthActionPage';

interface ConnectPreflight {
  state: 'connect_required' | 'sign_in_pending' | 'connected' | 'failed';
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

function openingState(preflight: ConnectPreflight): SlackOAuthActionState {
  if (preflight.state === 'sign_in_pending') return 'pending';
  if (preflight.state === 'failed') return 'failed';
  if (preflight.state === 'connected') return 'succeeded';
  return 'ready';
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
  const { state, preflight, start } = useSlackOAuthAction<ConnectPreflight>({
    client,
    preflightService: 'mcp-oauth-connect',
    startTokenField: 'connect_token',
    initialState: openingState,
    finalize: resolveWidget,
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
    if (state === 'failed') {
      return (
        <Alert
          type="error"
          showIcon
          title="The connection was not completed"
          description="Nothing was connected. Return to Slack and ask again, or connect from the Agor canvas instead."
        />
      );
    }
    if (state === 'succeeded') {
      return (
        <Alert
          type="success"
          showIcon
          title={serverName ? `${serverName} is connected` : 'Connected'}
          description="Agor is continuing the conversation in Slack. The tools become available on the agent's next turn."
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
        state === 'ready' ? (
          <Button type="primary" size="large" onClick={start}>
            Continue to sign-in
          </Button>
        ) : undefined
      }
      returnToSlackUrl={preflight?.return_to_slack_url}
      footnote="Agor never sees the account password, and the access token never reaches this page. Slack app tokens and MCP authorization are separate — Agor will never ask you to paste a broad Slack token here."
    />
  );
}
