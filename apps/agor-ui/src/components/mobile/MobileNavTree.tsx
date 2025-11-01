import type { Board, BoardComment, Session, Task, Worktree } from '@agor/core/types';
import { CommentOutlined } from '@ant-design/icons';
import { Badge, Button, Collapse, List, Space, Typography, theme } from 'antd';
import { useNavigate } from 'react-router-dom';
import { BoardCollapse } from '../BoardCollapse';

const { Panel } = Collapse;
const { Text } = Typography;

interface MobileNavTreeProps {
  boards: Board[];
  worktrees: Worktree[];
  sessions: Session[];
  tasks: Record<string, Task[]>;
  comments: BoardComment[];
  onNavigate?: () => void;
}

export const MobileNavTree: React.FC<MobileNavTreeProps> = ({
  boards,
  worktrees,
  sessions,
  tasks,
  comments,
  onNavigate,
}) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();

  const handleSessionClick = (sessionId: string) => {
    navigate(`/m/session/${sessionId}`);
    onNavigate?.();
  };

  const handleCommentsClick = (boardId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent board collapse toggle
    navigate(`/m/comments/${boardId}`);
    onNavigate?.();
  };

  // Count active comments per board (unresolved)
  const getActiveCommentCount = (boardId: string): number => {
    return comments.filter(c => c.board_id === boardId && !c.resolved && !c.parent_comment_id)
      .length;
  };

  // Group worktrees by board
  const worktreesByBoard = worktrees.reduce(
    (acc, worktree) => {
      const boardId = worktree.board_id || 'unassigned';
      if (!acc[boardId]) {
        acc[boardId] = [];
      }
      acc[boardId].push(worktree);
      return acc;
    },
    {} as Record<string, Worktree[]>
  );

  // Group sessions by worktree
  const sessionsByWorktree = sessions.reduce(
    (acc, session) => {
      const worktreeId = session.worktree_id;
      if (!acc[worktreeId]) {
        acc[worktreeId] = [];
      }
      acc[worktreeId].push(session);
      return acc;
    },
    {} as Record<string, Session[]>
  );

  // Get the first task prompt for a session as its title
  const getSessionTitle = (sessionId: string): string => {
    const sessionTasks = tasks[sessionId] || [];
    if (sessionTasks.length > 0 && sessionTasks[0]?.full_prompt) {
      const firstPrompt = sessionTasks[0].full_prompt;
      return firstPrompt.length > 50 ? `${firstPrompt.slice(0, 50)}...` : firstPrompt;
    }
    return `Session ${sessionId.slice(0, 8)}`;
  };

  // Get session status icon
  const getSessionStatusIcon = (session: Session): string => {
    if (session.status === 'running') return '▶️';
    if (session.status === 'completed') return '✅';
    if (session.status === 'failed') return '❌';
    return '⏸️';
  };

  return (
    <div
      style={{
        overflowY: 'auto',
        height: 'calc(100vh - 64px)',
      }}
    >
      <BoardCollapse
        items={boards.map(board => {
          const boardWorktrees = worktreesByBoard[board.board_id] || [];
          const activeComments = getActiveCommentCount(board.board_id);

          return {
            key: board.board_id,
            board,
            badge: (
              <Space size={8}>
                <Badge
                  count={boardWorktrees.length}
                  style={{ backgroundColor: token.colorPrimaryBg }}
                  showZero
                />
                <Button
                  type="text"
                  size="small"
                  icon={<CommentOutlined />}
                  onClick={e => handleCommentsClick(board.board_id, e)}
                  style={{
                    padding: '4px 8px',
                    height: 'auto',
                    color: activeComments > 0 ? token.colorPrimary : token.colorTextSecondary,
                  }}
                >
                  {activeComments > 0 && (
                    <Badge
                      count={activeComments}
                      style={{
                        backgroundColor: token.colorPrimary,
                        marginLeft: 4,
                      }}
                    />
                  )}
                </Button>
              </Space>
            ),
            children:
              boardWorktrees.length === 0 ? (
                <Text type="secondary">No worktrees on this board</Text>
              ) : (
                <Collapse defaultActiveKey={[]} ghost>
                  {boardWorktrees.map(worktree => {
                    const worktreeSessions = sessionsByWorktree[worktree.worktree_id] || [];

                    return (
                      <Panel
                        header={
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 4,
                              padding: '4px 0',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span>🌳</span>
                              <Text strong>{worktree.name}</Text>
                            </div>
                            <Text type="secondary" style={{ fontSize: 12, paddingLeft: 28 }}>
                              {worktreeSessions.length} sessions
                            </Text>
                          </div>
                        }
                        key={worktree.worktree_id}
                      >
                        {worktreeSessions.length === 0 ? (
                          <Text
                            type="secondary"
                            style={{ padding: '8px 0 8px 28px', display: 'block' }}
                          >
                            No sessions yet
                          </Text>
                        ) : (
                          <List
                            dataSource={worktreeSessions}
                            renderItem={session => (
                              <List.Item
                                onClick={() => handleSessionClick(session.session_id)}
                                style={{
                                  cursor: 'pointer',
                                  padding: '12px 8px 12px 28px',
                                  borderRadius: 4,
                                }}
                                onMouseEnter={e => {
                                  (e.currentTarget as HTMLElement).style.background =
                                    'rgba(255, 255, 255, 0.04)';
                                }}
                                onMouseLeave={e => {
                                  (e.currentTarget as HTMLElement).style.background = 'transparent';
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 4,
                                    width: '100%',
                                  }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span>{getSessionStatusIcon(session)}</span>
                                    <Text>{getSessionTitle(session.session_id)}</Text>
                                  </div>
                                  <Text type="secondary" style={{ fontSize: 11, paddingLeft: 28 }}>
                                    {session.agentic_tool}
                                    {session.model_config?.model &&
                                      ` • ${session.model_config.model}`}
                                  </Text>
                                </div>
                              </List.Item>
                            )}
                          />
                        )}
                      </Panel>
                    );
                  })}
                </Collapse>
              ),
          };
        })}
      />
    </div>
  );
};
