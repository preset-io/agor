import type { Board, Branch, Session } from '@agor-live/client';
import {
  ClockCircleOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Button, Empty, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { memo, useMemo, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectBranchById, selectSessionsByBranch } from '../../store/selectors';
import { formatRelativeTime } from '../../utils/time';
import { glassCardStyle } from './homeStyles';
import type { HomePageProps } from './types';

const { Text } = Typography;

const HOME_BOARDS_LIMIT = 50;
const BOARDS_PER_PAGE = 4;

/**
 * Everything below `board` is a primitive so the memo'd card bails out of
 * re-renders unless ITS board's display data actually changed — passing the
 * per-board branch/session arrays instead would defeat the memo (they're
 * rebuilt fresh on every derivation pass).
 */
interface BoardHomeRow {
  board: Board;
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

const groupVisibleSessionsByBranch = (
  sessionsByBranch: Map<string, Session[]>
): Map<string, Session[]> => {
  const grouped = new Map<string, Session[]>();
  for (const [branchId, sessions] of sessionsByBranch) {
    const visibleSessions = sessions.filter((session) => !session.archived);
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
  branchCount,
  activeCount,
  latestSessionAt,
  onBoardClick,
}: {
  board: Board;
  branchCount: number;
  activeCount: number;
  latestSessionAt: Session['last_updated'] | null;
  onBoardClick: (boardId: string) => void;
}) {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  return (
    <button
      type="button"
      onClick={() => onBoardClick(board.board_id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        textAlign: 'left',
        border: `1px solid ${hovered ? token.colorPrimary : token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        padding: '12px 14px',
        cursor: 'pointer',
        ...glassCardStyle(token, 0.3),
        boxShadow: hovered
          ? `${token.boxShadowSecondary}, inset 0 1px 0 rgba(255, 255, 255, 0.12)`
          : undefined,
        outline: focused ? `2px solid ${token.colorPrimary}` : undefined,
        outlineOffset: focused ? 2 : undefined,
        transition: 'border-color 0.2s, box-shadow 0.2s',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        {/* Board icon */}
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: token.colorFillTertiary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            flexShrink: 0,
          }}
        >
          {board.icon || '📋'}
        </div>

        {/* Name + meta — all aligned under each other, to the right of the icon */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Tooltip title={board.name}>
            <Text
              strong
              style={{
                fontSize: 14,
                display: 'block',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {board.name}
            </Text>
          </Tooltip>
          <div style={{ display: 'flex', gap: 10 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {branchCount} branch{branchCount !== 1 ? 'es' : ''}
            </Text>
            {activeCount > 0 && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                <ThunderboltOutlined style={{ marginRight: 2 }} />
                {activeCount} active
              </Text>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <ClockCircleOutlined style={{ fontSize: 11, color: token.colorTextSecondary }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {latestSessionAt
                ? `Last session ${formatRelativeTime(latestSessionAt)}`
                : 'No sessions yet'}
            </Text>
          </div>
        </div>
      </div>
    </button>
  );
});

export const HomeBoardsSection: React.FC<
  Pick<HomePageProps, 'recentBoardIds' | 'onBoardClick' | 'onOpenCreateDialog'>
> = ({ recentBoardIds = [], onBoardClick, onOpenCreateDialog }) => {
  const boardById = useAgorStore(selectBoardById);
  const branchById = useAgorStore(selectBranchById);
  const sessionsByBranch = useAgorStore(selectSessionsByBranch);
  const [page, setPage] = useState(0);

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
          const time = new Date(session.last_updated).getTime();
          if (time > latestSessionTime) {
            latestSessionTime = time;
            latestSessionAt = session.last_updated;
          }
        }
        const latest = Math.max(
          new Date(board.last_updated).getTime(),
          ...branches.map((branch) => new Date(branch.updated_at || branch.created_at).getTime()),
          latestSessionTime
        );
        return {
          board,
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

  const totalPages = Math.max(1, Math.ceil(rows.length / BOARDS_PER_PAGE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageStart = currentPage * BOARDS_PER_PAGE;
  const visibleRows = rows.slice(pageStart, pageStart + BOARDS_PER_PAGE);
  const showPager = rows.length > BOARDS_PER_PAGE;

  return (
    <section aria-label="Boards" style={{ marginBottom: 24 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <Text strong style={{ fontSize: 14 }}>
          Boards
        </Text>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {showPager && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Button
                type="text"
                size="small"
                icon={<LeftOutlined />}
                aria-label="Previous boards"
                disabled={currentPage === 0}
                onClick={() => setPage(Math.max(0, currentPage - 1))}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {currentPage + 1} / {totalPages}
              </Text>
              <Button
                type="text"
                size="small"
                icon={<RightOutlined />}
                aria-label="Next boards"
                disabled={currentPage >= totalPages - 1}
                onClick={() => setPage(Math.min(totalPages - 1, currentPage + 1))}
              />
            </div>
          )}
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            style={{ padding: 0 }}
            onClick={() => onOpenCreateDialog('board')}
          >
            New board
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No boards yet"
          style={{ padding: '24px 0' }}
        >
          <Button type="primary" onClick={() => onOpenCreateDialog('board')}>
            Create your first board
          </Button>
        </Empty>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: 12,
          }}
        >
          {visibleRows.map(({ board, branchCount, activeCount, latestSessionAt }) => (
            <BoardHomeCard
              key={board.board_id}
              board={board}
              branchCount={branchCount}
              activeCount={activeCount}
              latestSessionAt={latestSessionAt}
              onBoardClick={onBoardClick}
            />
          ))}
        </div>
      )}
    </section>
  );
};
