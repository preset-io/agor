import type { MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { sessionPath, shortId } from '@agor-live/client';
import { Alert, Button, Empty, Flex, message, Popconfirm, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
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
  const [detachConfirm, setDetachConfirm] = useState<string | null>(null);
  useEffect(() => {
    if (authorityKey) return;
    setDetachConfirm(null);
    setDetaching(null);
  }, [authorityKey]);
  const names = new Map(
    overview.servers.map((server) => [server.mcp_server_id, server.display_name ?? server.name])
  );
  if (!loading && overview.attachments.length === 0 && !error)
    return <Empty description="No sessions use your MCP servers" />;
  return (
    <Flex vertical gap={16}>
      {error && (
        <Alert
          type="error"
          showIcon
          message="Could not load Marketplace sessions"
          description={error}
          action={<Button onClick={() => void refresh()}>Retry</Button>}
        />
      )}
      <Table
        scroll={{ x: 'max-content' }}
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
              const serverName = names.get(row.mcp_server_id) ?? shortId(row.mcp_server_id);
              const sessionName = row.session_title || shortId(row.session_id);
              return (
                <Popconfirm
                  open={detachConfirm === key && authorityKey !== null}
                  title={`Detach ${serverName}?`}
                  description={`This removes it from ${sessionName}. Work already in flight may keep its current MCP configuration.`}
                  okText="Detach"
                  okButtonProps={{ danger: true }}
                  disabled={authorityKey === null}
                  onOpenChange={(next) => setDetachConfirm(next && authorityKey ? key : null)}
                  onConfirm={async () => {
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
                  <Button
                    aria-label={`Detach ${serverName} from session ${sessionName}`}
                    danger
                    disabled={authorityKey === null}
                    loading={detaching === key}
                  >
                    Detach
                  </Button>
                </Popconfirm>
              );
            },
          },
        ]}
        locale={{
          emptyText: <Typography.Text type="secondary">No session attachments</Typography.Text>,
        }}
      />
    </Flex>
  );
};
