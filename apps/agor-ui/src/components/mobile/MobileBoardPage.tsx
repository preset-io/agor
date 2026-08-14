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
  CodeOutlined,
  CommentOutlined,
  FileMarkdownOutlined,
  GitlabOutlined,
  LinkOutlined,
  PushpinFilled,
  RightOutlined,
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
import { getSessionDisplayTitle } from '@/utils/sessionTitle';
import { getBoardEmoji } from '../BoardTile';
import { MarkdownRenderer } from '../MarkdownRenderer/MarkdownRenderer';
import { MobileHeader } from './MobileHeader';

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
  onMenuClick: () => void;
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

function safeExternalUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol) ? url : undefined;
  } catch {
    return undefined;
  }
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
  onMenuClick,
}) => {
  const { boardId = '' } = useParams<{ boardId: string }>();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const board = boardById.get(boardId);

  if (!board) {
    return (
      <>
        <MobileHeader title="Board" onMenuClick={onMenuClick} />
        <Content style={{ padding: token.paddingLG }}>
          <Empty description="Board not found" />
        </Content>
      </>
    );
  }

  const placements = [...(boardObjectsByBoardId.get(boardId) ?? [])].sort((a, b) =>
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

  return (
    <>
      <MobileHeader title={board.name} onMenuClick={onMenuClick} />
      <Content
        style={{
          overflowY: 'auto',
          padding: token.paddingMD,
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
                    {branches.length} branches · {cards.length} cards · {annotations.length} canvas
                    objects
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
              <Empty description="This board is empty" />
            </Card>
          )}

          {zones.length > 0 && (
            <Card size="small" title="Workflow zones">
              <List
                dataSource={zones}
                renderItem={([objectId, zone]) => {
                  const pinnedCount = placements.filter((item) => item.zone_id === objectId).length;
                  return (
                    <List.Item style={{ paddingInline: 0 }}>
                      <List.Item.Meta
                        avatar={<TagsOutlined style={{ color: zone.borderColor ?? zone.color }} />}
                        title={
                          <Space wrap>
                            <Text strong>{zone.label}</Text>
                            {zone.status && <Tag>{zone.status}</Tag>}
                            {zone.locked && <Tag>Locked</Tag>}
                          </Space>
                        }
                        description={
                          <Flex vertical gap={4}>
                            <Text type="secondary">
                              {pinnedCount} pinned {pinnedCount === 1 ? 'item' : 'items'}
                            </Text>
                            {zone.trigger?.template && (
                              <Collapse
                                ghost
                                size="small"
                                items={[
                                  {
                                    key: 'trigger',
                                    label: 'Automation prompt',
                                    children: (
                                      <Paragraph copyable style={{ whiteSpace: 'pre-wrap' }}>
                                        {zone.trigger.template}
                                      </Paragraph>
                                    ),
                                  },
                                ]}
                              />
                            )}
                          </Flex>
                        }
                      />
                    </List.Item>
                  );
                }}
              />
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
                const externalUrl = safeExternalUrl(card.url);
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

          {branches.length > 0 && (
            <Flex vertical gap={token.marginSM}>
              <Title level={5} style={{ margin: 0 }}>
                Branches
              </Title>
              {branches.map(({ branch, placement }) => {
                const sessions = [...(sessionsByBranch.get(branch.branch_id) ?? [])].sort(
                  (a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime()
                );
                const repo = repoById.get(branch.repo_id);
                const zone = placement.zone_id ? board.objects?.[placement.zone_id] : undefined;
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
                      <Text type="secondary" ellipsis>
                        {repo?.slug ?? 'Repository unavailable'}
                      </Text>
                      <ZoneTag zone={zone} />
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
                        renderItem={(session) => (
                          <List.Item
                            style={{ paddingInline: 0 }}
                            actions={[
                              <Button
                                key="open"
                                type="text"
                                aria-label={`Open ${getSessionDisplayTitle(session)}`}
                                icon={<RightOutlined />}
                                onClick={() => navigate(`/m/session/${session.session_id}`)}
                              />,
                            ]}
                          >
                            <List.Item.Meta
                              title={<Text ellipsis>{getSessionDisplayTitle(session)}</Text>}
                              description={
                                <Space size={token.marginXS} wrap>
                                  <Badge
                                    status={session.status === 'running' ? 'processing' : 'default'}
                                  />
                                  <Text type="secondary">{session.status}</Text>
                                  <Text type="secondary">{session.agentic_tool}</Text>
                                </Space>
                              }
                            />
                          </List.Item>
                        )}
                      />
                    </Flex>
                  </Card>
                );
              })}
            </Flex>
          )}
        </Flex>
      </Content>
    </>
  );
};
