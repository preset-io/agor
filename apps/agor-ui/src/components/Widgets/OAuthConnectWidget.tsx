/**
 * OAuthConnectWidget — `oauth` in-conversation widget UI.
 *
 * Renders inline in the transcript when an agent calls
 * `agor_widgets_request_oauth` ("connect me to Notion"). One button, which
 * drives the ordinary browser MCP OAuth flow — the same three steps the
 * Marketplace drawer and the Slack recovery page run:
 *
 *   1. Pre-open a same-origin blank popup while the click still carries user
 *      activation (`openMarketplaceOAuthPopup`). Doing this AFTER the await
 *      below is what gets a sign-in silently blocked.
 *   2. `mcp-servers/oauth-start` → navigate the held popup to the provider.
 *   3. Poll the durable attempt (`waitForMCPOAuthAttempt`) until it settles.
 *
 * Then — and this is the part that is specific to widgets — POST
 * `widgets/:id/oauth-resolve`. That POST asserts nothing: the daemon re-reads
 * the persisted grant and decides, so a failure here means "the grant isn't
 * there", not "the button didn't work". The widget stays pending on failure
 * and the user can press Connect again.
 *
 * Steps 1-3 are skipped entirely when the user is already signed in to this
 * server: the card offers **Finish connecting**, which is the POST on its own.
 * That case is not rare and not only a shortcut — the grant is persisted by
 * the daemon's callback while the resolution waits on a POST from whichever
 * page ran the flow, so a reload, a closed tab, or a sign-in completed in
 * Slack leaves exactly this state. Before it, the only way forward was a full
 * re-authorization of an account that was already connected.
 *
 * No secret ever touches this component. The provider redirects to the
 * daemon's own callback; the popup's only job is to be the window the user
 * signs in to.
 *
 * Terminal states (one-line read-only summaries):
 *   - submitted (attached)      ✅ Connected and attached
 *   - submitted (not attached)  ⚠️ Connected, but the session owner must attach
 *   - dismissed                 ⊘ Declined
 *   - already_present           ✓ Already connected (⚠️ if it could not be attached)
 *
 * See `docs/internal/slack-mcp-oauth-connect-2026-09-16.md`.
 */

import type { AgorClient, MCPOAuthStartFailure, WidgetMessageMetadata } from '@agor-live/client';
import {
  ApiOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  MinusCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Space, Typography, theme } from 'antd';
import { useEffect, useRef, useState } from 'react';
import {
  type MarketplaceOAuthPopup,
  openMarketplaceOAuthPopup,
} from '@/components/Marketplace/marketplaceOAuthPopup';
import { useAgorStore } from '@/store/agorStore';
import { selectUserAuthenticatedMcpServerIds } from '@/store/selectors';
import { VISUALLY_HIDDEN_STYLE } from '@/utils/accessibility';
import { oauthAttemptFailureMessage, waitForMCPOAuthAttempt } from '@/utils/mcpOAuthAttempt';
import { useThemedMessage } from '@/utils/message';
import { registerWidgetComponent, type WidgetComponentProps } from '../MessageBlock/WidgetBlock';

const { Text, Paragraph } = Typography;

interface OAuthWidgetParams {
  mcpServerId: string;
  serverName: string;
  oauthMode: 'per_user' | 'shared';
  reason: string;
  catalogEntryName?: string;
  permissionDisclosure?: string;
}

interface OAuthWidgetResultMeta {
  mcp_server_id: string;
  name: string;
  oauth_mode: 'per_user' | 'shared';
  account_label?: string;
  attached: boolean;
}

interface OAuthStartSuccess {
  success: true;
  authorizationUrl: string;
  attempt_id: string;
}

function readParams(widget: WidgetMessageMetadata): OAuthWidgetParams {
  return widget.params as OAuthWidgetParams;
}

function readResultMeta(widget: WidgetMessageMetadata): OAuthWidgetResultMeta | undefined {
  return widget.result_meta as OAuthWidgetResultMeta | undefined;
}

const TerminalLine: React.FC<{
  icon: React.ReactNode;
  borderColor: string;
  text: React.ReactNode;
}> = ({ icon, borderColor, text }) => {
  const { token } = theme.useToken();
  return (
    <Card
      size="small"
      style={{
        margin: `${token.sizeUnit * 1.5}px 0`,
        background: token.colorBgContainer,
        borderLeft: `3px solid ${borderColor}`,
      }}
      styles={{ body: { padding: `${token.paddingXS}px ${token.paddingSM}px` } }}
    >
      <Space size="small">
        {icon}
        {text}
      </Space>
    </Card>
  );
};

