import type { AgorClient, Session, Task } from '@agor-live/client';
import { getGatewaySource, getTeammateConfig } from '@agor-live/client';
import {
  CheckOutlined,
  ClockCircleOutlined,
  InboxOutlined,
  MoreOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import type { FlexProps, MenuProps } from 'antd';
import { Button, Dropdown, Flex, Tooltip, Typography, theme } from 'antd';
import { memo, useEffect, useMemo, useState } from 'react';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useAgorStore } from '../../store/agorStore';
import {
  type HomeCommentNeed,
  type HomeSessionNeed,
  isSessionStartedByUser,
  makeBoardSelector,
  makeBranchSelector,
} from '../../store/selectors';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { pressableProps } from '../../utils/pressableProps';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime } from '../../utils/time';
import { getBoardEmoji } from '../BoardTile';
import { BoardPill, BranchPill, getChannelIcon, TeammatePill } from '../Pill';
import { SessionRowLogo, SessionStatusMark } from '../SessionRow';
import { UserIdentityAvatar } from '../UserIdentityAvatar';
import { HomeLink, useHomeCompact } from './HomeSection';

/** Divided list of Home rows; short previews, so no virtualization. */
export function HomeList<T>({
  items,
  itemKey,
  renderItem,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
}) {
  const { token } = theme.useToken();
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((item, index) => (
        <li
          key={itemKey(item)}
          style={index ? { borderTop: `1px solid ${token.colorSplit}` } : undefined}
        >
          {renderItem(item, index)}
        </li>
      ))}
    </ul>
  );
}

interface HomeRowProps {
  lead?: React.ReactNode;
  title: string;
  time?: string;
  /** Trailing mark on the title line (status). */
  mark?: React.ReactNode;
  /** Second line: reason and context. */
  meta?: React.ReactNode;
  ariaLabel: string;
  onOpen: () => void;
  action?: React.ReactNode;
  indent?: number;
}

interface HomePressableProps extends FlexProps {
  /** Omit for rows that only display. */
  onOpen?: () => void;
  ariaLabel: string;
  tooltip?: string;
  /** Sits beside the pressable area, inside the hover fill. */
  trailing?: React.ReactNode;
}

/**
 * Home's clickable surface: hover and keyboard-focus fill (the `agor-home-pressable`
 * rules in index.css), Enter or Space opens.
 */
export const HomePressable: React.FC<HomePressableProps> = ({
  onOpen,
  ariaLabel,
  tooltip,
  trailing,
  style,
  children,
  ...flexProps
}) => {
  const body = (
    <Flex
      {...flexProps}
      {...(onOpen && { ...pressableProps(onOpen), 'data-home-row': true, 'aria-label': ariaLabel })}
      style={{ flex: 1, minWidth: 0, cursor: onOpen ? 'pointer' : undefined, ...style }}
    >
      {children}
    </Flex>
  );
  return (
    <Flex align="center" className={onOpen ? 'agor-home-pressable' : undefined}>
      {tooltip && onOpen ? <Tooltip title={tooltip}>{body}</Tooltip> : body}
      {trailing}
    </Flex>
  );
};

