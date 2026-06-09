import type { KnowledgeDocument as CoreKnowledgeDocument } from '@agor/core/types';
import type { AgorClient, Board, Branch, Repo, Session, User } from '@agor-live/client';
import { getAssistantConfig, isAssistant } from '@agor-live/client';
import {
  ApartmentOutlined,
  BookOutlined,
  BranchesOutlined,
  ClockCircleOutlined,
  InfoCircleOutlined,
  RobotOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import {
  Avatar,
  Badge,
  Card,
  Empty,
  List,
  Popover,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_BACKGROUNDS } from '../../constants/ui';
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
import { isDarkTheme } from '../../utils/theme';
import { formatRelativeTime, formatTimestampWithRelative } from '../../utils/time';
import { HighlightMatch } from '../HighlightMatch';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { BranchPill } from '../Pill';
import { SessionSearchToolbar } from '../SessionSearchControls';
import { ToolIcon } from '../ToolIcon';

const { Text, Title } = Typography;

interface HomePageProps {
  client: AgorClient | null;
  currentUser?: User | null;
  connected?: boolean;
  boardById: Map<string, Board>;
  recentBoardIds?: string[];
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  sessionById: Map<string, Session>;
  sessionsByBranch: Map<string, Session[]>;
  userById: Map<string, User>;
  onBoardClick: (boardId: string) => void;
  onBranchClick: (branchId: string) => void;
  onSessionClick: (sessionId: string) => void;
}

interface KnowledgeDocument
  extends Omit<CoreKnowledgeDocument, 'created_at' | 'updated_at' | 'archived_at'> {
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
  archived_at?: string | Date | null;
}

const normalizeFindResult = <T,>(result: T[] | { data?: T[] }): T[] =>
  Array.isArray(result) ? result : (result.data ?? []);
const namespaceSlugFromUri = (uri?: string | null): string | null => {
  const prefix = 'agor://kb/';
  if (!uri?.startsWith(prefix)) return null;
  const rest = uri.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash > 0 ? rest.slice(0, slash) : null;
};
const encodeKnowledgeRoutePath = (path: string) =>
  path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
const buildKnowledgeRoutePath = (namespaceSlug?: string | null, documentPath?: string | null) => {
  if (!namespaceSlug) return '/knowledge';
  const encodedNamespace = encodeURIComponent(namespaceSlug);
  const encodedDocumentPath = documentPath ? encodeKnowledgeRoutePath(documentPath) : '';
  return encodedDocumentPath
    ? `/knowledge/${encodedNamespace}/${encodedDocumentPath}`
    : `/knowledge/${encodedNamespace}`;
};

const attentionStatuses = new Set<Session['status']>([
  'awaiting_permission',
  'awaiting_input',
  'failed',
  'timed_out',
]);
const activeStatuses = new Set<Session['status']>([
  'running',
  'stopping',
  'awaiting_permission',
  'awaiting_input',
]);

const glassCardStyle = (
  token: ReturnType<typeof theme.useToken>['token'],
  alpha = 0.5
): React.CSSProperties => ({
  background: withAlpha(token.colorBgContainer, alpha),
  backgroundColor: withAlpha(token.colorBgContainer, alpha),
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
});

const withAlpha = (color: string, alpha: number): string => {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const fullHex =
      hex.length === 3
        ? hex
            .split('')
            .map((char) => `${char}${char}`)
            .join('')
        : hex;
    if (fullHex.length === 6) {
      const value = Number.parseInt(fullHex, 16);
      const r = (value >> 16) & 255;
      const g = (value >> 8) & 255;
      const b = value & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }

  const rgbMatch = color.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const [r, g, b] = rgbMatch[1]
      .split(',')
      .map((part) => part.trim())
      .slice(0, 3);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  return color;
};

export const HomeSectionHeader: React.FC<{
  title: string;
  icon?: React.ReactNode;
  info?: React.ReactNode;
  extra?: React.ReactNode;
}> = ({ title, icon, info, extra }) => {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 12,
      }}
    >
      <Space size={8}>
        {icon}
        <Title level={4} style={{ margin: 0 }}>
          {title}
        </Title>
        {info && (
          <Popover
            content={<div style={{ maxWidth: 320 }}>{info}</div>}
            trigger="hover"
            placement="rightTop"
          >
            <InfoCircleOutlined style={{ color: token.colorTextTertiary, cursor: 'help' }} />
          </Popover>
        )}
      </Space>
      {extra}
    </div>
  );
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
  const activeCount = sessions.filter((s) => activeStatuses.has(s.status)).length;
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

