import type { Board, Branch, Repo, Session } from '@agor-live/client';
import { UnorderedListOutlined } from '@ant-design/icons';
import { Badge, Card, Empty, List, Space, Tag, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import {
  getMatchSnippet,
  isSessionSearchActive,
  SESSION_SORT_STORAGE_KEY,
  type SessionSort,
  searchSessions,
  sessionToolMatches,
  sortSessions,
} from '../../utils/sessionSearch';
import { getSessionStatusTone } from '../../utils/sessionStatus';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime, formatTimestampWithRelative } from '../../utils/time';
import { HighlightMatch } from '../HighlightMatch';
import { BoardPill, BranchPill } from '../Pill';
import { SessionSearchToolbar } from '../SessionSearchControls';
import { HomeSectionHeader } from './HomeSectionHeader';
import { glassCardStyle } from './homeStyles';
import type { HomePageProps } from './types';

const { Text } = Typography;

const HOME_SESSIONS_LIMIT = 100;

const attentionStatuses = new Set<Session['status']>([
  'awaiting_permission',
  'awaiting_input',
  'failed',
  'timed_out',
]);

const HomeSessionRow: React.FC<{
  session: Session;
  branch?: Branch;
  board?: Board;
  repo?: Repo;
  searchQuery: string;
  searchActive: boolean;
  onClick: () => void;
}> = ({ session, branch, board, repo, searchQuery, searchActive, onClick }) => {
  const { token } = theme.useToken();
  const title = getSessionDisplayTitle(session, { includeAgentFallback: true });
  const tone = getSessionStatusTone(session.status);
  const descriptionSnippet =
    searchActive && session.title && session.description
      ? getMatchSnippet(session.description, searchQuery)
      : null;
  const toolMatches = searchActive && sessionToolMatches(session, searchQuery);
  return (
    <List.Item
      onClick={onClick}
      style={{
        cursor: 'pointer',
        padding: '10px 16px',
        borderBlockEnd: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <List.Item.Meta
        avatar={
          <Badge
            dot={tone !== 'success' && tone !== 'default'}
            status={tone === 'success' || tone === 'default' ? undefined : tone}
          >
            <UnorderedListOutlined style={{ fontSize: 20, color: token.colorTextSecondary }} />
          </Badge>
        }
        title={
          <Space size={8} style={{ width: '100%' }}>
            <Text ellipsis={{ tooltip: title }} style={{ maxWidth: 420 }}>
              <HighlightMatch text={title} query={searchQuery} />
            </Text>
            {session.ready_for_prompt && <Tag color="cyan">ready</Tag>}
            {attentionStatuses.has(session.status) && (
              <Tag color="warning">{session.status.replaceAll('_', ' ')}</Tag>
            )}
          </Space>
        }
        description={
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {toolMatches && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                Agent: <HighlightMatch text={session.agentic_tool} query={searchQuery} />
              </Text>
            )}
            {descriptionSnippet && descriptionSnippet !== title && (
              <Text type="secondary" italic style={{ fontSize: 11, lineHeight: 1.4 }}>
                <HighlightMatch text={descriptionSnippet} query={searchQuery} />
              </Text>
            )}
            <Space size={8} wrap>
              <Tooltip title={formatTimestampWithRelative(session.last_updated)}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {formatRelativeTime(session.last_updated)}
                </Text>
              </Tooltip>
              {board && <BoardPill board={board} compact />}
              {branch && (
                <BranchPill
                  branch={branch.name}
                  compact
                  title={repo ? `${repo.slug} / ${branch.name}` : branch.name}
                />
              )}
            </Space>
          </Space>
        }
      />
    </List.Item>
  );
};

export const HomeSessionsSection: React.FC<
  Pick<
    HomePageProps,
    'sessionById' | 'branchById' | 'boardById' | 'repoById' | 'currentUserId' | 'onSessionClick'
  >
> = ({ sessionById, branchById, boardById, repoById, currentUserId, onSessionClick }) => {
  const { token } = theme.useToken();
  const cardGlassStyle = glassCardStyle(token);
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
    <section style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
      <HomeSectionHeader
        title={currentUserId ? 'My Sessions' : 'Sessions'}
        icon={<UnorderedListOutlined />}
        info={`Up to ${HOME_SESSIONS_LIMIT} ${currentUserId ? 'of your' : 'cross-board'} sessions using the same local session state as the board left panel. Board and branch pills are included because this list is not filtered to one board.`}
      />
      <Card
        styles={{
          body: {
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: 'transparent',
          },
        }}
        style={{ minHeight: 0, flex: 1, ...cardGlassStyle }}
      >
        <div style={{ padding: 16 }}>
          <SessionSearchToolbar
            value={searchQuery}
            onChange={setSearchQuery}
            sort={sort}
            onSortChange={setSort}
            searching={searching}
            placeholder="Search sessions..."
          />
        </div>
        <div style={{ overflow: 'auto', minHeight: 0, flex: 1 }}>
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
                const repo = branch ? repoById.get(branch.repo_id) : undefined;
                return (
                  <HomeSessionRow
                    session={session}
                    branch={branch}
                    board={board}
                    repo={repo}
                    searchQuery={trimmed}
                    searchActive={searching}
                    onClick={() => onSessionClick(session.session_id)}
                  />
                );
              }}
            />
          )}
        </div>
      </Card>
    </section>
  );
};
