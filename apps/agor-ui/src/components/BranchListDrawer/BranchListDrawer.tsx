import type { Board, Branch, Repo, Session } from '@agor-live/client';
import { SearchOutlined } from '@ant-design/icons';
import { Badge, Drawer, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import {
  getMatchSnippet,
  isSessionSearchActive,
  SESSION_SORT_STORAGE_KEY,
  type SessionSort,
  searchSessions,
  sessionToolMatches,
  sortSessions,
} from '../../utils/sessionSearch';
import { getSessionStatusTone, type StatusTone } from '../../utils/sessionStatus';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime, formatTimestampWithRelative } from '../../utils/time';
import { BranchBoardLocatorIcon } from '../BranchBoardLocatorIcon';
import { HighlightMatch } from '../HighlightMatch';
import { BranchPill } from '../Pill';
import { SessionRelationshipIcon } from '../SessionRelationshipIcon';
import { SessionRelevanceLabel, SessionSearchToolbar } from '../SessionSearchControls';
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
  const [sort, setSort] = useLocalStorage<SessionSort>(SESSION_SORT_STORAGE_KEY, 'recent');

  // Filter sessions by current board (branch-centric model)
  const boardSessions = useMemo(() => {
    // Get branch IDs for this board by iterating the Map
    const boardBranchIds: string[] = [];
    for (const branch of branchById.values()) {
      if (branch.board_id === currentBoardId) {
        boardBranchIds.push(branch.branch_id);
      }
    }

    return boardBranchIds.flatMap((branchId) => sessionsByBranch.get(branchId) || []);
  }, [sessionsByBranch, branchById, currentBoardId]);

  const trimmedQuery = searchQuery.trim();
  const searchActive = isSessionSearchActive(trimmedQuery);
  const displaySessions = useMemo(
    () =>
      searchActive
        ? searchSessions(boardSessions, trimmedQuery).map(({ session }) => session)
        : sortSessions(boardSessions, sort),
    [boardSessions, searchActive, trimmedQuery, sort]
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
        <SessionSearchToolbar
          value={searchQuery}
          onChange={setSearchQuery}
          sort={sort}
          onSortChange={setSort}
          searching={searchActive}
        />
      </div>

      {/* Session List */}
      <div style={{ padding: '8px 0' }}>
        {displaySessions.length === 0 ? (
          searchActive ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                padding: '28px 16px',
                gap: 6,
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: token.colorFillTertiary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 2,
                }}
              >
                <SearchOutlined style={{ fontSize: 16, color: token.colorTextTertiary }} />
              </div>
              <Typography.Text strong style={{ fontSize: 13 }}>
                No results
              </Typography.Text>
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, textAlign: 'center', lineHeight: 1.5, maxWidth: 200 }}
              >
                Nothing matched <Typography.Text code>{trimmedQuery}</Typography.Text>
              </Typography.Text>
            </div>
          ) : (
            <Typography.Text
              type="secondary"
              style={{ display: 'block', textAlign: 'center', padding: '24px 0', fontSize: 12 }}
            >
              No sessions in this board
            </Typography.Text>
          )
        ) : (
          displaySessions.map((session) => {
            const branch = session.branch_id ? branchById.get(session.branch_id) : undefined;
            const repo = branch ? repoById.get(branch.repo_id) : undefined;
            const titleText = getSessionDisplayTitle(session, {
              includeAgentFallback: true,
            });
            const descriptionSnippet =
              searchActive && session.title && session.description
                ? getMatchSnippet(session.description, trimmedQuery)
                : null;
            const toolMatches = searchActive && sessionToolMatches(session, trimmedQuery);

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
                  <Typography.Text
                    ellipsis={{ tooltip: titleText }}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    <HighlightMatch text={titleText} query={trimmedQuery} />
                  </Typography.Text>
                  <SessionRelationshipIcon session={session} />
                  <BranchBoardLocatorIcon branch={branch} />
                </div>

                {toolMatches && (
                  <Typography.Text
                    type="secondary"
                    style={{
                      display: 'block',
                      fontSize: 11,
                      marginTop: 3,
                      marginLeft: 26,
                    }}
                  >
                    Agent: <HighlightMatch text={session.agentic_tool} query={trimmedQuery} />
                  </Typography.Text>
                )}

                {descriptionSnippet && descriptionSnippet !== titleText && (
                  <Typography.Text
                    type="secondary"
                    style={{
                      fontSize: 11,
                      display: 'block',
                      marginTop: 3,
                      marginLeft: 26,
                      lineHeight: 1.4,
                      fontStyle: 'italic',
                    }}
                  >
                    <HighlightMatch text={descriptionSnippet} query={trimmedQuery} />
                  </Typography.Text>
                )}

                {/* Line 2: compact, non-interactive branch pill · relative timestamp */}
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
                    {branch ? (
                      <BranchPill
                        branch={branch.name}
                        compact
                        title={repo ? `${repo.slug} / ${branch.name}` : branch.name}
                      />
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
            {searchActive ? (
              <>
                {displaySessions.length} of {boardSessions.length} · <SessionRelevanceLabel />
                {board.description && ` • ${board.description}`}
              </>
            ) : (
              `${boardSessions.length} session${boardSessions.length === 1 ? '' : 's'}${
                board.description ? ` • ${board.description}` : ''
              }`
            )}
          </Typography.Text>
        </div>
      )}
    </div>
  );
};

export default BranchListDrawer;
