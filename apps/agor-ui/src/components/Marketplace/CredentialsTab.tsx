import type { MCPMarketplaceOverview } from '@agor/core/types';
import { Alert, Button, Empty, Flex, Table, Tag, Typography } from 'antd';

const formatTime = (value?: string) => (value ? new Date(value).toLocaleString() : '—');

export const CredentialsTab: React.FC<{
  overview: MCPMarketplaceOverview;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}> = ({ overview, loading, error, refresh }) => {
  if (!loading && overview.credentials.length === 0 && !error)
    return <Empty description="No credential metadata" />;
  return (
    <Flex vertical gap={16}>
      {error && (
        <Alert
          type="error"
          showIcon
          message="Could not load credential metadata"
          description={error}
          action={<Button onClick={() => void refresh()}>Retry</Button>}
        />
      )}
      <Typography.Paragraph type="secondary">
        Read-only connection metadata. Marketplace never displays credential values, identifiers,
        bindings, endpoints, or token fragments.
      </Typography.Paragraph>
      <Table
        scroll={{ x: 'max-content' }}
        loading={loading}
        rowKey={(row) => `${row.mcp_server_id}:${row.method}`}
        dataSource={overview.credentials}
        pagination={false}
        columns={[
          { title: 'Server', render: (_, row) => row.server_display_name ?? row.server_name },
          { title: 'Method', render: (_, row) => <Tag>{row.method.toUpperCase()}</Tag> },
          {
            title: 'Status',
            render: (_, row) => (
              <Tag
                color={
                  row.status === 'active' || row.status === 'configured'
                    ? 'green'
                    : row.status === 'attention'
                      ? 'orange'
                      : 'default'
                }
              >
                {row.status.replace('_', ' ')}
              </Tag>
            ),
          },
          { title: 'Expires', render: (_, row) => formatTime(row.expires_at) },
          { title: 'Created', render: (_, row) => formatTime(row.created_at) },
          { title: 'Updated', render: (_, row) => formatTime(row.updated_at) },
        ]}
      />
    </Flex>
  );
};
