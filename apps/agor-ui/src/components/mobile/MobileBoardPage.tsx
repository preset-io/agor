import type {
  Artifact,
  Board,
  BoardEntityObject,
  BoardObject,
  Branch,
  CardWithType,
  Repo,
  Session,
} from '@agor-live/client';
import {
  AppstoreOutlined,
  CalendarOutlined,
  CodeOutlined,
  CommentOutlined,
  FileMarkdownOutlined,
  GitlabOutlined,
  LinkOutlined,
  PlusOutlined,
  PushpinFilled,
  RightOutlined,
  SettingOutlined,
  TagsOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Card,
  Collapse,
  Empty,
  Flex,
  Layout,
  List,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { isSafeExternalUrl } from '@/utils/safeExternalUrl';
import { sortSessions } from '@/utils/sessionSearch';
import { resolveBoardFromUrlPure } from '@/utils/urlResolution';
import { getBoardEmoji } from '../BoardTile';
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer';
import { mobilePageStyle, mobileScrollAreaStyle } from './constants';
import { MobileHeader } from './MobileHeader';
import { MobileSessionRow } from './MobileSessionRow';

const { Content } = Layout;
const { Paragraph, Text, Title } = Typography;

interface MobileBoardPageProps {
  boardById: Map<string, Board>;
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  sessionsByBranch: Map<string, Session[]>;
  boardObjectsByBoardId: Map<string, BoardEntityObject[]>;
  cardById: Map<string, CardWithType>;
  artifactById: Map<string, Artifact>;
  onOpenBranch: (branchId: string, tab: 'general' | 'environment' | 'schedule') => void;
  /** Start a new session on a branch (opens the agent picker). */
  onNewSession: (branchId: string) => void;
  /** Empty-board CTA: hand the board's assistant its first task (Ask primary). */
  onGiveFirstTask: () => void;
  /** Display name of the assistant used in the empty-board CTA. */
  firstTaskAssistantName?: string;
  /** Unread comments count for the header bell. */
  commentsBadge?: number;
  /** Opens comments/mentions from the header bell. */
  onOpenComments?: () => void;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function statusColor(status: Branch['filesystem_status']): string {
  if (status === 'ready') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'creating') return 'processing';
  return 'default';
}

function spatialSort<T extends { x: number; y: number }>(a: T, b: T): number {
  return a.y - b.y || a.x - b.x;
}

function ZoneTag({ zone }: { zone: BoardObject | undefined }) {
  if (zone?.type !== 'zone') return null;
  return (
    <Tag icon={<PushpinFilled />} style={{ alignSelf: 'flex-start' }}>
      {zone.label}
    </Tag>
  );
}

export const MobileBoardPage: React.FC<MobileBoardPageProps> = ({
  boardById,
  branchById,
  repoById,
  sessionsByBranch,
  boardObjectsByBoardId,
  cardById,
  artifactById,
  onOpenBranch,
  onNewSession,
  onGiveFirstTask,
  firstTaskAssistantName,
  commentsBadge,
  onOpenComments,
}) => {
  const { boardId = '' } = useParams<{ boardId: string }>();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const resolvedBoardId = boardById.has(boardId)
    ? boardId
    : resolveBoardFromUrlPure(boardId, boardById);
  const board = resolvedBoardId ? boardById.get(resolvedBoardId) : undefined;

  const boardSwitcher = {
    boards: Array.from(boardById.values())
      .filter((b) => !b.archived)
      .map((b) => ({ board_id: b.board_id, name: b.name, emoji: getBoardEmoji(b, branchById) })),
    currentBoardId: resolvedBoardId ?? undefined,
    onSelect: (id: string) => navigate(`/m/board/${id}`),
  };

  if (!board) {
    return (
      <div style={mobilePageStyle}>
        <MobileHeader
          title="Board"
          boardSwitcher={boardSwitcher}
          onSearch={() => navigate('/m/search')}
        />
        <Content style={{ flex: 1, minHeight: 0, padding: token.padding }}>
          <Empty description="Board not found" />
        </Content>
      </div>
    );
  }

  const placements = [...(boardObjectsByBoardId.get(board.board_id) ?? [])].sort((a, b) =>
    spatialSort(a.position, b.position)
  );
  const branches = placements.flatMap((placement) => {
    const branch = placement.branch_id ? branchById.get(placement.branch_id) : undefined;
    return branch ? [{ branch, placement }] : [];
  });
  const cards = placements.flatMap((placement) => {
    const card = placement.card_id ? cardById.get(placement.card_id) : undefined;
    return card && !card.archived ? [{ card, placement }] : [];
  });
  const annotations = Object.entries(board.objects ?? {}).sort(([, a], [, b]) => spatialSort(a, b));
  const zones = annotations.filter(
    (entry): entry is [string, Extract<BoardObject, { type: 'zone' }>] => entry[1].type === 'zone'
  );
  const contentObjects = annotations.filter(([, object]) => object.type !== 'zone');
  const isEmpty = branches.length === 0 && cards.length === 0 && annotations.length === 0;

  // Group branch placements by their zone so the Board tab reads as collapsible
  // zones of branch cards. Branches outside any zone fall into `undefined`.
  const branchesByZone = new Map<string | undefined, typeof branches>();
  for (const item of branches) {
    const zoneId =
      item.placement.zone_id && board.objects?.[item.placement.zone_id]?.type === 'zone'
        ? item.placement.zone_id
        : undefined;
    const list = branchesByZone.get(zoneId) ?? [];
    list.push(item);
    branchesByZone.set(zoneId, list);
  }
  const hasZones = zones.length > 0;
  const ungroupedBranches = branchesByZone.get(undefined) ?? [];
  // A board that has a teammate branch but no sessions yet (e.g. just after
  // onboarding, or before an AI model is connected) should still lead with a
  // first-task action instead of a bare board.
  const boardHasSessions = branches.some(
    ({ branch }) => (sessionsByBranch.get(branch.branch_id) ?? []).length > 0
  );

  const renderBranchCard = (branch: Branch) => {
    const sessions = sortSessions(sessionsByBranch.get(branch.branch_id) ?? [], 'recent');
    const repo = repoById.get(branch.repo_id);
    return (
      <Card
        key={branch.branch_id}
        size="small"
        title={
          <Flex align="center" gap={token.marginXS} wrap>
            <GitlabOutlined />
            <Text strong ellipsis style={{ minWidth: 0, flex: 1 }}>
              {branch.name}
            </Text>
            <Tag color={statusColor(branch.filesystem_status)} style={{ margin: 0 }}>
              {branch.filesystem_status ?? 'unknown'}
            </Tag>
          </Flex>
        }
      >
        <Flex vertical gap={token.marginSM}>
          <Flex gap={token.marginXS}>
            <Button
              style={{ flex: 1 }}
              icon={<SettingOutlined />}
              onClick={() => onOpenBranch(branch.branch_id, 'general')}
            >
              Manage
            </Button>
            <Button
              style={{ flex: 1 }}
              onClick={() => onOpenBranch(branch.branch_id, 'environment')}
            >
              Environment
            </Button>
            <Button
              style={{ flex: 1 }}
              icon={<CalendarOutlined />}
              onClick={() => onOpenBranch(branch.branch_id, 'schedule')}
            >
              Schedules
            </Button>
          </Flex>
          <Text type="secondary" ellipsis>
            {repo?.slug ?? 'Repository unavailable'}
          </Text>
          {branch.filesystem_status === 'failed' && branch.error_message && (
            <Flex gap={token.marginXS} align="flex-start">
              <WarningOutlined style={{ color: token.colorError, marginTop: 3 }} />
              <Text type="danger">{branch.error_message}</Text>
            </Flex>
          )}
          <List
            size="small"
            locale={{ emptyText: 'No sessions yet' }}
            dataSource={sessions.slice(0, 4)}
            renderItem={(session) => <MobileSessionRow session={session} />}
          />
          <Button block icon={<PlusOutlined />} onClick={() => onNewSession(branch.branch_id)}>
            New session
          </Button>
        </Flex>
      </Card>
    );
  };

  return (
    <div style={mobilePageStyle}>
      <MobileHeader
        title={board.name}
        boardSwitcher={boardSwitcher}
        onSearch={() => navigate('/m/search')}
        commentsBadge={commentsBadge}
        onOpenComments={onOpenComments}
      />
      <Content
        style={{
          ...mobileScrollAreaStyle,
          paddingInline: token.padding,
          paddingBlock: token.paddingMD,
          paddingBottom: `calc(${token.paddingXL}px + env(safe-area-inset-bottom))`,
        }}
      >
        <Flex vertical gap={token.marginMD} style={{ maxWidth: 680, margin: '0 auto' }}>
          <Card size="small">
            <Flex justify="space-between" align="flex-start" gap={token.marginSM}>
              <Space align="start">
                <span aria-hidden style={{ fontSize: 28, lineHeight: 1 }}>
                  {getBoardEmoji(board, branchById)}
                </span>
                <div>
                  <Title level={4} style={{ margin: 0 }}>
                    {board.name}
                  </Title>
                  <Text type="secondary">
                    {plural(branches.length, 'branch', 'branches')} · {plural(cards.length, 'card')}{' '}
                    · {plural(annotations.length, 'canvas object')}
                  </Text>
                </div>
              </Space>
              <Button
                type="text"
                aria-label={`Open comments for ${board.name}`}
                icon={<CommentOutlined />}
                onClick={() => navigate(`/m/comments/${board.board_id}`)}
              />
            </Flex>
            {board.description && (
              <Paragraph type="secondary" style={{ marginBlock: token.marginSM, marginBottom: 0 }}>
                {board.description}
              </Paragraph>
            )}
          </Card>

          {isEmpty && (
            <Card>
              <Empty
                description={`No work here yet. Kick things off with ${
                  firstTaskAssistantName ?? 'your assistant'
                }.`}
              >
                <Button type="primary" onClick={onGiveFirstTask}>
                  Give {firstTaskAssistantName ?? 'your assistant'} their first task
                </Button>
              </Empty>
            </Card>
          )}

          {!isEmpty && !boardHasSessions && (
            <Card size="small">
              <Flex vertical gap={token.marginSM} align="flex-start">
                <Text>Ready when you are. Kick things off with a first task.</Text>
                <Button type="primary" onClick={onGiveFirstTask}>
                  Give {firstTaskAssistantName ?? 'your assistant'} their first task
                </Button>
              </Flex>
            </Card>
          )}

          {contentObjects.length > 0 && (
            <Flex vertical gap={token.marginSM}>
              <Title level={5} style={{ margin: 0 }}>
                Canvas content
              </Title>
              {contentObjects.map(([objectId, object]) => {
                if (object.type === 'text') {
                  return (
                    <Card key={objectId} size="small">
                      <Text style={{ fontSize: object.fontSize }}>{object.content}</Text>
                    </Card>
                  );
                }
                if (object.type === 'markdown') {
                  return (
                    <Card
                      key={objectId}
                      size="small"
                      title={
                        <Space>
                          <FileMarkdownOutlined /> Note
                        </Space>
                      }
                    >
                      <MarkdownRenderer content={object.content} compact showControls={false} />
                    </Card>
                  );
                }
                if (object.type === 'app') {
                  return (
                    <Card
                      key={objectId}
                      size="small"
                      title={
                        <Space>
                          <CodeOutlined /> {object.title}
                        </Space>
                      }
                    >
                      <Flex vertical gap={token.marginXS}>
                        {object.description && <Text>{object.description}</Text>}
                        <Text type="secondary">
                          Interactive app · {object.template} · {Object.keys(object.files).length}{' '}
                          files
                        </Text>
                        <Alert
                          type="info"
                          showIcon
                          title="Use the desktop canvas to run this legacy embedded app. Mobile keeps it visible without automatically executing board code."
                        />
                      </Flex>
                    </Card>
                  );
                }
                if (object.type !== 'artifact') return null;
                const artifact = artifactById.get(object.artifact_id);
                return (
                  <Card
                    key={objectId}
                    size="small"
                    title={
                      <Space>
                        <AppstoreOutlined /> {artifact?.name ?? 'Artifact unavailable'}
                      </Space>
                    }
                    extra={
                      artifact?.fullscreen_url ? (
                        <Button
                          type="link"
                          href={artifact.fullscreen_url}
                          icon={<RightOutlined />}
                          aria-label={`Open ${artifact.name}`}
                        >
                          Open
                        </Button>
                      ) : null
                    }
                  >
                    <Flex vertical gap={token.marginXS}>
                      {artifact?.description && <Text>{artifact.description}</Text>}
                      <Space wrap>
                        <Tag color={artifact?.build_status === 'error' ? 'error' : 'default'}>
                          {artifact?.build_status ?? 'missing'}
                        </Tag>
                        {artifact?.template && <Tag>{artifact.template}</Tag>}
                      </Space>
                      {artifact?.build_errors?.length ? (
                        <Alert type="error" showIcon title={artifact.build_errors.join('\n')} />
                      ) : null}
                    </Flex>
                  </Card>
                );
              })}
            </Flex>
          )}

          {cards.length > 0 && (
            <Flex vertical gap={token.marginSM}>
              <Title level={5} style={{ margin: 0 }}>
                Cards
              </Title>
              {cards.map(({ card, placement }) => {
                const externalUrl = isSafeExternalUrl(card.url) ? card.url : undefined;
                const zone = placement.zone_id ? board.objects?.[placement.zone_id] : undefined;
                return (
                  <Card
                    key={card.card_id}
                    size="small"
                    title={
                      <Space>
                        {card.effective_emoji && <span>{card.effective_emoji}</span>}
                        <Text strong>{card.title}</Text>
                      </Space>
                    }
                    extra={
                      externalUrl ? (
                        <Button
                          type="link"
                          href={externalUrl}
                          target="_blank"
                          icon={<LinkOutlined />}
                        >
                          Open
                        </Button>
                      ) : null
                    }
                    style={{
                      borderInlineStart: `4px solid ${card.effective_color ?? token.colorBorder}`,
                    }}
                  >
                    <Flex vertical gap={token.marginXS}>
                      <ZoneTag zone={zone} />
                      {card.description && <Text type="secondary">{card.description}</Text>}
                      {card.note && <Alert type="info" title={card.note} />}
                      {card.data && Object.keys(card.data).length > 0 && (
                        <Collapse
                          size="small"
                          items={[
                            {
                              key: 'data',
                              label: 'Structured data',
                              children: (
                                <pre style={{ margin: 0, overflowX: 'auto' }}>
                                  {JSON.stringify(card.data, null, 2)}
                                </pre>
                              ),
                            },
                          ]}
                        />
                      )}
                    </Flex>
                  </Card>
                );
              })}
            </Flex>
          )}

          {branches.length > 0 &&
            (hasZones ? (
              <Collapse
                ghost
                defaultActiveKey={zones.map(([id]) => id)}
                items={[
                  ...zones.map(([zoneId, zone]) => {
                    const zoneBranches = branchesByZone.get(zoneId) ?? [];
                    return {
                      key: zoneId,
                      // paddingInline:0 aligns the zone label with its cards' gutter.
                      styles: { header: { paddingInline: 0 }, body: { paddingInline: 0 } },
                      label: (
                        <Space>
                          <TagsOutlined style={{ color: zone.borderColor ?? zone.color }} />
                          <Text strong>{zone.label}</Text>
                          <Badge
                            count={zoneBranches.length}
                            showZero
                            color={token.colorFillSecondary}
                          />
                          {zone.locked && <Tag>Locked</Tag>}
                        </Space>
                      ),
                      children: (
                        <Flex vertical gap={token.marginSM}>
                          {zone.trigger?.template && (
                            <Paragraph
                              type="secondary"
                              copyable
                              style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}
                            >
                              {zone.trigger.template}
                            </Paragraph>
                          )}
                          {zoneBranches.length > 0 ? (
                            zoneBranches.map(({ branch }) => renderBranchCard(branch))
                          ) : (
                            <Text type="secondary">No branches in this zone</Text>
                          )}
                        </Flex>
                      ),
                    };
                  }),
                  ...(ungroupedBranches.length > 0
                    ? [
                        {
                          key: '__ungrouped',
                          styles: { header: { paddingInline: 0 }, body: { paddingInline: 0 } },
                          label: (
                            <Space>
                              <Text strong>Other branches</Text>
                              <Badge
                                count={ungroupedBranches.length}
                                showZero
                                color={token.colorFillSecondary}
                              />
                            </Space>
                          ),
                          children: (
                            <Flex vertical gap={token.marginSM}>
                              {ungroupedBranches.map(({ branch }) => renderBranchCard(branch))}
                            </Flex>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            ) : (
              <Flex vertical gap={token.marginSM}>
                <Title level={5} style={{ margin: 0 }}>
                  Branches
                </Title>
                {branches.map(({ branch }) => renderBranchCard(branch))}
              </Flex>
            ))}
        </Flex>
      </Content>
    </div>
  );
};
