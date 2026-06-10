import type { Board, Branch, Session } from '@agor-live/client';
import { getAssistantConfig } from '@agor-live/client';
import {
  ApartmentOutlined,
  BranchesOutlined,
  InfoCircleOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Avatar, Card, Empty, Popover, Space, Tag, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useMemo, useState } from 'react';
import { formatRelativeTime } from '../../utils/time';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { HomeSectionHeader } from './HomeSectionHeader';
import { glassCardStyle, withAlpha } from './homeStyles';
import type { HomePageProps } from './types';

const { Text } = Typography;

const HOME_BOARDS_LIMIT = 50;

const activeStatuses = new Set<Session['status']>([
  'running',
  'stopping',
  'awaiting_permission',
  'awaiting_input',
]);

interface BoardHomeRow {
  board: Board;
  branches: Branch[];
  sessions: Session[];
  primaryAssistant?: Branch;
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

const deriveBoardRows = ({
  boardById,
  recentBoardIds,
  branchById,
  sessionsByBranch,
}: Pick<HomePageProps, 'boardById' | 'recentBoardIds' | 'branchById' | 'sessionsByBranch'>) => {
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
      const primaryAssistant = board.primary_assistant_id
        ? branchById.get(board.primary_assistant_id)
        : undefined;
      const latest = Math.max(
        new Date(board.last_updated).getTime(),
        ...branches.map((branch) => new Date(branch.updated_at || branch.created_at).getTime()),
        ...sessions.map((session) => new Date(session.last_updated).getTime())
      );
      return {
        board,
        branches,
        sessions,
        primaryAssistant,
        latest: Number.isFinite(latest) ? latest : 0,
        visitRank: visitRank.get(board.board_id) ?? Number.POSITIVE_INFINITY,
      };
    })
    .sort(
      (a, b) =>
        a.visitRank - b.visitRank || b.latest - a.latest || a.board.name.localeCompare(b.board.name)
    )
    .slice(0, HOME_BOARDS_LIMIT);
};

const BoardHomeCard: React.FC<{
  board: Board;
  branches: Branch[];
  sessions: Session[];
  primaryAssistant?: Branch;
  onClick: () => void;
}> = ({ board, branches, sessions, primaryAssistant, onClick }) => {
  const { token } = theme.useToken();
  const cardGlassStyle = glassCardStyle(token);
  const assistantConfig = primaryAssistant ? getAssistantConfig(primaryAssistant) : null;
  const [hovered, setHovered] = useState(false);
  const activeCount = sessions.filter((session) => activeStatuses.has(session.status)).length;
  const latestSession = [...sessions].sort(
    (a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime()
  )[0];
  const description = board.description?.trim() ?? '';
  const firstDescriptionLine = description.split(/\r?\n/)[0]?.trim() ?? '';

  return (
    <Card
      hoverable
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 320,
        flex: '0 0 320px',
        borderColor: hovered ? token.colorPrimaryBorderHover : token.colorBorderSecondary,
        ...cardGlassStyle,
        background: hovered ? withAlpha(token.colorBgElevated, 0.65) : cardGlassStyle.background,
        backgroundColor: hovered
          ? withAlpha(token.colorBgElevated, 0.65)
          : cardGlassStyle.backgroundColor,
        boxShadow: hovered ? token.boxShadowSecondary : undefined,
        transition: 'border-color 0.2s, background 0.2s, box-shadow 0.2s',
      }}
      styles={{ body: { minHeight: 136, background: 'transparent' } }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space size={10} style={{ minWidth: 0 }}>
            <Avatar
              style={{
                background: token.colorFillSecondary,
                color: token.colorText,
                flexShrink: 0,
              }}
            >
              {board.icon || '📋'}
            </Avatar>
            <div style={{ minWidth: 0 }}>
              <Space size={6} style={{ maxWidth: 230 }}>
                <Text
                  strong
                  ellipsis={{ tooltip: board.name }}
                  style={{ display: 'block', maxWidth: primaryAssistant ? 190 : 220 }}
                >
                  {board.name}
                </Text>
                {primaryAssistant && (
                  <Tooltip
                    title={`Primary assistant: ${assistantConfig?.displayName ?? primaryAssistant.name}`}
                  >
                    <RobotOutlined
                      aria-label="Primary assistant"
                      style={{ color: token.colorPrimary, fontSize: 13, flexShrink: 0 }}
                    />
                  </Tooltip>
                )}
              </Space>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  maxWidth: 220,
                  minHeight: 20,
                }}
              >
                <Text
                  type="secondary"
                  ellipsis={description ? { tooltip: firstDescriptionLine } : false}
                  style={{
                    display: 'block',
                    fontSize: 12,
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {firstDescriptionLine || '\u00a0'}
                </Text>
                {description && (
                  <Popover
                    content={
                      <div style={{ maxWidth: 360, maxHeight: 320, overflow: 'auto' }}>
                        <MarkdownRenderer content={description} compact showControls={false} />
                      </div>
                    }
                    title="Board description"
                    trigger="hover"
                    placement="rightTop"
                  >
                    <InfoCircleOutlined
                      style={{
                        color: token.colorTextTertiary,
                        cursor: 'help',
                        flexShrink: 0,
                        fontSize: 12,
                      }}
                    />
                  </Popover>
                )}
              </div>
            </div>
          </Space>
        </Space>
        <Space wrap size={[6, 6]}>
          <Tag icon={<BranchesOutlined />}>
            {branches.length} branch{branches.length === 1 ? '' : 'es'}
          </Tag>
          <Tag>
            {sessions.length} session{sessions.length === 1 ? '' : 's'}
          </Tag>
          {activeCount > 0 && <Tag color="processing">{activeCount} active</Tag>}
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {latestSession ? (
            <>Last session {formatRelativeTime(latestSession.last_updated)}</>
          ) : (
            'No sessions yet'
          )}
        </Text>
      </Space>
    </Card>
  );
};

export const HomeBoardsSection: React.FC<
  Pick<
    HomePageProps,
    'boardById' | 'recentBoardIds' | 'branchById' | 'sessionsByBranch' | 'onBoardClick'
  >
> = ({ boardById, recentBoardIds = [], branchById, sessionsByBranch, onBoardClick }) => {
  const { token } = theme.useToken();
  const rows = useMemo(
    () => deriveBoardRows({ boardById, recentBoardIds, branchById, sessionsByBranch }),
    [boardById, recentBoardIds, branchById, sessionsByBranch]
  );

  return (
    <section>
      <HomeSectionHeader
        title="Boards"
        icon={<ApartmentOutlined />}
        info={`Up to ${HOME_BOARDS_LIMIT} accessible boards, sorted by this browser’s last-visited board order when available, then by recent board, branch, or session activity.`}
      />
      {rows.length === 0 ? (
        <Card style={glassCardStyle(token)}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No boards yet. Use the create button to make your first board, assistant, repo, or branch."
          />
        </Card>
      ) : (
        <div
          style={{
            display: 'flex',
            gap: 16,
            overflowX: 'auto',
            paddingTop: 2,
            paddingBottom: 10,
            scrollbarColor: `${token.colorFill} transparent`,
          }}
        >
          {rows.map(({ board, branches, sessions, primaryAssistant }) => (
            <BoardHomeCard
              key={board.board_id}
              board={board}
              branches={branches}
              sessions={sessions}
              primaryAssistant={primaryAssistant}
              onClick={() => onBoardClick(board.board_id)}
            />
          ))}
        </div>
      )}
    </section>
  );
};
