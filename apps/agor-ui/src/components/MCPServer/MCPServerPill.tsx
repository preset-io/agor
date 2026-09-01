import type { AgorClient, MCPServer } from '@agor-live/client';
import {
  ApiOutlined,
  EditOutlined,
  LoginOutlined,
  ReloadOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Tooltip } from 'antd';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { VISUALLY_HIDDEN_STYLE } from '@/utils/accessibility';
import { refreshAndRefetchMCPOAuthGrant } from '../../utils/mcpOAuthAttempt';
import { useThemedMessage } from '../../utils/message';
import { formatAbsoluteTime } from '../../utils/time';
import { ENTITY_PILL_COLORS } from '../Pill';
import { Tag } from '../Tag';
import { MCPOAuthRecoveryAlert } from './MCPOAuthRecoveryAlert';
import { useMCPServerOAuthStart } from './useMCPServerOAuthStart';

interface MCPServerPillProps {
  server: MCPServer;
  needsAuth: boolean;
  client: AgorClient | null;
  /** Opaque identity + role + successful-auth generation, null while disconnected. */
  authorityKey: string | null;
  /** Current server-side role/connection floor for OAuth mutations. */
  actionAllowed: boolean;
  actionBlockedReason: string;
  /** Same authoritative gate used by the owning editor's mutation service. */
  configureAllowed: boolean;
  configureBlockedReason: string;
  onOAuthAttemptStarted?: (attemptId: string, serverId: string) => void;
  /** Lets an overlay owner open an editor without nesting its lifecycle in this pill. */
  onEdit?: (server: MCPServer) => void;
}

/**
 * Format a (future or past) timestamp into the verb + phrase used in expiry
 * tooltips: `{ verb: 'Expires', phrase: 'in 3m' }` for future,
 * `{ verb: 'Expired', phrase: '5m ago' }` for past. Returning both from one
 * `Date.now()` read makes mismatched output ("Expires 0s ago" or
 * "Expired in 0s") impossible by construction at the expiry boundary.
 */
function formatExpiresIn(expiresAtMs: number): { verb: 'Expires' | 'Expired'; phrase: string } {
  const diffMs = expiresAtMs - Date.now();
  const abs = Math.abs(diffMs);
  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  const value = sec < 60 ? `${sec}s` : min < 60 ? `${min}m` : hr < 24 ? `${hr}h` : `${day}d`;

  return diffMs >= 0
    ? { verb: 'Expires', phrase: `in ${value}` }
    : { verb: 'Expired', phrase: `${value} ago` };
}

function formatRefreshError(error?: string): string {
  switch (error) {
    case 'missing_token_endpoint':
      return (
        'missing OAuth token endpoint — re-authenticate, or ask an admin to save the token URL ' +
        'in this MCP server’s OAuth settings'
      );
    case 'missing_client_id':
      return (
        'missing OAuth client ID for this grant — re-authenticate, or ask an admin to check ' +
        'the MCP server OAuth settings'
      );
    case 'needs_reauth':
      return 'refresh token is no longer valid — sign in again';
    case 'token_refresh_failed':
      return 'provider token refresh failed — try again, or sign in again if it keeps failing';
    default:
      return 'credential refresh failed — retry, or sign in again if it keeps failing';
  }
}

/**
 * Clickable MCP server pill.
 *
 *   - OAuth unauthenticated: warning + login icon, activation starts OAuth.
 *   - Bearer/JWT incomplete: warning + settings icon, activation opens config.
 *   - Authenticated:   purple + API icon, tooltip shows human-readable expiry,
 *                      activation force-refreshes the token (even before it's due)
 *                      so operators can probe per-provider refresh policy.
 *   - Admin only: when the overlay owner supplies `onEdit`, a small pencil icon
 *                 requests the MCP editor so operators can fix config without
 *                 leaving the session view.
 */
