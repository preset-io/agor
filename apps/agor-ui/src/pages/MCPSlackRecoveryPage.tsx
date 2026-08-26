import type { AgorClient, MCPOAuthStartFailure } from '@agor-live/client';
import { Alert, Button, Card, Flex, Spin, Typography, theme } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { openMarketplaceOAuthPopup } from '@/components/Marketplace/marketplaceOAuthPopup';
import { waitForMCPOAuthAttempt } from '@/utils/mcpOAuthAttempt';

type PageState =
  | 'checking'
  | 'ready'
  | 'starting'
  | 'pending'
  | 'recovered'
  | 'failed'
  | 'unavailable';

interface RecoveryPreflight {
  state: 'reconnect_required' | 'sign_in_pending' | 'failed';
  provider_dispatch: 'not_started' | 'ambiguous';
  expires_at: string;
  return_to_slack_url: string;
}

interface Props {
  client: AgorClient | null;
}

function fragmentToken(): string | null {
  const value = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
  return value?.trim() || null;
}

export function MCPSlackRecoveryPage({ client }: Props) {
  const token = useMemo(fragmentToken, []);
  const [state, setState] = useState<PageState>('checking');
  const [preflight, setPreflight] = useState<RecoveryPreflight | null>(null);
  const mounted = useRef(true);
  const pollAbort = useRef<AbortController | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const { token: designToken } = theme.useToken();

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (token && window.location.hash) {
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${window.location.search}`
      );
    }
  }, [token]);
  useEffect(
    () => () => {
      mounted.current = false;
      pollAbort.current?.abort();
    },
    []
  );
  useEffect(() => {
    if (!client || !token) {
      setState('unavailable');
      return;
    }
    let cancelled = false;
    client
      .service('mcp-slack-recovery')
      .create({ token })
      .then((result) => {
        if (cancelled) return;
        setPreflight(result as RecoveryPreflight);
        setState(
          (result as RecoveryPreflight).state === 'sign_in_pending'
            ? 'pending'
            : (result as RecoveryPreflight).state === 'failed'
              ? 'failed'
              : 'ready'
        );
      })
      .catch(() => !cancelled && setState('unavailable'));
    return () => {
      cancelled = true;
    };
  }, [client, token]);

  const start = async () => {
    if (!client || !token || state !== 'ready') return;
    // Reserve a popup synchronously while the click still has user activation.
    const popup = openMarketplaceOAuthPopup();
    if (!popup) {
      setState('failed');
      return;
    }
    setState('starting');
    try {
      const result = (await client.service('mcp-servers/oauth-start').create({
        slack_recovery_token: token,
      })) as { success: true; authorizationUrl: string; attempt_id: string } | MCPOAuthStartFailure;
      if (!mounted.current) return;
      if (!result.success || !result.authorizationUrl || !result.attempt_id) {
        popup.close();
        setState('failed');
        return;
      }
      if (!popup.navigate(result.authorizationUrl, () => mounted.current)) {
        setState('failed');
        return;
      }
      setState('pending');
      pollAbort.current?.abort();
      pollAbort.current = new AbortController();
      const attempt = await waitForMCPOAuthAttempt(client, result.attempt_id, {
        signal: pollAbort.current.signal,
      });
      if (!mounted.current) return;
      setState(attempt.status === 'succeeded' ? 'recovered' : 'failed');
    } catch {
      popup.close();
      if (mounted.current) setState('failed');
    }
  };

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
    if (state === 'recovered') {
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
      aria-labelledby="mcp-recovery-title"
    >
      <Card style={{ width: '100%', maxWidth: 560, overflowWrap: 'anywhere' }}>
        <Flex vertical gap={20} aria-live="polite">
          <div>
            <Typography.Title
              ref={titleRef}
              id="mcp-recovery-title"
              level={2}
              tabIndex={-1}
              style={{ marginBottom: designToken.marginXS, outline: 'none' }}
            >
              Reconnect MCP
            </Typography.Title>
            <Typography.Text type="secondary">
              Sign in with your current Agor account, then return to the originating Slack thread.
            </Typography.Text>
          </div>
          {status}
          <Flex gap={12} wrap>
            {state === 'ready' && (
              <Button type="primary" size="large" onClick={start}>
                Continue to sign-in
              </Button>
            )}
            {preflight?.return_to_slack_url && (
              <Button size="large" href={preflight.return_to_slack_url}>
                Return to Slack
              </Button>
            )}
          </Flex>
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            Slack app tokens and MCP authorization are separate. Agor will never ask you to paste a
            broad Slack token here.
          </Typography.Paragraph>
        </Flex>
      </Card>
    </main>
  );
}
