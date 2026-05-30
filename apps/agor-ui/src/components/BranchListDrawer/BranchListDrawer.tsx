import type { Board, Branch, Repo, Session } from '@agor-live/client';
import { SearchOutlined } from '@ant-design/icons';
import { Badge, Drawer, Empty, Input, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useMemo, useState } from 'react';
import { getSessionStatusTone, type StatusTone } from '../../utils/sessionStatus';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime, formatTimestampWithRelative } from '../../utils/time';
import { RepoPill } from '../Pill';
import { SessionRelationshipIcon } from '../SessionRelationshipIcon';
import { ToolIcon } from '../ToolIcon';

interface BranchListDrawerProps {
  open: boolean;
  onClose: () => void;
  boards: Board[];
  currentBoardId: string;
  onBoardChange: (boardId: string) => void;
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  sessionsByBranch: Map<string, Session[]>;
  onSessionClick: (sessionId: string) => void;
}

export interface BoardSessionListProps {
  board?: Board;
  currentBoardId: string;
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  sessionsByBranch: Map<string, Session[]>;
  onSessionClick: (sessionId: string) => void;
  onAfterSessionClick?: () => void;
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

export const BranchListDrawer: React.FC<BranchListDrawerProps> = ({
  open,
  onClose,
  boards,
  currentBoardId,
  branchById,
  repoById,
  sessionsByBranch,
  onSessionClick,
}) => {
  const currentBoard = boards.find((b) => b.board_id === currentBoardId);

  return (
    <Drawer
      title={null}
      placement="left"
      size={480}
      open={open}
      onClose={onClose}
      styles={{
        body: { padding: 0 },
      }}
    >
      <BoardSessionList
        board={currentBoard}
        currentBoardId={currentBoardId}
        branchById={branchById}
        repoById={repoById}
        sessionsByBranch={sessionsByBranch}
        onSessionClick={onSessionClick}
        onAfterSessionClick={onClose}
      />
    </Drawer>
  );
};

export const BoardSessionList: React.FC<BoardSessionListProps> = ({
  board,
  currentBoardId,
  branchById,
  repoById,
  sessionsByBranch,
  onSessionClick,
  onAfterSessionClick,
}) => {
  const { token } = theme.useToken();
  const [searchQuery, setSearchQuery] = useState('');

  // Filter sessions by current board (branch-centric model)
  const boardSessions = useMemo(() => {
    // Get branch IDs for this board by iterating the Map
    const boardBranchIds: string[] = [];
    for (const branch of branchById.values()) {
      if (branch.board_id === currentBoardId) {
        boardBranchIds.push(branch.branch_id);
      }
    }

    // Get sessions for these branches using O(1) Map lookups, sorted by last_updated desc
    return boardBranchIds
      .flatMap((branchId) => sessionsByBranch.get(branchId) || [])
      .sort((a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime());
  }, [sessionsByBranch, branchById, currentBoardId]);

  // Filter sessions by search query
  const filteredSessions = boardSessions.filter(
    (session) =>
      session.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      session.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      session.agentic_tool.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div style={{ height: '100%', position: 'relative', overflow: 'hidden' }}>
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
        {filteredSessions.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No sessions in this board"
            style={{ padding: '24px 0' }}
          />
        ) : (
          filteredSessions.map((session) => {
            const branch = session.branch_id ? branchById.get(session.branch_id) : undefined;
            const repo = branch ? repoById.get(branch.repo_id) : undefined;

            return (
              <div
                key={session.session_id}
                style={{
                  cursor: 'pointer',
                  padding: '10px 24px',
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
                  onAfterSessionClick?.();
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

                {/* Line 2: repo+branch pill · relative timestamp */}
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
                    {repo && branch ? (
                      <RepoPill repoName={repo.slug} branchName={branch.name} color="default" />
                    ) : branch ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        🌳 {branch.name}
                      </Typography.Text>
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        No branch
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
              </div>
            );
          })
        )}
      </div>

      {/* Board Info Footer */}
      {board && (
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
            {board.description && ` • ${board.description}`}
          </Typography.Text>
        </div>
      )}
    </div>
  );
};

export default BranchListDrawer;
