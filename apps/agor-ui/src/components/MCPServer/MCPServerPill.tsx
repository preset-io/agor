import type { AgorClient, MCPServer } from '@agor-live/client';
import { ApiOutlined, EditOutlined, LoginOutlined, ReloadOutlined } from '@ant-design/icons';
import { App, Tooltip } from 'antd';
import { useState } from 'react';
import { usePermissions } from '@/hooks/usePermissions';
import { formatAbsoluteTime } from '../../utils/time';
import { Tag } from '../Tag';
import { MCPServerEditModal } from './MCPServerEditModal';

interface MCPServerPillProps {
  server: MCPServer;
  needsAuth: boolean;
  client: AgorClient | null;
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

/**
 * Clickable MCP server pill.
 *
 *   - Unauthenticated: orange + login icon, click starts OAuth.
 *   - Authenticated:   purple + API icon, tooltip shows human-readable expiry,
 *                      click force-refreshes the token (even before it's due)
 *                      so operators can probe per-provider refresh policy.
 *   - Admin only: a small pencil icon at the end opens the MCP edit modal
 *                 so operators can fix config without leaving the session view.
 */
export const MCPServerPill: React.FC<MCPServerPillProps> = ({ server, needsAuth, client }) => {
  const { message } = App.useApp();
  const { isAdmin } = usePermissions();
  const [refreshing, setRefreshing] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  // Local override so the tooltip reflects a just-refreshed expiry without
  // waiting for a full MCPServer re-fetch from the parent.
  const [expiresAtOverride, setExpiresAtOverride] = useState<number | undefined>(undefined);

  const expiresAt = expiresAtOverride ?? server.auth?.oauth_token_expires_at;

  const handleOAuthClick = async () => {
    if (!client) return;
    try {
      const data = (await client.service('mcp-servers/oauth-start').create({
        mcp_url: server.url,
        mcp_server_id: server.mcp_server_id,
        client_id: server.auth?.oauth_client_id,
      })) as {
        success: boolean;
        error?: string;
        authorizationUrl?: string;
        state?: string;
      };

      if (data.success && data.authorizationUrl) {
        window.open(data.authorizationUrl, '_blank', 'noopener,noreferrer');
        message.info('Complete sign-in in the new tab.');

        // Listen for completion — show toast when done
        if (data.state) {
          const handleCompleted = (event: { state: string; success: boolean }) => {
            if (event.state === data.state && event.success) {
              message.success(`${server.display_name || server.name} authenticated!`);
              client.io.off('oauth:completed', handleCompleted);
            }
          };
          client.io.on('oauth:completed', handleCompleted);
          // Clean up after 5 minutes (flow timeout)
          setTimeout(() => client.io.off('oauth:completed', handleCompleted), 5 * 60 * 1000);
        }
      } else if (!data.success) {
        message.error(data.error || 'Failed to start OAuth flow');
      }
    } catch (err) {
      message.error(`OAuth error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRefreshClick = async () => {
    if (!client || refreshing) return;
    setRefreshing(true);
    try {
      const result = (await client.service('mcp-servers/oauth-refresh').create({
        mcp_server_id: server.mcp_server_id,
      })) as {
        success: boolean;
        expires_at?: number;
        error?: string;
      };

      if (result.success) {
        setExpiresAtOverride(result.expires_at);
        message.success(
          result.expires_at
            ? `${server.display_name || server.name} refreshed — expires ${formatExpiresIn(result.expires_at).phrase}`
            : `${server.display_name || server.name} refreshed`
        );
      } else if (result.error === 'needs_reauth') {
        message.warning('Refresh token is no longer valid — sign in again.');
        // Fall through to full OAuth flow so the user can re-auth in one click.
        await handleOAuthClick();
      } else {
        message.error(`Refresh failed: ${result.error || 'unknown error'}`);
      }
    } catch (err) {
      message.error(`Refresh error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRefreshing(false);
    }
  };

  // Build a multi-line tooltip for the authenticated case so operators can
  // see both the relative countdown and the absolute wall-clock time — handy
  // for spotting providers with suspiciously short or long TTLs.
  let authedTooltip: React.ReactNode;
  if (expiresAt) {
    const date = new Date(expiresAt);
    const { verb, phrase } = formatExpiresIn(expiresAt);
    authedTooltip = (
      <>
        <div>
          {verb} {phrase}
        </div>
        <div style={{ opacity: 0.75, fontSize: 12 }}>{formatAbsoluteTime(date)}</div>
        <div style={{ opacity: 0.75, fontSize: 12, marginTop: 4 }}>Click to refresh now</div>
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
        <div style={{ opacity: 0.75, fontSize: 12, marginTop: 4 }}>Click to refresh now</div>
      </>
    );
  }

  return (
    <>
      <Tooltip title={needsAuth ? 'Click to authenticate' : authedTooltip}>
        <Tag
          color={needsAuth ? 'orange' : 'purple'}
          icon={
            needsAuth ? <LoginOutlined /> : refreshing ? <ReloadOutlined spin /> : <ApiOutlined />
          }
          style={{ cursor: refreshing ? 'wait' : 'pointer' }}
          onClick={needsAuth ? handleOAuthClick : handleRefreshClick}
        >
          {server.display_name || server.name}
          {isAdmin && (
            // Real <button> for keyboard focus + screen-reader semantics.
            // Native `title` (not <Tooltip>) so we don't stack a second
            // AntD tooltip on top of the parent expiry/auth tooltip.
            <button
              type="button"
              aria-label="Edit MCP server"
              title="Edit MCP server"
              onClick={(e) => {
                e.stopPropagation();
                setEditModalOpen(true);
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
                (e.currentTarget as HTMLElement).style.opacity = '1';
              }}
              onBlur={(e) => {
                (e.currentTarget as HTMLElement).style.opacity = '0.55';
              }}
            >
              <EditOutlined />
            </button>
          )}
        </Tag>
      </Tooltip>
      {isAdmin && (
        <MCPServerEditModal
          server={server}
          open={editModalOpen}
          client={client}
          onClose={() => setEditModalOpen(false)}
        />
      )}
    </>
  );
};