/** Two-line Home list row: lead · title · time, then reason and context. */
const HomeRow: React.FC<HomeRowProps> = ({
  lead,
  title,
  time,
  mark,
  meta,
  ariaLabel,
  onOpen,
  action,
  indent = 0,
}) => {
  const { token } = theme.useToken();
  const compact = useHomeCompact();
  return (
    <HomePressable
      onOpen={onOpen}
      ariaLabel={ariaLabel}
      align="flex-start"
      gap={token.marginSM}
      // One right-aligned time column for every row kind. Row actions sit before the time
      // and, on hover-capable screens, replace it on hover or focus (index.css).
      trailing={
        (action || time || mark) && (
          <Flex
            align="center"
            gap={token.marginXS}
            style={{
              flex: '0 0 auto',
              alignSelf: 'flex-start',
              height: 22,
              marginTop: token.paddingXS,
              paddingInlineEnd: token.paddingSM,
            }}
          >
            {action}
            {time && (
              <Typography.Text
                type="secondary"
                className="agor-home-time"
                onClick={onOpen}
                style={{ fontSize: token.fontSizeSM, cursor: 'pointer' }}
              >
                {time}
              </Typography.Text>
            )}
            {mark}
          </Flex>
        )
      }
      style={{
        minHeight: compact ? MOBILE_TOUCH_TARGET : undefined,
        padding: `${token.paddingXS}px ${token.paddingSM}px`,
        paddingInlineStart: token.paddingSM + indent,
        paddingInlineEnd: token.paddingXS,
      }}
    >
      {lead !== undefined && (
        <Flex align="center" justify="center" style={{ width: 20, height: 22, flex: '0 0 auto' }}>
          {lead}
        </Flex>
      )}
      <Flex vertical gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Flex align="center" gap={token.marginXS} style={{ minWidth: 0, overflow: 'hidden' }}>
          <Typography.Text
            ellipsis={{ tooltip: title }}
            style={{ flex: 1, minWidth: 0, fontWeight: 500 }}
          >
            {title}
          </Typography.Text>
        </Flex>
        {meta && (
          <Flex
            align="center"
            gap={token.marginXS}
            wrap
            style={{ minWidth: 0, fontSize: token.fontSizeSM }}
          >
            {meta}
          </Flex>
        )}
      </Flex>
    </HomePressable>
  );
};

function sessionOrigin(session: Session): [React.ReactNode, string] | null {
  const source = getGatewaySource(session);
  if (source) {
    return [
      getChannelIcon(source.channel_type),
      source.channel_type === 'slack' ? 'Slack' : source.channel_name,
    ];
  }
  if (session.scheduled_from_branch) return [<ClockCircleOutlined key="icon" />, 'Scheduled'];
  return isSessionStartedByUser(session) ? null : [<RobotOutlined key="icon" />, 'By agent'];
}

/** Branch or teammate chip plus board chip for a session's or comment's home. */
export const HomeContext: React.FC<{
  branchId?: string;
  boardId?: string | null;
  showBoard?: boolean;
}> = ({ branchId, boardId, showBoard = true }) => {
  const compact = useHomeCompact();
  const branch = useAgorStore(useMemo(() => makeBranchSelector(branchId), [branchId]));
  const resolvedBoardId = boardId ?? branch?.board_id;
  const board = useAgorStore(useMemo(() => makeBoardSelector(resolvedBoardId), [resolvedBoardId]));
  const teammate = branch ? getTeammateConfig(branch) : null;
  const maxWidth = compact ? 140 : undefined;
  return (
    <>
      {teammate ? (
        <TeammatePill
          name={teammate.displayName}
          emoji={teammate.emoji}
          compact
          quiet
          maxWidth={maxWidth}
        />
      ) : (
        branch && <BranchPill branch={branch.name} compact quiet maxWidth={maxWidth} />
      )}
      {board && showBoard && !teammate && (
        <BoardPill board={board} emoji={getBoardEmoji(board)} compact quiet maxWidth={maxWidth} />
      )}
    </>
  );
};

const waited = (at: string) => {
  const relative = formatRelativeTime(at);
  return relative === 'just now' ? 'waiting now' : `waiting ${relative.replace(/ ago$/, '')}`;
};

function describeTask(task: Task, reason: HomeSessionNeed['reason']) {
  if (reason === 'permission') {
    const request = task.permission_request;
    const command = request?.tool_input?.command;
    if (typeof command === 'string') return `Wants to run ${command}`;
    return request ? `Wants to use ${request.tool_name}` : undefined;
  }
  return task.error_message?.split('\n')[0] || task.sdk_failure?.reason;
}

