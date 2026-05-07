import type { Board, Repo, Session, Worktree } from '@agor-live/client';
import { ForkOutlined, SearchOutlined, SubnodeOutlined } from '@ant-design/icons';
import { Badge, Drawer, Input, List, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useMemo, useState } from 'react';
import { getSessionDisplayTitle, getSessionTitleStyles } from '../../utils/sessionTitle';
import { formatRelativeTime, formatTimestampWithRelative } from '../../utils/time';
import { RepoPill } from '../Pill';
import { ToolIcon } from '../ToolIcon';

interface WorktreeListDrawerProps {
  open: boolean;
  onClose: () => void;
  boards: Board[];
  currentBoardId: string;
  onBoardChange: (boardId: string) => void;
  worktreeById: Map<string, Worktree>;
  repoById: Map<string, Repo>;
  sessionsByWorktree: Map<string, Session[]>;
  onSessionClick: (sessionId: string) => void;
}

/**
 * Maps every SessionStatus to an Ant Badge status color.
 * Today's drawer only colored 3 of 8 statuses; this covers the full set so
 * the dot is glanceable for awaiting_permission, awaiting_input, timed_out,
 * stopping, and idle as well.
 */
const getStatusColor = (
  status: Session['status']
): 'success' | 'processing' | 'error' | 'warning' | 'default' => {
  switch (status) {
    case 'running':
    case 'stopping':
      return 'processing';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'awaiting_permission':
    case 'awaiting_input':
    case 'timed_out':
      return 'warning';
    default:
      return 'default';
  }
};

/**
 * Small inline relationship icon when a session was forked from a sibling or
 * spawned from a parent. Visual grammar matches WorktreeCard.tsx so the same
 * icon means the same thing wherever sessions appear.
 */
const GenealogyIndicator: React.FC<{ session: Session }> = ({ session }) => {
  const { token } = theme.useToken();
  const parentId = session.genealogy?.parent_session_id;
  const forkedFromId = session.genealogy?.forked_from_session_id;

  if (parentId) {
    return (
      <Tooltip title={`Spawned from ${parentId.substring(0, 8)}`}>
        <SubnodeOutlined style={{ fontSize: 11, color: token.colorInfo, flexShrink: 0 }} />
      </Tooltip>
    );
  }
  if (forkedFromId) {
    return (
      <Tooltip title={`Forked from ${forkedFromId.substring(0, 8)}`}>
        <ForkOutlined style={{ fontSize: 11, color: token.colorWarning, flexShrink: 0 }} />
      </Tooltip>
    );
  }
  return null;
};

export const WorktreeListDrawer: React.FC<WorktreeListDrawerProps> = ({
  open,
  onClose,
  boards,
  currentBoardId,
  onBoardChange,
  worktreeById,
  repoById,
  sessionsByWorktree,
  onSessionClick,
}) => {
  const { token } = theme.useToken();
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

  return (
    <Drawer
      title={null}
      placement="left"
      size={400}
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
          renderItem={(session) => {
            const worktree = session.worktree_id
              ? worktreeById.get(session.worktree_id)
              : undefined;
            const repo = worktree ? repoById.get(worktree.repo_id) : undefined;

            return (
              <List.Item
                style={{
                  cursor: 'pointer',
                  padding: '10px 24px',
                  transition: 'background 0.2s',
                  display: 'block', // override List.Item flex so our 2-line layout owns the row
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
                {/* Line 1: status dot · tool icon · title · genealogy */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    minWidth: 0,
                  }}
                >
                  <Badge
                    status={getStatusColor(session.status)}
                    style={{ marginTop: 6, flexShrink: 0 }}
                  />
                  <ToolIcon tool={session.agentic_tool} size={14} />
                  <Typography.Text
                    strong
                    style={{ ...getSessionTitleStyles(2), flex: 1, minWidth: 0 }}
                  >
                    {getSessionDisplayTitle(session, { includeAgentFallback: true })}
                  </Typography.Text>
                  <GenealogyIndicator session={session} />
                </div>

                {/* Line 2: repo+worktree pill · relative timestamp */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginTop: 6,
                    marginLeft: 22, // align under title (badge 6 + gap 8 + icon 14 - approx)
                    minWidth: 0,
                  }}
                >
                  <div style={{ minWidth: 0, overflow: 'hidden' }}>
                    {repo && worktree ? (
                      <RepoPill repoName={repo.slug} worktreeName={worktree.name} />
                    ) : worktree ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        🌳 {worktree.name}
                      </Typography.Text>
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        No worktree
                      </Typography.Text>
                    )}
                  </div>
                  <Tooltip title={formatTimestampWithRelative(session.last_updated)}>
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}
                    >
                      {formatRelativeTime(session.last_updated)}
                    </Typography.Text>
                  </Tooltip>
                </div>
              </List.Item>
            );
          }}
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
