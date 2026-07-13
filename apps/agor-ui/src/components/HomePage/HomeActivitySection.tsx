import type { Board, Branch, Session, User } from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import {
  BranchesOutlined,
  RobotOutlined,
  TeamOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import {
  Avatar,
  Card,
  Empty,
  List,
  Popover,
  Segmented,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { memo, useMemo, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import {
  selectBoardById,
  selectBranchById,
  selectSessionById,
  selectUserById,
} from '../../store/selectors';
import { getTimeMs } from '../../utils/entityTime';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime } from '../../utils/time';
import { BoardPill, BranchPill, SessionPill, TeammatePill, UserPill } from '../Pill';
import { glassCardStyle } from './homeStyles';
import type { HomePageProps } from './types';

const { Text } = Typography;

const HOME_ACTIVITY_LIMIT = 100;

type ActivityFilter = 'all' | 'branches' | 'sessions' | 'teammates';
type ActivityEventType = Exclude<ActivityFilter, 'all'>;

// `t` is the numeric sort key, parsed once via the shared memoized util so the
// comparator never touches `new Date` — the whole feed is rebuilt on every
// store notify, and a Date-per-comparison there was the hot path.
interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  dttm: string | Date;
  t: number;
  entityId: string;
}

type ActivityCallbacks = Pick<HomePageProps, 'onBoardClick' | 'onBranchClick' | 'onSessionClick'>;

// Module-level constants: passing referentially-stable style objects keeps the
// pills (and the memo'd rows below) from churning on unrelated store notifies.
const CLICKABLE_PILL_STYLE: React.CSSProperties = { cursor: 'pointer', marginInlineEnd: 0 };
const SESSION_PILL_STYLE: React.CSSProperties = {
  ...CLICKABLE_PILL_STYLE,
  display: 'inline-flex',
  alignItems: 'center',
  paddingInline: 6,
};

const activityIcon = (type: ActivityEventType): React.ReactNode => {
  if (type === 'sessions') return <UnorderedListOutlined />;
  if (type === 'teammates') return <RobotOutlined />;
  return <BranchesOutlined />;
};

/**
 * One activity row. Receives the already-resolved entity object references
 * (session/branch/board/user) plus stable callbacks, and builds its message
 * content HERE — so a store notify re-renders only the rows whose entities
 * actually changed. Because these props are entity references (not the whole
 * maps), `memo` bails out for every unaffected row: a single session:patched no
 * longer rebuilds all 100 rows.
 */
const ActivityRow = memo(function ActivityRow({
  type,
  dttm,
  session,
  branch,
  board,
  actor,
  onBoardClick,
  onBranchClick,
  onSessionClick,
}: ActivityCallbacks & {
  type: ActivityEventType;
  dttm: string | Date;
  session?: Session;
  branch?: Branch;
  board?: Board;
  actor?: User;
}) {
  const { token } = theme.useToken();

  let message: React.ReactNode = null;

  if (type === 'sessions') {
    if (!session) return null;
    const sessionTitle = getSessionDisplayTitle(session, {
      includeAgentFallback: true,
      includeIdFallback: true,
    });
    const verb =
      Math.abs(getTimeMs(session, 'last_updated') - getTimeMs(session, 'created_at')) < 1000
        ? 'started'
        : 'updated';

    message = (
      <Space size={4} wrap>
        {actor ? <UserPill user={actor} compact /> : <Text strong>Someone</Text>}
        <Text type="secondary">{verb}</Text>
        <Popover
          trigger="hover"
          title={<Text style={{ maxWidth: 320, display: 'block' }}>{sessionTitle}</Text>}
          content={
            <Text type="secondary" style={{ fontSize: 12 }}>
              {session.agentic_tool} · {session.status.replaceAll('_', ' ')}
            </Text>
          }
        >
          <SessionPill
            ariaLabel={sessionTitle}
            title={sessionTitle}
            onClick={() => onSessionClick(session.session_id)}
            style={SESSION_PILL_STYLE}
          />
        </Popover>
        {branch && (
          <>
            <Text type="secondary">in</Text>
            <BranchPill
              branch={branch.name}
              compact
              onClick={() => onBranchClick(branch.branch_id)}
            />
          </>
        )}
        {board && (
          <>
            <Text type="secondary">on</Text>
            <BoardPill
              board={board}
              compact
              onClick={() => onBoardClick(board.board_id)}
              style={CLICKABLE_PILL_STYLE}
            />
          </>
        )}
      </Space>
    );
  } else {
    if (!branch) return null;
    const teammate = type === 'teammates';
    const teammateConfig = getTeammateConfig(branch);
    const branchLabel = teammateConfig?.displayName ?? branch.name;

    message = (
      <Space size={4} wrap>
        {actor ? <UserPill user={actor} compact /> : <Text strong>Someone</Text>}
        <Text type="secondary">created</Text>
        {teammate ? (
          <TeammatePill
            name={branchLabel}
            emoji={teammateConfig?.emoji}
            compact
            title={branch.name}
            onClick={() => onBranchClick(branch.branch_id)}
            style={CLICKABLE_PILL_STYLE}
          />
        ) : (
          <BranchPill
            branch={branchLabel}
            compact
            title={branch.name}
            onClick={() => onBranchClick(branch.branch_id)}
          />
        )}
        {board && (
          <>
            <Text type="secondary">on</Text>
            <BoardPill
              board={board}
              compact
              onClick={() => onBoardClick(board.board_id)}
              style={CLICKABLE_PILL_STYLE}
            />
          </>
        )}
      </Space>
    );
  }

  return (
    <List.Item style={{ padding: '10px 0' }}>
      <Space align="start">
        <Avatar
          size="small"
          style={{ background: token.colorFillSecondary, color: token.colorText }}
        >
          {activityIcon(type)}
        </Avatar>
        <div>
          <div>{message}</div>
          {dttm && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {formatRelativeTime(dttm)}
            </Text>
          )}
        </div>
      </Space>
    </List.Item>
  );
});

