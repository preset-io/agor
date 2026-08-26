import type { AgorClient, MCPServer } from '@agor-live/client';
import { ROLES } from '@agor-live/client';
import { ApiOutlined } from '@ant-design/icons';
import { Tag as AntTag, Space, Typography, theme } from 'antd';
import React from 'react';
import { useConnectionState } from '@/contexts/ConnectionContext';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { usePermissions } from '@/hooks/usePermissions';
import { markMarketplacePromptAttempt } from '../../utils/marketplaceOAuthPrompt';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';
import { useThemedMessage } from '../../utils/message';
import { updateSessionMcpServers } from '../../utils/sessionMcpServers';
import { MCPServerEditModal, MCPServerPill } from '../MCPServer';
import { summarizeSessionMcpServers } from '../MCPServer/mcp-session-summary';
import { MCPServerSelect } from '../MCPServerSelect';
import { Tag } from '../Tag';

export interface SessionMcpFooterControlProps {
  client: AgorClient | null;
  currentUserId?: string;
  sessionId: string;
  sessionMcpServerIds: string[];
  mcpServerById: Map<string, MCPServer>;
  userAuthenticatedMcpServerIds: Set<string>;
}

const SessionMcpFooterControlForIdentity: React.FC<SessionMcpFooterControlProps> = ({
  client,
  currentUserId,
  sessionId,
  sessionMcpServerIds,
  mcpServerById,
  userAuthenticatedMcpServerIds,
}) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const { hasRole, isAdmin, role } = usePermissions();
  const { connected, connecting, authGeneration } = useConnectionState();
  const connectionReady = connected && !connecting;
  const identityRoleKey = currentUserId && role ? `${currentUserId}:${role}` : null;
  const establishedAuthorityRef = React.useRef<{
    client: AgorClient;
    identityRoleKey: string;
    authGeneration: number;
  } | null>(null);
  const establishedAuthority = establishedAuthorityRef.current;
  const authorityMatchesEstablished =
    !!establishedAuthority &&
    establishedAuthority.client === client &&
    establishedAuthority.identityRoleKey === identityRoleKey &&
    authGeneration >= establishedAuthority.authGeneration;
  const authorityHasNewAuthentication =
    !establishedAuthority || authGeneration > establishedAuthority.authGeneration;
  const callerAuthorityReady =
    !!client &&
    connectionReady &&
    !!identityRoleKey &&
    (authorityMatchesEstablished || authorityHasNewAuthentication);
  React.useLayoutEffect(() => {
    if (!callerAuthorityReady || !client || !identityRoleKey) return;
    establishedAuthorityRef.current = { client, identityRoleKey, authGeneration };
  }, [authGeneration, callerAuthorityReady, client, identityRoleKey]);
  const oauthActionAllowed = callerAuthorityReady && hasRole(ROLES.MEMBER);
  const durableAuthorityKey =
    client && oauthActionAllowed && currentUserId && role
      ? `${currentUserId}:${role}:${authGeneration}`
      : null;
  const editMutationAllowed = isAdmin && callerAuthorityReady;
  const [saving, setSaving] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [editingServer, setEditingServer] = React.useState<MCPServer | null>(null);
  const [editModalOpen, setEditModalOpen] = React.useState(false);
  const operationGuard = useAuthorityOperationGuard(
    durableAuthorityKey ? [durableAuthorityKey, client, editMutationAllowed] : null
  );
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const popupRef = React.useRef<HTMLDivElement>(null);
  const generatedId = React.useId().replaceAll(':', '');
  const popupId = `session-mcp-popup-${generatedId}`;
  const headingId = `${popupId}-heading`;

  React.useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (
        rootRef.current &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [open]);

  const dismissAndRestoreFocus = React.useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  const handleEscape = (event: React.KeyboardEvent) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismissAndRestoreFocus();
    }
  };

  const handleEditServer = React.useCallback((server: MCPServer) => {
    // AntD Modal portals to document.body. Close this disclosure deliberately
    // before opening the modal, and keep the modal's state at this overlay
    // owner, so interacting with the portal cannot be mistaken for an outside
    // click or unmount the editor with the disclosure contents.
    setOpen(false);
    setEditingServer(server);
    setEditModalOpen(true);
  }, []);

  const finishEditModalClose = React.useCallback(() => {
    setEditingServer(null);
    triggerRef.current?.focus();
  }, []);

  React.useEffect(() => {
    if (!editingServer) return;
    const updatedServer = mcpServerById.get(editingServer.mcp_server_id);
    if (!updatedServer) {
      setEditModalOpen(false);
      setEditingServer(null);
    } else if (updatedServer !== editingServer) {
      setEditingServer(updatedServer);
    }
  }, [editingServer, mcpServerById]);

  const summary = React.useMemo(
    () =>
      summarizeSessionMcpServers(sessionMcpServerIds, mcpServerById, userAuthenticatedMcpServerIds),
    [sessionMcpServerIds, mcpServerById, userAuthenticatedMcpServerIds]
  );

  const attachedServers = React.useMemo(
    () =>
      sessionMcpServerIds
        .map((id) => mcpServerById.get(id))
        .filter((server): server is MCPServer => Boolean(server)),
    [sessionMcpServerIds, mcpServerById]
  );

  const unauthedServers = React.useMemo(
    () =>
      attachedServers.filter((server) => mcpServerNeedsAuth(server, userAuthenticatedMcpServerIds)),
    [attachedServers, userAuthenticatedMcpServerIds]
  );
  const markNewOAuthAttempt = React.useCallback(
    (attemptId: string) => {
      if (!currentUserId || !role) return;
      markMarketplacePromptAttempt({
        sessionId,
        attemptId,
        userId: currentUserId,
        role,
        authGeneration,
        createdAt: Date.now(),
      });
    },
    [authGeneration, currentUserId, role, sessionId]
  );

  const badgeTitle =
    unauthedServers.length === 1
      ? `${unauthedServers[0].display_name || unauthedServers[0].name} isn’t connected. Open to connect.`
      : unauthedServers.length > 1
        ? `${unauthedServers.length} MCP servers aren’t connected. Open to connect.`
        : `${summary.tooltip}. Open to add or change MCP servers.`;
  const badgeAccessibleName = `MCP servers. ${badgeTitle}`;

  const handleChange = async (nextIds: string[]) => {
    const operation = operationGuard.begin();
    if (!client || !operation.isCurrent()) return;
    setSaving(true);
    try {
      await updateSessionMcpServers(client, sessionId, sessionMcpServerIds, nextIds);
      if (!operation.isCurrent()) return;
      showSuccess('Session MCP servers updated');
    } catch (err) {
      if (!operation.isCurrent()) return;
      showError(
        `Failed to update MCP servers: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      if (operation.isCurrent()) setSaving(false);
    }
  };

  const content = (
    <div style={{ width: 340, maxWidth: 'min(340px, 80vw)' }}>
      <Space orientation="vertical" size={10} style={{ width: '100%' }}>
        <div>
          <Typography.Text id={headingId} strong>
            Session MCP servers
          </Typography.Text>
          <Typography.Paragraph type="secondary" style={{ margin: `${token.sizeUnit}px 0 0` }}>
            Attach tools/connectors that the agent can use in this conversation.
          </Typography.Paragraph>
        </div>

        {attachedServers.length > 0 && (
          <Space size={6} wrap>
            {attachedServers.map((server) => (
              <MCPServerPill
                key={server.mcp_server_id}
                server={server}
                needsAuth={mcpServerNeedsAuth(server, userAuthenticatedMcpServerIds)}
                client={client}
                authorityKey={durableAuthorityKey}
                actionAllowed={oauthActionAllowed}
                actionBlockedReason={
                  !connectionReady
                    ? 'Reconnect to the Agor daemon before changing OAuth credentials.'
                    : 'Your account can no longer change OAuth credentials.'
                }
                configureAllowed={editMutationAllowed}
                configureBlockedReason={
                  !connectionReady
                    ? 'Reconnect to the Agor daemon before changing saved credentials.'
                    : 'Only an administrator can change saved credentials.'
                }
                onOAuthAttemptStarted={markNewOAuthAttempt}
                onEdit={editMutationAllowed ? handleEditServer : undefined}
              />
            ))}
          </Space>
        )}

        <MCPServerSelect
          mcpServers={Array.from(mcpServerById.values())}
          placeholder="Attach MCP servers…"
          value={sessionMcpServerIds}
          onChange={handleChange}
          loading={saving}
          disabled={!client || saving}
          style={{ width: '100%' }}
          getPopupContainer={(trigger) =>
            popupRef.current ?? trigger.parentElement ?? document.body
          }
        />
      </Space>
    </div>
  );

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      {/* Tag renders a span, but this popover contains the only in-session
          sign-in action for a fresh Marketplace OAuth install. Keep the Tag's
          appearance inside a native disclosure control so Enter/Space, focus,
          and the stateful accessible name do not depend on click handlers on a
          span. */}
      <button
        ref={triggerRef}
        type="button"
        aria-label={badgeAccessibleName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popupId}
        title={badgeTitle}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleEscape}
        style={{
          margin: 0,
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          lineHeight: 1,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        <Tag
          icon={<ApiOutlined aria-hidden />}
          color="default"
          style={{ cursor: 'pointer', height: 22, display: 'inline-flex', alignItems: 'center' }}
          // antd nests children in a content span, so the root's align-items never reaches the chip.
          styles={{ content: { display: 'inline-flex', alignItems: 'center' } }}
        >
          <span>MCP</span>
          <AntTag
            style={{
              marginInlineStart: token.sizeUnit,
              marginInlineEnd: 0,
              // Round notification counter: a 16px circle at one digit
              // (minWidth === height), growing into a pill for 2+ digits. The
              // large radius fully rounds the ends (clamped to height/2) in both.
              boxSizing: 'border-box',
              minWidth: 16,
              height: 16,
              paddingInline: 4,
              borderRadius: 999,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
              fontSize: 10,
              textAlign: 'center',
              fontVariantNumeric: 'tabular-nums',
              // Recolor the count amber via semantic tokens only — the neutral chip's
              // geometry (size, radius, shape) is untouched, so the not-connected
              // state differs from the healthy state purely in color, theme-aware
              // in light and dark. Avoids AntD's `color="warning"` preset, whose own
              // fill/border/radius would shift the box vs. the neutral chip.
              ...(summary.tone === 'warning'
                ? { backgroundColor: token.colorWarningBg, color: token.colorWarning }
                : {}),
            }}
          >
            {summary.attachedCount}
          </AntTag>
        </Tag>
      </button>

      {open && (
        <div
          ref={popupRef}
          id={popupId}
          role="dialog"
          aria-labelledby={headingId}
          onKeyDown={handleEscape}
          style={{
            position: 'absolute',
            bottom: `calc(100% + ${token.sizeXS}px)`,
            left: 0,
            zIndex: token.zIndexPopupBase,
            padding: token.paddingSM,
            background: token.colorBgElevated,
            borderWidth: token.lineWidth,
            borderStyle: 'solid',
            borderColor: token.colorBorderSecondary,
            borderRadius: token.borderRadiusLG,
            boxShadow: token.boxShadowSecondary,
          }}
        >
          {content}
        </div>
      )}
      {editingServer && (
        <MCPServerEditModal
          server={editingServer}
          open={editModalOpen}
          client={client}
          identityKey={currentUserId ?? null}
          authGeneration={authGeneration}
          authorityKey={durableAuthorityKey}
          mutationAllowed={editMutationAllowed}
          mutationBlockedReason={
            !connected || connecting
              ? 'Reconnect to the Agor daemon before changing this MCP server.'
              : 'Your account can no longer change this MCP server.'
          }
          onClose={() => setEditModalOpen(false)}
          afterClose={finishEditModalClose}
          focusTriggerAfterClose={false}
        />
      )}
    </div>
  );
};

/**
 * #2482 keeps the portaled editor owned outside the disclosure. Key that whole
 * owner by identity rather than moving the modal back into the popup: A -> B
 * closes and destroys both overlays and their form state, while same-user
 * reconnects preserve the established lifecycle and focus behavior.
 */
export const SessionMcpFooterControl: React.FC<SessionMcpFooterControlProps> = (props) => (
  <SessionMcpFooterControlForIdentity
    key={props.currentUserId ?? '__no-authenticated-user__'}
    {...props}
  />
);
