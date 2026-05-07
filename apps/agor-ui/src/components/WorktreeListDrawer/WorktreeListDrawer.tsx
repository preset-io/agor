import type { Board, Repo, Session, Worktree } from '@agor-live/client';
import { SearchOutlined } from '@ant-design/icons';
import { Badge, Drawer, Input, List, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useMemo, useState } from 'react';
import { getSessionStatusTone, type StatusTone } from '../../utils/sessionStatus';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime, formatTimestampWithRelative } from '../../utils/time';
import { RepoPill } from '../Pill';
import { SessionRelationshipIcon } from '../SessionRelationshipIcon';
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
 * Drawer suppresses badges for the "boring" tones (`success`/`default`) so
 * idle and completed rows show a clean avatar with no decoration. The absence
 * of a badge becomes its own signal: "nothing to see here". `processing` uses
 * Ant's pulsing animation so it doubles as a live-activity indicator.
 */
const getBadgeTone = (
  status: Session['status']
): Exclude<StatusTone, 'success' | 'default'> | null => {
  const tone = getSessionStatusTone(status);
  return tone === 'success' || tone === 'default' ? null : tone;
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
      width={480}
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
                {/* Line 1: tool icon (with corner status badge) · title · genealogy */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    minWidth: 0,
                  }}
                >
                  <span style={{ flexShrink: 0, display: 'inline-flex' }}>
                    {(() => {
                      const tone = getBadgeTone(session.status);
                      const icon = <ToolIcon tool={session.agentic_tool} size={18} />;
                      return tone ? (
                        <Badge dot status={tone} offset={[-3, 3]}>
                          {icon}
                        </Badge>
                      ) : (
                        icon
                      );
                    })()}
                  </span>
                  {(() => {
                    const titleText = getSessionDisplayTitle(session, {
                      includeAgentFallback: true,
                    });
                    return (
                      <Typography.Text
                        ellipsis={{ tooltip: titleText }}
                        style={{ flex: 1, minWidth: 0 }}
                      >
                        {titleText}
                      </Typography.Text>
                    );
                  })()}
                  <SessionRelationshipIcon session={session} />
                </div>

                {/* Line 2: repo+worktree pill · relative timestamp */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginTop: 6,
                    marginLeft: 26, // align under title (icon 18 + gap 8)
                    minWidth: 0,
                  }}
                >
                  <div style={{ minWidth: 0, overflow: 'hidden' }}>
                    {repo && worktree ? (
                      <RepoPill repoName={repo.slug} worktreeName={worktree.name} color="default" />
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
