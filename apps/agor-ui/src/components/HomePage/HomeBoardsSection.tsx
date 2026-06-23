import type { Board, Branch, Session } from '@agor-live/client';
import { ClockCircleOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Button, Typography, theme } from 'antd';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatRelativeTime } from '../../utils/time';
import type { HomePageProps } from './types';

const { Text } = Typography;

const HOME_BOARDS_LIMIT = 50;

const PASTEL_BACKGROUNDS = [
  '#e0e7ff',
  '#fce7f3',
  '#dcfce7',
  '#fef9c3',
  '#dbeafe',
  '#ede9fe',
  '#ffedd5',
  '#d1fae5',
];

const getPastelBg = (index: number) => PASTEL_BACKGROUNDS[index % PASTEL_BACKGROUNDS.length];

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
  boardIndex: number;
  branches: Branch[];
  sessions: Session[];
  onClick: () => void;
}> = ({ board, boardIndex, branches, sessions, onClick }) => {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);
  const activeCount = activeSessions(sessions).length;
  const latestSession = [...sessions].sort(
    (a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime()
  )[0];

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        border: `1px solid ${hovered ? token.colorPrimary : token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        padding: '12px 14px',
        cursor: 'pointer',
        background: token.colorBgContainer,
        boxShadow: hovered ? token.boxShadowSecondary : undefined,
        transition: 'border-color 0.2s, box-shadow 0.2s',
      }}
    >
      {/* Icon + name row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: getPastelBg(boardIndex),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            flexShrink: 0,
          }}
        >
          {board.icon || '📋'}
        </div>
        <Text
          strong
          ellipsis={{ tooltip: board.name }}
          style={{ fontSize: 14, minWidth: 0, flex: 1, paddingTop: 2 }}
        >
          {board.name}
        </Text>
      </div>

      {/* Counts */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 6 }}>
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

      {/* Last session */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <ClockCircleOutlined style={{ color: 'inherit', fontSize: 11 }} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {latestSession
            ? `Last session ${formatRelativeTime(latestSession.last_updated)}`
            : 'No sessions yet'}
        </Text>
      </div>
    </div>
  );
};

export const HomeBoardsSection: React.FC<
  Pick<
    HomePageProps,
    'boardById' | 'recentBoardIds' | 'branchById' | 'sessionsByBranch' | 'onBoardClick'
  >
> = ({ boardById, recentBoardIds = [], branchById, sessionsByBranch, onBoardClick }) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(4);

  useEffect(() => {
    if (!gridRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setColumns(w < 400 ? 1 : w < 700 ? 2 : 4);
    });
    observer.observe(gridRef.current);
    return () => observer.disconnect();
  }, []);

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
        <Button type="link" size="small" icon={<PlusOutlined />} style={{ padding: 0 }}>
          New board
        </Button>
      </div>

      <div
        ref={gridRef}
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: 12,
        }}
      >
        {rows.map(({ board, branches, sessions }, index) => (
          <BoardHomeCard
            key={board.board_id}
            board={board}
            boardIndex={index}
            branches={branches}
            sessions={sessions}
            onClick={() => onBoardClick(board.board_id)}
          />
        ))}
      </div>
    </section>
  );
};