export const MCPServerPill: React.FC<MCPServerPillProps> = ({
  server,
  needsAuth,
  client,
  authorityKey,
  actionAllowed,
  actionBlockedReason,
  configureAllowed,
  configureBlockedReason,
  onOAuthAttemptStarted,
  onEdit,
}) => {
  const { showSuccess, showInfo, showWarning, showError } = useThemedMessage();
  const [refreshing, setRefreshing] = useState(false);
  // Local override so the tooltip reflects a just-refreshed expiry without
  // waiting for a full MCPServer re-fetch from the parent.
  const [expiresAtOverride, setExpiresAtOverride] = useState<number | undefined>(undefined);
  const operationGuard = useAuthorityOperationGuard(
    authorityKey && actionAllowed ? [authorityKey, client, actionAllowed] : null
  );

  // Local status/expiry is caller-shaped too. Clear it immediately when the
  // identity, role, auth generation, or connection authority changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these props are the transition key
  useLayoutEffect(() => {
    setRefreshing(false);
    setExpiresAtOverride(undefined);
  }, [actionAllowed, authorityKey]);

  const isOAuthServer = server.auth?.type === 'oauth';
  const needsConfiguration = needsAuth && !isOAuthServer;
  const expiresAt = expiresAtOverride ?? server.auth?.oauth_token_expires_at;

  const { handleStartOAuthFlow, oauthFailure, startingOAuthFlow } = useMCPServerOAuthStart({
    client,
    authorityKey,
    onPrepareOAuthStart: async () => server.mcp_server_id,
    onOAuthAttemptStarted,
    onOAuthSucceeded: () => showSuccess(`${server.display_name || server.name} authenticated!`),
    showError,
    showInfo,
    showSuccess,
    startAllowed: actionAllowed,
    startBlockedReason: actionBlockedReason,
  });

  const handleRefreshClick = async () => {
    const operation = operationGuard.begin();
    if (!client || !actionAllowed || !authorityKey || refreshing || !operation.isCurrent()) return;
    const shouldApply = operation.isCurrent;
    setRefreshing(true);
    try {
      const result = await refreshAndRefetchMCPOAuthGrant(
        client,
        server.mcp_server_id,
        shouldApply
      );
      if (!shouldApply()) return;

      if (result.success) {
        setExpiresAtOverride(result.expires_at);
        showSuccess(
          result.expires_at
            ? `${server.display_name || server.name} refreshed — expires ${formatExpiresIn(result.expires_at).phrase}`
            : `${server.display_name || server.name} refreshed`
        );
      } else if (result.error === 'needs_reauth' || result.error === 'missing_client_id') {
        setExpiresAtOverride(undefined);
        showWarning(formatRefreshError(result.error));
        // Fall through to full OAuth flow so the user can re-auth in one click.
        await handleStartOAuthFlow();
      } else {
        showError(`Refresh failed: ${formatRefreshError(result.error)}`);
      }
    } catch {
      if (!shouldApply()) return;
      showError('Credential refresh failed. Check the connection and try again.');
    } finally {
      if (shouldApply()) setRefreshing(false);
    }
  };

  // Build a multi-line tooltip for the authenticated case so operators can
  // see both the relative countdown and the absolute wall-clock time — handy
  // for spotting providers with suspiciously short or long TTLs.
  let authedTooltip: React.ReactNode;
  if (!isOAuthServer) {
    authedTooltip = `${server.transport.toUpperCase()} MCP server`;
  } else if (expiresAt) {
    const date = new Date(expiresAt);
    const { verb, phrase } = formatExpiresIn(expiresAt);
    authedTooltip = (
      <>
        <div>
          {verb} {phrase}
        </div>
        <div style={{ opacity: 0.75, fontSize: 12 }}>{formatAbsoluteTime(date)}</div>
        <div style={{ opacity: 0.75, fontSize: 12, marginTop: 4 }}>Activate to refresh now</div>
      </>
    );
  } else {
    // No expiry surfaced. With the resolveTokenExpiry cascade in place, this
    // is now an honest "we couldn't determine a TTL from anything the
    // provider returned" — Notion is the canonical example (omits expires_in
    // on both initial grant and refresh). The token is still usable; the
    // operator can force a refresh from this pill if it stops working.
    // (A retry-on-401 transport shim is tracked as a follow-up — see
    // `context/explorations/mcp-oauth-token-lifecycle.md` Phase 5.)
    authedTooltip = (
      <>
        <div>Expires in: unknown</div>
        <div style={{ opacity: 0.75, fontSize: 12 }}>
          Provider returned no expiry. Token is used until it stops working.
        </div>
        <div style={{ opacity: 0.75, fontSize: 12, marginTop: 4 }}>Activate to refresh now</div>
      </>
    );
  }

  const label = server.display_name || server.name;
  const needsAuthTooltip = isOAuthServer
    ? actionAllowed
      ? `${label} isn’t connected. Activate to sign in.`
      : actionBlockedReason
    : configureAllowed && onEdit
      ? `${label} needs configuration. Activate to configure saved credentials.`
      : `${label} needs configuration. ${configureBlockedReason}`;

  // OAuth and static credential recovery are deliberately separate actions:
  // only OAuth may enter the browser-flow hook; bearer/JWT opens the editor.
  const primaryAction = needsConfiguration
    ? configureAllowed && onEdit
      ? () => onEdit(server)
      : undefined
    : actionAllowed && isOAuthServer
      ? needsAuth
        ? () => void handleStartOAuthFlow()
        : handleRefreshClick
      : undefined;
  const [announcedState, setAnnouncedState] = useState('');
  const previousStatus = useRef({ needsAuth, startingOAuthFlow, refreshing });
  useEffect(() => {
    const previous = previousStatus.current;
    let announcement = '';
    if (!previous.startingOAuthFlow && startingOAuthFlow) {
      announcement = `${label} sign-in is starting.`;
    } else if (!previous.refreshing && refreshing) {
      announcement = `${label} credentials are refreshing.`;
    } else if (previous.needsAuth !== needsAuth) {
      announcement = needsAuth
        ? isOAuthServer
          ? `${label} requires authentication.`
          : `${label} needs configuration.`
        : `${label} is ready.`;
    }
    previousStatus.current = { needsAuth, startingOAuthFlow, refreshing };
    if (announcement) setAnnouncedState(announcement);
  }, [isOAuthServer, label, needsAuth, refreshing, startingOAuthFlow]);

  return (
    <>
      <span aria-live="polite" aria-atomic="true" style={VISUALLY_HIDDEN_STYLE}>
        {announcedState}
      </span>
      <Tooltip
        // The label is a button for actionable pills, so the same explanation
        // keyboard users receive on focus is available to pointer users on hover.
        trigger={['hover', 'focus']}
        title={
          needsConfiguration && !configureAllowed
            ? configureBlockedReason
            : !actionAllowed && isOAuthServer
              ? actionBlockedReason
              : needsAuth
                ? startingOAuthFlow
                  ? 'Starting OAuth authentication'
                  : needsAuthTooltip
                : authedTooltip
        }
      >
        <Tag
          color={needsAuth ? 'warning' : ENTITY_PILL_COLORS.mcp}
          icon={
            needsConfiguration ? (
              <SettingOutlined aria-hidden />
            ) : needsAuth ? (
              <LoginOutlined aria-hidden />
            ) : refreshing ? (
              <ReloadOutlined spin aria-hidden />
            ) : (
              <ApiOutlined aria-hidden />
            )
          }
          style={{
            cursor:
              refreshing || startingOAuthFlow ? 'wait' : primaryAction ? 'pointer' : 'default',
          }}
          onClick={primaryAction}
        >
          {primaryAction ? (
            // Tag is a span. Keep the whole visual pill as the pointer target,
            // but give its primary action a native keyboard/focus target. Stop
            // propagation so activating the button does not also fire Tag's
            // pointer handler.
            <button
              type="button"
              aria-label={
                needsConfiguration
                  ? `Needs configuration: ${label}`
                  : needsAuth
                    ? `Sign in to ${label}`
                    : `Refresh OAuth credentials for ${label}`
              }
              aria-busy={startingOAuthFlow || refreshing}
              onClick={(event) => {
                event.stopPropagation();
                void primaryAction();
              }}
              style={{
                margin: 0,
                padding: 0,
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                font: 'inherit',
                cursor: 'inherit',
              }}
            >
              {label}
            </button>
          ) : (
            <button
              type="button"
              aria-disabled="true"
              aria-label={`${label} MCP server. ${needsConfiguration ? `Needs configuration. ${configureBlockedReason}` : needsAuth ? 'Authentication required.' : 'Ready.'}`}
              style={{
                margin: 0,
                padding: 0,
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                font: 'inherit',
              }}
            >
              {label}
            </button>
          )}
          {configureAllowed && onEdit && (
            // Real <button> for keyboard focus + screen-reader semantics.
            // Native `title` (not <Tooltip>) so we don't stack a second
            // AntD tooltip on top of the parent expiry/auth tooltip.
            <button
              type="button"
              aria-label={`Edit ${label} MCP server`}
              title={`Edit ${label} MCP server`}
              onClick={(e) => {
                e.stopPropagation();
                onEdit(server);
              }}
              style={{
                marginLeft: 8,
                padding: 0,
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                fontSize: 11,
                lineHeight: 1,
                opacity: 0.55,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.opacity = '1';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.opacity = '0.55';
              }}
              onFocus={(e) => {
                e.stopPropagation();
                (e.currentTarget as HTMLElement).style.opacity = '1';
              }}
              onBlur={(e) => {
                e.stopPropagation();
                (e.currentTarget as HTMLElement).style.opacity = '0.55';
              }}
            >
              <EditOutlined aria-hidden />
            </button>
          )}
        </Tag>
      </Tooltip>
      {oauthFailure && (
        <MCPOAuthRecoveryAlert
          failure={oauthFailure}
          onRetry={() => void handleStartOAuthFlow()}
          onConfigure={configureAllowed && onEdit ? () => onEdit(server) : undefined}
        />
      )}
    </>
  );
};
