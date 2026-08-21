import type {
  MCPMarketplaceOverview,
  MCPMarketplaceServer,
  ToolPermission,
} from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
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
import { useMemo, useState } from 'react';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';

const { Text, Title } = Typography;

export function nextToolPermissions(
  server: MCPMarketplaceServer,
  toolName: string,
  enabled: boolean
): Record<string, ToolPermission> {
  const next: Record<string, ToolPermission> = {};
  for (const tool of server.tools) {
    if (tool.permission !== 'default') next[tool.name] = tool.permission;
  }
  if (enabled) delete next[toolName];
  else next[toolName] = 'deny';
  return next;
}

export const MyServersTab: React.FC<{
  client: AgorClient | null;
  authorityKey: readonly unknown[] | null;
  overview: MCPMarketplaceOverview;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}> = ({ client, authorityKey, overview, loading, error, refresh }) => {
  const guard = useAuthorityOperationGuard(authorityKey);
  const [busy, setBusy] = useState<string | null>(null);
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
    if (!client || !operation.isCurrent()) return;
    setBusy(key);
    try {
      await work();
      if (!operation.isCurrent()) return;
      message.success(success);
      await refresh();
    } catch (cause) {
      if (operation.isCurrent())
        message.error(cause instanceof Error ? cause.message : 'Action failed');
    } finally {
      if (operation.isCurrent()) setBusy(null);
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
                    icon={<ReloadOutlined />}
                    loading={busy === `discover:${server.mcp_server_id}`}
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
                    title="Remove this server?"
                    description="Only unattached servers can be removed here."
                    disabled={server.session_count > 0}
                    onConfirm={() =>
                      void mutate(
                        `remove:${server.mcp_server_id}`,
                        () => client!.service('mcp-servers').remove(server.mcp_server_id),
                        'Server removed'
                      )
                    }
                  >
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      disabled={server.session_count > 0}
                      loading={busy === `remove:${server.mcp_server_id}`}
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
                          aria-label={`${tool.name} ${tool.permission === 'deny' ? 'off' : 'on'}`}
                          checked={tool.permission !== 'deny'}
                          loading={busy === `tool:${server.mcp_server_id}:${tool.name}`}
                          onChange={(checked) =>
                            void mutate(
                              `tool:${server.mcp_server_id}:${tool.name}`,
                              () =>
                                client!.service('mcp-servers').patch(server.mcp_server_id, {
                                  tool_permissions: nextToolPermissions(server, tool.name, checked),
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
