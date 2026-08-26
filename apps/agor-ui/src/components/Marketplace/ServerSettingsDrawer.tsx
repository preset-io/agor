import type {
  MCPMarketplaceAttachment,
  MCPMarketplaceCredential,
  MCPMarketplaceServer,
} from '@agor/core/types';
import { DeleteOutlined, KeyOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useEffect, useState } from 'react';
import { MARKETPLACE_SERVER_DRAWER_WIDTH } from './marketplaceLayout';
import {
  type MarketplaceCredentialPresentation,
  marketplaceCredentialActionLabel,
  marketplaceCredentialMethodLabel,
  marketplaceCredentialNeedsRecovery,
  marketplaceServerTitle,
  marketplaceSessionTitle,
} from './marketplacePresentation';

const { Text, Title } = Typography;

export interface ServerSettingsDrawerProps {
  server: MCPMarketplaceServer | null;
  credential?: MCPMarketplaceCredential;
  connection: MarketplaceCredentialPresentation;
  attachments: MCPMarketplaceAttachment[];
  cursorAttached: boolean;
  canRefresh: boolean;
  canChangeTools: boolean;
  canReconnect: boolean;
  canRemove: boolean;
  busy: ReadonlySet<string>;
  toolDiscoveryError?: string;
  onClose: () => void;
  onAfterOpenChange: (open: boolean) => void;
  reconnectingOAuth?: boolean;
  disconnectingOAuth?: boolean;
  editingCredential?: boolean;
  onReconnectOAuth?: () => void;
  onDisconnectOAuth?: () => void;
  onEditCredential?: () => void;
  onRefreshTools: (server: MCPMarketplaceServer) => void;
  onToggleTool: (
    server: MCPMarketplaceServer,
    tool: MCPMarketplaceServer['tools'][number],
    enabled: boolean
  ) => void;
  onRemove: (server: MCPMarketplaceServer) => void;
}

