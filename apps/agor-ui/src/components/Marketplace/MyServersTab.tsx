import type { MCPMarketplaceOverview, MCPMarketplaceServer } from '@agor/core/types';
import type { AgorClient, MCPServer, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { SettingOutlined } from '@ant-design/icons';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Empty,
  Flex,
  message,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { useMcpMemberPolicy } from '../../hooks/useMcpMemberPolicy';
import { MCPServerEditModal } from '../MCPServer/MCPServerEditModal';
import {
  canDeleteMcpServer,
  canEditMcpServer,
  canRefreshMcpServer,
  explainManageRestriction,
  policyPendingState,
} from '../MCPServer/memberPolicy';
import { useMCPServerOAuthStart } from '../MCPServer/useMCPServerOAuthStart';
import { MARKETPLACE_DRAWER_FOCUS_FALLBACK_MS } from './marketplaceLayout';
import {
  formatMarketplaceDate,
  marketplaceCredentialPresentation,
  marketplaceServerTitle,
} from './marketplacePresentation';
import { ServerSettingsDrawer } from './ServerSettingsDrawer';

const { Text } = Typography;

export interface MyServersTabProps {
  client: AgorClient | null;
  connected: boolean;
  connecting: boolean;
  authGeneration: number;
  currentUser?: User | null;
  overview: MCPMarketplaceOverview;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<unknown>;
  onBrowseCatalog?: () => void;
  requestedServerId?: string | null;
  onRequestedServerOpened?: () => void;
}

export const MyServersTab: React.FC<MyServersTabProps> = ({
  client,
  connected,
  connecting,
  authGeneration,
  currentUser,
  overview,
  loading,
  error,
  refresh,
  onBrowseCatalog,
  requestedServerId,
  onRequestedServerOpened,
}) => {
  const { token } = theme.useToken();
  const connectionReady = connected && !connecting;
  const memberPolicy = useMcpMemberPolicy(client, {
    connectionReady,
    currentUser,
    authGeneration,
  });
  const capability = useMemo(
    () => ({
      role: currentUser?.role,
      isAdmin: hasMinimumRole(currentUser?.role, ROLES.ADMIN),
      connectionReady,
      policy: memberPolicy.policy,
      userId: currentUser?.user_id,
      canConfigure: memberPolicy.canConfigure,
    }),
    [connectionReady, currentUser, memberPolicy.canConfigure, memberPolicy.policy]
  );
  const policyState = policyPendingState(memberPolicy);
  const authorityFor = useCallback(
    (server: MCPMarketplaceServer) => ({
      owner_user_id: currentUser?.user_id,
      transport: server.transport,
    }),
    [currentUser?.user_id]
  );
  const hasAnyAction =
    !policyState.pending &&
    overview.servers.some((server) => {
      const authority = authorityFor(server);
      return (
        canRefreshMcpServer(authority, capability) ||
        canEditMcpServer(authority, capability) ||
        canDeleteMcpServer(authority, capability)
      );
    });
  const mutationAuthorityKey = useMemo(
    () =>
      hasAnyAction && client && currentUser
        ? [
            currentUser.user_id,
            currentUser.role,
            authGeneration,
            client,
            memberPolicy.policy,
            memberPolicy.canConfigure,
          ]
        : null,
    [
      authGeneration,
      client,
      currentUser,
      hasAnyAction,
      memberPolicy.canConfigure,
      memberPolicy.policy,
    ]
  );
  const guard = useAuthorityOperationGuard(mutationAuthorityKey);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [editingCredentialServer, setEditingCredentialServer] = useState<MCPServer | null>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const drawerOpen = useRef(false);

  useLayoutEffect(() => {
    // Pending visual state belongs to this exact authority epoch. Clear it
    // before paint so a newly-ready authority cannot race this reset.
    if (mutationAuthorityKey === null) {
      setBusy(new Set());
      return;
    }
    setBusy(new Set());
  }, [mutationAuthorityKey]);

  const selectedServer = useMemo(
    () => overview.servers.find((server) => server.mcp_server_id === selectedServerId) ?? null,
    [overview.servers, selectedServerId]
  );
  const credentials = useMemo(
    () => new Map(overview.credentials.map((item) => [item.mcp_server_id, item])),
    [overview.credentials]
  );
  const cursorServerIds = useMemo(
    () =>
      new Set(
        overview.attachments
          .filter((attachment) => attachment.agentic_tool === 'cursor')
          .map((attachment) => attachment.mcp_server_id)
      ),
    [overview.attachments]
  );

  const selectedAuthority = selectedServer ? authorityFor(selectedServer) : null;
  const canRefresh = Boolean(
    selectedAuthority && !policyState.pending && canRefreshMcpServer(selectedAuthority, capability)
  );
  const canChangeTools = Boolean(
    selectedAuthority && !policyState.pending && canEditMcpServer(selectedAuthority, capability)
  );
  const canRemove = Boolean(
    selectedAuthority && !policyState.pending && canDeleteMcpServer(selectedAuthority, capability)
  );
  const canReconnect = Boolean(
    connectionReady && currentUser && hasMinimumRole(currentUser.role, ROLES.MEMBER)
  );
  const selectedCredential = selectedServer
    ? credentials.get(selectedServer.mcp_server_id)
    : undefined;
  const selectedStatus = marketplaceCredentialPresentation(
    selectedCredential,
    selectedServer?.enabled
  );
  const selectedAttachments = selectedServer
    ? overview.attachments.filter(
        (attachment) => attachment.mcp_server_id === selectedServer.mcp_server_id
      )
    : [];

  const oauth = useMCPServerOAuthStart({
    client,
    authorityKey:
      connectionReady && currentUser
        ? `${currentUser.user_id}:${currentUser.role}:${authGeneration}`
        : null,
    startAllowed: canReconnect,
    onPrepareOAuthStart: async () => selectedServer?.mcp_server_id ?? null,
    onOAuthSucceeded: () => void refresh(),
    showError: (value) => message.error(value),
    showInfo: (value) => message.info(value),
    showSuccess: (value) => message.success(value),
  });

  useEffect(() => {
    if (!requestedServerId) return;
    const requested = overview.servers.find((server) => server.mcp_server_id === requestedServerId);
    if (!requested) return;
    drawerOpen.current = true;
    drawerTrigger.current =
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-marketplace-settings-server-id]')
      ).find((element) => element.dataset.marketplaceSettingsServerId === requestedServerId) ??
      document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    setSelectedServerId(requestedServerId);
    onRequestedServerOpened?.();
  }, [onRequestedServerOpened, overview.servers, requestedServerId]);

  const mutate = async (
    key: string,
    allowed: boolean,
    work: () => Promise<unknown>,
    success: string
  ) => {
    const operation = guard.begin();
    if (!client || !allowed || !operation.isCurrent()) return;
    setBusy((current) => new Set(current).add(key));
    try {
      await work();
      if (!operation.isCurrent()) return;
      message.success(success);
      await refresh();
    } catch (cause) {
      if (operation.isCurrent())
        message.error(cause instanceof Error ? cause.message : 'Action failed');
    } finally {
      if (operation.isCurrent())
        setBusy((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
    }
  };

  const refreshTools = (server: MCPMarketplaceServer, allowed: boolean) =>
    mutate(
      `discover:${server.mcp_server_id}`,
      allowed,
      async () => {
        const result = (await client!.service('mcp-servers/discover').create({
          mcp_server_id: server.mcp_server_id,
        })) as { success?: boolean; error?: string };
        if (result?.success !== true) throw new Error(result?.error || 'Tool refresh failed');
      },
      'Tools refreshed'
    );

  const openServer = (server: MCPMarketplaceServer) => {
    drawerOpen.current = true;
    drawerTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedServerId(server.mcp_server_id);
  };

  const restoreDrawerFocus = useCallback((trigger: HTMLElement | null) => {
    if (drawerOpen.current || !trigger?.isConnected || drawerTrigger.current !== trigger) return;
    trigger.focus();
  }, []);

  const closeDrawer = useCallback(() => {
    drawerOpen.current = false;
    const trigger = drawerTrigger.current;
    setSelectedServerId(null);
    window.setTimeout(() => restoreDrawerFocus(trigger), MARKETPLACE_DRAWER_FOCUS_FALLBACK_MS);
  }, [restoreDrawerFocus]);

  const openCredentialEditor = async (server: MCPMarketplaceServer) => {
    const operation = guard.begin();
    if (!client || !canChangeTools || !operation.isCurrent()) return;
    const key = `credential:${server.mcp_server_id}`;
    setBusy((current) => new Set(current).add(key));
    try {
      const fullServer = await client.service('mcp-servers').get(server.mcp_server_id);
      if (operation.isCurrent()) setEditingCredentialServer(fullServer);
    } catch (cause) {
      if (operation.isCurrent()) {
        message.error(
          cause instanceof Error ? cause.message : 'Could not open credential settings'
        );
      }
    } finally {
      if (operation.isCurrent()) {
        setBusy((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  };

  if (error && overview.servers.length === 0)
    return (
      <Alert
        type="error"
        showIcon
        title="Could not load your servers"
        description={error}
        action={<Button onClick={() => void refresh()}>Retry</Button>}
      />
    );
  if (!loading && overview.servers.length === 0)
    return (
      <Empty description="No MCP servers installed">
        {onBrowseCatalog && (
          <Button type="primary" onClick={onBrowseCatalog}>
            Browse catalog
          </Button>
        )}
      </Empty>
    );

  return (
    <Flex vertical gap={token.margin}>
      {error && (
        <Alert
          type="error"
          showIcon
          title="Some server data may be out of date"
          description={error}
          action={<Button onClick={() => void refresh()}>Retry</Button>}
        />
      )}
      {(policyState.pending || !capability.canConfigure) && (
        <Alert
          type="warning"
          showIcon
          title={policyState.pending ? policyState.hint : explainManageRestriction(capability)}
        />
      )}
      <Table<MCPMarketplaceServer>
        aria-label="Installed MCP servers"
        scroll={{ x: 760 }}
        loading={loading}
        rowKey="mcp_server_id"
        dataSource={overview.servers}
        pagination={false}
        columns={[
          {
            title: 'Server',
            render: (_, server) => (
              <Flex gap={token.marginSM} align="center" style={{ minWidth: 220 }}>
                <Avatar shape="square">
                  {marketplaceServerTitle(server).charAt(0).toUpperCase()}
                </Avatar>
                <Flex vertical style={{ minWidth: 0 }}>
                  <Text strong ellipsis={{ tooltip: marketplaceServerTitle(server) }}>
                    {marketplaceServerTitle(server)}
                  </Text>
                  <Space size={token.marginXXS} wrap>
                    <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                      {server.source === 'catalog' ? 'Catalog' : 'Manual'}
                    </Text>
                    {!server.enabled && <Tag color="default">Disabled</Tag>}
                  </Space>
                </Flex>
              </Flex>
            ),
          },
          {
            title: 'Authentication',
            render: (_, server) => {
              const status = marketplaceCredentialPresentation(
                credentials.get(server.mcp_server_id),
                server.enabled
              );
              return (
                <Tooltip title={status.detail}>
                  <Badge status={status.badge} text={status.label} />
                </Tooltip>
              );
            },
          },
          {
            title: 'Tools',
            render: (_, server) => {
              const enabled = server.tools.filter((tool) => tool.permission !== 'deny').length;
              return server.tools.length ? `${enabled} of ${server.tools.length} enabled` : 'None';
            },
          },
          {
            title: 'Sessions attached',
            render: (_, server) => server.session_count,
          },
          {
            title: 'Updated',
            render: (_, server) => formatMarketplaceDate(server.updated_at),
          },
          {
            title: '',
            align: 'end',
            render: (_, server) => (
              <Button
                data-marketplace-settings-server-id={server.mcp_server_id}
                aria-label={`Settings for ${marketplaceServerTitle(server)}`}
                title={`Settings for ${marketplaceServerTitle(server)}`}
                icon={<SettingOutlined />}
                onClick={() => openServer(server)}
              >
                Settings
              </Button>
            ),
          },
        ]}
      />

      <ServerSettingsDrawer
        server={selectedServer}
        credential={selectedCredential}
        connection={{ ...selectedStatus, status: selectedStatus.badge }}
        attachments={selectedAttachments}
        cursorAttached={Boolean(
          selectedServer && cursorServerIds.has(selectedServer.mcp_server_id)
        )}
        canRefresh={canRefresh}
        canChangeTools={canChangeTools}
        canReconnect={canReconnect}
        canRemove={canRemove}
        busy={busy}
        onClose={closeDrawer}
        onAfterOpenChange={(open) => {
          if (open || drawerOpen.current) return;
          restoreDrawerFocus(drawerTrigger.current);
        }}
        reconnectingOAuth={oauth.startingOAuthFlow}
        onReconnectOAuth={
          selectedCredential?.method === 'oauth'
            ? () => void oauth.handleStartOAuthFlow()
            : undefined
        }
        editingCredential={Boolean(
          selectedServer && busy.has(`credential:${selectedServer.mcp_server_id}`)
        )}
        onEditCredential={
          selectedCredential && selectedCredential.method !== 'oauth' && selectedServer
            ? () => void openCredentialEditor(selectedServer)
            : undefined
        }
        onRefreshTools={(server) => void refreshTools(server, canRefresh)}
        onToggleTool={(server, tool, checked) =>
          void mutate(
            `tool:${server.mcp_server_id}:${tool.name}`,
            canChangeTools,
            () =>
              client!.service('mcp-marketplace/tool-permission').create({
                mcp_server_id: server.mcp_server_id,
                tool_name: tool.name,
                enabled: checked,
              }),
            checked ? `${tool.name} uses the default` : `${tool.name} is off`
          )
        }
        onRemove={(server) =>
          void mutate(
            `remove:${server.mcp_server_id}`,
            canRemove,
            () =>
              client!.service('mcp-marketplace/remove-unattached').create({
                mcp_server_id: server.mcp_server_id,
              }),
            'Server removed'
          )
        }
      />
      <MCPServerEditModal
        server={editingCredentialServer}
        open={editingCredentialServer !== null}
        client={client}
        identityKey={currentUser?.user_id ?? null}
        authGeneration={authGeneration}
        authorityKey={
          mutationAuthorityKey && currentUser
            ? `${currentUser.user_id}:${currentUser.role}:${authGeneration}`
            : null
        }
        mutationAllowed={canChangeTools}
        mutationBlockedReason="You can no longer change this MCP server credential."
        onClose={() => {
          setEditingCredentialServer(null);
          void refresh();
        }}
      />
    </Flex>
  );
};
