import type { Board, Branch, Repo, Session } from '@agor-live/client';
import { CommentOutlined, GitlabOutlined, RightOutlined, WarningOutlined } from '@ant-design/icons';
import {
  Badge,
  Button,
  Card,
  Empty,
  Flex,
  Layout,
  List,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { getSessionDisplayTitle } from '@/utils/sessionTitle';
import { getBoardEmoji } from '../BoardTile';
import { MobileHeader } from './MobileHeader';

const { Content } = Layout;
const { Paragraph, Text, Title } = Typography;

interface MobileBoardPageProps {
  boardById: Map<string, Board>;
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  sessionsByBranch: Map<string, Session[]>;
  onMenuClick: () => void;
}

function statusColor(status: Branch['filesystem_status']): string {
  if (status === 'ready') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'creating') return 'processing';
  return 'default';
}

export const MobileBoardPage: React.FC<MobileBoardPageProps> = ({
  boardById,
  branchById,
  repoById,
  sessionsByBranch,
  onMenuClick,
}) => {
  const { boardId = '' } = useParams<{ boardId: string }>();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const board = boardById.get(boardId);
  const branches = Array.from(branchById.values())
    .filter((branch) => branch.board_id === boardId)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!board) {
    return (
      <>
        <MobileHeader title="Board" onMenuClick={onMenuClick} />
        <Content style={{ padding: token.paddingLG }}>
          <Empty description="Board not found" />
        </Content>
      </>
    );
  }

  return (
    <>
      <MobileHeader title={board.name} onMenuClick={onMenuClick} />
      <Content
        style={{
          overflowY: 'auto',
          padding: token.paddingMD,
          paddingBottom: `calc(${token.paddingXL}px + env(safe-area-inset-bottom))`,
        }}
      >
        <Flex vertical gap={token.marginMD} style={{ maxWidth: 680, margin: '0 auto' }}>
          <Card size="small">
            <Flex justify="space-between" align="flex-start" gap={token.marginSM}>
              <Space align="start">
                <span aria-hidden style={{ fontSize: 28, lineHeight: 1 }}>
                  {getBoardEmoji(board, branchById)}
                </span>
                <div>
                  <Title level={4} style={{ margin: 0 }}>
                    {board.name}
                  </Title>
                  <Text type="secondary">
                    {branches.length} {branches.length === 1 ? 'branch' : 'branches'}
                  </Text>
                </div>
              </Space>
              <Button
                type="text"
                aria-label={`Open comments for ${board.name}`}
                icon={<CommentOutlined />}
                onClick={() => navigate(`/m/comments/${board.board_id}`)}
              />
            </Flex>
            {board.description && (
              <Paragraph type="secondary" style={{ marginBlock: token.marginSM, marginBottom: 0 }}>
                {board.description}
              </Paragraph>
            )}
          </Card>

          {branches.length === 0 ? (
            <Card>
              <Empty description="No branches on this board yet" />
            </Card>
          ) : (
            branches.map((branch) => {
              const sessions = [...(sessionsByBranch.get(branch.branch_id) ?? [])].sort(
                (a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime()
              );
              const repo = repoById.get(branch.repo_id);
              return (
                <Card
                  key={branch.branch_id}
                  size="small"
                  title={
                    <Flex align="center" gap={token.marginXS} wrap>
                      <GitlabOutlined />
                      <Text strong ellipsis style={{ minWidth: 0, flex: 1 }}>
                        {branch.name}
                      </Text>
                      <Tag color={statusColor(branch.filesystem_status)} style={{ margin: 0 }}>
                        {branch.filesystem_status ?? 'unknown'}
                      </Tag>
                    </Flex>
                  }
                >
                  <Flex vertical gap={token.marginSM}>
                    <Text type="secondary" ellipsis>
                      {repo?.slug ?? 'Repository unavailable'}
                    </Text>
                    {branch.filesystem_status === 'failed' && branch.error_message && (
                      <Flex gap={token.marginXS} align="flex-start">
                        <WarningOutlined style={{ color: token.colorError, marginTop: 3 }} />
                        <Text type="danger">{branch.error_message}</Text>
                      </Flex>
                    )}
                    <List
                      size="small"
                      locale={{ emptyText: 'No sessions yet' }}
                      dataSource={sessions.slice(0, 4)}
                      renderItem={(session) => (
                        <List.Item
                          style={{ paddingInline: 0 }}
                          actions={[
                            <Button
                              key="open"
                              type="text"
                              aria-label={`Open ${getSessionDisplayTitle(session)}`}
                              icon={<RightOutlined />}
                              onClick={() => navigate(`/m/session/${session.session_id}`)}
                            />,
                          ]}
                        >
                          <List.Item.Meta
                            title={<Text ellipsis>{getSessionDisplayTitle(session)}</Text>}
                            description={
                              <Space size={token.marginXS} wrap>
                                <Badge
                                  status={session.status === 'running' ? 'processing' : 'default'}
                                />
                                <Text type="secondary">{session.status}</Text>
                                <Text type="secondary">{session.agentic_tool}</Text>
                              </Space>
                            }
                          />
                        </List.Item>
                      )}
                    />
                  </Flex>
                </Card>
              );
            })
          )}
        </Flex>
      </Content>
    </>
  );
};