export const ServerSettingsDrawer: React.FC<ServerSettingsDrawerProps> = ({
  server,
  credential,
  connection,
  attachments,
  cursorAttached,
  canRefresh,
  canChangeTools,
  canReconnect,
  canRemove,
  busy,
  toolDiscoveryError,
  onClose,
  onAfterOpenChange,
  reconnectingOAuth = false,
  disconnectingOAuth = false,
  editingCredential = false,
  onReconnectOAuth,
  onDisconnectOAuth,
  onEditCredential,
  onRefreshTools,
  onToggleTool,
  onRemove,
}) => {
  const { token } = theme.useToken();
  const [removeConfirm, setRemoveConfirm] = useState(false);
  useEffect(() => {
    if (!server || !canRemove) setRemoveConfirm(false);
  }, [canRemove, server]);
  const discoveringTools = Boolean(server && busy.has(`discover:${server.mcp_server_id}`));
  const toolMutationActive = Boolean(
    server && Array.from(busy).some((key) => key.startsWith(`tool:${server.mcp_server_id}:`))
  );
  const toolWorkActive = discoveringTools || toolMutationActive;

  return (
    <Drawer
      open={server !== null}
      size={MARKETPLACE_SERVER_DRAWER_WIDTH}
      destroyOnHidden
      onClose={onClose}
      afterOpenChange={onAfterOpenChange}
      title={
        server && (
          <Space size={token.marginSM}>
            <Avatar shape="square">{marketplaceServerTitle(server).charAt(0).toUpperCase()}</Avatar>
            <Flex vertical style={{ minWidth: 0 }}>
              <Text strong ellipsis>
                {marketplaceServerTitle(server)}
              </Text>
              <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                Server settings
              </Text>
            </Flex>
          </Space>
        )
      }
    >
      {server && (
        <Flex vertical gap={token.marginLG}>
          <Descriptions
            size="small"
            column={1}
            items={[
              {
                key: 'connection',
                label: 'Authentication',
                children: <Badge status={connection.badge} text={connection.label} />,
              },
              {
                key: 'source',
                label: 'Installed from',
                children: server.source === 'catalog' ? 'Catalog' : 'Manual setup',
              },
              { key: 'sessions', label: 'Session attachments', children: server.session_count },
            ]}
          />

          <Flex vertical gap={token.marginXS}>
            <Title level={5} style={{ margin: 0 }}>
              Credential
            </Title>
            {credential ? (
              <Flex justify="space-between" align="center" gap={token.marginSM} wrap>
                <Space>
                  <KeyOutlined />
                  <Text>
                    {marketplaceCredentialMethodLabel(credential.method)} · {connection.label}
                  </Text>
                </Space>
                <Space wrap>
                  {marketplaceCredentialNeedsRecovery(credential, server.enabled) &&
                    onReconnectOAuth && (
                      <Button
                        disabled={!canReconnect || toolWorkActive}
                        loading={reconnectingOAuth}
                        onClick={onReconnectOAuth}
                        title={`${marketplaceCredentialActionLabel(credential, server.enabled)} ${marketplaceServerTitle(server)}`}
                        aria-label={`${marketplaceCredentialActionLabel(credential, server.enabled)} ${marketplaceServerTitle(server)} account`}
                      >
                        {marketplaceCredentialActionLabel(credential, server.enabled)}
                      </Button>
                    )}
                  {credential.method !== 'oauth' && onEditCredential && (
                    <Button
                      disabled={!canChangeTools || toolWorkActive}
                      loading={editingCredential}
                      onClick={onEditCredential}
                      title={`Edit ${marketplaceServerTitle(server)} credential securely`}
                      aria-label={`Edit ${marketplaceServerTitle(server)} credential`}
                    >
                      Edit credential
                    </Button>
                  )}
                  {credential.method === 'oauth' && onDisconnectOAuth && (
                    <Popconfirm
                      title={`Disconnect ${marketplaceServerTitle(server)}?`}
                      description="This removes the saved OAuth connection from Agor. Provider-side access may remain until you revoke it with the provider."
                      okText="Disconnect"
                      okButtonProps={{ danger: true }}
                      onConfirm={onDisconnectOAuth}
                    >
                      <Button
                        danger
                        disabled={!canChangeTools || toolWorkActive}
                        loading={disconnectingOAuth}
                        aria-label={`Disconnect ${marketplaceServerTitle(server)} OAuth connection`}
                      >
                        Disconnect OAuth
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              </Flex>
            ) : (
              <Text type="secondary">No account is needed for this connection.</Text>
            )}
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {connection.detail}
            </Text>
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Credential values are never displayed here. OAuth recovery uses the existing secure
              provider flow; API keys and JWT credentials open the existing secure editor.
            </Text>
          </Flex>

          <Flex vertical gap={token.marginXS}>
            <Flex justify="space-between" align="center" gap={token.marginSM} wrap>
              <Title level={5} style={{ margin: 0 }}>
                Enabled tools
              </Title>
              <Button
                aria-label="Refresh tools"
                icon={<ReloadOutlined />}
                disabled={!canRefresh || toolMutationActive}
                loading={discoveringTools}
                onClick={() => onRefreshTools(server)}
              >
                Refresh tools
              </Button>
            </Flex>
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Default follows the server policy. Ask requires approval for each use; turning an Ask
              tool off and back on restores Default.
            </Text>
            {cursorAttached && (
              <Alert
                type="warning"
                showIcon
                title="Cursor cannot enforce per-tool choices"
                description="When any tool is Off or Ask, Agor withholds this entire server from Cursor."
              />
            )}
            {discoveringTools && (
              <Alert
                type="info"
                showIcon
                role="status"
                title="Discovering tools…"
                description="Checking the server for its current tool list. Existing settings stay available while this finishes."
              />
            )}
            {toolDiscoveryError && (
              <Alert
                type="error"
                showIcon
                title="Could not discover tools"
                description={toolDiscoveryError}
              />
            )}
            {server.tools.length ? (
              <Flex
                vertical
                role="list"
                aria-label={`${marketplaceServerTitle(server)} tools`}
                aria-busy={toolWorkActive}
              >
                {server.tools.map((tool) => {
                  const changing = busy.has(`tool:${server.mcp_server_id}:${tool.name}`);
                  return (
                    <Flex
                      key={tool.name}
                      role="listitem"
                      justify="space-between"
                      align="center"
                      gap={token.marginSM}
                      style={{
                        paddingBlock: token.paddingSM,
                        borderBottomWidth: token.lineWidth,
                        borderBottomStyle: 'solid',
                        borderBottomColor: token.colorBorderSecondary,
                      }}
                    >
                      <Flex vertical style={{ minWidth: 0 }}>
                        <Text strong>{tool.name}</Text>
                        {tool.description && <Text type="secondary">{tool.description}</Text>}
                      </Flex>
                      <Space>
                        {tool.permission === 'ask' && <Tag color="gold">Ask</Tag>}
                        {changing && (
                          <Spin size="small" aria-label={`Saving ${tool.name} permission`} />
                        )}
                        <Switch
                          aria-label={`${marketplaceServerTitle(server)}: ${tool.name} ${tool.permission === 'deny' ? 'off' : 'on'}`}
                          checked={tool.permission !== 'deny'}
                          disabled={!canChangeTools}
                          aria-disabled={!canChangeTools || toolWorkActive}
                          aria-busy={changing || discoveringTools}
                          onChange={(checked) => onToggleTool(server, tool, checked)}
                        />
                      </Space>
                    </Flex>
                  );
                })}
              </Flex>
            ) : discoveringTools ? null : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No tools discovered yet" />
            )}
          </Flex>

          <Flex vertical gap={token.marginXS}>
            <Title level={5} style={{ margin: 0 }}>
              Session attachments
            </Title>
            {attachments.length ? (
              <Space wrap>
                {attachments.map((attachment) => (
                  <Tag
                    key={attachment.session_id}
                    color={attachment.enabled ? undefined : 'default'}
                  >
                    {marketplaceSessionTitle(attachment)}
                    {!attachment.enabled && ' · Disabled'}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Text type="secondary">No sessions are attached.</Text>
            )}
          </Flex>

          <Flex
            vertical
            gap={token.marginXS}
            style={{
              borderTopWidth: token.lineWidth,
              borderTopStyle: 'solid',
              borderTopColor: token.colorBorderSecondary,
              paddingTop: token.paddingLG,
            }}
          >
            <Title level={5} style={{ margin: 0 }}>
              Remove server
            </Title>
            <Text type="secondary">
              A server can be removed only after it is detached from every session.
            </Text>
            <Popconfirm
              open={removeConfirm && canRemove}
              title={`Remove ${marketplaceServerTitle(server)}?`}
              description="Agor checks attachments again before removing the server and its saved connection."
              okText="Remove"
              okButtonProps={{ danger: true }}
              disabled={server.session_count > 0 || !canRemove}
              onOpenChange={(next) => setRemoveConfirm(next && canRemove)}
              onConfirm={() => onRemove(server)}
            >
              <Button
                aria-label={`Remove ${marketplaceServerTitle(server)} server`}
                title={`Remove ${marketplaceServerTitle(server)} server`}
                danger
                icon={<DeleteOutlined />}
                disabled={server.session_count > 0 || !canRemove}
                loading={busy.has(`remove:${server.mcp_server_id}`)}
              >
                Remove server
              </Button>
            </Popconfirm>
          </Flex>
        </Flex>
      )}
    </Drawer>
  );
};
