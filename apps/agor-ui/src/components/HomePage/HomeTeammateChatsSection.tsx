import type { Branch, Session } from '@agor-live/client';
import { getGatewaySource, getTeammateConfig, isGatewaySession } from '@agor-live/client';
import { MessageOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Tag, Tooltip, Typography, theme } from 'antd';
import { memo, useMemo } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectBranchById, selectSessionById, selectUserById } from '../../store/selectors';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime } from '../../utils/time';
import { readTeammateChatPreferences } from '../TeammateChatCollections/preferences';
import { glassCardStyle } from './homeStyles';
import { StatusDot } from './StatusDot';
import type { HomePageProps } from './types';

const { Text } = Typography;

interface TeammateChatRowProps {
  session: Session;
  branch: Branch;
  onSessionClick: (sessionId: string) => void;
}

const TeammateChatRow = memo(function TeammateChatRow({
  session,
  branch,
  onSessionClick,
}: TeammateChatRowProps) {
  const { token } = theme.useToken();
  const teammate = getTeammateConfig(branch);
  const gateway = getGatewaySource(session);
  const title = getSessionDisplayTitle(session, { includeAgentFallback: true });

  return (
    <button
      type="button"
      onClick={() => onSessionClick(session.session_id)}
      style={{
        width: '100%',
        display: 'grid',
        gridTemplateColumns: '28px minmax(0, 1fr) auto',
        alignItems: 'center',
        gap: 8,
        padding: '9px 10px',
        border: 0,
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        background: 'transparent',
        color: token.colorText,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 28,
          height: 28,
          display: 'grid',
          placeItems: 'center',
          borderRadius: '50%',
          background: token.colorFillSecondary,
          fontSize: 15,
        }}
      >
        {teammate?.emoji || '💬'}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <StatusDot status={session.status} />
          <Tooltip title={title}>
            <Text ellipsis strong style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
              {title}
            </Text>
          </Tooltip>
        </span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', paddingLeft: 13 }}>
          <Text type="secondary" ellipsis style={{ fontSize: 11 }}>
            {teammate?.displayName || branch.name}
          </Text>
          {isGatewaySession(session) && (
            <Tag bordered={false} style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>
              {gateway?.channel_type || 'Gateway'}
            </Tag>
          )}
        </span>
      </span>
      <Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
        {formatRelativeTime(session.last_updated)}
      </Text>
    </button>
  );
});

export const HomeTeammateChatsSection: React.FC<
  Pick<HomePageProps, 'currentUserId' | 'onSessionClick' | 'onManageTeammateChats'>
> = ({ currentUserId, onSessionClick, onManageTeammateChats }) => {
  const { token } = theme.useToken();
  const userById = useAgorStore(selectUserById);
  const sessionById = useAgorStore(selectSessionById);
  const branchById = useAgorStore(selectBranchById);
  const currentUserPreferences = currentUserId
    ? userById.get(currentUserId)?.preferences
    : undefined;
  const preferences = useMemo(
    () => readTeammateChatPreferences(currentUserPreferences),
    [currentUserPreferences]
  );

  const collections = useMemo(
    () =>
      preferences.collections.map((collection) => ({
        ...collection,
        sessions: collection.session_ids
          .flatMap((sessionId) => {
            const session = sessionById.get(sessionId);
            if (!session || session.archived) return [];
            const branch = branchById.get(session.branch_id);
            if (!branch || branch.archived) return [];
            return [{ session, branch }];
          })
          .sort(
            (left, right) =>
              Date.parse(right.session.last_updated) - Date.parse(left.session.last_updated)
          ),
      })),
    [branchById, preferences.collections, sessionById]
  );

  if (collections.length === 0) {
    return (
      <section aria-label="Chat collections" style={{ marginBottom: 24 }}>
        <Card
          style={{ borderColor: token.colorBorderSecondary, ...glassCardStyle(token, 0.3) }}
          styles={{ body: { padding: 18 } }}
        >
          <Empty
            image={<MessageOutlined style={{ fontSize: 28, color: token.colorTextTertiary }} />}
            styles={{ image: { height: 32 } }}
            description="Pin the conversations you use most and group them for quick access."
          >
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={onManageTeammateChats}
            >
              Create chat collection
            </Button>
          </Empty>
        </Card>
      </section>
    );
  }

  return (
    <section aria-label="Chat collections" style={{ marginBottom: 24 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <Text strong style={{ fontSize: 14 }}>
          Chat collections
        </Text>
        <Button size="small" type="text" icon={<SettingOutlined />} onClick={onManageTeammateChats}>
          Manage
        </Button>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
          gap: 12,
        }}
      >
        {collections.map((collection) => (
          <Card
            key={collection.collection_id}
            size="small"
            title={collection.name}
            style={{
              minWidth: 0,
              overflow: 'hidden',
              borderColor: token.colorBorderSecondary,
              ...glassCardStyle(token, 0.3),
            }}
            styles={{ header: { minHeight: 40 }, body: { padding: 0 } }}
          >
            {collection.sessions.length > 0 ? (
              collection.sessions.map(({ session, branch }) => (
                <TeammateChatRow
                  key={session.session_id}
                  session={session}
                  branch={branch}
                  onSessionClick={onSessionClick}
                />
              ))
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No available sessions"
                style={{ margin: '18px 0' }}
              />
            )}
          </Card>
        ))}
      </div>
    </section>
  );
};
