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
  Switch,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useEffect, useState } from 'react';
import { MARKETPLACE_SERVER_DRAWER_WIDTH } from './marketplaceLayout';
import {
  marketplaceCredentialActionLabel,
  marketplaceCredentialMethodLabel,
  marketplaceCredentialNeedsRecovery,
  marketplaceServerTitle,
} from './marketplacePresentation';

const { Text, Title } = Typography;

export interface ServerConnectionPresentation {
  label: string;
  status: 'default' | 'success' | 'error' | 'warning' | 'processing';
  detail: string;
}

export interface ServerSettingsDrawerProps {
  server: MCPMarketplaceServer | null;
  credential?: MCPMarketplaceCredential;
  connection: ServerConnectionPresentation;
  attachments: MCPMarketplaceAttachment[];
  cursorAttached: boolean;
  canRefresh: boolean;
  canChangeTools: boolean;
  canReconnect: boolean;
  canRemove: boolean;
  busy: ReadonlySet<string>;
  onClose: () => void;
  onAfterOpenChange: (open: boolean) => void;
  reconnectingOAuth?: boolean;
  editingCredential?: boolean;
  onReconnectOAuth?: () => void;
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
  onClose,
  onAfterOpenChange,
  reconnectingOAuth = false,
  editingCredential = false,
  onReconnectOAuth,
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
                children: <Badge status={connection.status} text={connection.label} />,
              },
              {
                key: 'source',
                label: 'Installed from',
                children: server.source === 'catalog' ? 'Marketplace catalog' : 'Manual setup',
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
                {marketplaceCredentialNeedsRecovery(credential, server.enabled) &&
                onReconnectOAuth ? (
                  <Button
                    disabled={!canReconnect}
                    loading={reconnectingOAuth}
                    onClick={onReconnectOAuth}
                    title={`${marketplaceCredentialActionLabel(credential, server.enabled)} ${marketplaceServerTitle(server)}`}
                    aria-label={`${marketplaceCredentialActionLabel(credential, server.enabled)} ${marketplaceServerTitle(server)} account`}
                  >
                    {marketplaceCredentialActionLabel(credential, server.enabled)}
                  </Button>
                ) : credential.method !== 'oauth' && onEditCredential ? (
                  <Button
                    disabled={!canChangeTools}
                    loading={editingCredential}
                    onClick={onEditCredential}
                    title={`Edit ${marketplaceServerTitle(server)} credential securely`}
                    aria-label={`Edit ${marketplaceServerTitle(server)} credential`}
                  >
                    Edit credential
                  </Button>
                ) : null}
              </Flex>
            ) : (
              <Text type="secondary">No account is needed for this connection.</Text>
            )}
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
                disabled={!canRefresh}
                loading={busy.has(`discover:${server.mcp_server_id}`)}
                onClick={() => onRefreshTools(server)}
              >
                Refresh tools
              </Button>
            </Flex>
            {cursorAttached && (
              <Alert
                type="warning"
                showIcon
                title="Cursor cannot enforce per-tool choices"
                description="When any tool is Off or Ask, Agor withholds this entire server from Cursor."
              />
            )}
            {server.tools.length ? (
              <Flex vertical role="list" aria-label={`${marketplaceServerTitle(server)} tools`}>
                {server.tools.map((tool) => (
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
                      <Switch
                        aria-label={`${marketplaceServerTitle(server)}: ${tool.name} ${tool.permission === 'deny' ? 'off' : 'on'}`}
                        checked={tool.permission !== 'deny'}
                        disabled={!canChangeTools}
                        loading={busy.has(`tool:${server.mcp_server_id}:${tool.name}`)}
                        onChange={(checked) => onToggleTool(server, tool, checked)}
                      />
                    </Space>
                  </Flex>
                ))}
              </Flex>
            ) : (
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
                    {attachment.session_title ?? attachment.branch_name}
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
