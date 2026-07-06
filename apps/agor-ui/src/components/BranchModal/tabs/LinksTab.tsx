import type { AgorClient, Branch, Link } from '@agor-live/client';
import {
  DownloadOutlined,
  EllipsisOutlined,
  ExportOutlined,
  EyeOutlined,
  GithubOutlined,
  PushpinFilled,
  PushpinOutlined,
  RightOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import {
  Alert,
  Button,
  Dropdown,
  Empty,
  List,
  Space,
  Spin,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useThemedMessage } from '../../../utils/message';
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
import {
  buildLinkDisplayItems,
  getCompactLinkDisplayName,
  getLinkDisplayGlyphLabel,
  getLinkDisplaySecondaryLabel,
  isBranchOwnedLink,
  type LinkDisplayCategory,
  type LinkDisplayItem,
  normalizeLinkFindResult,
  removeLinkById,
  upsertLinkById,
} from '../../Links/linkDisplay';
import { dispatchLinkMutation, listenForLinkMutations } from '../../Links/linkEvents';
import {
  findAssistantLinkForTarget,
  getAssistantPromotionState,
  promoteLinkToAssistant,
} from '../../Links/linkPromotion';

interface LinksTabProps {
  branch: Branch;
  client: AgorClient | null;
  assistantBranchId?: string | null;
}

const DOCUMENT_CATEGORIES = new Set<LinkDisplayCategory>([
  'pdf',
  'spreadsheet',
  'csv',
  'document',
  'markdown',
  'text',
  'code',
  'json',
  'log',
]);

function isFileItem(item: LinkDisplayItem): boolean {
  return (
    item.category === 'image' || Boolean(item.filePath) || DOCUMENT_CATEGORIES.has(item.category)
  );
}

function getUnavailableReason(item: LinkDisplayItem): string | null {
  if (item.href || getLinkContentAction(item)) return null;
  if (isFileItem(item)) return 'No preview/download route is available yet.';
  return 'No safe route is available for this item yet.';
}

function getTypeLabel(item: LinkDisplayItem): string {
  switch (item.category) {
    case 'issue':
      return 'Issue';
    case 'pr':
      return 'PR';
    case 'knowledge':
      return 'Knowledge';
    case 'url':
      return 'Saved URL';
    case 'image':
      return 'Image';
    case 'pdf':
    case 'spreadsheet':
    case 'csv':
    case 'document':
    case 'markdown':
    case 'text':
    case 'code':
    case 'json':
    case 'log':
      return 'Doc';
    case 'internal':
      return 'Ref';
    default:
      return 'Link';
  }
}

function getTypePillColors(item: LinkDisplayItem): { background: string; color: string } {
  switch (item.category) {
    case 'issue':
    case 'pr':
    case 'url':
      return { background: 'rgba(22, 119, 255, 0.16)', color: '#69b1ff' };
    case 'knowledge':
      return { background: 'rgba(114, 46, 209, 0.18)', color: '#b37feb' };
    case 'image':
    case 'pdf':
    case 'spreadsheet':
    case 'csv':
    case 'document':
    case 'markdown':
    case 'text':
    case 'code':
    case 'json':
    case 'log':
      return { background: 'rgba(83, 29, 171, 0.18)', color: '#d3adf7' };
    default:
      return { background: 'rgba(255, 255, 255, 0.06)', color: 'rgba(255, 255, 255, 0.78)' };
  }
}

function BranchGlyph({ item, disabled = false }: { item: LinkDisplayItem; disabled?: boolean }) {
  const { token } = theme.useToken();
  const isGitHubLink = item.category === 'issue' || item.category === 'pr';
  return (
    <span
      aria-hidden="true"
      style={{
        width: 28,
        height: 28,
        borderRadius: token.borderRadiusLG,
        background: token.colorFillTertiary,
        color: disabled ? token.colorTextDisabled : token.colorTextTertiary,
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

function BranchTypePill({ item }: { item: LinkDisplayItem }) {
  const { token } = theme.useToken();
  const colors = getTypePillColors(item);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: token.borderRadiusSM,
        padding: '1px 8px',
        background: colors.background,
        color: colors.color,
        fontSize: 12,
        lineHeight: 1.35,
        whiteSpace: 'nowrap',
      }}
    >
      {getTypeLabel(item)}
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
    color: disabled ? token.colorTextDisabled : token.colorPrimary,
    fontWeight: 600,
    lineHeight: 1.25,
  };

  if (item.href && item.navigation === 'spa') {
    return (
      <RouterLink to={item.href} style={{ ...style, textDecoration: 'none' }} title={title}>
        {title}
      </RouterLink>
    );
  }

  if (item.href) {
    return (
      <a
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

function BranchAction({
  item,
  busy = false,
  onPreview,
  onDownload,
}: {
  item: LinkDisplayItem;
  busy?: boolean;
  onPreview: (item: LinkDisplayItem) => void;
  onDownload: (item: LinkDisplayItem) => void;
}) {
  const { token } = theme.useToken();
  const title = getCompactLinkDisplayName(item);
  const contentAction = getLinkContentAction(item);
  const disabledReason = getUnavailableReason(item);
  const iconLinkStyle: React.CSSProperties = {
    width: 24,
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: token.colorTextTertiary,
    borderRadius: token.borderRadiusSM,
  };

  if (contentAction) {
    return (
      <Tooltip title={contentAction === 'preview' ? 'Preview' : 'Download'}>
        <Button
          type="text"
          size="small"
          loading={busy}
          aria-label={`${contentAction === 'preview' ? 'Preview' : 'Download'} ${title}`}
          icon={contentAction === 'preview' ? <EyeOutlined /> : <DownloadOutlined />}
          onClick={() => {
            if (contentAction === 'preview') onPreview(item);
            else onDownload(item);
          }}
          style={{
            width: 24,
            minWidth: 24,
            height: 24,
            padding: 0,
            color: token.colorTextTertiary,
          }}
        />
      </Tooltip>
    );
  }

  if (item.href && item.navigation === 'spa') {
    return (
      <Tooltip title="Open link">
        <RouterLink aria-label="Open link" to={item.href} style={iconLinkStyle}>
          <RightOutlined />
        </RouterLink>
      </Tooltip>
    );
  }

  if (item.href) {
    return (
      <Tooltip title="Open link">
        <a
          aria-label="Open link"
          href={item.href}
          target="_blank"
          rel="noreferrer"
          style={iconLinkStyle}
        >
          <ExportOutlined />
        </a>
      </Tooltip>
    );
  }

  return (
    <Tooltip title={disabledReason ?? 'No route available'}>
      <span
        role="img"
        aria-label={`No route available for ${title}`}
        style={{ ...iconLinkStyle, color: token.colorTextDisabled }}
      >
        <StopOutlined />
      </span>
    </Tooltip>
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
  const label = item.isPinned ? 'pinned' : 'saved';
  const actionLabel = item.isPinned ? 'Unpin from branch card' : 'Pin to branch card';
  return (
    <Tooltip title={canTogglePin ? actionLabel : label}>
      <button
        type="button"
        disabled={!canTogglePin || pinning}
        aria-label={`${canTogglePin ? actionLabel : label} ${title}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onTogglePinned(item);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          height: 24,
          padding: '0 8px',
          border: 0,
          borderRadius: token.borderRadiusSM,
          background: item.isPinned ? token.colorPrimaryBg : token.colorFillTertiary,
          color: item.isPinned ? token.colorPrimary : token.colorTextSecondary,
          fontSize: 12,
          cursor: canTogglePin && !pinning ? 'pointer' : 'default',
          opacity: pinning ? 0.55 : 1,
        }}
      >
        {item.isPinned ? <PushpinFilled /> : <PushpinOutlined />}
        {label}
      </button>
    </Tooltip>
  );
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
  onRemove: (item: LinkDisplayItem) => void | Promise<void>;
}) {
  const { token } = theme.useToken();
  const state = getAssistantPromotionState({
    item,
    assistantBranchId,
    assistantLinks,
    sourceBranchId,
  });
  const busy = busyKey === (state.assistantLink?.link_id ?? item.linkId ?? item.key);
  const menuItems: MenuProps['items'] = [
    {
      key: state.isPromoted ? 'remove-assistant' : 'promote-assistant',
      label: state.actionLabel,
      disabled: !state.canUseAssistantPromotion || busy,
      title: state.unavailableReason ?? undefined,
    },
  ];

  return (
    <Tooltip title={state.unavailableReason ?? 'Assistant link actions'}>
      <Dropdown
        trigger={['click']}
        menu={{
          items: menuItems,
          onClick: ({ domEvent }) => {
            domEvent.preventDefault();
            domEvent.stopPropagation();
            if (!state.canUseAssistantPromotion || busy) return;
            if (state.isPromoted) void onRemove(item);
            else void onPromote(item);
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

const LinksTabInner: React.FC<LinksTabProps> = ({ branch, client, assistantBranchId = null }) => {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const [links, setLinks] = useState<Link[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pinningLinkId, setPinningLinkId] = useState<string | null>(null);
  const [assistantLinks, setAssistantLinks] = useState<Link[]>([]);
  const [assistantPromotionBusyKey, setAssistantPromotionBusyKey] = useState<string | null>(null);
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null);
  const [previewTarget, setPreviewTarget] = useState<LinkImagePreviewTarget | null>(null);
  const [markdownTarget, setMarkdownTarget] = useState<LinkMarkdownPreviewTarget | null>(null);

  useEffect(() => {
    if (!client) {
      setLinks([]);
      setLoading(false);
      setError(null);
      return;
    }

    let active = true;
    const linksService = client.service('links');
    const branchId = branch.branch_id;

    const upsertBranchLink = (link: Link) => {
      setLinks((prev) => {
        if (isBranchOwnedLink(link, branchId)) return upsertLinkById(prev, link);
        return removeLinkById(prev, link);
      });
    };

    const removeBranchLink = (link: Link) => {
      setLinks((prev) => removeLinkById(prev, link));
    };

    const fetchLinks = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await linksService.find({
          query: { branch_id: branchId, $limit: 200 },
        });
        if (!active) return;
        setLinks(
          normalizeLinkFindResult(result).filter((link) => isBranchOwnedLink(link, branchId))
        );
      } catch (err) {
        if (!active) return;
        console.error('[BranchLinksTab] Failed to fetch links:', err);
        setError('Could not load branch links');
        setLinks([]);
      } finally {
        if (active) setLoading(false);
      }
    };

    void fetchLinks();
    linksService.on('created', upsertBranchLink);
    linksService.on('patched', upsertBranchLink);
    linksService.on('updated', upsertBranchLink);
    linksService.on('removed', removeBranchLink);
    const stopListeningForLocalMutations = listenForLinkMutations(({ link, mutation }) => {
      if (mutation === 'removed') {
        removeBranchLink(link);
      } else {
        upsertBranchLink(link);
      }
    });

    return () => {
      active = false;
      linksService.off('created', upsertBranchLink);
      linksService.off('patched', upsertBranchLink);
      linksService.off('updated', upsertBranchLink);
      linksService.off('removed', removeBranchLink);
      stopListeningForLocalMutations();
    };
  }, [branch.branch_id, client]);

  useEffect(() => {
    if (!client || !assistantBranchId || assistantBranchId === branch.branch_id) {
      setAssistantLinks([]);
      return;
    }

    let active = true;
    const linksService = client.service('links');

    const upsertAssistantLink = (link: Link) => {
      setAssistantLinks((prev) => {
        if (isBranchOwnedLink(link, assistantBranchId)) return upsertLinkById(prev, link);
        return removeLinkById(prev, link);
      });
    };

    const removeAssistantLink = (link: Link) => {
      setAssistantLinks((prev) => removeLinkById(prev, link));
    };

    const fetchAssistantLinks = async () => {
      try {
        const result = await linksService.find({
          query: { branch_id: assistantBranchId, $limit: 200 },
        });
        if (active) {
          setAssistantLinks(
            normalizeLinkFindResult(result).filter((link) =>
              isBranchOwnedLink(link, assistantBranchId)
            )
          );
        }
      } catch (err) {
        if (!active) return;
        console.error('[BranchLinksTab] Failed to fetch assistant links:', err);
        setAssistantLinks([]);
      }
    };

    void fetchAssistantLinks();
    linksService.on('created', upsertAssistantLink);
    linksService.on('patched', upsertAssistantLink);
    linksService.on('updated', upsertAssistantLink);
    linksService.on('removed', removeAssistantLink);
    const stopListeningForLocalMutations = listenForLinkMutations(({ link, mutation }) => {
      if (mutation === 'removed') removeAssistantLink(link);
      else upsertAssistantLink(link);
    });

    return () => {
      active = false;
      linksService.off('created', upsertAssistantLink);
      linksService.off('patched', upsertAssistantLink);
      linksService.off('updated', upsertAssistantLink);
      linksService.off('removed', removeAssistantLink);
      stopListeningForLocalMutations();
    };
  }, [assistantBranchId, branch.branch_id, client]);

  const assistantPromotionLinks = assistantBranchId === branch.branch_id ? links : assistantLinks;

  const items = useMemo(() => buildLinkDisplayItems({ branch, links }), [branch, links]);

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

  const handleTogglePinned = useCallback(
    async (item: LinkDisplayItem) => {
      if (!client || !item.linkId || pinningLinkId) return;
      setPinningLinkId(item.linkId);
      try {
        const updated = await client.service('links').patch(item.linkId, {
          is_pinned: !item.isPinned,
        });
        setLinks((prev) => {
          if (isBranchOwnedLink(updated, branch.branch_id)) return upsertLinkById(prev, updated);
          return removeLinkById(prev, updated);
        });
        dispatchLinkMutation({ link: updated, mutation: 'patched' });
      } catch (err) {
        showError(`Failed to update pin: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setPinningLinkId(null);
      }
    },
    [branch.branch_id, client, pinningLinkId, showError]
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
        if (assistantBranchId === branch.branch_id) {
          setLinks((prev) => upsertLinkById(prev, promoted));
        } else {
          setAssistantLinks((prev) => upsertLinkById(prev, promoted));
        }
        dispatchLinkMutation({ link: promoted, mutation: 'patched' });
      } catch (err) {
        showError(`Failed to promote link: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setAssistantPromotionBusyKey(null);
      }
    },
    [assistantBranchId, assistantPromotionBusyKey, branch.branch_id, client, showError]
  );

  const handleRemoveFromAssistant = useCallback(
    async (item: LinkDisplayItem) => {
      if (!client || !assistantBranchId || assistantPromotionBusyKey) return;
      const assistantLink =
        assistantBranchId === branch.branch_id && item.linkId
          ? links.find((link) => link.link_id === item.linkId)
          : findAssistantLinkForTarget(item, assistantPromotionLinks);
      if (!assistantLink) return;
      setAssistantPromotionBusyKey(assistantLink.link_id);
      try {
        const removed = (await client.service('links').remove(assistantLink.link_id)) as Link;
        if (assistantBranchId === branch.branch_id) {
          setLinks((prev) => removeLinkById(prev, assistantLink));
        } else {
          setAssistantLinks((prev) => removeLinkById(prev, assistantLink));
        }
        dispatchLinkMutation({ link: removed, mutation: 'removed' });
      } catch (err) {
        showError(
          `Failed to remove assistant link: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setAssistantPromotionBusyKey(null);
      }
    },
    [
      assistantBranchId,
      assistantPromotionBusyKey,
      assistantPromotionLinks,
      branch.branch_id,
      client,
      links,
      showError,
    ]
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
          <div
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 1,
              background: token.colorBgElevated,
              padding: `0 ${token.paddingLG}px ${token.sizeXS}px`,
            }}
          >
            <Typography.Title level={5} style={{ margin: 0 }}>
              Branch links
            </Typography.Title>
            <Typography.Text type="secondary">
              Durable resources owned by this branch. Session-owned pins stay promoted in session
              headers, not on the branch card.
            </Typography.Text>
          </div>

          {error && (
            <div style={{ padding: `0 ${token.paddingLG}px` }}>
              <Alert title="Error" description={error} type="error" showIcon />
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
            <List
              style={{ padding: `0 ${token.paddingLG}px` }}
              dataSource={items}
              renderItem={(item) => {
                const disabledReason = getUnavailableReason(item);
                const disabled = Boolean(disabledReason);
                const targetLabel = getLinkDisplaySecondaryLabel(item);
                return (
                  <List.Item
                    key={item.key}
                    style={{ borderColor: token.colorBorderSecondary, paddingRight: token.sizeSM }}
                    actions={[
                      <BranchAction
                        key="open"
                        item={item}
                        busy={item.linkId === busyLinkId}
                        onPreview={openPreview}
                        onDownload={downloadItem}
                      />,
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
                          <BranchTypePill item={item} />
                        </span>
                      }
                      description={
                        <span>
                          {targetLabel && (
                            <Typography.Text type="secondary" ellipsis style={{ display: 'block' }}>
                              {targetLabel}
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
    prevProps.branch.branch_id === nextProps.branch.branch_id &&
    prevProps.branch.issue_url === nextProps.branch.issue_url &&
    prevProps.branch.pull_request_url === nextProps.branch.pull_request_url &&
    prevProps.assistantBranchId === nextProps.assistantBranchId
  );
});