type ConnectState = 'idle' | 'starting' | 'pending' | 'finishing' | 'connected' | 'declined';

/** States where a second press must do nothing. */
const busyStates = new Set<ConnectState>(['starting', 'pending', 'finishing']);

interface PendingCardProps {
  widgetId: string;
  params: OAuthWidgetParams;
  client: AgorClient | null;
}

const PendingCard: React.FC<PendingCardProps> = ({ widgetId, params, client }) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const [state, setState] = useState<ConnectState>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  // Has this user already signed in to this server?
  //
  // The same last-observed snapshot the rest of the UI reads
  // (`/mcp-servers/oauth-status`), and deliberately only a HINT: it decides
  // which button this card offers, never what happens when it is pressed. The
  // daemon re-reads the grant before it resolves anything, and `finishFailed`
  // below drops the card back to an ordinary Connect if it turns out the
  // snapshot was stale.
  //
  // It matters because the grant can land without this widget ever resolving:
  // the provider callback persists it and the resolution waits on a POST from
  // whichever page ran the flow. A reload in between — or a browser closed
  // after consent — used to leave this card offering a full re-authorization
  // as the only way forward.
  const authenticatedServerIds = useAgorStore(selectUserAuthenticatedMcpServerIds);
  const [finishFailed, setFinishFailed] = useState(false);
  const canFinish = !finishFailed && authenticatedServerIds.has(params.mcpServerId);

  // Latest-click-wins. A second Connect invalidates the first click's popup and
  // poll so a stale attempt cannot resolve the widget behind a newer one.
  const operationOwner = useRef(0);
  const activePopup = useRef<MarketplaceOAuthPopup | null>(null);
  const pollAbort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      operationOwner.current++;
      pollAbort.current?.abort();
      activePopup.current?.close();
      activePopup.current = null;
    },
    []
  );

  /**
   * Resolve the widget with no provider round-trip at all.
   *
   * Idempotent on the daemon side: it re-reads the grant, attaches, and queues
   * the auto-resume under a durable task id, and answers success for a widget
   * that some other surface already finished. So pressing this twice, or
   * pressing it after the Slack page finished the same request, converges
   * rather than duplicating.
   */
  const finish = async () => {
    if (busyStates.has(state) || !client) return;
    const owner = ++operationOwner.current;
    setFailure(null);
    setState('finishing');
    try {
      const resolved = (await client
        .service(`widgets/${encodeURIComponent(widgetId)}/oauth-resolve`)
        .create({})) as { status?: string };
      if (operationOwner.current !== owner) return;
      setState('connected');
      if (resolved.status === 'submitted') showSuccess(`Connected ${params.serverName}`);
    } catch {
      if (operationOwner.current !== owner) return;
      // The snapshot said there was a grant and the daemon disagrees — it may
      // have been revoked, or it may belong to someone else. Fall back to the
      // ordinary sign-in rather than leaving a button that cannot work.
      setFinishFailed(true);
      setState('idle');
      setFailure(
        `Agor could not finish connecting "${params.serverName}". Sign in again to continue.`
      );
    }
  };

  const connect = async () => {
    if (state === 'starting' || state === 'pending' || state === 'connected') return;
    if (!client) {
      setFailure('Not connected to Agor — refresh and try again.');
      return;
    }
    // Reserve the popup synchronously, while the click still has user
    // activation. Opening it after the oauth-start await gets it blocked.
    const popup = openMarketplaceOAuthPopup();
    if (!popup) {
      setFailure('Your browser blocked the sign-in window. Allow pop-ups for Agor and try again.');
      return;
    }
    const owner = ++operationOwner.current;
    const isCurrent = () => operationOwner.current === owner;
    activePopup.current = popup;
    setFailure(null);
    setState('starting');

    try {
      const result = (await client.service('mcp-servers/oauth-start').create({
        mcp_server_id: params.mcpServerId,
      })) as OAuthStartSuccess | MCPOAuthStartFailure;
      if (!isCurrent()) return;
      if (!result.success || !result.authorizationUrl || !result.attempt_id) {
        popup.close();
        setState('idle');
        setFailure(
          (result as MCPOAuthStartFailure).error ??
            'Sign-in could not be started. Try again, or connect from the MCP Catalog.'
        );
        return;
      }
      if (!popup.navigate(result.authorizationUrl, isCurrent)) {
        setState('idle');
        setFailure('The sign-in window closed before it opened. Try Connect again.');
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
        setState('idle');
        const message = attempt.recovery?.message ?? oauthAttemptFailureMessage(attempt.status);
        setFailure(message);
        showError(message);
        return;
      }

      // The daemon decides, not this poll: it re-reads the grant before it
      // will resolve anything.
      const resolved = (await client
        .service(`widgets/${encodeURIComponent(widgetId)}/oauth-resolve`)
        .create({ attempt_id: result.attempt_id })) as { status?: string };
      if (!isCurrent()) return;
      setState('connected');
      if (resolved.status === 'submitted') showSuccess(`Connected ${params.serverName}`);
    } catch (err) {
      popup.close();
      if (!isCurrent()) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const message = err instanceof Error ? err.message : String(err);
      setState('idle');
      setFailure(message);
      showError(`Connect failed: ${message}`);
    }
  };

  const decline = async () => {
    if (!client || busyStates.has(state) || state === 'connected') return;
    try {
      await client.service(`widgets/${encodeURIComponent(widgetId)}/dismiss`).create({});
      setState('declined');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFailure(`Dismiss failed: ${message}`);
      showError(`Dismiss failed: ${message}`);
    }
  };

  if (state === 'connected') {
    return (
      <TerminalLine
        icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
        borderColor={token.colorSuccess}
        // Transient: the durable row arrives over the socket a moment later and
        // `ResolvedSummary` renders the authoritative outcome, including
        // whether the attach was allowed.
        text={<Text>Connected "{params.serverName}"</Text>}
      />
    );
  }
  if (state === 'declined') {
    return (
      <TerminalLine
        icon={<MinusCircleOutlined style={{ color: token.colorTextSecondary }} />}
        borderColor={token.colorBorder}
        text={<Text type="secondary">Declined to connect "{params.serverName}"</Text>}
      />
    );
  }

  const busy = busyStates.has(state);
  // What a screen reader is told, separately from what the card shows.
  //
  // Nothing about this flow is synchronous: the user clicks, a popup opens, a
  // provider round-trip happens, and the card rewrites itself. The alerts that
  // render at each of those moments are conditional, and a live region created
  // in the same commit as its content is the classic case assistive technology
  // misses — so the regions are PERSISTENT and empty rather than appearing with
  // their text. Polite for progress so it waits its turn, assertive for the
  // failure so it interrupts. Visually hidden, so they add no gap to a card
  // whose visible states are the Alerts below.
  const progressAnnouncement =
    state === 'starting'
      ? `Opening the sign-in window for ${params.serverName}.`
      : state === 'pending'
        ? `Sign-in to ${params.serverName} is pending. Finish signing in in the provider window.`
        : state === 'finishing'
          ? `Finishing the connection to ${params.serverName}.`
          : '';
  return (
    <Card
      size="small"
      style={{ margin: `${token.sizeUnit * 1.5}px 0`, background: token.colorBgContainer }}
      styles={{ body: { padding: token.paddingSM } }}
    >
      <span role="status" aria-live="polite" aria-atomic="true" style={VISUALLY_HIDDEN_STYLE}>
        {progressAnnouncement}
      </span>
      <span role="alert" aria-atomic="true" style={VISUALLY_HIDDEN_STYLE}>
        {failure ? `Sign-in to ${params.serverName} was not completed. ${failure}` : ''}
      </span>
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Space size="small">
          <ApiOutlined style={{ color: token.colorPrimary }} />
          <Text strong>Connect "{params.serverName}"</Text>
        </Space>

        {params.reason ? (
          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {params.reason}
          </Text>
        ) : null}

        {params.permissionDisclosure ? (
          <Paragraph
            type="secondary"
            style={{ fontSize: token.fontSizeSM, margin: 0 }}
            data-testid="oauth-widget-disclosure"
          >
            {params.permissionDisclosure}
          </Paragraph>
        ) : null}

        {params.oauthMode === 'shared' ? (
          // Icon, not colour alone: this is the one line that distinguishes a
          // personal sign-in from handing the whole workspace an account, and
          // `type="warning"` carries that entirely in the text colour.
          <Space size="small" align="start">
            <WarningOutlined
              aria-hidden
              style={{ color: token.colorWarning, fontSize: token.fontSizeSM, marginTop: 3 }}
            />
            <Text type="warning" style={{ fontSize: token.fontSizeSM }}>
              This is a workspace-wide connection: everyone in this Agor workspace will use the
              account you sign in with.
            </Text>
          </Space>
        ) : null}

        {state === 'pending' ? (
          <Alert
            // The visible copy. The announcement is the persistent region
            // below, so this hands its role over rather than being a second
            // one — antd puts `role="alert"` on every Alert, including this
            // informational one, which would interrupt for mere progress.
            role="presentation"
            type="info"
            showIcon
            title="Sign-in is pending"
            description="Finish signing in in the provider window. This card confirms once Agor has the connection."
          />
        ) : null}

        {canFinish && state !== 'pending' ? (
          <Alert
            role="presentation"
            type="info"
            showIcon
            title="You are already signed in"
            description={`Agor has your ${params.serverName} sign-in. It only has to attach it to this session and continue — no second sign-in.`}
          />
        ) : null}

        {failure ? (
          <Alert
            role="presentation"
            type="error"
            showIcon
            title="Sign-in was not completed"
            description={failure}
          />
        ) : null}

        <Space style={{ width: '100%', justifyContent: 'flex-end' }} size="small">
          <Button size="small" onClick={decline} disabled={busy}>
            Not now
          </Button>
          {canFinish ? (
            <Button size="small" type="primary" onClick={finish} loading={busy}>
              Finish connecting
            </Button>
          ) : (
            <Button size="small" type="primary" onClick={connect} loading={busy}>
              {failure ? 'Try again' : 'Connect'}
            </Button>
          )}
        </Space>
      </Space>
    </Card>
  );
};

