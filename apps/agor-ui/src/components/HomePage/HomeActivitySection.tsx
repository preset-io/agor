import type { Board, Branch, Session } from '@agor-live/client';
import { getAssistantConfig, isAssistant } from '@agor-live/client';
import {
  ApartmentOutlined,
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
import { useCallback, useMemo, useState } from 'react';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime } from '../../utils/time';
import { BranchPill, ENTITY_PILL_COLORS } from '../Pill';
import { Tag } from '../Tag';
import { ToolIcon } from '../ToolIcon';
import { HomeSectionHeader } from './HomeSectionHeader';
import { glassCardStyle } from './homeStyles';
import type { HomePageProps } from './types';

const { Text } = Typography;

const HOME_ACTIVITY_LIMIT = 100;

type ActivityFilter = 'all' | 'branches' | 'sessions' | 'assistants';
type ActivityEventType = Exclude<ActivityFilter, 'all'>;

interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  dttm: string | Date;
  icon: React.ReactNode;
  message: React.ReactNode;
}

const ActivityFeedItem: React.FC<{
  icon: React.ReactNode;
  message: React.ReactNode;
  time?: string | Date | null;
}> = ({ icon, message, time }) => {
  const { token } = theme.useToken();
  return (
    <List.Item style={{ padding: '10px 0' }}>
      <Space align="start">
        <Avatar
          size="small"
          style={{ background: token.colorFillSecondary, color: token.colorText }}
        >
          {icon}
        </Avatar>
        <div>
          <div>{message}</div>
          {time && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {formatRelativeTime(time)}
            </Text>
          )}
        </div>
      </Space>
    </List.Item>
  );
};

export const HomeActivitySection: React.FC<
  Pick<
    HomePageProps,
    | 'branchById'
    | 'boardById'
    | 'sessionById'
    | 'userById'
    | 'onBoardClick'
    | 'onBranchClick'
    | 'onSessionClick'
  >