export const HomeActivitySection: React.FC<ActivityCallbacks> = ({
  onBoardClick,
  onBranchClick,
  onSessionClick,
}) => {
  const branchById = useAgorStore(selectBranchById);
  const boardById = useAgorStore(selectBoardById);
  const sessionById = useAgorStore(selectSessionById);
  const userById = useAgorStore(selectUserById);
  const { token } = theme.useToken();
  const cardGlassStyle = glassCardStyle(token);
  const [filter, setFilter] = useState<ActivityFilter>('all');

  const items = useMemo(() => {
    const events: ActivityEvent[] = [];
    for (const branch of branchById.values()) {
      if (branch.archived) continue;
      const teammate = isTeammate(branch);
      events.push({
        id: `branch:${branch.branch_id}`,
        type: teammate ? 'teammates' : 'branches',
        dttm: branch.created_at,
        t: getTimeMs(branch, 'created_at'),
        entityId: branch.branch_id,
      });
    }
    for (const session of sessionById.values()) {
      if (session.archived) continue;
      events.push({
        id: `session:${session.session_id}`,
        type: 'sessions',
        dttm: session.last_updated,
        t: getTimeMs(session, 'last_updated'),
        entityId: session.session_id,
      });
    }

    return events
      .filter((event) => filter === 'all' || event.type === filter)
      .sort((a, b) => b.t - a.t)
      .slice(0, HOME_ACTIVITY_LIMIT);
  }, [branchById, sessionById, filter]);

  return (
    <section
      aria-label="Team activity"
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          marginBottom: 8,
          gap: 6,
        }}
      >
        <Space size={6}>
          <TeamOutlined style={{ color: token.colorTextSecondary, fontSize: 13 }} />
          <Text strong style={{ fontSize: 14 }}>
            Team activity
          </Text>
        </Space>
        <Segmented<ActivityFilter>
          size="small"
          value={filter}
          onChange={setFilter}
          options={[
            { label: <Tooltip title="All activity">All</Tooltip>, value: 'all' },
            {
              label: (
                <Tooltip title="Branches">
                  <BranchesOutlined aria-label="Branches" />
                </Tooltip>
              ),
              value: 'branches',
            },
            {
              label: (
                <Tooltip title="Sessions">
                  <UnorderedListOutlined aria-label="Sessions" />
                </Tooltip>
              ),
              value: 'sessions',
            },
            {
              label: (
                <Tooltip title="Teammates">
                  <RobotOutlined aria-label="Teammates" />
                </Tooltip>
              ),
              value: 'teammates',
            },
          ]}
        />
      </div>
      <Card
        style={{
          flex: 1,
          minHeight: 0,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          ...cardGlassStyle,
        }}
        styles={{
          body: {
            padding: 0,
            height: '100%',
            overflow: 'auto',
            background: 'transparent',
          },
        }}
      >
        {items.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No recent activity"
            style={{ padding: '24px 0' }}
          />
        ) : (
          <List
            rowKey="id"
            dataSource={items}
            renderItem={(item) => {
              if (item.type === 'sessions') {
                const session = sessionById.get(item.entityId);
                const branch = session ? branchById.get(session.branch_id) : undefined;
                const board = branch?.board_id ? boardById.get(branch.board_id) : undefined;
                const actor = session ? userById.get(session.created_by) : undefined;
                return (
                  <ActivityRow
                    type="sessions"
                    dttm={item.dttm}
                    session={session}
                    branch={branch}
                    board={board}
                    actor={actor}
                    onBoardClick={onBoardClick}
                    onBranchClick={onBranchClick}
                    onSessionClick={onSessionClick}
                  />
                );
              }
              const branch = branchById.get(item.entityId);
              const board = branch?.board_id ? boardById.get(branch.board_id) : undefined;
              const actor = branch ? userById.get(branch.created_by) : undefined;
              return (
                <ActivityRow
                  type={item.type}
                  dttm={item.dttm}
                  branch={branch}
                  board={board}
                  actor={actor}
                  onBoardClick={onBoardClick}
                  onBranchClick={onBranchClick}
                  onSessionClick={onSessionClick}
                />
              );
            }}
            style={{ padding: '0 12px' }}
          />
        )}
      </Card>
    </section>
  );
};