/** What a permission request asks for, or why the latest task failed. */
function useNeedDetail(
  client: AgorClient | null | undefined,
  session: Session,
  reason?: HomeSessionNeed['reason']
) {
  const taskId = reason === 'permission' || reason === 'failed' ? session.tasks?.at(-1) : undefined;
  const [detail, setDetail] = useState<{ taskId?: string; text?: string }>({});
  useEffect(() => {
    if (!client || !taskId || !reason) return;
    let cancelled = false;
    client
      .service('tasks')
      .get(taskId)
      .then((task) => {
        if (!cancelled) setDetail({ taskId, text: describeTask(task as Task, reason) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, taskId, reason]);
  return detail.taskId === taskId ? detail.text : undefined;
}

const SESSION_REASONS = {
  permission: 'Waiting for your permission',
  failed: 'Failed',
  finished: 'Finished, not opened yet',
} as const;

/** Needs you's quiet dot; only failures keep their red mark. */
const NeedDot: React.FC = () => {
  const { token } = theme.useToken();
  return (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: token.colorTextTertiary,
        flex: '0 0 auto',
      }}
    />
  );
};

interface HomeSessionRowProps {
  session: Session;
  reason?: HomeSessionNeed['reason'];
  /** Reads what a permission request asks or why a run failed; pass only for visible previews. */
  client?: AgorClient | null;
  /** Replaces the session title (grouped rows). */
  title?: string;
  /** Grouped rows already show branch and board in their headers. */
  showContext?: boolean;
  /** Off when every row in view uses the same agent. */
  showLogo?: boolean;
  indent?: number;
  /** A group row's toggle for its earlier runs. */
  expand?: { expanded: boolean; count: number; onToggle: () => void };
  onOpen: (sessionId: string) => void;
  onMarkRead?: (sessionId: string) => void;
  onArchive?: (sessionId: string) => void;
}

export const HomeSessionRow = memo(function HomeSessionRow({
  session,
  reason,
  client,
  title = getSessionDisplayTitle(session, { includeAgentFallback: true }),
  showContext = true,
  showLogo = true,
  indent,
  expand,
  onOpen,
  onMarkRead,
  onArchive,
}: HomeSessionRowProps) {
  const { token } = theme.useToken();
  const compact = useHomeCompact();
  // Without hover (phones, touch tablets) every row action lives in the ⋯ menu.
  const canHover = useMediaQuery('(hover: hover)');
  const inMenu = compact || !canHover;
  const detail = useNeedDetail(client, session, reason);
  const reasonLabel =
    reason === 'failed' && session.status === 'timed_out'
      ? 'Timed out'
      : reason && SESSION_REASONS[reason];
  const origin = compact ? null : sessionOrigin(session);
  const id = session.session_id;
  const menu: MenuProps['items'] = [
    ...(expand && inMenu
      ? [
          {
            key: 'expand',
            label: expand.expanded ? 'Hide earlier runs' : `Show all ${expand.count}`,
            onClick: expand.onToggle,
          },
        ]
      : []),
    ...(onMarkRead && inMenu
      ? [
          {
            key: 'read',
            label: 'Mark as read',
            icon: <CheckOutlined />,
            onClick: () => onMarkRead(id),
          },
        ]
      : []),
    ...(onArchive && inMenu
      ? [
          {
            key: 'archive',
            label: 'Archive',
            icon: <InboxOutlined />,
            onClick: () => onArchive(id),
          },
        ]
      : []),
  ];
  return (
    <HomeRow
      lead={
        reason === 'failed' ? (
          <SessionStatusMark session={session} />
        ) : reason ? (
          <NeedDot />
        ) : showLogo ? (
          <SessionRowLogo tool={session.agentic_tool} />
        ) : undefined
      }
      mark={reason ? undefined : <SessionStatusMark session={session} />}
      title={title}
      time={
        reason === 'permission'
          ? waited(session.last_updated)
          : `${reason === 'failed' ? 'failed ' : ''}${formatRelativeTime(session.last_updated)}`
      }
      ariaLabel={[title, reasonLabel, detail].filter(Boolean).join(', ')}
      onOpen={() => onOpen(id)}
      indent={indent}
      action={
        inMenu
          ? menu.length > 0 && (
              <Dropdown trigger={['click']} menu={{ items: menu }}>
                <Button
                  type="text"
                  size="small"
                  icon={<MoreOutlined />}
                  aria-label="More actions"
                  style={{ marginBlock: (22 - token.controlHeightSM) / 2 }}
                />
              </Dropdown>
            )
          : (expand || onMarkRead || onArchive) && (
              <Flex align="center" className="agor-home-actions">
                {expand && (
                  <HomeLink aria-expanded={expand.expanded} onClick={expand.onToggle}>
                    {expand.expanded ? 'Hide' : `Show ${expand.count}`}
                  </HomeLink>
                )}
                {onMarkRead && (
                  <Button
                    type="text"
                    size="small"
                    icon={<CheckOutlined />}
                    onClick={() => onMarkRead(id)}
                  >
                    Mark as read
                  </Button>
                )}
                {onArchive && (
                  <Button
                    type="text"
                    size="small"
                    icon={<InboxOutlined />}
                    onClick={() => onArchive(id)}
                  >
                    Archive
                  </Button>
                )}
              </Flex>
            )
      }
      meta={
        (reasonLabel || showContext || origin) && (
          <>
            {reasonLabel && (
              <Typography.Text
                type="secondary"
                ellipsis={{ tooltip: detail }}
                style={{ fontSize: token.fontSizeSM, minWidth: 0 }}
              >
                {detail ? `${reasonLabel} · ${detail}` : reasonLabel}
              </Typography.Text>
            )}
            {showContext && (
              <HomeContext branchId={session.branch_id} boardId={session.branch_board_id} />
            )}
            {origin && (
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                {origin[0]} {origin[1]}
              </Typography.Text>
            )}
          </>
        )
      }
    />
  );
});

export const HomeCommentRow = memo(function HomeCommentRow({
  need,
  onOpen,
}: {
  need: HomeCommentNeed;
  onOpen: (need: HomeCommentNeed) => void;
}) {
  const { token } = theme.useToken();
  const { thread, comment, reason, threadSize } = need;
  const author = useAgorStore((s) => s.userById.get(comment.created_by));
  const sessionBranchId = useAgorStore((s) =>
    thread.session_id ? s.sessionById.get(thread.session_id)?.branch_id : undefined
  );
  const name = author?.name || author?.email || 'Someone';
  const reasonLabel =
    reason === 'mention'
      ? `${name} mentioned you`
      : reason === 'reply'
        ? `${name} replied`
        : `${name} commented on your ${thread.session_id ? 'session' : 'branch'}`;
  const quote = `“${(comment.content_preview || comment.content).trim()}”`;
  return (
    <HomeRow
      lead={<UserIdentityAvatar user={author} size={20} style={{ fontSize: token.fontSizeSM }} />}
      title={quote}
      time={formatRelativeTime(comment.created_at)}
      ariaLabel={`${reasonLabel}: ${quote}`}
      onOpen={() => onOpen(need)}
      meta={
        <>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {reasonLabel}
          </Typography.Text>
          <HomeContext branchId={thread.branch_id ?? sessionBranchId} boardId={thread.board_id} />
          {threadSize > 1 && (
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {threadSize} in thread
            </Typography.Text>
          )}
        </>
      }
    />
  );
});

/** "N finished on {branch}": opens the latest run and expands to the rest. */
export const HomeFinishedGroupRow = memo(function HomeFinishedGroupRow({
  need,
  onOpen,
  onMarkRead,
}: {
  need: HomeSessionNeed & { earlier: Session[] };
  onOpen: (sessionId: string) => void;
  onMarkRead: (sessionId: string) => void;
}) {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(false);
  const { session, earlier } = need;
  const branch = useAgorStore(
    useMemo(() => makeBranchSelector(session.branch_id), [session.branch_id])
  );
  const name = branch ? (getTeammateConfig(branch)?.displayName ?? branch.name) : 'this branch';
  const all = [session, ...earlier];
  return (
    <>
      <HomeSessionRow
        session={session}
        reason="finished"
        title={`${all.length} finished on ${name}`}
        onOpen={onOpen}
        onMarkRead={() => {
          for (const run of all) onMarkRead(run.session_id);
        }}
        expand={{ expanded, count: all.length, onToggle: () => setExpanded(!expanded) }}
      />
      {expanded && (
        <div style={{ borderTop: `1px solid ${token.colorSplit}` }}>
          <HomeList
            items={all}
            itemKey={(run) => run.session_id}
            renderItem={(run) => (
              <HomeSessionRow
                session={run}
                showContext={false}
                indent={token.paddingLG}
                onOpen={onOpen}
                onMarkRead={onMarkRead}
              />
            )}
          />
        </div>
      )}
    </>
  );
});