const HomeBoardsSection: React.FC<
  Pick<
    HomePageProps,
    'boardById' | 'recentBoardIds' | 'branchById' | 'sessionsByBranch' | 'onBoardClick'
  >
> = ({ boardById, recentBoardIds = [], branchById, sessionsByBranch, onBoardClick }) => {
  const { token } = theme.useToken();
  const rows = useMemo(() => {
    const visitRank = new Map(recentBoardIds.map((boardId, index) => [boardId, index]));
    return Array.from(boardById.values())
      .filter((b) => !b.archived)
      .map((board) => {
        const branches = Array.from(branchById.values()).filter(
          (branch) => branch.board_id === board.board_id && !branch.archived
        );
        const sessions = branches.flatMap((branch) => sessionsByBranch.get(branch.branch_id) || []);
        const primaryAssistant = board.primary_assistant_id
          ? branchById.get(board.primary_assistant_id)
          : undefined;
        const latest = Math.max(
          new Date(board.last_updated).getTime(),
          ...branches.map((b) => new Date(b.updated_at || b.created_at).getTime()),
          ...sessions.map((s) => new Date(s.last_updated).getTime())
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
          a.visitRank - b.visitRank ||
          b.latest - a.latest ||
          a.board.name.localeCompare(b.board.name)
      );
  }, [boardById, recentBoardIds, branchById, sessionsByBranch]);

  return (
    <section>
      <HomeSectionHeader
        title="Boards"
        icon={<ApartmentOutlined />}
        info="All accessible boards, sorted by this browser’s last-visited board order when available, then by recent board, branch, or session activity."
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
            <ToolIcon tool={session.agentic_tool} size={20} />
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
              {board && (
                <Tag>
                  {board.icon || '📋'} {board.name}
                </Tag>
              )}
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

const HomeSessionsSection: React.FC<
  Pick<HomePageProps, 'sessionById' | 'branchById' | 'boardById' | 'repoById' | 'onSessionClick'>
> = ({ sessionById, branchById, boardById, repoById, onSessionClick }) => {
  const { token } = theme.useToken();
  const cardGlassStyle = glassCardStyle(token);
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useLocalStorage<SessionSort>(SESSION_SORT_STORAGE_KEY, 'recent');
  const allSessions = useMemo(() => Array.from(sessionById.values()), [sessionById]);
  const trimmed = searchQuery.trim();
  const searching = isSessionSearchActive(trimmed);
  const displaySessions = useMemo(
    () =>
      searching
        ? searchSessions(allSessions, trimmed).map(({ session }) => session)
        : sortSessions(allSessions, sort),
    [allSessions, searching, trimmed, sort]
  );

  return (
    <section style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
      <HomeSectionHeader
        title="Sessions"
        icon={<ClockCircleOutlined />}
        info="Cross-board sessions using the same local session state as the board left panel. Board and branch pills are included because this list is not filtered to one board."
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

const HomeActivitySection: React.FC<
  Pick<HomePageProps, 'branchById' | 'boardById' | 'userById' | 'onBoardClick' | 'onBranchClick'>
> = ({ branchById, boardById, userById, onBoardClick, onBranchClick }) => {
  const { token } = theme.useToken();
  const cardGlassStyle = glassCardStyle(token);
  const items = useMemo(
    () =>
      Array.from(branchById.values())
        .filter((b) => !b.archived)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 8),
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
        info="V1 derives a quiet activity summary from local branch/assistant creation state. A persisted activity summary endpoint can replace this later for comments, artifacts, and assistant prompt events."
      />
      <div style={{ overflow: 'auto', minHeight: 0 }}>
        {items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No recent activity" />
        ) : (
          <List
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

const KnowledgeDocRow: React.FC<{ doc: KnowledgeDocument }> = ({ doc }) => {
  const navigate = useNavigate();
  const namespace = namespaceSlugFromUri(doc.uri);
  const path = buildKnowledgeRoutePath(namespace, doc.path);
  return (
    <List.Item onClick={() => navigate(path)} style={{ cursor: 'pointer', padding: '10px 0' }}>
      <List.Item.Meta
        avatar={<BookOutlined />}
        title={<Text ellipsis={{ tooltip: doc.title || doc.path }}>{doc.title || doc.path}</Text>}
        description={
          <Space size={6} wrap>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {namespace || 'Knowledge'} / {doc.path}
            </Text>
            {doc.updated_at && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                · {formatRelativeTime(doc.updated_at)}
              </Text>
            )}
          </Space>
        }
      />
    </List.Item>
  );
};

const HomeKnowledgeSection: React.FC<{ client: AgorClient | null; connected?: boolean }> = ({
  client,
  connected,
}) => {
  const { token } = theme.useToken();
  const cardGlassStyle = glassCardStyle(token);
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!client) return;
    setLoading(true);
    client
      .service('kb/documents')
      .find({ query: { archived: false, $limit: 8, $sort: { updated_at: -1 } } })
      .then((result) => {
        if (cancelled) return;
        const rows = normalizeFindResult<KnowledgeDocument>(result as KnowledgeDocument[])
          .sort(
            (a, b) =>
              new Date(b.updated_at || b.created_at || 0).getTime() -
              new Date(a.updated_at || a.created_at || 0).getTime()
          )
          .slice(0, 8);
        setDocs(rows);
      })
      .catch((err) => {
        if (!cancelled) console.error('Failed to load recent Knowledge:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);
  return (
    <Card
      loading={loading}
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
        title="Recent Knowledge"
        icon={<BookOutlined />}
        info="Recently updated readable Knowledge documents from kb/documents. Access checks remain server-side through the existing Knowledge service."
      />
      <div style={{ overflow: 'auto', minHeight: 0 }}>
        {!connected ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Reconnect to refresh Knowledge"
          />
        ) : docs.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No Knowledge docs yet" />
        ) : (
          <List dataSource={docs} renderItem={(doc) => <KnowledgeDocRow doc={doc} />} />
        )}
      </div>
    </Card>
  );
};

export const HomePage: React.FC<HomePageProps> = (props) => {
  const { token } = theme.useToken();
  const homeBackground = DEFAULT_BACKGROUNDS[isDarkTheme(token) ? 'dark' : 'light'];
  return (
    <div style={{ height: '100%', width: '100%', overflow: 'hidden', background: homeBackground }}>
      <div
        style={{
          height: '100%',
          minHeight: 0,
          padding: '32px clamp(32px, 5vw, 80px) 28px',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(380px, 540px)',
          gap: 24,
        }}
      >
        <main
          style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 24 }}
        >
          <div>
            <Space direction="vertical" size={4}>
              <Title level={2} style={{ margin: 0 }}>
                Home
              </Title>
              <Text type="secondary">
                Jump into boards, resume your sessions, and see recent team context.
              </Text>
            </Space>
          </div>
          <HomeBoardsSection
            boardById={props.boardById}
            recentBoardIds={props.recentBoardIds}
            branchById={props.branchById}
            sessionsByBranch={props.sessionsByBranch}
            onBoardClick={props.onBoardClick}
          />
          <HomeSessionsSection
            sessionById={props.sessionById}
            branchById={props.branchById}
            boardById={props.boardById}
            repoById={props.repoById}
            onSessionClick={props.onSessionClick}
          />
        </main>
        <aside style={{ minHeight: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <HomeActivitySection
            branchById={props.branchById}
            boardById={props.boardById}
            userById={props.userById}
            onBoardClick={props.onBoardClick}
            onBranchClick={props.onBranchClick}
          />
          <HomeKnowledgeSection client={props.client} connected={props.connected} />
        </aside>
      </div>
    </div>
  );
};

export default HomePage;
