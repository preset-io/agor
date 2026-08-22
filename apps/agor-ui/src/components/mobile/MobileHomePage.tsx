import type { Board, Branch, Session, User } from '@agor-live/client';
import {
  AppstoreAddOutlined,
  AppstoreOutlined,
  BulbOutlined,
  PlusOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  Badge,
  Button,
  Card,
  Empty,
  Flex,
  Layout,
  List,
  Space,
  Statistic,
  Typography,
  theme,
} from 'antd';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSessionDisplayTitle } from '@/utils/sessionTitle';
import { formatRelativeTime } from '@/utils/time';
import { getBoardEmoji } from '../BoardTile';
import { MobileHeader } from './MobileHeader';

const { Content } = Layout;
const { Text, Title } = Typography;

interface MobileHomePageProps {
  user?: User | null;
  boardById: Map<string, Board>;
  branchById: Map<string, Branch>;
  sessionById: Map<string, Session>;
  onMenuClick: () => void;
  onOpenSettings: (section: string) => void;
}

export const MobileHomePage: React.FC<MobileHomePageProps> = ({
  user,
  boardById,
  branchById,
  sessionById,
  onMenuClick,
  onOpenSettings,
}) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const boards = useMemo(
    () => Array.from(boardById.values()).filter((board) => !board.archived),
    [boardById]
  );
  const sessions = useMemo(
    () =>
      Array.from(sessionById.values())
        .filter((session) => !session.archived && (!user || session.created_by === user.user_id))
        .sort((a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime()),
    [sessionById, user]
  );
  const { activeBranches, branchCountByBoard } = useMemo(() => {
    let count = 0;
    const byBoard = new Map<string, number>();
    for (const branch of branchById.values()) {
      if (branch.archived) continue;
      count += 1;
      if (branch.board_id) {
        byBoard.set(branch.board_id, (byBoard.get(branch.board_id) ?? 0) + 1);
      }
    }
    return { activeBranches: count, branchCountByBoard: byBoard };
  }, [branchById]);
  const running = sessions.filter((session) => session.status === 'running').length;

  return (
    <>
      <MobileHeader showLogo user={user} onMenuClick={onMenuClick} />
      <Content style={{ overflowY: 'auto', padding: token.paddingMD, paddingBottom: 40 }}>
        <Flex vertical gap={token.marginLG} style={{ maxWidth: 680, margin: '0 auto' }}>
          <div>
            <Title level={4} style={{ margin: 0 }}>
              Hi, {user?.name || 'there'}! 👋
            </Title>
            <Text type="secondary">Here’s an overview of your workspace.</Text>
          </div>
          <Flex gap={token.marginSM} wrap>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => onOpenSettings('teammates')}
            >
              New teammate
            </Button>
            <Button icon={<AppstoreAddOutlined />} onClick={() => onOpenSettings('branches')}>
              New branch
            </Button>
            <Button icon={<AppstoreOutlined />} onClick={() => onOpenSettings('boards')}>
              New board
            </Button>
          </Flex>
          <Flex gap={token.marginSM} wrap>
            <Card size="small" style={{ flex: '1 1 140px' }}>
              <Statistic title="Boards" value={boards.length} prefix={<AppstoreOutlined />} />
            </Card>
            <Card size="small" style={{ flex: '1 1 140px' }}>
              <Statistic
                title="Active branches"
                value={activeBranches}
                prefix={<AppstoreAddOutlined />}
              />
            </Card>
            <Card size="small" style={{ flex: '1 1 140px' }}>
              <Statistic title="Running now" value={running} prefix={<ThunderboltOutlined />} />
            </Card>
          </Flex>
          <section aria-labelledby="mobile-home-sessions">
            <Flex justify="space-between" align="center" style={{ marginBottom: token.marginSM }}>
              <Title id="mobile-home-sessions" level={5} style={{ margin: 0 }}>
                My sessions
              </Title>
              <Text type="secondary">{sessions.length} total</Text>
            </Flex>
            <Card size="small" styles={{ body: { padding: 0 } }}>
              {sessions.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No sessions yet" />
              ) : (
                <List
                  dataSource={sessions.slice(0, 8)}
                  renderItem={(session) => {
                    const branch = branchById.get(session.branch_id);
                    return (
                      <List.Item style={{ padding: 0 }}>
                        <Button
                          type="text"
                          block
                          onClick={() => navigate(`/m/session/${session.session_id}`)}
                          style={{ height: 'auto', padding: token.paddingSM, textAlign: 'start' }}
                        >
                          <List.Item.Meta
                            avatar={
                              <Badge
                                status={session.status === 'running' ? 'processing' : 'default'}
                              />
                            }
                            title={
                              <Text ellipsis>
                                {getSessionDisplayTitle(session, { includeAgentFallback: true })}
                              </Text>
                            }
                            description={
                              <Space size={token.marginXS} wrap>
                                {branch && <Text type="secondary">{branch.name}</Text>}
                                <Text type="secondary">
                                  {formatRelativeTime(session.last_updated)}
                                </Text>
                              </Space>
                            }
                          />
                        </Button>
                      </List.Item>
                    );
                  }}
                />
              )}
            </Card>
          </section>
          <section aria-labelledby="mobile-home-boards">
            <Flex justify="space-between" align="center" style={{ marginBottom: token.marginSM }}>
              <Title id="mobile-home-boards" level={5} style={{ margin: 0 }}>
                Boards
              </Title>
              <Button type="link" onClick={() => onOpenSettings('boards')}>
                Manage
              </Button>
            </Flex>
            {boards.length === 0 ? (
              <Card>
                <Empty description="No boards yet" />
              </Card>
            ) : (
              <Flex vertical gap={token.marginSM}>
                {boards.map((board) => {
                  const branchCount = branchCountByBoard.get(board.board_id) ?? 0;
                  return (
                    <Card
                      key={board.board_id}
                      size="small"
                      hoverable
                      styles={{ body: { padding: 0 } }}
                    >
                      <Button
                        type="text"
                        block
                        onClick={() => navigate(`/m/board/${board.board_id}`)}
                        style={{ height: 'auto', padding: token.paddingSM, textAlign: 'start' }}
                      >
                        <Flex align="center" gap={token.marginSM}>
                          <span aria-hidden style={{ fontSize: 28 }}>
                            {getBoardEmoji(board, branchById)}
                          </span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <Text strong ellipsis style={{ display: 'block' }}>
                              {board.name}
                            </Text>
                            <Text type="secondary">
                              {branchCount} {branchCount === 1 ? 'branch' : 'branches'}
                            </Text>
                          </div>
                        </Flex>
                      </Button>
                    </Card>
                  );
                })}
              </Flex>
            )}
          </section>
          <Card size="small">
            <Flex align="center" justify="space-between" gap={token.marginSM}>
              <Space>
                <BulbOutlined />
                <div>
                  <Text strong>Knowledge Base</Text>
                  <br />
                  <Text type="secondary">Browse team context and documentation</Text>
                </div>
              </Space>
              <Button type="link" onClick={() => navigate('/knowledge')}>
                Open
              </Button>
            </Flex>
          </Card>
          <Card size="small" title="Workspace setup">
            <Flex vertical gap={token.marginXS}>
              <Button block icon={<AppstoreOutlined />} onClick={() => onOpenSettings('repos')}>
                Connect a repository
              </Button>
              <Button block icon={<RobotOutlined />} onClick={() => onOpenSettings('mcp')}>
                Configure MCP tools
              </Button>
            </Flex>
          </Card>
        </Flex>
      </Content>
    </>
  );
};
