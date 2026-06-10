import { getAssistantConfig, isAssistant } from '@agor-live/client';
import {
  ApartmentOutlined,
  BranchesOutlined,
  RobotOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Avatar, Card, Empty, List, Space, Typography, theme } from 'antd';
import type React from 'react';
import { useMemo } from 'react';
import { formatRelativeTime } from '../../utils/time';
import { HomeSectionHeader } from './HomeSectionHeader';
import { glassCardStyle } from './homeStyles';
import type { HomePageProps } from './types';

const { Text } = Typography;

const HOME_ACTIVITY_LIMIT = 100;

const ActivityFeedItem: React.FC<{
  icon: React.ReactNode;
  text: React.ReactNode;
  time?: string | Date | null;
}> = ({ icon, text, time }) => {
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
          <div>{text}</div>
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
  Pick<HomePageProps, 'branchById' | 'boardById' | 'userById' | 'onBoardClick' | 'onBranchClick'>
> = ({ branchById, boardById, userById, onBoardClick, onBranchClick }) => {
  const { token } = theme.useToken();
  const cardGlassStyle = glassCardStyle(token);
  const items = useMemo(
    () =>
      Array.from(branchById.values())
        .filter((branch) => !branch.archived)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, HOME_ACTIVITY_LIMIT),
    [branchById]
  );
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
        info={`Up to ${HOME_ACTIVITY_LIMIT} recent branch/assistant creation events derived from local state. A persisted activity summary endpoint can replace this later for comments, artifacts, and assistant prompt events.`}
      />
      <div style={{ overflow: 'auto', minHeight: 0 }}>
        {items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No recent activity" />
        ) : (
          <List
            rowKey="branch_id"
            dataSource={items}
            renderItem={(branch) => {
              const board = branch.board_id ? boardById.get(branch.board_id) : undefined;
              const actor = userById.get(branch.created_by)?.name || 'Someone';
              const assistant = isAssistant(branch);
              const branchLabel = getAssistantConfig(branch)?.displayName ?? branch.name;
              return (
                <ActivityFeedItem
                  icon={assistant ? <RobotOutlined /> : <BranchesOutlined />}
                  text={
                    <Space size={4} wrap>
                      <Text strong>{actor}</Text>
                      <Text type="secondary">created</Text>
                      {assistant ? (
                        <RobotOutlined style={{ color: token.colorTextTertiary }} />
                      ) : (
                        <BranchesOutlined style={{ color: token.colorTextTertiary }} />
                      )}
                      <Typography.Link onClick={() => onBranchClick(branch.branch_id)}>
                        {branchLabel}
                      </Typography.Link>
                      {board && (
                        <>
                          <Text type="secondary">on</Text>
                          <ApartmentOutlined style={{ color: token.colorTextTertiary }} />
                          <Typography.Link onClick={() => onBoardClick(board.board_id)}>
                            {board.name}
                          </Typography.Link>
                        </>
                      )}
                    </Space>
                  }
                  time={branch.created_at}
                />
              );
            }}
          />
        )}
      </div>
    </Card>
  );
};