const ResolvedSummary: React.FC<{ widget: WidgetMessageMetadata }> = ({ widget }) => {
  const { token } = theme.useToken();
  const params = readParams(widget);
  const rm = readResultMeta(widget);
  const name = rm?.name || params.serverName;

  if (widget.status === 'already_present') {
    // `result_meta` is absent on rows minted before the shortcut recorded it;
    // those were only ever written after a successful attach.
    if (rm?.attached === false) {
      return (
        <TerminalLine
          icon={<ExclamationCircleOutlined style={{ color: token.colorWarning }} />}
          borderColor={token.colorWarning}
          text={
            <Space orientation="vertical" size={0}>
              <Text>"{name}" was already connected</Text>
              <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                It could not be attached here — only the session owner or an admin can change this
                session's MCP servers.
              </Text>
            </Space>
          }
        />
      );
    }
    return (
      <TerminalLine
        icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
        borderColor={token.colorSuccess}
        text={
          <Text type="secondary">"{name}" was already connected — attached to this session</Text>
        }
      />
    );
  }
  if (widget.status === 'dismissed') {
    return (
      <TerminalLine
        icon={<MinusCircleOutlined style={{ color: token.colorTextSecondary }} />}
        borderColor={token.colorBorder}
        text={<Text type="secondary">Declined to connect "{name}"</Text>}
      />
    );
  }
  if (rm && !rm.attached) {
    return (
      <TerminalLine
        icon={<ExclamationCircleOutlined style={{ color: token.colorWarning }} />}
        borderColor={token.colorWarning}
        text={
          <Space orientation="vertical" size={0}>
            <Text>Connected "{name}"</Text>
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              It could not be attached here — only the session owner or an admin can change this
              session's MCP servers.
            </Text>
          </Space>
        }
      />
    );
  }
  return (
    <TerminalLine
      icon={<CheckCircleOutlined style={{ color: token.colorSuccess }} />}
      borderColor={token.colorSuccess}
      text={
        <Space orientation="vertical" size={0}>
          <Text>Connected "{name}" — attached to this session</Text>
          {rm?.account_label ? (
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Account: {rm.account_label}
            </Text>
          ) : null}
        </Space>
      }
    />
  );
};

export const OAuthConnectWidget: React.FC<WidgetComponentProps> = ({ widget, client }) => {
  const params = readParams(widget);
  const widgetId = widget.widget_id as unknown as string;

  switch (widget.status) {
    case 'submitted':
    case 'dismissed':
    case 'already_present':
      return <ResolvedSummary widget={widget} />;
    default:
      return <PendingCard widgetId={widgetId} params={params} client={client} />;
  }
};

// Side-effect: register with the WidgetBlock dispatcher on module load.
registerWidgetComponent('oauth', OAuthConnectWidget);

export const _OAuthConnectWidgetForTests = { PendingCard, ResolvedSummary };

export type { OAuthWidgetParams, OAuthWidgetResultMeta };
