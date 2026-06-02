import type { Board, Branch, Repo, Session } from '@agor-live/client';
import { SearchOutlined } from '@ant-design/icons';
import { Badge, Drawer, Empty, Input, Select, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { getSessionStatusTone, type StatusTone } from '../../utils/sessionStatus';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime, formatTimestampWithRelative } from '../../utils/time';
import { HighlightMatch, SESSION_SORT_OPTIONS, type SessionSort, getMatchSnippet, scoreSession, sortSessions } from '../../utils/sessionSearch';
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
  const [inputValue, setInputValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useState<SessionSort>('recent');

  // Debounce input → searchQuery by 150 ms
  useEffect(() => {
    const id = setTimeout(() => setSearchQuery(inputValue), 150);
    return () => clearTimeout(id);
  }, [inputValue]);

  // Collect sessions for current board (unsorted — sort applied separately)
  const boardSessions = useMemo(() => {
    const boardBranchIds: string[] = [];
    for (const branch of branchById.values()) {
      if (branch.board_id === currentBoardId) {
        boardBranchIds.push(branch.branch_id);
      }
    }
    return boardBranchIds.flatMap((branchId) => sessionsByBranch.get(branchId) || []);
  }, [sessionsByBranch, branchById, currentBoardId]);

  const displaySessions = useMemo(() => {
    if (!searchQuery.trim()) return sortSessions(boardSessions, sort);

    return boardSessions
      .map((s) => ({ session: s, score: scoreSession(s, searchQuery) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ session }) => session);
  }, [boardSessions, searchQuery, sort]);

  return (
    <div style={{ height: '100%', position: 'relative', overflow: 'hidden' }}>
      {/* Search Bar + Sort */}
      <div
        style={{
          padding: '16px 24px',
          borderBottom: `1px solid ${token.colorBorder}`,
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Input
            style={{ flex: 1 }}
            placeholder="Search sessions..."
            prefix={<SearchOutlined />}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            allowClear
          />
          <Select
            value={sort}
            onChange={setSort}
            size="small"
            style={{ width: 96, flexShrink: 0 }}
            disabled={!!searchQuery.trim()}
            options={SESSION_SORT_OPTIONS}
          />
        </div>
      </div>

      {/* Session List */}
      <div style={{ padding: '8px 0' }}>
        {displaySessions.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              searchQuery.trim()
                ? `No sessions match "${searchQuery}"`
                : 'No sessions in this board'
            }
            style={{ padding: '24px 0' }}
          />
        ) : (
          displaySessions.map((session) => {
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
                {(() => {
                  const titleText = getSessionDisplayTitle(session, { includeAgentFallback: true });
                  const titleLower = titleText.toLowerCase();
                  const qLower = searchQuery.trim().toLowerCase();
                  const titleMatches = searchQuery.trim() && titleLower.includes(qLower);
                  const descSnippet =
                    searchQuery.trim() && !titleMatches && session.description
                      ? getMatchSnippet(session.description, searchQuery)
                      : null;

                  return (
                    <>
                      {/* Line 1: tool icon + title + genealogy icon */}
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
                        <Typography.Text
                          ellipsis={{ tooltip: titleText }}
                          style={{ flex: 1, minWidth: 0 }}
                        >
                          {searchQuery.trim() ? (
                            <HighlightMatch text={titleText} query={searchQuery} />
                          ) : (
                            titleText
                          )}
                        </Typography.Text>
                        <SessionRelationshipIcon session={session} />
                      </div>

                      {/* Description snippet — only shown when match is in description, not in title */}
                      {descSnippet && (
                        <Typography.Text
                          type="secondary"
                          style={{
                            fontSize: 11,
                            display: 'block',
                            marginTop: 3,
                            marginLeft: 26, // aligns under title text (icon 18px + gap 8px)
                            lineHeight: 1.4,
                            fontStyle: 'italic',
                          }}
                        >
                          <HighlightMatch text={descSnippet} query={searchQuery} />
                        </Typography.Text>
                      )}

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
                    </>
                  );
                })()}
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
            {searchQuery.trim()
              ? `${displaySessions.length} result${displaySessions.length !== 1 ? 's' : ''} · sorted by relevance`
              : `${displaySessions.length} session${displaySessions.length !== 1 ? 's' : ''}${sort !== 'recent' ? ` · ${sort === 'alpha' ? 'A–Z' : 'oldest first'}` : ''}`
            }
            {board.description && ` • ${board.description}`}
          </Typography.Text>
        </div>
      )}
    </div>
  );
};

export default BranchListDrawer;
