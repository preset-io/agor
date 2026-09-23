import type { Board, Branch, Session } from '@agor-live/client';
import { PlusOutlined } from '@ant-design/icons';
import { Button, Flex, theme } from 'antd';
import type React from 'react';
import { memo, useMemo, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectBranchById, selectSessionsByBranch } from '../../store/selectors';
import { getTimeMs } from '../../utils/entityTime';
import { formatRelativeTime } from '../../utils/time';
import { BoardTile, getBoardEmoji } from '../BoardTile';
import { HomeBlock, HomeEmpty, HomeLink } from './HomeBlock';
import type { HomePageProps } from './types';

const HOME_BOARDS_LIMIT = 50;
/** Home shows the most relevant boards; "View all" reveals the rest. */
const HOME_BOARDS_PREVIEW = 8;

/**
 * Everything below `board` is a primitive so the memo'd card bails out of
 * re-renders unless ITS board's display data actually changed — passing the
 * per-board branch/session arrays instead would defeat the memo (they're
 * rebuilt fresh on every derivation pass).
 */
interface BoardHomeRow {
  board: Board;
  emoji: string | undefined;
  branchCount: number;
  activeCount: number;
  latestSessionAt: Session['last_updated'] | null;
  latest: number;
  visitRank: number;
}

const groupBranchesByBoard = (branchById: Map<string, Branch>): Map<string, Branch[]> => {
  const grouped = new Map<string, Branch[]>();
  for (const branch of branchById.values()) {
    if (branch.archived || !branch.board_id) continue;
    const branches = grouped.get(branch.board_id) ?? [];
    branches.push(branch);
    grouped.set(branch.board_id, branches);
  }
  return grouped;
};

// Keyed by the per-branch session bucket array reference. The store preserves
// untouched buckets by reference across patches, so a session:patched on one
// branch leaves every other branch's filtered result cached — no re-filter of
// the whole workspace on every notify.
const visibleSessionsCache = new WeakMap<Session[], Session[]>();

const filterVisibleSessions = (sessions: Session[]): Session[] => {
  const cached = visibleSessionsCache.get(sessions);
  if (cached) return cached;
  const visible = sessions.filter((session) => !session.archived);
  visibleSessionsCache.set(sessions, visible);
  return visible;
};

const groupVisibleSessionsByBranch = (
  sessionsByBranch: Map<string, Session[]>
): Map<string, Session[]> => {
  const grouped = new Map<string, Session[]>();
  for (const [branchId, sessions] of sessionsByBranch) {
    const visibleSessions = filterVisibleSessions(sessions);
    if (visibleSessions.length > 0) grouped.set(branchId, visibleSessions);
  }
  return grouped;
};

const activeSessions = (sessions: Session[]) =>
  sessions.filter(
    (s) =>
      s.status === 'running' || s.status === 'awaiting_permission' || s.status === 'awaiting_input'
  );

const BoardHomeCard = memo(function BoardHomeCard({
  board,
  emoji,
  branchCount,
  activeCount,
  latestSessionAt,
  onBoardClick,
}: {
  board: Board;
  emoji: string | undefined;
  branchCount: number;
  activeCount: number;
  latestSessionAt: Session['last_updated'] | null;
  onBoardClick: (boardId: string) => void;
}) {
  const { token } = theme.useToken();
  const branches = `${branchCount} branch${branchCount !== 1 ? 'es' : ''}`;
  const lastSession = latestSessionAt
    ? `Last session ${formatRelativeTime(latestSessionAt)}`
    : 'No sessions yet';

  // Surface, border and hover/focus states come from .agor-home-tile (index.css).
  return (
    <button
      type="button"
      className="agor-home-tile"
      aria-label={[
        `Open board ${board.name}`,
        branches,
        activeCount > 0 && `${activeCount} active`,
        lastSession,
      ]
        .filter(Boolean)
        .join('; ')}
      title={`${board.name}\n${lastSession}`}
      onClick={() => onBoardClick(board.board_id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: token.marginSM,
        minWidth: 0,
        padding: token.paddingSM,
        borderRadius: token.borderRadiusLG,
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
      }}
    >
      <BoardTile emoji={emoji} size={36} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontSize: token.fontSize,
            fontWeight: 500,
            color: token.colorText,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {board.name}
        </span>
        <Flex align="center" gap={token.marginXS} style={{ fontSize: token.fontSizeSM }}>
          <span style={{ color: token.colorTextTertiary }}>{branches}</span>
          {activeCount > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: token.marginXXS,
                color: token.colorTextSecondary,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: token.colorSuccess,
                }}
              />
              {activeCount} active
            </span>
          )}
        </Flex>
      </span>
    </button>
  );
});

