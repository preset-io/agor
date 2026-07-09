import type { AgorClient, Branch, Link, Session } from '@agor-live/client';
import {
  EllipsisOutlined,
  GithubOutlined,
  PushpinFilled,
  PushpinOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Dropdown,
  Empty,
  Input,
  List,
  Select,
  Space,
  Spin,
  Tabs,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { useAgorStore } from '../../../store/agorStore';
import {
  makeLinksForBranchSelector,
  selectApplyKnownLinkCreatedResult,
  selectApplyKnownLinkRemovedResult,
  selectApplyLinkMutationResult,
  selectBoardById,
  selectFetchAndReplaceFullBranchLinks,
  selectSessionById,
} from '../../../store/selectors';
import { useThemedMessage } from '../../../utils/message';
import {
  buildLinkDisplayItems,
  compareLinkDisplayItemsBySort,
  getAssistantPromotionState,
  getCompactLinkDisplayName,
  getLinkCategoryCounts,
  getLinkDisplayGlyphLabel,
  getLinkDisplaySecondaryLabel,
  isFileLinkDisplayItem,
  LINK_CATEGORY_TAB_LABELS,
  LINK_SORT_LABELS,
  type LinkCategoryTabKey,
  type LinkDisplayItem,
  type LinkSortKey,
  matchesLinkCategoryTab,
  promoteLinkToAssistant,
} from '../../Links';
import {
  LinkImagePreviewModal,
  type LinkImagePreviewTarget,
} from '../../Links/LinkImagePreviewModal';
import {
  LinkMarkdownPreviewModal,
  type LinkMarkdownPreviewTarget,
} from '../../Links/LinkMarkdownPreviewModal';
import {
  downloadLinkContent,
  getLinkContentAction,
  getLinkPreviewKind,
} from '../../Links/linkContent';

interface LinksTabProps {
  branch: Branch;
  client: AgorClient | null;
  active: boolean;
  open: boolean;
}

function isFileItem(item: LinkDisplayItem): boolean {
  return isFileLinkDisplayItem(item);
}

function getUnavailableReason(item: LinkDisplayItem): string | null {
  if (item.href || getLinkContentAction(item)) return null;
  if (isFileItem(item)) return 'No preview/download route is available yet.';
  return 'No safe route is available for this item yet.';
}

function BranchGlyph({ item, disabled = false }: { item: LinkDisplayItem; disabled?: boolean }) {
  const { token } = theme.useToken();
  const isGitHubLink = item.category === 'issue' || item.category === 'pr';
  return (
    <span
      className="agor-action-link-icon"
      aria-hidden="true"
      style={{
        width: 28,
        height: 28,
        borderRadius: token.borderRadiusLG,
        background: token.colorFillTertiary,
        color: disabled
          ? token.colorTextDisabled
          : `var(--agor-link-icon-color, ${token.colorTextTertiary})`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: 0.2,
        flex: '0 0 auto',
      }}
    >
      {disabled ? (
        <StopOutlined style={{ fontSize: 13 }} />
      ) : isGitHubLink ? (
        <GithubOutlined style={{ fontSize: 13 }} />
      ) : (
        getLinkDisplayGlyphLabel(item.category)
      )}
    </span>
  );
}

function BranchTitle({
  item,
  onPreview,
  onDownload,
}: {
  item: LinkDisplayItem;
  onPreview: (item: LinkDisplayItem) => void;
  onDownload: (item: LinkDisplayItem) => void;
}) {
  const { token } = theme.useToken();
  const title = getCompactLinkDisplayName(item);
  const contentAction = getLinkContentAction(item);
  const disabled = Boolean(getUnavailableReason(item));
  const style: React.CSSProperties = {
    color: disabled ? token.colorTextDisabled : `var(--agor-link-title-color, ${token.colorText})`,
    fontWeight: 600,
    lineHeight: 1.25,
  };

  if (item.href && item.navigation === 'spa') {
    return (
      <RouterLink
        className="agor-action-link-title"
        to={item.href}
        style={{ ...style, textDecoration: 'none' }}
        title={title}
      >
        {title}
      </RouterLink>
    );
  }

  if (item.href) {
    return (
      <a
        className="agor-action-link-title"
        href={item.href}
        target="_blank"
        rel="noreferrer"
        style={{ ...style, textDecoration: 'none' }}
        title={title}
      >
        {title}
      </a>
    );
  }

  if (contentAction) {
    return (
      <button
        className="agor-action-link-title"
        type="button"
        onClick={() => {
          if (contentAction === 'preview') onPreview(item);
          else onDownload(item);
        }}
        style={{
          ...style,
          border: 0,
          background: 'transparent',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left',
        }}
        title={title}
      >
        {title}
      </button>
    );
  }

  return (
    <Typography.Text disabled style={style} title={title}>
      {title}
    </Typography.Text>
  );
}

function BranchStatusPill({
  item,
  onTogglePinned,
  pinning = false,
}: {
  item: LinkDisplayItem;
  onTogglePinned: (item: LinkDisplayItem) => void | Promise<void>;
  pinning?: boolean;
}) {
  const { token } = theme.useToken();
  const title = getCompactLinkDisplayName(item);
  const canTogglePin = Boolean(item.linkId);
  const actionLabel = item.isPinned ? 'Unpin from branch card' : 'Pin to branch card';
  return (
    <Tooltip title={actionLabel}>
      <button
        type="button"
        disabled={!canTogglePin || pinning}
        aria-label={`${actionLabel} ${title}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onTogglePinned(item);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0,
          width: 24,
          height: 24,
          padding: 0,
          border: 0,
          borderRadius: token.borderRadiusSM,
          background: item.isPinned ? token.colorWarningBg : token.colorFillTertiary,
          color: item.isPinned ? token.colorWarning : token.colorTextSecondary,
          fontSize: 12,
          cursor: canTogglePin && !pinning ? 'pointer' : 'default',
          opacity: pinning ? 0.55 : 1,
        }}
      >
        {item.isPinned ? <PushpinFilled /> : <PushpinOutlined />}
      </button>
    </Tooltip>
  );
}

function assistantPromotionLabel(state: ReturnType<typeof getAssistantPromotionState>): string {
  if (!state.canPromote) {
    if (state.reason === 'no-assistant') return 'No assistant configured';
    if (state.reason === 'same-owner') return 'Already on assistant branch';
    if (state.reason === 'missing-source-link') return 'Cannot add generated branch metadata';
    return 'Cannot add this link';
  }
  return state.isPromoted ? 'Remove from assistant' : 'Promote to assistant';
}

function BranchAssistantPromotionAction({
  item,
  assistantBranchId,
  assistantLinks,
  sourceBranchId,
  busyKey,
  onPromote,
  onRemove,
}: {
  item: LinkDisplayItem;
  assistantBranchId?: string | null;
  assistantLinks: Link[];
  sourceBranchId: string;
  busyKey?: string | null;
  onPromote: (item: LinkDisplayItem) => void | Promise<void>;
  onRemove: (item: LinkDisplayItem, assistantLinkId: string) => void | Promise<void>;
}) {
  const { token } = theme.useToken();
  const state = getAssistantPromotionState({
    item,
    assistantBranchId,
    assistantLinks,
    sourceBranchId,
  });
  const busy = busyKey === (state.assistantLink?.link_id ?? item.linkId ?? item.key);
  const label = assistantPromotionLabel(state);

  return (
    <Tooltip title={state.canPromote ? 'Assistant link actions' : label}>
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            {
              key: state.isPromoted ? 'remove-assistant' : 'promote-assistant',
              label,
              disabled: !state.canPromote || busy,
            },
          ],
          onClick: ({ domEvent }) => {
            domEvent.preventDefault();
            domEvent.stopPropagation();
            if (!state.canPromote || busy) return;
            if (state.isPromoted && state.assistantLink) {
              void onRemove(item, state.assistantLink.link_id);
            } else {
              void onPromote(item);
            }
          },
        }}
      >
        <Button
          type="text"
          size="small"
          loading={busy}
          aria-label={`Assistant actions for ${getCompactLinkDisplayName(item)}`}
          icon={<EllipsisOutlined />}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          style={{
            width: 24,
            minWidth: 24,
            height: 24,
            padding: 0,
            color: token.colorTextTertiary,
          }}
        />
      </Dropdown>
    </Tooltip>
  );
}

function shouldIgnoreRowActivation(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('a,button,[role="button"]'));
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function getSessionLabel(session: Session | undefined, sessionId: string): string {
  const title = typeof session?.title === 'string' ? session.title.trim() : '';
  return title || sessionId.slice(0, 8);
}

function getSourceSessionLabel(
  item: LinkDisplayItem,
  sessionById: Map<string, Session>
): string | null {
  const sessionId = item.sourceSessionId ?? item.sessionId;
  if (!sessionId) return null;
  return getSessionLabel(sessionById.get(sessionId), sessionId);
}

function itemMatchesSearch(
  item: LinkDisplayItem,
  query: string,
  sessionById: Map<string, Session>
): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  const fields = [
    item.name,
    getCompactLinkDisplayName(item),
    getLinkDisplaySecondaryLabel(item),
    item.url,
    item.refUri,
    item.filePath,
    getSourceSessionLabel(item, sessionById),
  ];
  return fields.some((field) => field?.toLowerCase().includes(normalizedQuery));
}

const LinksTabInner: React.FC<LinksTabProps> = ({ branch, client, active, open }) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { showSuccess, showError } = useThemedMessage();
  const boardById = useAgorStore(selectBoardById);
  const sessionById = useAgorStore(selectSessionById);
  const fetchAndReplaceFullBranchLinks = useAgorStore(selectFetchAndReplaceFullBranchLinks);
  const applyLinkMutationResult = useAgorStore(selectApplyLinkMutationResult);
  const applyKnownLinkCreatedResult = useAgorStore(selectApplyKnownLinkCreatedResult);
  const applyKnownLinkRemovedResult = useAgorStore(selectApplyKnownLinkRemovedResult);
  const branchLinksSelector = useMemo(
    () => makeLinksForBranchSelector(branch.branch_id),
    [branch.branch_id]
  );
  const links = useAgorStore(branchLinksSelector) ?? [];
  const assistantBranchId = branch.board_id
    ? (boardById.get(branch.board_id)?.primary_assistant_id ?? null)
    : null;
  const assistantLinksSelector = useMemo(
    () => makeLinksForBranchSelector(assistantBranchId ?? ''),
    [assistantBranchId]
  );
  const assistantLinks = useAgorStore(assistantLinksSelector) ?? [];
  const assistantPromotionLinks = assistantBranchId === branch.branch_id ? links : assistantLinks;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinningLinkId, setPinningLinkId] = useState<string | null>(null);
  const [assistantPromotionBusyKey, setAssistantPromotionBusyKey] = useState<string | null>(null);
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<LinkImagePreviewTarget | null>(null);
  const [markdownTarget, setMarkdownTarget] = useState<LinkMarkdownPreviewTarget | null>(null);
  const [activeCategory, setActiveCategory] = useState<LinkCategoryTabKey>('all');
  const [sortOrder, setSortOrder] = useState<LinkSortKey>('az');
  const [searchQuery, setSearchQuery] = useState('');

  const hydrate = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const requests = [fetchAndReplaceFullBranchLinks(client, branch.branch_id)];
      if (assistantBranchId && assistantBranchId !== branch.branch_id) {
        requests.push(fetchAndReplaceFullBranchLinks(client, assistantBranchId));
      }
      await Promise.all(requests);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Could not load branch links');
    } finally {
      setLoading(false);
    }
  }, [assistantBranchId, branch.branch_id, client, fetchAndReplaceFullBranchLinks]);

  useEffect(() => {
    if (!open || !active || !client) return;
    void hydrate();
  }, [active, client, hydrate, open]);

  const items = useMemo(() => buildLinkDisplayItems({ branch, links }), [branch, links]);
  const categoryCounts = useMemo(() => getLinkCategoryCounts(items), [items]);
  const categoryTabs = useMemo(
    () =>
      (['all', 'files', 'links', 'knowledge', 'issues'] as const).map((key) => ({
        key,
        label: `${LINK_CATEGORY_TAB_LABELS[key]} ${categoryCounts[key]}`,
      })),
    [categoryCounts]
  );
  const visibleItems = useMemo(
    () =>
      items
        .filter((item) => matchesLinkCategoryTab(item, activeCategory))
        .filter((item) => itemMatchesSearch(item, searchQuery, sessionById))
        .sort((a, b) => compareLinkDisplayItemsBySort(a, b, sortOrder)),
    [activeCategory, items, searchQuery, sessionById, sortOrder]
  );

  const openPreview = useCallback((item: LinkDisplayItem) => {
    if (!item.linkId) return;
    const previewKind = getLinkPreviewKind(item);
    const target = {
      linkId: item.linkId,
      title: getCompactLinkDisplayName(item),
      subtitle: getLinkDisplaySecondaryLabel(item),
    };
    if (previewKind === 'image') {
      setPreviewTarget(target);
    } else if (previewKind === 'markdown' || previewKind === 'text') {
      setMarkdownTarget(target);
    }
  }, []);

  const downloadItem = useCallback(
    async (item: LinkDisplayItem) => {
      if (!item.linkId || busyLinkId) return;
      setBusyLinkId(item.linkId);
      try {
        await downloadLinkContent(item.linkId, getCompactLinkDisplayName(item));
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Download failed');
      } finally {
        setBusyLinkId(null);
      }
    },
    [busyLinkId, showError]
  );

  const openItem = useCallback(
    (item: LinkDisplayItem) => {
      const contentAction = getLinkContentAction(item);
      if (contentAction === 'preview') {
        openPreview(item);
        return;
      }
      if (contentAction === 'download') {
        void downloadItem(item);
        return;
      }
      if (item.href && item.navigation === 'spa') {
        navigate(item.href);
        return;
      }
      if (item.href) {
        window.open(item.href, '_blank', 'noopener,noreferrer');
      }
    },
    [downloadItem, navigate, openPreview]
  );

  const handleTogglePinned = useCallback(
    async (item: LinkDisplayItem) => {
      if (!client || !item.linkId || pinningLinkId) return;
      setPinningLinkId(item.linkId);
      try {
        const updated = (await client.service('links').patch(item.linkId, {
          is_pinned: !item.isPinned,
        })) as Link;
        applyLinkMutationResult(updated);
      } catch (err) {
        showError(`Failed to update pin: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setPinningLinkId(null);
      }
    },
    [applyLinkMutationResult, client, pinningLinkId, showError]
  );

  const handlePromoteToAssistant = useCallback(
    async (item: LinkDisplayItem) => {
      if (!client || !assistantBranchId || !item.linkId || assistantPromotionBusyKey) return;
      setAssistantPromotionBusyKey(item.linkId);
      try {
        const promoted = await promoteLinkToAssistant({
          client,
          sourceLinkId: item.linkId,
          assistantBranchId,
        });
        applyKnownLinkCreatedResult(promoted);
        showSuccess('Promoted to assistant');
      } catch (err) {
        showError(`Failed to promote link: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setAssistantPromotionBusyKey(null);
      }
    },
    [
      applyKnownLinkCreatedResult,
      assistantBranchId,
      assistantPromotionBusyKey,
      client,
      showError,
      showSuccess,
    ]
  );

  const handleRemoveFromAssistant = useCallback(
    async (_item: LinkDisplayItem, assistantLinkId: string) => {
      if (!client || assistantPromotionBusyKey) return;
      setAssistantPromotionBusyKey(assistantLinkId);
      try {
        const removed = (await client.service('links').remove(assistantLinkId)) as Link;
        applyKnownLinkRemovedResult(removed);
        showSuccess('Removed from assistant');
      } catch (err) {
        showError(
          `Failed to remove assistant link: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setAssistantPromotionBusyKey(null);
      }
    },
    [applyKnownLinkRemovedResult, assistantPromotionBusyKey, client, showError, showSuccess]
  );

  return (
    <>
      <LinkImagePreviewModal target={previewTarget} onClose={() => setPreviewTarget(null)} />
      <LinkMarkdownPreviewModal target={markdownTarget} onClose={() => setMarkdownTarget(null)} />
      <div
        style={{ width: '100%', height: '70vh', overflowY: 'auto' }}
        data-testid="branch-links-tab"
      >
        <Space direction="vertical" size={token.sizeMD} style={{ width: '100%' }}>
          {error && (
            <div style={{ padding: `0 ${token.paddingLG}px` }}>
              <Alert message="Error" description={error} type="error" showIcon />
            </div>
          )}

          {loading ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 180,
              }}
            >
              <Spin />
            </div>
          ) : items.length > 0 ? (
            <Space direction="vertical" size={token.sizeMD} style={{ width: '100%' }}>
              <div style={{ padding: `0 ${token.paddingLG}px` }}>
                <Tabs
                  className="agor-link-category-tabs"
                  activeKey={activeCategory}
                  items={categoryTabs}
                  onChange={(key) => setActiveCategory(key as LinkCategoryTabKey)}
                />
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: token.sizeSM,
                    width: '100%',
                    flexWrap: 'wrap',
                    marginTop: token.sizeMD,
                  }}
                >
                  <Input.Search
                    allowClear
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search links"
                    aria-label="Search links"
                    style={{ flex: '1 1 320px', minWidth: 220 }}
                  />
                  <Space size={token.sizeXS} style={{ flex: '0 0 auto' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Sort
                    </Typography.Text>
                    <Select<LinkSortKey>
                      size="small"
                      value={sortOrder}
                      options={(Object.keys(LINK_SORT_LABELS) as LinkSortKey[]).map((key) => ({
                        value: key,
                        label: LINK_SORT_LABELS[key],
                      }))}
                      onChange={setSortOrder}
                      style={{ width: 128 }}
                    />
                  </Space>
                </div>
              </div>
              {visibleItems.length > 0 ? (
                <List
                  style={{ padding: `0 ${token.paddingLG}px` }}
                  dataSource={visibleItems}
                  renderItem={(item) => {
                    const disabledReason = getUnavailableReason(item);
                    const disabled = Boolean(disabledReason);
                    const targetLabel = getLinkDisplaySecondaryLabel(item);
                    const sourceSessionLabel = getSourceSessionLabel(item, sessionById);
                    return (
                      <List.Item
                        className="agor-action-link-row"
                        key={item.key}
                        role={disabled ? undefined : 'link'}
                        tabIndex={disabled ? -1 : 0}
                        aria-disabled={disabled || undefined}
                        onClick={(event) => {
                          if (disabled || shouldIgnoreRowActivation(event.target)) return;
                          openItem(item);
                        }}
                        onKeyDown={(event) => {
                          if (disabled || shouldIgnoreRowActivation(event.target)) return;
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          openItem(item);
                        }}
                        style={
                          {
                            '--agor-link-title-color': disabled
                              ? token.colorTextDisabled
                              : token.colorText,
                            '--agor-link-icon-color': disabled
                              ? token.colorTextDisabled
                              : token.colorTextTertiary,
                            '--agor-link-row-hover-bg': token.colorFillTertiary,
                            '--agor-link-row-hover-color': token.colorPrimary,
                            borderColor: token.colorBorderSecondary,
                            borderRadius: token.borderRadius,
                            cursor: disabled ? 'default' : 'pointer',
                            paddingRight: token.sizeSM,
                          } as React.CSSProperties
                        }
                        actions={[
                          <BranchStatusPill
                            key="state"
                            item={item}
                            onTogglePinned={handleTogglePinned}
                            pinning={item.linkId === pinningLinkId}
                          />,
                          <BranchAssistantPromotionAction
                            key="assistant"
                            item={item}
                            assistantBranchId={assistantBranchId}
                            assistantLinks={assistantPromotionLinks}
                            sourceBranchId={branch.branch_id}
                            busyKey={assistantPromotionBusyKey}
                            onPromote={handlePromoteToAssistant}
                            onRemove={handleRemoveFromAssistant}
                          />,
                        ]}
                      >
                        <List.Item.Meta
                          avatar={<BranchGlyph item={item} disabled={disabled} />}
                          title={
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: token.sizeXS,
                                minWidth: 0,
                              }}
                            >
                              <BranchTitle
                                item={item}
                                onPreview={openPreview}
                                onDownload={downloadItem}
                              />
                            </span>
                          }
                          description={
                            <span>
                              {targetLabel && (
                                <Typography.Text
                                  type="secondary"
                                  ellipsis
                                  style={{ display: 'block' }}
                                >
                                  {targetLabel}
                                </Typography.Text>
                              )}
                              {sourceSessionLabel && (
                                <Typography.Text
                                  type="secondary"
                                  ellipsis
                                  style={{ display: 'block', fontSize: 12, marginTop: 2 }}
                                >
                                  From {sourceSessionLabel}
                                </Typography.Text>
                              )}
                              {disabledReason && (
                                <Typography.Text
                                  type="warning"
                                  style={{ display: 'block', fontSize: 12, marginTop: 2 }}
                                >
                                  {disabledReason}
                                </Typography.Text>
                              )}
                            </span>
                          }
                        />
                      </List.Item>
                    );
                  }}
                />
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No links match this view."
                />
              )}
            </Space>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No durable branch links yet. Add branch-owned links here when they should persist with the branch."
            />
          )}
        </Space>
      </div>
    </>
  );
};

export const LinksTab = memo(LinksTabInner, (prevProps, nextProps) => {
  return (
    prevProps.client === nextProps.client &&
    prevProps.active === nextProps.active &&
    prevProps.open === nextProps.open &&
    prevProps.branch.branch_id === nextProps.branch.branch_id &&
    prevProps.branch.board_id === nextProps.branch.board_id &&
    prevProps.branch.issue_url === nextProps.branch.issue_url &&
    prevProps.branch.pull_request_url === nextProps.branch.pull_request_url
  );
});

export default LinksTab;
