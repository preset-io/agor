import type { MCPMarketplaceAttachment, MCPMarketplaceOverview } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { sessionPath, shortId } from '@agor-live/client';
import { ArrowRightOutlined, RobotOutlined } from '@ant-design/icons';
import {
  Alert,
  Avatar,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  message,
  Popconfirm,
  Row,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { marketplaceServerTitle, marketplaceSessionTitle } from './marketplacePresentation';

interface SessionGroup {
  attachment: MCPMarketplaceAttachment;
  servers: MCPMarketplaceAttachment[];
}

export const SessionsTab: React.FC<{
  client: AgorClient | null;
  authorityKey: readonly unknown[] | null;
  overview: MCPMarketplaceOverview;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<unknown>;
  onBrowseCatalog?: () => void;
}> = ({ client, authorityKey, overview, loading, error, refresh, onBrowseCatalog }) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const guard = useAuthorityOperationGuard(authorityKey);
  const [detaching, setDetaching] = useState<string | null>(null);
  const [detachConfirm, setDetachConfirm] = useState<string | null>(null);
  useEffect(() => {
    if (authorityKey) return;
    setDetachConfirm(null);
    setDetaching(null);
  }, [authorityKey]);

  const names = useMemo(
    () =>
      new Map(
        overview.servers.map((server) => [server.mcp_server_id, marketplaceServerTitle(server)])
      ),
    [overview.servers]
  );
  const sessions = useMemo(() => {
    const bySession = new Map<string, SessionGroup>();
    for (const attachment of overview.attachments) {
      const current = bySession.get(attachment.session_id);
      if (current) current.servers.push(attachment);
      else bySession.set(attachment.session_id, { attachment, servers: [attachment] });
    }
    return [...bySession.values()];
  }, [overview.attachments]);

  if (!loading && sessions.length === 0 && !error)
    return (
      <Empty description="No sessions use your MCP servers">
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
          title="Could not load Catalog sessions"
          description={error}
          action={<Button onClick={() => void refresh()}>Retry</Button>}
        />
      )}
      <Spin spinning={loading}>
        <Row gutter={[token.marginSM, token.marginSM]} aria-busy={loading}>
          {sessions.map(({ attachment, servers }) => {
            const sessionName = marketplaceSessionTitle(attachment);
            return (
              <Col key={attachment.session_id} xs={24} lg={12}>
                <Card style={{ width: '100%', height: '100%' }}>
                  <Flex vertical gap={token.margin}>
                    <Flex justify="space-between" align="flex-start" gap={token.margin} wrap>
                      <Flex gap={token.marginSM} align="center" style={{ minWidth: 0 }}>
                        <Avatar icon={<RobotOutlined />} />
                        <Flex vertical style={{ minWidth: 0 }}>
                          <Button
                            type="link"
                            style={{ padding: 0, height: 'auto', alignSelf: 'flex-start' }}
                            onClick={() => navigate(sessionPath(attachment.session_id))}
                            title={`Open session ${sessionName}`}
                          >
                            <Typography.Text strong ellipsis={{ tooltip: sessionName }}>
                              {sessionName}
                            </Typography.Text>
                          </Button>
                          <Space size={token.marginXXS} wrap>
                            <Typography.Text type="secondary">
                              {attachment.agentic_tool}
                            </Typography.Text>
                            <Typography.Text type="secondary">·</Typography.Text>
                            <Typography.Text type="secondary">
                              {attachment.branch_name}
                            </Typography.Text>
                          </Space>
                        </Flex>
                      </Flex>
                      <Space wrap>
                        <Tag
                          color={attachment.session_status === 'running' ? 'processing' : undefined}
                        >
                          {attachment.session_status}
                        </Tag>
                        <Button
                          aria-label={`Open session ${sessionName}`}
                          title={`Open session ${sessionName}`}
                          icon={<ArrowRightOutlined />}
                          onClick={() => navigate(sessionPath(attachment.session_id))}
                        >
                          Open session
                        </Button>
                      </Space>
                    </Flex>

                    <Flex vertical gap={token.marginXS}>
                      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                        Attached servers
                      </Typography.Text>
                      <Space size={[token.marginXS, token.marginXS]} wrap>
                        {servers.map((server) => {
                          const key = `${server.session_id}:${server.mcp_server_id}`;
                          const serverName =
                            names.get(server.mcp_server_id) ?? shortId(server.mcp_server_id);
                          return (
                            <Space key={key} size={0}>
                              <Tag
                                color={server.enabled ? undefined : 'default'}
                                style={{ marginInlineEnd: 0, alignContent: 'center' }}
                              >
                                {serverName}
                                {!server.enabled && ' · Disabled'}
                              </Tag>
                              <Popconfirm
                                open={detachConfirm === key && authorityKey !== null}
                                title={`Detach ${serverName}?`}
                                description={`This removes it from ${sessionName}. Work already in flight may keep its current MCP configuration.`}
                                okText="Detach"
                                okButtonProps={{ danger: true }}
                                disabled={authorityKey === null}
                                onOpenChange={(next) =>
                                  setDetachConfirm(next && authorityKey ? key : null)
                                }
                                onConfirm={async () => {
                                  const operation = guard.begin();
                                  if (!client || !operation.isCurrent()) return;
                                  setDetaching(key);
                                  try {
                                    await client
                                      .service(`sessions/${server.session_id}/mcp-servers`)
                                      .remove(server.mcp_server_id);
                                    if (!operation.isCurrent()) return;
                                    message.success('Server detached');
                                    await refresh();
                                  } catch (cause) {
                                    if (operation.isCurrent())
                                      message.error(
                                        cause instanceof Error
                                          ? cause.message
                                          : 'Could not detach server'
                                      );
                                  } finally {
                                    if (operation.isCurrent()) setDetaching(null);
                                  }
                                }}
                              >
                                <Button
                                  size="small"
                                  aria-label={`Detach ${serverName} from session ${sessionName}`}
                                  title={`Detach ${serverName} from session ${sessionName}`}
                                  danger
                                  disabled={authorityKey === null}
                                  loading={detaching === key}
                                >
                                  Detach
                                </Button>
                              </Popconfirm>
                            </Space>
                          );
                        })}
                      </Space>
                    </Flex>
                  </Flex>
                </Card>
              </Col>
            );
          })}
        </Row>
      </Spin>
    </Flex>
  );
};
