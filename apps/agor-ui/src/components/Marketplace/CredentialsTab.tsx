import type { MCPMarketplaceCredential, MCPMarketplaceOverview } from '@agor/core/types';
import { LockOutlined } from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Flex,
  Grid,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import { MARKETPLACE_ACTION_COLUMN_WIDTH } from './marketplaceLayout';
import {
  formatMarketplaceDate,
  marketplaceCredentialActionLabel,
  marketplaceCredentialMethodLabel,
  marketplaceCredentialPresentation,
  marketplaceCredentialServerTitle,
} from './marketplacePresentation';

export const CredentialsTab: React.FC<{
  overview: MCPMarketplaceOverview;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<unknown>;
  canManageCredentials?: boolean;
  onOpenServerSettings?: (serverId: string) => void;
  onBrowseCatalog?: () => void;
}> = ({
  overview,
  loading,
  error,
  refresh,
  canManageCredentials = false,
  onOpenServerSettings,
  onBrowseCatalog,
}) => {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const compact = screens.xs === true && screens.md !== true;
  const serverEnabled = new Map(
    overview.servers.map((server) => [server.mcp_server_id, server.enabled] as const)
  );
  const actionFor = (row: MCPMarketplaceCredential) => {
    const enabled = serverEnabled.get(row.mcp_server_id) === true;
    const action = marketplaceCredentialActionLabel(row, enabled);
    const title = marketplaceCredentialServerTitle(row);
    return (
      <Button
        block={compact}
        disabled={!canManageCredentials || !onOpenServerSettings}
        onClick={() => onOpenServerSettings?.(row.mcp_server_id)}
        aria-label={`${action} ${marketplaceCredentialMethodLabel(row.method)} connection for ${title}`}
        title={`${action} or manage ${title}`}
      >
        {action}
      </Button>
    );
  };
  if (!loading && overview.credentials.length === 0 && !error)
    return (
      <Empty description="No saved Catalog credentials">
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
          title="Could not load credential metadata"
          description={error}
          action={<Button onClick={() => void refresh()}>Retry</Button>}
        />
      )}
      <Space size={token.marginXS} align="start">
        <LockOutlined style={{ color: token.colorTextSecondary, marginTop: token.marginXXS }} />
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Connection methods and status only. Secret values, identifiers, endpoints, and token
          fragments are never shown. Manage opens this server's Catalog drawer, where policy and
          secure recovery flows are enforced.
        </Typography.Paragraph>
      </Space>
      {compact ? (
        <Spin spinning={loading}>
          <ul
            aria-label="Saved MCP credential metadata"
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
            {overview.credentials.map((row) => {
              const status = marketplaceCredentialPresentation(
                row,
                serverEnabled.get(row.mcp_server_id) === true
              );
              return (
                <li key={`${row.mcp_server_id}:${row.method}`}>
                  <Card size="small" style={{ width: '100%' }}>
                    <Flex vertical gap={token.marginSM}>
                      <Typography.Text strong>
                        {marketplaceCredentialServerTitle(row)}
                      </Typography.Text>
                      <Space wrap size={token.marginXS}>
                        <Tag>{marketplaceCredentialMethodLabel(row.method)}</Tag>
                        <Badge status={status.badge} text={status.label} />
                      </Space>
                      <Flex justify="space-between" gap={token.marginSM} wrap>
                        <Typography.Text type="secondary">Last changed</Typography.Text>
                        <Typography.Text>
                          {formatMarketplaceDate(row.updated_at ?? row.created_at, true)}
                        </Typography.Text>
                      </Flex>
                      {actionFor(row)}
                    </Flex>
                  </Card>
                </li>
              );
            })}
          </ul>
        </Spin>
      ) : (
        <Table<MCPMarketplaceCredential>
          aria-label="Saved MCP credential metadata"
          loading={loading}
          rowKey={(row) => `${row.mcp_server_id}:${row.method}`}
          dataSource={overview.credentials}
          pagination={false}
          columns={[
            {
              title: 'Server',
              render: (_, row) => (
                <Typography.Text strong>{marketplaceCredentialServerTitle(row)}</Typography.Text>
              ),
            },
            {
              title: 'Method',
              render: (_, row) => <Tag>{marketplaceCredentialMethodLabel(row.method)}</Tag>,
            },
            {
              title: 'Status',
              render: (_, row) => {
                const status = marketplaceCredentialPresentation(
                  row,
                  serverEnabled.get(row.mcp_server_id) === true
                );
                return <Badge status={status.badge} text={status.label} />;
              },
            },
            {
              title: 'Expires',
              render: (_, row) =>
                row.method === 'oauth' ? formatMarketplaceDate(row.expires_at, true) : '—',
            },
            {
              title: 'Last changed',
              render: (_, row) => formatMarketplaceDate(row.updated_at ?? row.created_at, true),
            },
            {
              title: '',
              align: 'end',
              fixed: 'right',
              width: MARKETPLACE_ACTION_COLUMN_WIDTH,
              render: (_, row) => actionFor(row),
            },
          ]}
        />
      )}
    </Flex>
  );
};