> = ({
  branchById,
  boardById,
  sessionById,
  userById,
  onBoardClick,
  onBranchClick,
  onSessionClick,
}) => {
  const { token } = theme.useToken();
  const cardGlassStyle = glassCardStyle(token);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const clickablePillStyle = useMemo<React.CSSProperties>(
    () => ({
      cursor: 'pointer',
      marginInlineEnd: 0,
    }),
    []
  );

  const boardPill = useCallback(
    (board: Board) => (
      <Tag
        color={ENTITY_PILL_COLORS.board}
        icon={<ApartmentOutlined />}
        onClick={() => onBoardClick(board.board_id)}
        style={clickablePillStyle}
      >
        <span style={{ fontFamily: token.fontFamilyCode }}>{board.name}</span>
      </Tag>
    ),
    [clickablePillStyle, onBoardClick, token.fontFamilyCode]
  );

  const branchMessage = useCallback(
    (branch: Branch, assistant: boolean) => {
      const board = branch.board_id ? boardById.get(branch.board_id) : undefined;
      const actor = userById.get(branch.created_by)?.name || 'Someone';
      const branchLabel = getAssistantConfig(branch)?.displayName ?? branch.name;

      return (
        <Space size={4} wrap>
          <Text strong>{actor}</Text>
          <Text type="secondary">created</Text>
          {assistant ? (
            <Tag
              icon={<RobotOutlined />}
              color={ENTITY_PILL_COLORS.assistant}
              onClick={() => onBranchClick(branch.branch_id)}
              style={clickablePillStyle}
            >
              <span style={{ fontFamily: token.fontFamilyCode }}>{branchLabel}</span>
            </Tag>
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
              {boardPill(board)}
            </>
          )}
        </Space>
      );
    },
    [boardById, boardPill, clickablePillStyle, onBranchClick, token.fontFamilyCode, userById]
  );

  const sessionMessage = useCallback(
    (session: Session) => {
      const branch = branchById.get(session.branch_id);
      const board = branch?.board_id ? boardById.get(branch.board_id) : undefined;
      const actor = userById.get(session.created_by)?.name || 'Someone';
      const sessionTitle = getSessionDisplayTitle(session, {
        includeAgentFallback: true,
        includeIdFallback: true,
      });
      const createdAt = new Date(session.created_at).getTime();
      const updatedAt = new Date(session.last_updated).getTime();
      const verb = Math.abs(updatedAt - createdAt) < 1000 ? 'started' : 'updated';

      return (
        <Space size={4} wrap>
          <Text strong>{actor}</Text>
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
            <Tag
              color={ENTITY_PILL_COLORS.session}
              aria-label={sessionTitle}
              onClick={() => onSessionClick(session.session_id)}
              style={{
                ...clickablePillStyle,
                display: 'inline-flex',
                alignItems: 'center',
                paddingInline: 6,
              }}
            >
              <ToolIcon tool={session.agentic_tool} size={14} />
            </Tag>
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
              {boardPill(board)}
            </>
          )}
        </Space>
      );
    },
    [boardById, boardPill, branchById, onBranchClick, onSessionClick, clickablePillStyle, userById]
  );

  const items = useMemo(() => {
    const events: ActivityEvent[] = [
      ...Array.from(branchById.values())
        .filter((branch) => !branch.archived)
        .map((branch): ActivityEvent => {
          const assistant = isAssistant(branch);
          return {
            id: `branch:${branch.branch_id}`,
            type: assistant ? 'assistants' : 'branches',
            dttm: branch.created_at,
            icon: assistant ? <RobotOutlined /> : <BranchesOutlined />,
            message: branchMessage(branch, assistant),
          };
        }),
      ...Array.from(sessionById.values())
        .filter((session) => !session.archived)
        .map(
          (session): ActivityEvent => ({
            id: `session:${session.session_id}`,
            type: 'sessions',
            dttm: session.last_updated,
            icon: <UnorderedListOutlined />,
            message: sessionMessage(session),
          })
        ),
    ];

    return events
      .filter((event) => filter === 'all' || event.type === filter)
      .sort((a, b) => new Date(b.dttm).getTime() - new Date(a.dttm).getTime())
      .slice(0, HOME_ACTIVITY_LIMIT);
  }, [branchById, sessionById, filter, branchMessage, sessionMessage]);

  return (
    <Card
      style={{ minHeight: 0, flex: 1, ...cardGlassStyle }}
      styles={{
        body: {
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'transparent',
        },
      }}
    >
      <HomeSectionHeader
        title="Team activity"
        icon={<TeamOutlined />}
        info={`Up to ${HOME_ACTIVITY_LIMIT} recent branch, assistant, and session events derived from local state and sorted together by event time. A persisted activity summary endpoint can replace this later for comments, artifacts, and prompt events.`}
        extra={
          <Segmented<ActivityFilter>
            size="small"
            value={filter}
            onChange={setFilter}
            options={[
              { label: <Tooltip title="All activity">All</Tooltip>, value: 'all' },
              {
                label: (
                  <Tooltip title="Branches">
                    <BranchesOutlined />
                  </Tooltip>
                ),
                value: 'branches',
              },
              {
                label: (
                  <Tooltip title="Sessions">
                    <UnorderedListOutlined />
                  </Tooltip>
                ),
                value: 'sessions',
              },
              {
                label: (
                  <Tooltip title="Assistants">
                    <RobotOutlined />
                  </Tooltip>
                ),
                value: 'assistants',
              },
            ]}
          />
        }
      />
      <div style={{ overflow: 'auto', minHeight: 0 }}>
        {items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No recent activity" />
        ) : (
          <List
            rowKey="id"
            dataSource={items}
            renderItem={(item) => (
              <ActivityFeedItem icon={item.icon} message={item.message} time={item.dttm} />
            )}
          />
        )}
      </div>
    </Card>
  );
};
