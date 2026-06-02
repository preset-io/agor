import type { Board, Branch, Repo, Session } from '@agor-live/client';
import { SearchOutlined } from '@ant-design/icons';
import { Badge, Drawer, Empty, Input, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
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

const SCORE_WEIGHTS = {
  TITLE_EXACT: 1000,
  TITLE_STARTS: 800,
  TITLE_PHRASE: 600,
  TITLE_ALL_WORDS: 400,
  TITLE_PARTIAL_WORDS: 200,
  DESC_PHRASE: 120,
  DESC_ALL_WORDS: 80,
  DESC_PARTIAL_WORDS: 40,
  TOOL_MATCH: 30,
  STATUS_RUNNING: 20,
  STATUS_AWAITING: 15,
  RECENCY_MAX: 50,
} as const;

function scoreSession(session: Session, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const words = q.split(/\s+/).filter(Boolean);
  const displayTitle = getSessionDisplayTitle(session, { includeAgentFallback: false }).toLowerCase();
  const desc = (session.description ?? '').toLowerCase();
  const tool = session.agentic_tool.toLowerCase();

  let score = 0;

  // Title scoring
  if (displayTitle === q) {
    score += SCORE_WEIGHTS.TITLE_EXACT;
  } else if (displayTitle.startsWith(q)) {
    score += SCORE_WEIGHTS.TITLE_STARTS;
  } else if (displayTitle.includes(q)) {
    score += SCORE_WEIGHTS.TITLE_PHRASE;
  } else {
    const matched = words.filter((w) => displayTitle.includes(w));
    if (matched.length === words.length) {
      score += SCORE_WEIGHTS.TITLE_ALL_WORDS;
    } else if (matched.length > 0) {
      score += Math.round(SCORE_WEIGHTS.TITLE_PARTIAL_WORDS * (matched.length / words.length));
    }
  }

  // Description scoring (skip if description is empty or same as title)
  if (desc && desc !== displayTitle) {
    if (desc.includes(q)) {
      score += SCORE_WEIGHTS.DESC_PHRASE;
    } else {
      const matched = words.filter((w) => desc.includes(w));
      if (matched.length === words.length) {
        score += SCORE_WEIGHTS.DESC_ALL_WORDS;
      } else if (matched.length > 0) {
        score += Math.round(SCORE_WEIGHTS.DESC_PARTIAL_WORDS * (matched.length / words.length));
      }
    }
  }

  // Tool match
  if (words.some((w) => tool.includes(w))) {
    score += SCORE_WEIGHTS.TOOL_MATCH;
  }

  // Recency bonus — only added when there is already a match (score > 0)
  if (score > 0) {
    const ageDays = (Date.now() - new Date(session.last_updated).getTime()) / 86_400_000;
    score += Math.round(SCORE_WEIGHTS.RECENCY_MAX * Math.exp(-ageDays));
  }

  // Status bonus for actively running sessions
  if (session.status === 'running') score += SCORE_WEIGHTS.STATUS_RUNNING;
  else if (session.status === 'awaiting_permission') score += SCORE_WEIGHTS.STATUS_AWAITING;

  return score;
}

function getMatchSnippet(text: string, query: string, contextLen = 60): string | null {
  if (!text || !query.trim()) return null;

  const q = query.trim().toLowerCase();
  const lower = text.toLowerCase();

  let pos = lower.indexOf(q);
  if (pos === -1) {
    for (const w of q.split(/\s+/).filter(Boolean)) {
      const idx = lower.indexOf(w);
      if (idx !== -1) { pos = idx; break; }
    }
  }
  if (pos === -1) return null;

  const start = Math.max(0, pos - contextLen);
  const end = Math.min(text.length, pos + Math.max(q.length, 10) + contextLen);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet = snippet + '…';
  return snippet;
}

const HighlightMatch: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const { token } = theme.useToken();
  if (!query.trim() || !text) return <>{text}</>;

  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(re);

  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? ( // odd indices are matches from split with capture group
          <mark
            // biome-ignore lint/suspicious/noArrayIndexKey: positional marks in a static string split
            key={i}
            style={{
              background: token.colorWarningBg,
              color: 'inherit',
              padding: '0 1px',
              borderRadius: 2,
            }}
          >
            {part}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional text in a static string split
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
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

  // Debounce input → searchQuery by 150 ms
  useEffect(() => {
    const id = setTimeout(() => setSearchQuery(inputValue), 150);
    return () => clearTimeout(id);
  }, [inputValue]);

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

  const displaySessions = useMemo(() => {
    if (!searchQuery.trim()) return boardSessions; // recency order, no filter

    return boardSessions
      .map((s) => ({ session: s, score: scoreSession(s, searchQuery) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ session }) => session);
  }, [boardSessions, searchQuery]);

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
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          allowClear
        />
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
              : `${boardSessions.length} session${boardSessions.length !== 1 ? 's' : ''}`
            }
            {board.description && ` • ${board.description}`}
          </Typography.Text>
        </div>
      )}
    </div>
  );
};

export default BranchListDrawer;
