import type { Board, Branch, Session } from '@agor-live/client';
import { ForkOutlined } from '@ant-design/icons';
import { Card, Empty, List, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import {
  isSessionSearchActive,
  SESSION_SORT_STORAGE_KEY,
  type SessionSort,
  searchSessions,
  sortSessions,
} from '../../utils/sessionSearch';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime } from '../../utils/time';
import { SessionSearchToolbar } from '../SessionSearchControls';
import { glassCardStyle } from './homeStyles';
import { StatusDot } from './StatusDot';
import type { HomePageProps } from './types';

const { Text } = Typography;

const HOME_SESSIONS_LIMIT = 100;

const HomeSessionRow: React.FC<{
  session: Session;
  branch?: Branch;
  board?: Board;
  onClick: () => void;
}> = ({ session, branch, board, onClick }) => {
  const { token } = theme.useToken();
  const title = getSessionDisplayTitle(session, { includeAgentFallback: true });
  const isForked = !!(
    session.genealogy.parent_session_id || session.genealogy.forked_from_session_id
  );

  return (
    <List.Item
      onClick={onClick}
      style={{
        cursor: 'pointer',
        padding: '8px 14px',
        borderBlockEnd: `1px solid ${token.colorBorderSecondary}`,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <StatusDot status={session.status} />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Tooltip title={title}>
          <Text ellipsis style={{ fontSize: 14, fontWeight: 500, maxWidth: '60%', minWidth: 0 }}>
            {title}
          </Text>
        </Tooltip>
        {isForked && (
          <ForkOutlined style={{ fontSize: 12, color: token.colorTextTertiary, flexShrink: 0 }} />
        )}
        {board && (
          <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
            {board.name}
          </Text>
        )}
        {branch && (
          <span
            style={{
              fontFamily: 'monospace',
              fontSize: 12,
              background: token.colorFillTertiary,
              borderRadius: 3,
              padding: '0 4px',
              flexShrink: 0,
              whiteSpace: 'nowrap',
              maxWidth: 120,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: 'inline-block',
            }}
          >
            {branch.name}
          </span>
        )}
      </div>

      <Text type="secondary" style={{ fontSize: 12, flexShrink: 0, whiteSpace: 'nowrap' }}>
        {formatRelativeTime(session.last_updated)}
      </Text>
    </List.Item>
  );
};

export const HomeSessionsSection: React.FC<
  Pick<
    HomePageProps,
    'sessionById' | 'branchById' | 'boardById' | 'currentUserId' | 'onSessionClick'
  >
> = ({ sessionById, branchById, boardById, currentUserId, onSessionClick }) => {
  const { token } = theme.useToken();
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useLocalStorage<SessionSort>(SESSION_SORT_STORAGE_KEY, 'recent');
  const allSessions = useMemo(
    () =>
      Array.from(sessionById.values()).filter(
        (session) => !session.archived && (!currentUserId || session.created_by === currentUserId)
      ),
    [currentUserId, sessionById]
  );
  const trimmed = searchQuery.trim();
  const searching = isSessionSearchActive(trimmed);
  const displaySessions = useMemo(() => {
    const sessions = searching
      ? searchSessions(allSessions, trimmed).map(({ session }) => session)
      : sortSessions(allSessions, sort);
    return sessions.slice(0, HOME_SESSIONS_LIMIT);
  }, [allSessions, searching, trimmed, sort]);

  return (
    <section aria-label={currentUserId ? 'My sessions' : 'Sessions'}>
      {/* Section header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
          gap: 8,
        }}
      >
        <Text strong style={{ fontSize: 14 }}>
          {currentUserId ? 'My Sessions' : 'Sessions'}
        </Text>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <SessionSearchToolbar
            value={searchQuery}
            onChange={setSearchQuery}
            sort={sort}
            onSortChange={setSort}
            searching={searching}
            placeholder="Filter sessions..."
          />
        </div>
      </div>

      <Card
        styles={{
          body: {
            padding: 0,
            maxHeight: 300,
            overflowY: 'auto',
          },
        }}
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          ...glassCardStyle(token, 0.65),
        }}
      >
        {displaySessions.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={searching ? 'No matching sessions' : 'No sessions yet'}
            style={{ padding: '28px 0' }}
          />
        ) : (
          <List
            rowKey="session_id"
            dataSource={displaySessions}
            renderItem={(session) => {
              const branch = branchById.get(session.branch_id);
              const board = branch?.board_id ? boardById.get(branch.board_id) : undefined;
              return (
                <HomeSessionRow
                  session={session}
                  branch={branch}
                  board={board}
                  onClick={() => onSessionClick(session.session_id)}
                />
              );
            }}
          />
        )}
      </Card>
    </section>
  );
};
