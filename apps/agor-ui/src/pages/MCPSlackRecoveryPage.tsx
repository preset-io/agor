import type { AgorClient } from '@agor-live/client';
import { Alert, Button, Spin } from 'antd';
import {
  SlackOAuthActionShell,
  type SlackOAuthActionState,
  slackOAuthActionIsStartable,
  useSlackOAuthAction,
} from './slackOAuthActionPage';

interface RecoveryPreflight {
  state: 'reconnect_required' | 'sign_in_pending' | 'failed';
  provider_dispatch: 'not_started' | 'ambiguous';
  expires_at: string;
  return_to_slack_url: string;
}

interface Props {
  client: AgorClient | null;
}

function openingState(preflight: RecoveryPreflight): SlackOAuthActionState {
  if (preflight.state === 'sign_in_pending') return 'pending';
  if (preflight.state === 'failed') return 'failed';
  return 'ready';
}

export function MCPSlackRecoveryPage({ client }: Props) {
  const { state, preflight, start } = useSlackOAuthAction<RecoveryPreflight>({
    client,
    preflightService: 'mcp-slack-recovery',
    startTokenField: 'slack_recovery_token',
    initialState: openingState,
  });

  const ambiguous = preflight?.provider_dispatch === 'ambiguous';
  const status = (() => {
    if (state === 'checking' || state === 'starting') {
      return (
        <Spin
          description={state === 'checking' ? 'Checking this recovery action…' : 'Opening sign-in…'}
        />
      );
    }
    if (state === 'unavailable') {
      return (
        <Alert
          type="warning"
          showIcon
          title="This recovery action is unavailable"
          description="It may have expired, been used already, or no longer match your Agor account. Return to Slack and send a new message if recovery is still needed."
        />
      );
    }
    if (state === 'blocked') {
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
          title="MCP recovery was not completed"
          description="No provider call was replayed. Return to Slack and try from a new turn, or contact an administrator."
        />
      );
    }
    if (state === 'succeeded') {
      return (
        <Alert
          type="success"
          showIcon
          title="MCP sign-in completed"
          description={
            ambiguous
              ? 'Agor is reconnecting later MCP calls. The interrupted call may have started and was not replayed.'
              : 'Agor is reconnecting this task. The interrupted call was not replayed; ask explicitly in Slack if you want to retry it.'
          }
        />
      );
    }
    return (
      <Alert
        type={state === 'pending' ? 'info' : 'warning'}
        showIcon
        title={state === 'pending' ? 'Sign-in is pending' : 'MCP sign-in is required'}
        description={
          ambiguous
            ? 'The interrupted provider call may have started. Reconnecting updates MCP for later calls and never replays that call automatically.'
            : 'Reconnect MCP for this same task and conversation. Agor will not replay the interrupted call automatically.'
        }
      />
    );
  })();

  return (
    <SlackOAuthActionShell
      titleId="mcp-recovery-title"
      title="Reconnect MCP"
      subtitle="Sign in with your current Agor account, then return to the originating Slack thread."
      status={status}
      primaryAction={
        slackOAuthActionIsStartable(state) ? (
          <Button type="primary" size="large" onClick={start}>
            Continue to sign-in
          </Button>
        ) : undefined
      }
      returnToSlackUrl={preflight?.return_to_slack_url}
      footnote="Slack app tokens and MCP authorization are separate. Agor will never ask you to paste a broad Slack token here."
    />
  );
}