export const HomeBoardsSection: React.FC<
  Pick<HomePageProps, 'recentBoardIds' | 'onBoardClick' | 'onOpenCreateDialog'>
> = ({ recentBoardIds = [], onBoardClick, onOpenCreateDialog }) => {
  const boardById = useAgorStore(selectBoardById);
  const branchById = useAgorStore(selectBranchById);
  const sessionsByBranch = useAgorStore(selectSessionsByBranch);
  const { token } = theme.useToken();
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    const visitRank = new Map((recentBoardIds ?? []).map((boardId, index) => [boardId, index]));
    const branchesByBoard = groupBranchesByBoard(branchById);
    const visibleSessionsByBranch = groupVisibleSessionsByBranch(sessionsByBranch);

    return Array.from(boardById.values())
      .filter((board) => !board.archived)
      .map<BoardHomeRow>((board) => {
        const branches = branchesByBoard.get(board.board_id) ?? [];
        const sessions = branches.flatMap(
          (branch) => visibleSessionsByBranch.get(branch.branch_id) ?? []
        );
        let latestSessionAt: BoardHomeRow['latestSessionAt'] = null;
        let latestSessionTime = Number.NEGATIVE_INFINITY;
        for (const session of sessions) {
          const time = getTimeMs(session, 'last_updated');
          if (time > latestSessionTime) {
            latestSessionTime = time;
            latestSessionAt = session.last_updated;
          }
        }
        const latest = Math.max(
          getTimeMs(board, 'last_updated'),
          ...branches.map((branch) =>
            getTimeMs(branch, branch.updated_at ? 'updated_at' : 'created_at')
          ),
          latestSessionTime
        );
        return {
          board,
          emoji: getBoardEmoji(board, branchById),
          branchCount: branches.length,
          activeCount: activeSessions(sessions).length,
          latestSessionAt,
          latest: Number.isFinite(latest) ? latest : 0,
          visitRank: visitRank.get(board.board_id) ?? Number.POSITIVE_INFINITY,
        };
      })
      .sort(
        (a, b) =>
          a.visitRank - b.visitRank ||
          b.latest - a.latest ||
          a.board.name.localeCompare(b.board.name)
      )
      .slice(0, HOME_BOARDS_LIMIT);
  }, [boardById, recentBoardIds, branchById, sessionsByBranch]);

  const visibleRows = showAll ? rows : rows.slice(0, HOME_BOARDS_PREVIEW);

  return (
    <HomeBlock
      label="Boards"
      count={rows.length || undefined}
      actions={
        <>
          <HomeLink onClick={() => onOpenCreateDialog('board')}>
            <PlusOutlined /> New board
          </HomeLink>
          {rows.length > HOME_BOARDS_PREVIEW && (
            <HomeLink onClick={() => setShowAll((open) => !open)}>
              {showAll ? 'Show less' : `View all ${rows.length}`}
            </HomeLink>
          )}
        </>
      }
    >
      {rows.length === 0 ? (
        <HomeEmpty>
          No boards yet.{' '}
          <Button
            type="link"
            size="small"
            style={{ padding: 0, fontSize: token.fontSizeSM }}
            onClick={() => onOpenCreateDialog('board')}
          >
            Create your first board
          </Button>
        </HomeEmpty>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
            gap: token.marginSM,
          }}
        >
          {visibleRows.map(({ board, emoji, branchCount, activeCount, latestSessionAt }) => (
            <BoardHomeCard
              key={board.board_id}
              board={board}
              emoji={emoji}
              branchCount={branchCount}
              activeCount={activeCount}
              latestSessionAt={latestSessionAt}
              onBoardClick={onBoardClick}
            />
          ))}
        </div>
      )}
    </HomeBlock>
  );
};
