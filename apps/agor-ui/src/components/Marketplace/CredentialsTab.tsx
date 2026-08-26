import type { MCPMarketplaceCredential, MCPMarketplaceOverview } from '@agor/core/types';
import { LockOutlined } from '@ant-design/icons';
import { Alert, Badge, Button, Empty, Flex, Space, Table, Tag, Typography, theme } from 'antd';
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
  const serverEnabled = new Map(
    overview.servers.map((server) => [server.mcp_server_id, server.enabled] as const)
  );
  if (!loading && overview.credentials.length === 0 && !error)
    return (
      <Empty description="No saved Marketplace credentials">
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
          fragments are never shown. Manage opens this server's Marketplace drawer, where policy and
          secure recovery flows are enforced.
        </Typography.Paragraph>
      </Space>
      <Table<MCPMarketplaceCredential>
        aria-label="Saved MCP credential metadata"
        scroll={{ x: 700 }}
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
            render: (_, row) => (
              <Button
                disabled={!canManageCredentials || !onOpenServerSettings}
                onClick={() => onOpenServerSettings?.(row.mcp_server_id)}
                aria-label={`${marketplaceCredentialActionLabel(row, serverEnabled.get(row.mcp_server_id) === true)} ${marketplaceCredentialMethodLabel(row.method)} connection for ${marketplaceCredentialServerTitle(row)}`}
                title={`${marketplaceCredentialActionLabel(row, serverEnabled.get(row.mcp_server_id) === true)} or manage ${marketplaceCredentialServerTitle(row)}`}
              >
                {marketplaceCredentialActionLabel(
                  row,
                  serverEnabled.get(row.mcp_server_id) === true
                )}
              </Button>
            ),
          },
        ]}
      />
    </Flex>
  );
};
