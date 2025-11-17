import type { Board, BoardComment, Session, Task, Worktree } from '@agor/core/types';
import { CommentOutlined, DownOutlined } from '@ant-design/icons';
import { Badge, Button, Collapse, List, Space, Typography, theme } from 'antd';
import { useNavigate } from 'react-router-dom';
import { BoardCollapse } from '../BoardCollapse';

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
    return comments.filter((c) => c.board_id === boardId && !c.resolved && !c.parent_comment_id)
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

  // Group sessions by worktree and sort by last_updated DESC
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

  // Sort sessions within each worktree by last_updated (most recent first)
  Object.keys(sessionsByWorktree).forEach((worktreeId) => {
    sessionsByWorktree[worktreeId].sort((a, b) => {
      const aTime = new Date(a.last_updated).getTime();
      const bTime = new Date(b.last_updated).getTime();
      return bTime - aTime; // DESC (most recent first)
    });
  });

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
        items={boards.map((board) => {
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
                <Badge
                  count={activeComments}
                  offset={[-6, 6]}
                  styles={{
                    indicator: {
                      backgroundColor: `${token.colorPrimary}80`, // 0.5 opacity (80 in hex = 128/255 ≈ 0.5)
                      boxShadow: '0 0 0 2px rgba(0, 0, 0, 0.5)',
                    },
                  }}
                >
                  <Button
                    type="text"
                    icon={<CommentOutlined style={{ fontSize: 18 }} />}
                    onClick={(e) => handleCommentsClick(board.board_id, e)}
                    style={{
                      padding: '6px 10px',
                      height: 'auto',
                      color: activeComments > 0 ? token.colorPrimary : token.colorTextSecondary,
                    }}
                  />
                </Badge>
              </Space>
            ),
            children:
              boardWorktrees.length === 0 ? (
                <Text type="secondary">No worktrees on this board</Text>
              ) : (
                <Collapse
                  defaultActiveKey={[]}
                  ghost
                  expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
                  items={boardWorktrees
                    .sort((a, b) => {
                      // Sort worktrees by most recent session activity
                      const aMaxActivity = Math.max(
                        ...(sessionsByWorktree[a.worktree_id] || []).map((s) =>
                          new Date(s.last_updated).getTime()
                        ),
                        0
                      );
                      const bMaxActivity = Math.max(
                        ...(sessionsByWorktree[b.worktree_id] || []).map((s) =>
                          new Date(s.last_updated).getTime()
                        ),
                        0
                      );
                      return bMaxActivity - aMaxActivity; // DESC (most recent first)
                    })
                    .map((worktree) => {
                      const worktreeSessions = sessionsByWorktree[worktree.worktree_id] || [];

                      return {
                        key: worktree.worktree_id,
                        label: (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 2,
                              padding: '2px 0',
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
                        ),
                        children:
                          worktreeSessions.length === 0 ? (
                            <Text
                              type="secondary"
                              style={{ padding: '8px 0 8px 28px', display: 'block' }}
                            >
                              No sessions yet
                            </Text>
                          ) : (
                            <List
                              dataSource={worktreeSessions}
                              renderItem={(session) => (
                                <List.Item
                                  onClick={() => handleSessionClick(session.session_id)}
                                  style={{
                                    cursor: 'pointer',
                                    padding: '6px 8px 6px 28px',
                                    borderRadius: 4,
                                  }}
                                  onMouseEnter={(e) => {
                                    (e.currentTarget as HTMLElement).style.background =
                                      'rgba(255, 255, 255, 0.04)';
                                  }}
                                  onMouseLeave={(e) => {
                                    (e.currentTarget as HTMLElement).style.background =
                                      'transparent';
                                  }}
                                >
                                  <div
                                    style={{
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: 2,
                                      width: '100%',
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <span>{getSessionStatusIcon(session)}</span>
                                      <Text>{getSessionTitle(session.session_id)}</Text>
                                    </div>
                                    <Text
                                      type="secondary"
                                      style={{ fontSize: 11, paddingLeft: 28 }}
                                    >
                                      {session.agentic_tool}
                                      {session.model_config?.model &&
                                        ` • ${session.model_config.model}`}
                                    </Text>
                                  </div>
                                </List.Item>
                              )}
                            />
                          ),
                      };
                    })}
                />
              ),
          };
        })}
      />
    </div>
  );
};
