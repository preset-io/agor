import type { Board, Branch, Session } from '@agor-live/client';
import { ClockCircleOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Button, Empty, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatRelativeTime } from '../../utils/time';
import { glassCardStyle } from './homeStyles';
import type { HomeSectionProps } from './types';

const { Text } = Typography;

const HOME_BOARDS_LIMIT = 50;

interface BoardHomeRow {
  board: Board;
  branches: Branch[];
  sessions: Session[];
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

const BoardHomeCard: React.FC<{
  board: Board;
  branches: Branch[];
  sessions: Session[];
  onClick: () => void;
}> = ({ board, branches, sessions, onClick }) => {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const activeCount = activeSessions(sessions).length;
  const latestSession = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime()
      )[0],
    [sessions]
  );

  return (
    <button
      type="button"
      onClick={onClick}
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
              {branches.length} branch{branches.length !== 1 ? 'es' : ''}
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
              {latestSession
                ? `Last session ${formatRelativeTime(latestSession.last_updated)}`
                : 'No sessions yet'}
            </Text>
          </div>
        </div>
      </div>
    </button>
  );
};

export const HomeBoardsSection: React.FC<
  Pick<
    HomeSectionProps,
    | 'boardById'
    | 'recentBoardIds'
    | 'branchById'
    | 'sessionsByBranch'
    | 'onBoardClick'
    | 'onOpenCreateDialog'
  >
> = ({
  boardById,
  recentBoardIds = [],
  branchById,
  sessionsByBranch,
  onBoardClick,
  onOpenCreateDialog,
}) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(4);

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
        const latest = Math.max(
          new Date(board.last_updated).getTime(),
          ...branches.map((branch) => new Date(branch.updated_at || branch.created_at).getTime()),
          ...sessions.map((session) => new Date(session.last_updated).getTime())
        );
        return {
          board,
          branches,
          sessions,
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

  const hasBoards = rows.length > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: hasBoards is a sentinel dep — re-attaches observer when board count transitions between 0 and >0 (gridRef only mounts with boards)
  useEffect(() => {
    if (!gridRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setColumns(w < 400 ? 1 : w < 700 ? 2 : 4);
    });
    observer.observe(gridRef.current);
    return () => observer.disconnect();
  }, [hasBoards]);

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
          ref={gridRef}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: 12,
          }}
        >
          {rows.map(({ board, branches, sessions }) => (
            <BoardHomeCard
              key={board.board_id}
              board={board}
              branches={branches}
              sessions={sessions}
              onClick={() => onBoardClick(board.board_id)}
            />
          ))}
        </div>
      )}
    </section>
  );
};
