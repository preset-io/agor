import type { Board, Branch, Session, User } from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import {
  AppstoreOutlined,
  BranchesOutlined,
  CheckOutlined,
  DownOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Tooltip, theme } from 'antd';
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
import { getBoardEmoji } from '../BoardTile';
import { isSessionRowRead, SessionRowLogo } from '../SessionRow';
import { HomeBlock, HomeEmpty, HomeLink } from './HomeBlock';
import { compactRelativeTime, HomeRow, HomeTime } from './HomeRow';
import type { HomePageProps } from './types';

const HOME_ACTIVITY_LIMIT = 100;
/** The feed shows the latest few; "Show more" expands to the full feed. */
const HOME_ACTIVITY_PREVIEW = 6;

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

const FILTER_LABELS: Record<ActivityFilter, string> = {
  all: 'All',
  branches: 'Branches',
  sessions: 'Sessions',
  teammates: 'Teammates',
};

/** Hover link to a row's branch or board, beside the row's own open button. */
const RowLink: React.FC<{ label: string; icon: React.ReactNode; onClick: () => void }> = ({
  label,
  icon,
  onClick,
}) => (
  <Tooltip title={label}>
    <Button type="text" size="small" aria-label={label} icon={icon} onClick={onClick} />
  </Tooltip>
);

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
  boardEmoji,
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
  boardEmoji?: string;
  actor?: User;
}) {
  const { token } = theme.useToken();
  const who = actor?.name ?? 'Someone';
  const relative = dttm ? formatRelativeTime(dttm) : null;
  const trailing = relative ? <HomeTime>{compactRelativeTime(relative)}</HomeTime> : undefined;
  const boardLink = board ? (
    <RowLink
      label={`Open board ${board.name}`}
      icon={boardEmoji ? <span style={{ fontSize: 12 }}>{boardEmoji}</span> : <AppstoreOutlined />}
      onClick={() => onBoardClick(board.board_id)}
    />
  ) : null;

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
    const context = [
      `${who} ${verb} this session`,
      branch && `in ${branch.name}`,
      board && `on ${board.name}`,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <HomeRow
        ariaLabel={`Open session ${sessionTitle}; ${context}`}
        onOpen={() => onSessionClick(session.session_id)}
        leading={<SessionRowLogo tool={session.agentic_tool} />}
        title={sessionTitle}
        tooltip={[sessionTitle, context, relative].filter(Boolean).join('\n')}
        read={isSessionRowRead(session, false)}
        trailing={trailing}
        hover={
          branch || board ? (
            <>
              {branch && (
                <RowLink
                  label={`Open branch ${branch.name}`}
                  icon={<BranchesOutlined />}
                  onClick={() => onBranchClick(branch.branch_id)}
                />
              )}
              {boardLink}
            </>
          ) : undefined
        }
      />
    );
  }

  if (!branch) return null;
  const teammate = type === 'teammates';
  const teammateConfig = getTeammateConfig(branch);
  const branchLabel = teammateConfig?.displayName ?? branch.name;
  const context = [
    `${who} created this ${teammate ? 'teammate' : 'branch'}`,
    board && `on ${board.name}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <HomeRow
      ariaLabel={`Open ${teammate ? 'teammate' : 'branch'} ${branchLabel}; ${context}`}
      onOpen={() => onBranchClick(branch.branch_id)}
      leading={
        <span
          style={{
            width: 16,
            display: 'inline-flex',
            justifyContent: 'center',
            color: token.colorTextTertiary,
            fontSize: teammate && teammateConfig?.emoji ? 13 : token.fontSizeSM,
          }}
        >
          {teammate ? (teammateConfig?.emoji ?? <RobotOutlined />) : <BranchesOutlined />}
        </span>
      }
      title={branchLabel}
      tooltip={[branchLabel, branch.name !== branchLabel && branch.name, context, relative]
        .filter(Boolean)
        .join('\n')}
      read
      trailing={trailing}
      hover={boardLink ?? undefined}
    />
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
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [expanded, setExpanded] = useState(false);

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

  const visibleItems = expanded ? items : items.slice(0, HOME_ACTIVITY_PREVIEW);

  return (
    <HomeBlock
      label="Activity"
      surface
      actions={
        <>
          <Dropdown
            trigger={['click']}
            menu={{
              selectedKeys: [filter],
              items: (Object.keys(FILTER_LABELS) as ActivityFilter[]).map((key) => ({
                key,
                label: FILTER_LABELS[key],
                icon:
                  key === filter ? (
                    <CheckOutlined />
                  ) : (
                    <span style={{ width: 12, display: 'inline-block' }} />
                  ),
              })),
              onClick: ({ key }) => setFilter(key as ActivityFilter),
            }}
          >
            <Button
              type="text"
              size="small"
              aria-label={`Filter activity: ${FILTER_LABELS[filter]}`}
              style={{
                color: token.colorTextTertiary,
                fontSize: token.fontSizeSM,
                paddingInline: token.paddingXXS,
                background: filter !== 'all' ? token.colorFillSecondary : undefined,
              }}
            >
              {FILTER_LABELS[filter]} <DownOutlined style={{ fontSize: 9 }} />
            </Button>
          </Dropdown>
          {items.length > HOME_ACTIVITY_PREVIEW && (
            <HomeLink onClick={() => setExpanded((open) => !open)}>
              {expanded ? 'Show less' : 'Show more'}
            </HomeLink>
          )}
        </>
      }
    >
      <div style={expanded ? { maxHeight: 420, overflowY: 'auto' } : undefined}>
        {items.length === 0 ? (
          <HomeEmpty>No recent activity</HomeEmpty>
        ) : (
          visibleItems.map((item) => {
            if (item.type === 'sessions') {
              const session = sessionById.get(item.entityId);
              const branch = session ? branchById.get(session.branch_id) : undefined;
              const board = branch?.board_id ? boardById.get(branch.board_id) : undefined;
              const actor = session ? userById.get(session.created_by) : undefined;
              return (
                <ActivityRow
                  key={item.id}
                  type="sessions"
                  dttm={item.dttm}
                  session={session}
                  branch={branch}
                  board={board}
                  boardEmoji={board ? getBoardEmoji(board, branchById) : undefined}
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
                key={item.id}
                type={item.type}
                dttm={item.dttm}
                branch={branch}
                board={board}
                boardEmoji={board ? getBoardEmoji(board, branchById) : undefined}
                actor={actor}
                onBoardClick={onBoardClick}
                onBranchClick={onBranchClick}
                onSessionClick={onSessionClick}
              />
            );
          })
        )}
      </div>
    </HomeBlock>
  );
};
