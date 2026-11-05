import type { AgorClient, MCPServer } from '@agor-live/client';
import { ROLES } from '@agor-live/client';
import { ApiOutlined, ShopOutlined } from '@ant-design/icons';
import { Tag as AntTag, Button, Flex, Space, Switch, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { useConnectionState } from '@/contexts/ConnectionContext';
import { useMCPCatalogModal } from '@/contexts/MCPCatalogModalContext';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport';
import { usePermissions } from '@/hooks/usePermissions';
import { useAgorStore } from '../../store/agorStore';
import { formatActionError } from '../../utils/connectionErrors';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';
import { useThemedMessage } from '../../utils/message';
import { updateSessionMcpServers } from '../../utils/sessionMcpServers';
import { setMcpServerHidden } from '../../utils/userPreferences';
import { MCPServerEditModal, MCPServerPill } from '../MCPServer';
import { summarizeSessionMcpServers } from '../MCPServer/mcp-session-summary';
import { MCPServerSelect } from '../MCPServerSelect';
import { Tag } from '../Tag';
import { useSessionMcpEffectiveView } from './useSessionMcpEffectiveView';

export interface SessionMcpFooterControlProps {
  client: AgorClient | null;
  currentUserId?: string;
  sessionId: string;
  sessionMcpServerIds: string[];
  sessionMcpLoadFailed?: boolean;
  onSessionMcpRetry?: () => void;
  mcpServerById: Map<string, MCPServer>;
  userAuthenticatedMcpServerIds: Set<string>;
}

const SessionMcpFooterControlForIdentity: React.FC<SessionMcpFooterControlProps> = ({
  client,
  currentUserId,
  sessionId,
  sessionMcpServerIds,
  sessionMcpLoadFailed = false,
  onSessionMcpRetry,
  mcpServerById,
  userAuthenticatedMcpServerIds,
}) => {
  const { token } = theme.useToken();
  const catalog = useMCPCatalogModal();
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
  // Until this session's links are loaded `sessionMcpServerIds` may be
  // partial, and an edit diff would detach what it never saw.
  const linksLoaded = useAgorStore((s) => s.sessionMcpLoaded.has(sessionId));
  const [saving, setSaving] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  // Bind the response to every authority/inventory input at render time, not
  // just effect cleanup. A stale response cannot enable an option for one render.
  const availabilityRequest = React.useMemo(
    () => ({
      client,
      sessionId,
      open,
      callerAuthorityReady,
      currentUserId,
      role,
      authGeneration,
      mcpServerById,
    }),
    [
      client,
      sessionId,
      open,
      callerAuthorityReady,
      currentUserId,
      role,
      authGeneration,
      mcpServerById,
    ]
  );
  const [availability, setAvailability] = React.useState<{
    request: typeof availabilityRequest;
    servers: MCPServer[];
    error: 'forbidden' | 'unavailable' | null;
  } | null>(null);
  const availabilityCurrent =
    open && callerAuthorityReady && availability?.request === availabilityRequest;
  const availableServers = availabilityCurrent ? availability.servers : [];
  const serversError = availabilityCurrent ? availability.error : null;
  const loadingServers = open && callerAuthorityReady && !availabilityCurrent;
  React.useEffect(() => {
    if (!open || !client || !callerAuthorityReady) return;
    let active = true;
    void client
      .service(`sessions/${sessionId}/mcp-servers`)
      .find({ query: { available: true } })
      .then((result) => {
        if (active)
          setAvailability({
            request: availabilityRequest,
            servers: (Array.isArray(result) ? result : result.data) as MCPServer[],
            error: null,
          });
      })
      .catch((error: { code?: number }) => {
        if (active)
          setAvailability({
            request: availabilityRequest,
            servers: [],
            error: error.code === 403 ? 'forbidden' : 'unavailable',
          });
      });
    return () => {
      active = false;
    };
  }, [open, client, callerAuthorityReady, sessionId, availabilityRequest]);
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

  // The phone info bar scrolls horizontally, which clips an absolutely
  // positioned popup to nothing. On phones, anchor it to the viewport just
  // above the trigger instead.
  const isMobile = useIsMobileViewport();
  const [phoneBottom, setPhoneBottom] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const top = open && isMobile ? triggerRef.current?.getBoundingClientRect().top : undefined;
    setPhoneBottom(top === undefined ? null : window.innerHeight - top);
  }, [open, isMobile]);

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

  const handleBrowseCatalog = () => {
    setOpen(false);
    catalog?.openCatalog(triggerRef.current);
  };

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

  // The runtime's effective set (global servers included). Until it loads,
  // fall back to the session's own links.
  const effective = useSessionMcpEffectiveView(client, sessionId, callerAuthorityReady, [
    sessionMcpServerIds,
    userAuthenticatedMcpServerIds,
    mcpServerById,
    authGeneration,
  ]);
  const entryServer = React.useCallback(
    (entry: { mcp_server_id: string; server: MCPServer }) =>
      mcpServerById.get(entry.mcp_server_id) ?? entry.server,
    [mcpServerById]
  );
  const activeIds = React.useMemo(
    () =>
      effective.entries
        ? effective.entries
            .filter((entry) => entry.state === 'active')
            .map((entry) => entry.mcp_server_id)
        : sessionMcpServerIds,
    [effective.entries, sessionMcpServerIds]
  );
  const globalEntries = React.useMemo(
    () =>
      (effective.entries ?? []).filter(
        (entry) => entry.source === 'global' && entry.state !== 'hidden'
      ),
    [effective.entries]
  );
  const hiddenEntries = React.useMemo(
    () => (effective.entries ?? []).filter((entry) => entry.state === 'hidden'),
    [effective.entries]
  );
  const toConnectCount = globalEntries.filter((entry) => entry.state === 'needs_connect').length;

  const summary = React.useMemo(
    () => summarizeSessionMcpServers(activeIds, mcpServerById, userAuthenticatedMcpServerIds),
    [activeIds, mcpServerById, userAuthenticatedMcpServerIds]
  );

  const attachedServers = React.useMemo(
    () =>
      sessionMcpServerIds
        .map((id) => mcpServerById.get(id))
        .filter((server): server is MCPServer => Boolean(server)),
    [sessionMcpServerIds, mcpServerById]
  );
  // Session-specific links; global servers get their own rows below.
  const linkedServers = React.useMemo(
    () =>
      attachedServers.filter(
        (server) => !globalEntries.some((entry) => entry.mcp_server_id === server.mcp_server_id)
      ),
    [attachedServers, globalEntries]
  );

  const unauthedServers = React.useMemo(
    () =>
      activeIds
        .map((id) => mcpServerById.get(id))
        .filter((server): server is MCPServer => Boolean(server))
        .filter((server) => mcpServerNeedsAuth(server, userAuthenticatedMcpServerIds)),
    [activeIds, mcpServerById, userAuthenticatedMcpServerIds]
  );
  const connectSuffix = toConnectCount > 0 ? ` ${toConnectCount} more available to connect.` : '';
  const badgeTitle =
    (unauthedServers.length === 1
      ? `${unauthedServers[0].display_name || unauthedServers[0].name} isn’t connected. Open to connect.`
      : unauthedServers.length > 1
        ? `${unauthedServers.length} MCP servers aren’t connected. Open to connect.`
        : `${summary.tooltip}. Open to add or change MCP servers.`) + connectSuffix;
  const badgeAccessibleName = `MCP servers. ${badgeTitle}`;

  const handleChange = async (nextIds: string[]) => {
    const operation = operationGuard.begin();
    if (
      !client ||
      !operation.isCurrent() ||
      !linksLoaded ||
      !availabilityCurrent ||
      serversError ||
      saving
    )
      return;
    // Display-only selected metadata must never authorize a new attachment,
    // including a queued Select event racing an inventory/authority refresh.
    if (
      nextIds.some(
        (id) =>
          !sessionMcpServerIds.includes(id) &&
          !availableServers.some((server) => server.mcp_server_id === id && server.enabled)
      )
    )
      return;
    setSaving(true);
    try {
      await updateSessionMcpServers(client, sessionId, sessionMcpServerIds, nextIds);
      if (!operation.isCurrent()) return;
      showSuccess('Session MCP servers updated.');
    } catch (err) {
      if (!operation.isCurrent()) return;
      showError(formatActionError('update MCP servers', err, { idempotent: true }));
    } finally {
      if (operation.isCurrent()) setSaving(false);
    }
  };

  const [switching, setSwitching] = React.useState<string | null>(null);
  const [showHidden, setShowHidden] = React.useState(false);
  const runEntryAction = async (
    serverId: string,
    label: string,
    action: () => Promise<unknown>
  ) => {
    const operation = operationGuard.begin();
    if (!client || !operation.isCurrent() || switching) return;
    setSwitching(serverId);
    try {
      await action();
      if (!operation.isCurrent()) return;
      effective.refresh();
    } catch (err) {
      if (!operation.isCurrent()) return;
      showError(formatActionError(label, err, { idempotent: true }));
    } finally {
      if (operation.isCurrent()) setSwitching(null);
    }
  };
  const handleGlobalSwitch = (serverId: string, enabled: boolean) =>
    runEntryAction(serverId, enabled ? 'turn on MCP server' : 'turn off MCP server', () =>
      // A disabled link switches a global server off for this session only.
      client!.service(`sessions/${sessionId}/mcp-servers`).patch(serverId, { enabled })
    );
  const handleHide = (serverId: string, hidden: boolean) =>
    runEntryAction(serverId, hidden ? 'hide MCP server' : 'show MCP server', () =>
      currentUserId
        ? setMcpServerHidden(client!, currentUserId, serverId, hidden)
        : Promise.resolve()
    );
  const entryActionAllowed = oauthActionAllowed && !switching;

  const renderServerPill = (server: MCPServer, needsAuth: boolean) => (
    <MCPServerPill
      key={server.mcp_server_id}
      server={server}
      needsAuth={needsAuth}
      client={client}
      authorityKey={durableAuthorityKey}
      actionAllowed={oauthActionAllowed}
      actionBlockedReason={
        !connectionReady
          ? 'Reconnect to Agor before changing OAuth credentials.'
          : 'Your account can no longer change OAuth credentials.'
      }
      configureAllowed={editMutationAllowed}
      configureBlockedReason={
        !connectionReady
          ? 'Reconnect to Agor before changing saved credentials.'
          : 'Only an administrator can change saved credentials.'
      }
      onEdit={editMutationAllowed ? handleEditServer : undefined}
    />
  );

  const content = (
    <div style={{ width: 340, maxWidth: 'min(340px, 80vw)' }}>
      <Space orientation="vertical" size={10} style={{ width: '100%' }}>
        <div>
          <Flex align="center" justify="space-between">
            <Typography.Text id={headingId} strong>
              Session MCP servers
            </Typography.Text>
            {catalog && (
              <Button
                size="small"
                // The text names the button; keep the icon's "shop" label out of it.
                icon={<ShopOutlined aria-hidden />}
                onClick={handleBrowseCatalog}
              >
                Browse catalog
              </Button>
            )}
          </Flex>
          <Typography.Paragraph type="secondary" style={{ margin: `${token.sizeUnit}px 0 0` }}>
            Attach tools/connectors that the agent can use in this conversation.
          </Typography.Paragraph>
        </div>

        {linkedServers.length > 0 && (
          <Space size={6} wrap>
            {linkedServers.map((server) =>
              renderServerPill(server, mcpServerNeedsAuth(server, userAuthenticatedMcpServerIds))
            )}
          </Space>
        )}

        {globalEntries.length > 0 && (
          <Flex vertical gap={token.marginXXS} data-testid="session-mcp-global-servers">
            {globalEntries.map((entry) => {
              const server = entryServer(entry);
              const label = server.display_name || server.name;
              const toConnect = entry.state === 'needs_connect';
              return (
                <Flex
                  key={entry.mcp_server_id}
                  align="center"
                  justify="space-between"
                  gap={token.marginXS}
                  data-mcp-entry-state={entry.state}
                >
                  <Space
                    size={4}
                    style={{ minWidth: 0, opacity: entry.state === 'active' ? 1 : 0.55 }}
                  >
                    {renderServerPill(
                      server,
                      toConnect || mcpServerNeedsAuth(server, userAuthenticatedMcpServerIds)
                    )}
                    <AntTag bordered={false} style={{ marginInlineEnd: 0 }}>
                      Global
                    </AntTag>
                  </Space>
                  {toConnect ? (
                    <Tooltip title="Stop showing this server until you unhide it">
                      <Button
                        type="text"
                        size="small"
                        aria-label={`Hide ${label}`}
                        disabled={!entryActionAllowed || !currentUserId}
                        onClick={() => void handleHide(entry.mcp_server_id, true)}
                      >
                        Hide
                      </Button>
                    </Tooltip>
                  ) : (
                    <Switch
                      size="small"
                      checked={entry.state === 'active'}
                      loading={switching === entry.mcp_server_id}
                      disabled={!entryActionAllowed}
                      aria-label={`Use ${label} in this session`}
                      onChange={(checked) => void handleGlobalSwitch(entry.mcp_server_id, checked)}
                    />
                  )}
                </Flex>
              );
            })}
          </Flex>
        )}

        {hiddenEntries.length > 0 && (
          <div>
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              onClick={() => setShowHidden((v) => !v)}
            >
              {showHidden ? 'Hide hidden servers' : `Show hidden (${hiddenEntries.length})`}
            </Button>
            {showHidden &&
              hiddenEntries.map((entry) => {
                const server = entryServer(entry);
                const label = server.display_name || server.name;
                return (
                  <Flex key={entry.mcp_server_id} align="center" justify="space-between">
                    <Typography.Text type="secondary" ellipsis>
                      {label}
                    </Typography.Text>
                    <Button
                      type="text"
                      size="small"
                      aria-label={`Unhide ${label}`}
                      disabled={!entryActionAllowed || !currentUserId}
                      onClick={() => void handleHide(entry.mcp_server_id, false)}
                    >
                      Unhide
                    </Button>
                  </Flex>
                );
              })}
          </div>
        )}

        <MCPServerSelect
          onBrowseCatalog={catalog ? handleBrowseCatalog : undefined}
          mcpServers={availableServers}
          selectedServers={attachedServers}
          placeholder="Attach MCP servers…"
          value={sessionMcpServerIds}
          onChange={handleChange}
          loading={saving || loadingServers || (!linksLoaded && !sessionMcpLoadFailed)}
          disabled={!callerAuthorityReady || !linksLoaded || saving || !!serversError}
          style={{ width: '100%' }}
          getPopupContainer={(trigger) =>
            popupRef.current ?? trigger.parentElement ?? document.body
          }
        />
        {!linksLoaded && sessionMcpLoadFailed && (
          <Space>
            <Typography.Text type="danger">MCP servers unavailable</Typography.Text>
            <Button size="small" onClick={onSessionMcpRetry} disabled={!callerAuthorityReady}>
              Retry
            </Button>
          </Space>
        )}
        {serversError && (
          <Typography.Text type="danger">
            {serversError === 'forbidden'
              ? 'Only the session owner or an administrator can change attached MCP servers.'
              : 'Could not load available servers. Close and reopen to retry.'}
          </Typography.Text>
        )}
        {catalog && (
          <Typography.Text type="secondary">
            Catalog Connect adds a server to My Servers. Select it above to attach it here.
          </Typography.Text>
        )}
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
          {toConnectCount > 0 && (
            <span style={{ marginInlineStart: token.marginXXS, color: token.colorTextSecondary }}>
              {isMobile ? `+${toConnectCount}` : `· ${toConnectCount} to connect`}
            </span>
          )}
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
            ...(isMobile && phoneBottom !== null
              ? {
                  position: 'fixed',
                  bottom: phoneBottom + token.sizeXS,
                  left: token.paddingXS,
                  right: token.paddingXS,
                  // The info bar is nowrap; let the panel's copy wrap.
                  whiteSpace: 'normal',
                }
              : { position: 'absolute', bottom: `calc(100% + ${token.sizeXS}px)`, left: 0 }),
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
              ? 'Reconnect to Agor before changing this MCP server.'
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
    key={`${props.currentUserId ?? '__no-authenticated-user__'}:${props.sessionId}`}
    {...props}
  />
);
