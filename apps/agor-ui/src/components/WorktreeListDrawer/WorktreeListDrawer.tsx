import type { Board, Session, Worktree } from '@agor/core/types';
import { SearchOutlined } from '@ant-design/icons';
import { Badge, Drawer, Input, List, Space, Typography, theme } from 'antd';
import type React from 'react';
import { useMemo, useState } from 'react';
import { ToolIcon } from '../ToolIcon';

const { useToken } = theme;

interface WorktreeListDrawerProps {
  open: boolean;
  onClose: () => void;
  boards: Board[];
  currentBoardId: string;
  onBoardChange: (boardId: string) => void;
  worktreeById: Map<string, Worktree>;
  sessionsByWorktree: Map<string, Session[]>;
  onSessionClick: (sessionId: string) => void;
}

export const WorktreeListDrawer: React.FC<WorktreeListDrawerProps> = ({
  open,
  onClose,
  boards,
  currentBoardId,
  onBoardChange,
  worktreeById,
  sessionsByWorktree,
  onSessionClick,
}) => {
  const { token } = useToken();
  const [searchQuery, setSearchQuery] = useState('');

  // Get current board
  const currentBoard = boards.find((b) => b.board_id === currentBoardId);

  // Filter sessions by current board (worktree-centric model)
  const boardSessions = useMemo(() => {
    // Get worktree IDs for this board by iterating the Map
    const boardWorktreeIds: string[] = [];
    for (const worktree of worktreeById.values()) {
      if (worktree.board_id === currentBoardId) {
        boardWorktreeIds.push(worktree.worktree_id);
      }
    }

    // Get sessions for these worktrees using O(1) Map lookups, sorted by last_updated desc
    return boardWorktreeIds
      .flatMap((worktreeId) => sessionsByWorktree.get(worktreeId) || [])
      .sort((a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime());
  }, [sessionsByWorktree, worktreeById, currentBoardId]);

  // Filter sessions by search query
  const filteredSessions = boardSessions.filter(
    (session) =>
      session.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      session.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      session.agentic_tool.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getStatusColor = (status: Session['status']) => {
    switch (status) {
      case 'running':
        return 'processing';
      case 'completed':
        return 'success';
      case 'failed':
        return 'error';
      default:
        return 'default';
    }
  };

  // Get worktree name for session
  const getWorktreeName = (worktreeId: string) => {
    return worktreeById.get(worktreeId)?.name || 'Unknown';
  };

  return (
    <Drawer
      title={null}
      placement="left"
      width={400}
      open={open}
      onClose={onClose}
      styles={{
        body: { padding: 0 },
      }}
    >
      {/* Search Bar */}
      <div
        style={{
          padding: '16px 24px',
          borderBottom: `1px solid ${token.colorBorder}`,
        }}
      >
        <Input
          placeholder="Search sessions..."
          prefix={<SearchOutlined />}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          allowClear
        />
      </div>

      {/* Session List */}
      <div style={{ padding: '8px 0' }}>
        <List
          dataSource={filteredSessions}
          locale={{ emptyText: 'No sessions in this board' }}
          renderItem={(session) => (
            <List.Item
              style={{
                cursor: 'pointer',
                padding: '12px 24px',
                transition: 'background 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = token.colorBgTextHover;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
              onClick={() => {
                onSessionClick(session.session_id);
                onClose();
              }}
            >
              <List.Item.Meta
                avatar={<ToolIcon tool={session.agentic_tool} size={24} />}
                title={
                  <Space size={8}>
                    <Typography.Text strong>
                      {session.title || session.description || session.agentic_tool}
                    </Typography.Text>
                    <Badge status={getStatusColor(session.status)} />
                  </Space>
                }
                description={
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {session.agentic_tool} • {session.tasks.length}{' '}
                      {session.tasks.length === 1 ? 'task' : 'tasks'}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      🌳{' '}
                      {session.worktree_id ? getWorktreeName(session.worktree_id) : 'No worktree'}
                    </Typography.Text>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      </div>

      {/* Board Info Footer */}
      {currentBoard && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: '16px 24px',
            borderTop: `1px solid ${token.colorBorder}`,
            background: token.colorBgContainer,
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {filteredSessions.length} of {boardSessions.length} sessions
            {currentBoard.description && ` • ${currentBoard.description}`}
          </Typography.Text>
        </div>
      )}
    </Drawer>
  );
};

export default WorktreeListDrawer;
