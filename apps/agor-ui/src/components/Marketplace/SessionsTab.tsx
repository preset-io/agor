import type { MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { sessionPath, shortId } from '@agor-live/client';
import { Button, Empty, message, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';

export const SessionsTab: React.FC<{
  client: AgorClient | null;
  authorityKey: readonly unknown[] | null;
  overview: MCPMarketplaceOverview;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}> = ({ client, authorityKey, overview, loading, error, refresh }) => {
  const navigate = useNavigate();
  const guard = useAuthorityOperationGuard(authorityKey);
  const [detaching, setDetaching] = useState<string | null>(null);
  const names = new Map(
    overview.servers.map((server) => [server.mcp_server_id, server.display_name ?? server.name])
  );
  if (!loading && overview.attachments.length === 0)
    return <Empty description={error ?? 'No sessions use your MCP servers'} />;
  return (
    <Table
      loading={loading}
      rowKey={(row) => `${row.session_id}:${row.mcp_server_id}`}
      dataSource={overview.attachments}
      pagination={false}
      columns={[
        {
          title: 'Session',
          render: (_, row) => (
            <Button
              type="link"
              style={{ padding: 0 }}
              onClick={() => navigate(sessionPath(row.session_id))}
            >
              {row.session_title || shortId(row.session_id)}
            </Button>
          ),
        },
        {
          title: 'Server',
          render: (_, row) => names.get(row.mcp_server_id) ?? shortId(row.mcp_server_id),
        },
        { title: 'Branch', dataIndex: 'branch_name' },
        { title: 'Agent', dataIndex: 'agentic_tool' },
        { title: 'Status', render: (_, row) => <Tag>{row.session_status}</Tag> },
        {
          title: '',
          render: (_, row) => {
            const key = `${row.session_id}:${row.mcp_server_id}`;
            return (
              <Button
                danger
                loading={detaching === key}
                onClick={async () => {
                  const operation = guard.begin();
                  if (!client || !operation.isCurrent()) return;
                  setDetaching(key);
                  try {
                    await client
                      .service(`sessions/${row.session_id}/mcp-servers`)
                      .remove(row.mcp_server_id);
                    if (!operation.isCurrent()) return;
                    message.success('Server detached');
                    await refresh();
                  } catch (cause) {
                    if (operation.isCurrent())
                      message.error(
                        cause instanceof Error ? cause.message : 'Could not detach server'
                      );
                  } finally {
                    if (operation.isCurrent()) setDetaching(null);
                  }
                }}
              >
                Detach
              </Button>
            );
          },
        },
      ]}
      locale={{
        emptyText: <Typography.Text type="secondary">No session attachments</Typography.Text>,
      }}
    />
  );
};
