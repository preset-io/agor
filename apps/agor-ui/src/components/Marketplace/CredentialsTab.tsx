import type { MCPMarketplaceOverview } from '@agor/core/types';
import { Empty, Table, Tag, Typography } from 'antd';

const formatTime = (value?: string) => (value ? new Date(value).toLocaleString() : '—');

export const CredentialsTab: React.FC<{
  overview: MCPMarketplaceOverview;
  loading: boolean;
  error: string | null;
}> = ({ overview, loading, error }) => {
  if (!loading && overview.credentials.length === 0)
    return <Empty description={error ?? 'No credential metadata'} />;
  return (
    <>
      <Typography.Paragraph type="secondary">
        Read-only connection metadata. Marketplace never displays credential values, identifiers,
        bindings, endpoints, or token fragments.
      </Typography.Paragraph>
      <Table
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
    </>
  );
};
