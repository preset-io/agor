import type {
  MCPMarketplaceOverview,
  MCPMarketplaceServer,
  MCPMarketplaceTool,
  MCPMarketplaceToolPermissionResult,
} from '@agor/core/types';
import type { AgorClient, MCPServer, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { SettingOutlined } from '@ant-design/icons';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Empty,
  Flex,
  Grid,
  message,
  Space,
  Spin,
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
import {
  MARKETPLACE_ACTION_COLUMN_WIDTH,
  MARKETPLACE_DRAWER_FOCUS_FALLBACK_MS,
  MARKETPLACE_TOOL_DISCOVERY_STALE_MS,
} from './marketplaceLayout';
import {
  formatMarketplaceDate,
  marketplaceCredentialPresentation,
  marketplaceServerTitle,
} from './marketplacePresentation';
import { ServerSettingsDrawer } from './ServerSettingsDrawer';

const { Text } = Typography;

type LocalToolDiscovery = {
  baseline: string | undefined;
  tools: MCPMarketplaceTool[];
};

type RemovalFocusAuthority = {
  userId: string;
  authGeneration: number;
  serverId: string;
  fallbackTimer: number | null;
};

function toolMutationKey(serverId: string, toolName: string): string {
  return JSON.stringify([serverId, toolName]);
}

function toolBusyKey(serverId: string, toolName: string): string {
  return `tool:${serverId}:${toolName}`;
}

function hasServerToolWork(busy: ReadonlySet<string>, serverId: string): boolean {
  return (
    busy.has(`discover:${serverId}`) ||
    Array.from(busy).some((key) => key.startsWith(`tool:${serverId}:`))
  );
}

function toolsNeedDiscovery(server: MCPMarketplaceServer, now = Date.now()): boolean {
  if (!server.capabilities_discovered_at) return true;
  const discoveredAt = Date.parse(server.capabilities_discovered_at);
  return Number.isNaN(discoveredAt) || now - discoveredAt >= MARKETPLACE_TOOL_DISCOVERY_STALE_MS;
}

function uniqueTools(tools: readonly MCPMarketplaceTool[]): MCPMarketplaceTool[] {
  const names = new Set<string>();
  return tools.filter((tool) => {
    if (names.has(tool.name)) return false;
    names.add(tool.name);
    return true;
  });
}

export interface MyServersTabProps {
  /** Whether this tab is the active route; inactive drawers must not portal over another tab. */
  active?: boolean;
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
  active = true,
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
  const screens = Grid.useBreakpoint();
  const compact = screens.xs === true && screens.md !== true;
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
  const busyRef = useRef<ReadonlySet<string>>(busy);
  busyRef.current = busy;
  const [toolOverrides, setToolOverrides] = useState<
    ReadonlyMap<string, MCPMarketplaceTool['permission']>
  >(() => new Map());
  const [localDiscoveries, setLocalDiscoveries] = useState<ReadonlyMap<string, LocalToolDiscovery>>(
    () => new Map()
  );
  const [discoveryErrors, setDiscoveryErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  const autoDiscoveryAttempts = useRef(new Set<string>());
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [editingCredentialServer, setEditingCredentialServer] = useState<MCPServer | null>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const drawerOpen = useRef(false);
  const inventoryFocusTarget = useRef<HTMLElement | null>(null);
  const removalFocusAuthority = useRef<RemovalFocusAuthority | null>(null);

  const clearRemovalFocusAuthority = useCallback(() => {
    const authority = removalFocusAuthority.current;
    if (authority?.fallbackTimer != null) window.clearTimeout(authority.fallbackTimer);
    removalFocusAuthority.current = null;
  }, []);

  const settleRemovalFocus = useCallback((authority: RemovalFocusAuthority) => {
    if (removalFocusAuthority.current !== authority) return;
    if (authority.fallbackTimer !== null) window.clearTimeout(authority.fallbackTimer);
    removalFocusAuthority.current = null;
    if (drawerOpen.current) return;
    inventoryFocusTarget.current?.focus();
  }, []);

  useEffect(() => () => clearRemovalFocusAuthority(), [clearRemovalFocusAuthority]);

  useEffect(() => {
    if (active) return;
    clearRemovalFocusAuthority();
    drawerOpen.current = false;
    drawerTrigger.current = null;
    setSelectedServerId(null);
    setEditingCredentialServer(null);
    setDiscoveryErrors(new Map());
  }, [active, clearRemovalFocusAuthority]);

  useLayoutEffect(() => {
    // The value is an authority generation key; any identity/capability change
    // invalidates mutation-local state regardless of the new key's contents.
    // Clear it before paint so newly-ready authority cannot race the reset.
    void mutationAuthorityKey;
    setBusy(new Set());
    setToolOverrides(new Map());
    setLocalDiscoveries(new Map());
    setDiscoveryErrors(new Map());
    autoDiscoveryAttempts.current.clear();
  }, [mutationAuthorityKey]);

  const visibleServers = useMemo(
    () =>
      overview.servers.map((server) => {
        const local = localDiscoveries.get(server.mcp_server_id);
        const serverTools = uniqueTools(server.tools);
        const basePermissions = new Map(serverTools.map((tool) => [tool.name, tool.permission]));
        const sourceTools = local?.tools ?? serverTools;
        const uniqueSourceTools = uniqueTools(sourceTools);
        let changed = Boolean(local) || serverTools.length !== server.tools.length;
        const tools = uniqueSourceTools.map((tool) => {
          const permission =
            toolOverrides.get(toolMutationKey(server.mcp_server_id, tool.name)) ??
            basePermissions.get(tool.name) ??
            tool.permission;
          if (permission !== tool.permission) changed = true;
          return permission === tool.permission ? tool : { ...tool, permission };
        });
        return changed ? { ...server, tools } : server;
      }),
    [localDiscoveries, overview.servers, toolOverrides]
  );

  const selectedServer = useMemo(
    () => visibleServers.find((server) => server.mcp_server_id === selectedServerId) ?? null,
    [selectedServerId, visibleServers]
  );
  const credentials = useMemo(
    () => new Map(overview.credentials.map((item) => [item.mcp_server_id, item])),
    [overview.credentials]
  );

  // A realtime freshness read can land before or after the action reply. Keep
  // the local result until the closed overview projection agrees, then discard
  // it without changing drawer identity or focus.
  useEffect(() => {
    setToolOverrides((current) => {
      let next: Map<string, MCPMarketplaceTool['permission']> | null = null;
      for (const server of overview.servers) {
        for (const tool of server.tools) {
          const key = toolMutationKey(server.mcp_server_id, tool.name);
          if (busyRef.current.has(toolBusyKey(server.mcp_server_id, tool.name))) continue;
          if (current.get(key) !== tool.permission) continue;
          next ??= new Map(current);
          next.delete(key);
        }
      }
      return next ?? current;
    });
    setLocalDiscoveries((current) => {
      let next: Map<string, LocalToolDiscovery> | null = null;
      for (const server of overview.servers) {
        const local = current.get(server.mcp_server_id);
        if (hasServerToolWork(busyRef.current, server.mcp_server_id)) continue;
        if (!local || server.capabilities_discovered_at === local.baseline) continue;
        next ??= new Map(current);
        next.delete(server.mcp_server_id);
      }
      return next ?? current;
    });
  }, [overview.servers]);
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
    success: string,
    beforeRefresh?: () => void
  ) => {
    const operation = guard.begin();
    if (!client || !allowed || !operation.isCurrent()) return false;
    setBusy((current) => new Set(current).add(key));
    try {
      await work();
      if (!operation.isCurrent()) return false;
      message.success(success);
      beforeRefresh?.();
      await refresh();
      return operation.isCurrent();
    } catch (cause) {
      if (operation.isCurrent())
        message.error(cause instanceof Error ? cause.message : 'Action failed');
      return false;
    } finally {
      if (operation.isCurrent())
        setBusy((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
    }
  };

  const discoverTools = useCallback(
    async (server: MCPMarketplaceServer, allowed: boolean, manual: boolean) => {
      const key = `discover:${server.mcp_server_id}`;
      if (!client || !allowed) return;
      if (hasServerToolWork(busyRef.current, server.mcp_server_id)) {
        if (manual) {
          message.info(
            busyRef.current.has(key)
              ? 'Tool discovery is already in progress'
              : 'Wait for the current tool change to finish before refreshing tools'
          );
        }
        return;
      }
      const operation = guard.begin();
      if (!operation.isCurrent()) return;
      const nextBusy = new Set(busyRef.current).add(key);
      busyRef.current = nextBusy;
      setBusy(nextBusy);
      setDiscoveryErrors((current) => {
        if (!current.has(server.mcp_server_id)) return current;
        const next = new Map(current);
        next.delete(server.mcp_server_id);
        return next;
      });
      try {
        const result = (await client.service('mcp-servers/discover').create({
          mcp_server_id: server.mcp_server_id,
        })) as {
          success?: boolean;
          error?: string;
          tools?: Array<{ name?: unknown; description?: unknown }>;
        };
        if (result?.success !== true) throw new Error(result?.error || 'Tool discovery failed');
        if (!operation.isCurrent()) return;
        const currentPermissions = new Map(
          uniqueTools(server.tools).map((tool) => [tool.name, tool.permission])
        );
        const tools = uniqueTools(
          (result.tools ?? [])
            .filter(
              (tool): tool is { name: string; description?: unknown } =>
                typeof tool?.name === 'string' && tool.name.length > 0
            )
            .map((tool) => ({
              name: tool.name,
              description: typeof tool.description === 'string' ? tool.description : '',
              permission: currentPermissions.get(tool.name) ?? 'default',
            }))
        );
        setLocalDiscoveries((current) =>
          new Map(current).set(server.mcp_server_id, {
            baseline: server.capabilities_discovered_at,
            tools,
          })
        );
        if (manual) message.success('Tools refreshed');
      } catch (cause) {
        if (!operation.isCurrent()) return;
        const error = cause instanceof Error ? cause.message : 'Tool discovery failed';
        setDiscoveryErrors((current) => new Map(current).set(server.mcp_server_id, error));
        if (manual) message.error(error);
      } finally {
        if (operation.isCurrent()) {
          const next = new Set(busyRef.current);
          next.delete(key);
          busyRef.current = next;
          setBusy(next);
        }
      }
    },
    [client, guard]
  );

  const toggleTool = useCallback(
    async (
      server: MCPMarketplaceServer,
      tool: MCPMarketplaceServer['tools'][number],
      checked: boolean,
      allowed: boolean
    ) => {
      const busyKey = toolBusyKey(server.mcp_server_id, tool.name);
      const overrideKey = toolMutationKey(server.mcp_server_id, tool.name);
      if (!client || !allowed) return;
      if (busyRef.current.has(`discover:${server.mcp_server_id}`)) {
        message.info('Wait for tool discovery to finish before changing a tool');
        return;
      }
      if (
        Array.from(busyRef.current).some((key) => key.startsWith(`tool:${server.mcp_server_id}:`))
      ) {
        message.info('Wait for the current tool change to finish before changing another tool');
        return;
      }
      const operation = guard.begin();
      if (!operation.isCurrent()) return;

      const optimisticPermission: MCPMarketplaceTool['permission'] = checked ? 'default' : 'deny';
      setToolOverrides((current) => new Map(current).set(overrideKey, optimisticPermission));
      const nextBusy = new Set(busyRef.current).add(busyKey);
      busyRef.current = nextBusy;
      setBusy(nextBusy);
      try {
        const result = (await client.service('mcp-marketplace/tool-permission').create({
          mcp_server_id: server.mcp_server_id,
          tool_name: tool.name,
          enabled: checked,
        })) as MCPMarketplaceToolPermissionResult;
        if (
          !operation.isCurrent() ||
          result.mcp_server_id !== server.mcp_server_id ||
          result.tool_name !== tool.name ||
          (result.permission !== 'default' && result.permission !== 'deny')
        ) {
          if (operation.isCurrent()) throw new Error('Tool permission response was invalid');
          return;
        }
        setToolOverrides((current) => new Map(current).set(overrideKey, result.permission));
        message.success(
          result.permission === 'deny' ? `${tool.name} is off` : `${tool.name} uses the default`
        );
        // The daemon emits one caller-targeted `marketplace:changed` hint for
        // cross-device convergence. Do not issue a second overview request
        // here or replace the stable drawer with a page-level loading cycle.
      } catch (cause) {
        if (!operation.isCurrent()) return;
        setToolOverrides((current) => {
          const next = new Map(current);
          next.delete(overrideKey);
          return next;
        });
        message.error(cause instanceof Error ? cause.message : 'Could not change tool permission');
      } finally {
        if (operation.isCurrent()) {
          const next = new Set(busyRef.current);
          next.delete(busyKey);
          busyRef.current = next;
          setBusy(next);
        }
      }
    },
    [client, guard]
  );

  const selectedCredentialSignature = selectedCredential
    ? [
        selectedCredential.status,
        selectedCredential.updated_at ?? '',
        selectedCredential.expires_at ?? '',
      ].join(':')
    : 'no-account';
  const autoDiscoveryKey = selectedServer
    ? [
        selectedServer.mcp_server_id,
        selectedServer.capabilities_discovered_at ?? 'never',
        selectedCredentialSignature,
      ].join(':')
    : null;
  const selectedCredentialReady = Boolean(
    selectedServer &&
      (!selectedCredential ||
        selectedCredential.status === 'active' ||
        selectedCredential.status === 'configured')
  );
  const selectedToolWorkActive = Boolean(
    selectedServer && hasServerToolWork(busy, selectedServer.mcp_server_id)
  );

  useEffect(() => {
    if (
      !selectedServer?.enabled ||
      !selectedCredentialReady ||
      !canRefresh ||
      !toolsNeedDiscovery(selectedServer) ||
      selectedToolWorkActive ||
      !autoDiscoveryKey ||
      autoDiscoveryAttempts.current.has(autoDiscoveryKey)
    ) {
      return;
    }
    autoDiscoveryAttempts.current.add(autoDiscoveryKey);
    void discoverTools(selectedServer, true, false);
  }, [
    autoDiscoveryKey,
    canRefresh,
    discoverTools,
    selectedCredentialReady,
    selectedServer,
    selectedToolWorkActive,
  ]);

  const openServer = (server: MCPMarketplaceServer) => {
    drawerOpen.current = true;
    drawerTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedServerId(server.mcp_server_id);
  };

  const restoreDrawerFocus = useCallback((trigger: HTMLElement | null, settled = true) => {
    if (drawerOpen.current || !trigger?.isConnected || drawerTrigger.current !== trigger) return;
    trigger.focus();
    if (settled) drawerTrigger.current = null;
  }, []);

  useEffect(() => {
    const authority = removalFocusAuthority.current;
    if (!authority) return;
    if (authority.userId !== currentUser?.user_id || authority.authGeneration !== authGeneration) {
      clearRemovalFocusAuthority();
      return;
    }
    if (overview.servers.some((server) => server.mcp_server_id === authority.serverId)) return;
    const timer = window.setTimeout(() => {
      settleRemovalFocus(authority);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    authGeneration,
    clearRemovalFocusAuthority,
    currentUser?.user_id,
    overview.servers,
    settleRemovalFocus,
  ]);

  const closeDrawer = useCallback(() => {
    drawerOpen.current = false;
    const trigger = drawerTrigger.current;
    const closingServerId = selectedServerId;
    setSelectedServerId(null);
    if (closingServerId) {
      setDiscoveryErrors((current) => {
        if (!current.has(closingServerId)) return current;
        const next = new Map(current);
        next.delete(closingServerId);
        return next;
      });
    }
    // Keep the trigger through the drawer's close lifecycle: rc-drawer restores
    // the element focused when it opened, which can be a hidden Credentials
    // action during a cross-tab handoff. The lifecycle callback below performs
    // the final, authoritative restoration after that built-in behavior.
    window.setTimeout(
      () => restoreDrawerFocus(trigger, false),
      MARKETPLACE_DRAWER_FOCUS_FALLBACK_MS
    );
  }, [restoreDrawerFocus, selectedServerId]);

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

  const disconnectOAuth = async (server: MCPMarketplaceServer) => {
    const key = `disconnect:${server.mcp_server_id}`;
    if (!client || !canChangeTools || busyRef.current.size > 0) return;
    const operation = guard.begin();
    if (!operation.isCurrent()) return;
    const nextBusy = new Set(busyRef.current).add(key);
    busyRef.current = nextBusy;
    setBusy(nextBusy);
    try {
      const result = (await client.service('mcp-servers/oauth-disconnect').create({
        mcp_server_id: server.mcp_server_id,
      })) as { success?: boolean; message?: string; error?: string };
      if (!operation.isCurrent()) return;
      if (result.success !== true) throw new Error(result.error || 'OAuth disconnect failed');
      message.success(result.message || 'OAuth connection removed');
      await refresh();
    } catch (cause) {
      if (operation.isCurrent())
        message.error(cause instanceof Error ? cause.message : 'OAuth disconnect failed');
    } finally {
      if (operation.isCurrent()) {
        const next = new Set(busyRef.current);
        next.delete(key);
        busyRef.current = next;
        setBusy(next);
      }
    }
  };

  const renderServerIdentity = (server: MCPMarketplaceServer) => (
    <Flex gap={token.marginSM} align="center" style={{ minWidth: 0 }}>
      <Avatar shape="square">{marketplaceServerTitle(server).charAt(0).toUpperCase()}</Avatar>
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
  );

  const renderSettingsAction = (server: MCPMarketplaceServer, block = false) => (
    <Button
      block={block}
      data-marketplace-settings-server-id={server.mcp_server_id}
      aria-label={`Settings for ${marketplaceServerTitle(server)}`}
      title={`Settings for ${marketplaceServerTitle(server)}`}
      icon={<SettingOutlined />}
      onClick={() => openServer(server)}
    >
      Settings
    </Button>
  );

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
      <section ref={inventoryFocusTarget} tabIndex={-1} aria-label="Installed MCP server inventory">
        <Empty description="No MCP servers installed">
          {onBrowseCatalog && (
            <Button type="primary" onClick={onBrowseCatalog}>
              Browse catalog
            </Button>
          )}
        </Empty>
      </section>
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
      <section ref={inventoryFocusTarget} tabIndex={-1} aria-label="Installed MCP server inventory">
        {compact ? (
          <Spin spinning={loading}>
            <ul
              aria-label="Installed MCP servers"
              aria-busy={loading}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: token.marginSM,
                listStyle: 'none',
                margin: 0,
                padding: 0,
              }}
            >
              {visibleServers.map((server) => {
                const status = marketplaceCredentialPresentation(
                  credentials.get(server.mcp_server_id),
                  server.enabled
                );
                const enabledTools = server.tools.filter(
                  (tool) => tool.permission !== 'deny'
                ).length;
                return (
                  <li key={server.mcp_server_id}>
                    <Card size="small" style={{ width: '100%' }}>
                      <Flex vertical gap={token.marginSM}>
                        {renderServerIdentity(server)}
                        <Tooltip title={status.detail}>
                          <Badge status={status.badge} text={status.label} />
                        </Tooltip>
                        <Flex justify="space-between" gap={token.marginSM} wrap>
                          <Text type="secondary">Tools</Text>
                          <Text>
                            {server.tools.length
                              ? `${enabledTools} of ${server.tools.length} enabled`
                              : 'None'}
                          </Text>
                        </Flex>
                        <Flex justify="space-between" gap={token.marginSM} wrap>
                          <Text type="secondary">Sessions attached</Text>
                          <Text>{server.session_count}</Text>
                        </Flex>
                        {renderSettingsAction(server, true)}
                      </Flex>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </Spin>
        ) : (
          <Table<MCPMarketplaceServer>
            aria-label="Installed MCP servers"
            loading={loading}
            rowKey="mcp_server_id"
            dataSource={visibleServers}
            pagination={false}
            columns={[
              {
                title: 'Server',
                render: (_, server) => renderServerIdentity(server),
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
                  return server.tools.length
                    ? `${enabled} of ${server.tools.length} enabled`
                    : 'None';
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
                fixed: 'right',
                width: MARKETPLACE_ACTION_COLUMN_WIDTH,
                render: (_, server) => renderSettingsAction(server),
              },
            ]}
          />
        )}
      </section>

      <ServerSettingsDrawer
        server={selectedServer}
        credential={selectedCredential}
        connection={selectedStatus}
        attachments={selectedAttachments}
        cursorAttached={Boolean(
          selectedServer && cursorServerIds.has(selectedServer.mcp_server_id)
        )}
        canRefresh={canRefresh}
        canChangeTools={canChangeTools}
        canReconnect={canReconnect}
        canRemove={canRemove}
        busy={busy}
        toolDiscoveryError={
          selectedServer ? discoveryErrors.get(selectedServer.mcp_server_id) : undefined
        }
        onClose={closeDrawer}
        onAfterOpenChange={(open) => {
          if (open || drawerOpen.current) return;
          const trigger = drawerTrigger.current;
          window.setTimeout(() => restoreDrawerFocus(trigger), 0);
        }}
        reconnectingOAuth={oauth.startingOAuthFlow}
        onReconnectOAuth={
          selectedCredential?.method === 'oauth'
            ? () => void oauth.handleStartOAuthFlow()
            : undefined
        }
        disconnectingOAuth={Boolean(
          selectedServer && busy.has(`disconnect:${selectedServer.mcp_server_id}`)
        )}
        onDisconnectOAuth={
          selectedCredential?.method === 'oauth' && selectedServer
            ? () => void disconnectOAuth(selectedServer)
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
        onRefreshTools={(server) => void discoverTools(server, canRefresh, true)}
        onToggleTool={(server, tool, checked) =>
          void toggleTool(server, tool, checked, canChangeTools)
        }
        onRemove={(server) =>
          void mutate(
            `remove:${server.mcp_server_id}`,
            canRemove,
            () =>
              client!.service('mcp-marketplace/remove-unattached').create({
                mcp_server_id: server.mcp_server_id,
              }),
            'Server removed',
            () => {
              if (!currentUser) return;
              clearRemovalFocusAuthority();
              const authority: RemovalFocusAuthority = {
                userId: currentUser.user_id,
                authGeneration,
                serverId: server.mcp_server_id,
                fallbackTimer: null,
              };
              removalFocusAuthority.current = authority;
              authority.fallbackTimer = window.setTimeout(
                () => settleRemovalFocus(authority),
                MARKETPLACE_DRAWER_FOCUS_FALLBACK_MS
              );
              drawerOpen.current = false;
              drawerTrigger.current = null;
              setSelectedServerId(null);
            }
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
