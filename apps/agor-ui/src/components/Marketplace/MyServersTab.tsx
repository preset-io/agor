import type { MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  List,
  message,
  Popconfirm,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { useMcpMemberPolicy } from '../../hooks/useMcpMemberPolicy';
import {
  canAddMcpServer,
  explainManageRestriction,
  policyPendingState,
} from '../MCPServer/memberPolicy';

const { Text, Title } = Typography;

export const MyServersTab: React.FC<{
  client: AgorClient | null;
  connected: boolean;
  connecting: boolean;
  authGeneration: number;
  currentUser?: User | null;
  overview: MCPMarketplaceOverview;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}> = ({
  client,
  connected,
  connecting,
  authGeneration,
  currentUser,
  overview,
  loading,
  error,
  refresh,
}) => {
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
  const canMutate = !policyState.pending && canAddMcpServer(capability);
  const mutationAuthorityKey =
    canMutate && client && currentUser
      ? [
          currentUser.user_id,
          currentUser.role,
          authGeneration,
          client,
          memberPolicy.policy,
          memberPolicy.canConfigure,
        ]
      : null;
  const guard = useAuthorityOperationGuard(mutationAuthorityKey);
  // Per-operation tracking permits safe concurrent A/B tool toggles while
  // preventing a second click on the same control. The daemon mutation itself
  // is an atomic one-tool merge, so no whole-policy lost update is possible.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);
  useEffect(() => {
    if (canMutate) return;
    // An open confirmation captured under older authority must not remain an
    // actionable portal after demotion, policy invalidation, or reconnect.
    setRemoveConfirm(null);
    setBusy(new Set());
  }, [canMutate]);
  const cursorServerIds = useMemo(
    () =>
      new Set(
        overview.attachments
          .filter((attachment) => attachment.agentic_tool === 'cursor')
          .map((attachment) => attachment.mcp_server_id)
      ),
    [overview.attachments]
  );

  const mutate = async (key: string, work: () => Promise<unknown>, success: string) => {
    const operation = guard.begin();
    if (!client || !canMutate || !operation.isCurrent()) return;
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

  if (error)
    return (
      <Alert
        type="error"
        showIcon
        message="Could not load your servers"
        description={error}
        action={<Button onClick={() => void refresh()}>Retry</Button>}
      />
    );
  if (!loading && overview.servers.length === 0)
    return <Empty description="You have no MCP servers yet" />;

  return (
    <Flex vertical gap={16}>
      <Alert
        type="info"
        showIcon
        message="Tool controls apply to future MCP configuration"
        description="Work already in flight may keep its current tools. Off stores an explicit deny; On returns the tool to its agent's default. Existing Ask choices are preserved."
      />
      {!canMutate && (
        <Alert
          type="warning"
          showIcon
          message={policyState.pending ? policyState.hint : explainManageRestriction(capability)}
        />
      )}
      <List
        loading={loading}
        dataSource={overview.servers}
        renderItem={(server) => (
          <List.Item>
            <Card style={{ width: '100%' }}>
              <Flex justify="space-between" align="flex-start" gap={16} wrap>
                <div>
                  <Title level={5} style={{ margin: 0 }}>
                    {server.display_name ?? server.name}
                  </Title>
                  <Space wrap>
                    <Tag>{server.source === 'catalog' ? 'Catalog' : 'Manual'}</Tag>
                    <Text type="secondary">
                      {server.session_count} {server.session_count === 1 ? 'session' : 'sessions'}
                    </Text>
                    {!server.enabled && <Tag color="warning">Disabled</Tag>}
                  </Space>
                  {server.description && (
                    <div>
                      <Text type="secondary">{server.description}</Text>
                    </div>
                  )}
                </div>
                <Space>
                  <Button
                    aria-label={`Refresh tools for ${server.display_name ?? server.name}`}
                    icon={<ReloadOutlined />}
                    disabled={!canMutate}
                    loading={busy.has(`discover:${server.mcp_server_id}`)}
                    onClick={() =>
                      void mutate(
                        `discover:${server.mcp_server_id}`,
                        () =>
                          client!
                            .service('mcp-servers/discover')
                            .create({ mcp_server_id: server.mcp_server_id }),
                        'Tools refreshed'
                      )
                    }
                  >
                    Refresh tools
                  </Button>
                  <Popconfirm
                    open={removeConfirm === server.mcp_server_id && canMutate}
                    title="Remove this unattached server?"
                    description="Agor checks attachments again when you confirm. If a session attaches it first, nothing is removed and you can detach it before retrying."
                    onOpenChange={(next) =>
                      setRemoveConfirm(next && canMutate ? server.mcp_server_id : null)
                    }
                    disabled={server.session_count > 0 || !canMutate}
                    onConfirm={() =>
                      void mutate(
                        `remove:${server.mcp_server_id}`,
                        () =>
                          client!.service('mcp-marketplace/remove-unattached').create({
                            mcp_server_id: server.mcp_server_id,
                          }),
                        'Server removed'
                      )
                    }
                  >
                    <Button
                      aria-label={`Remove ${server.display_name ?? server.name}`}
                      danger
                      icon={<DeleteOutlined />}
                      disabled={server.session_count > 0 || !canMutate}
                      loading={busy.has(`remove:${server.mcp_server_id}`)}
                    >
                      Remove
                    </Button>
                  </Popconfirm>
                </Space>
              </Flex>
              {cursorServerIds.has(server.mcp_server_id) && (
                <Alert
                  style={{ marginTop: 12 }}
                  type="warning"
                  showIcon
                  message="Cursor cannot enforce per-tool choices"
                  description="When any tool is Off or Ask, Agor withholds this entire server from Cursor rather than exposing more than you allowed."
                />
              )}
              <List
                style={{ marginTop: 8 }}
                size="small"
                locale={{ emptyText: 'No tools discovered yet' }}
                dataSource={server.tools}
                renderItem={(tool) => (
                  <List.Item
                    actions={[
                      <Space key="control">
                        {tool.permission === 'ask' && <Tag color="gold">Ask</Tag>}
                        <Switch
                          aria-label={`${server.display_name ?? server.name}: ${tool.name} ${tool.permission === 'deny' ? 'off' : 'on'}`}
                          checked={tool.permission !== 'deny'}
                          disabled={!canMutate}
                          loading={busy.has(`tool:${server.mcp_server_id}:${tool.name}`)}
                          onChange={(checked) =>
                            void mutate(
                              `tool:${server.mcp_server_id}:${tool.name}`,
                              () =>
                                client!.service('mcp-marketplace/tool-permission').create({
                                  mcp_server_id: server.mcp_server_id,
                                  tool_name: tool.name,
                                  enabled: checked,
                                }),
                              checked ? `${tool.name} uses the default` : `${tool.name} is off`
                            )
                          }
                        />
                      </Space>,
                    ]}
                  >
                    <List.Item.Meta title={tool.name} description={tool.description || undefined} />
                  </List.Item>
                )}
              />
            </Card>
          </List.Item>
        )}
      />
    </Flex>
  );
};
