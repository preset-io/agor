import {
  BookOutlined,
  EllipsisOutlined,
  FileImageOutlined,
  FileTextOutlined,
  GithubOutlined,
  GlobalOutlined,
  LinkOutlined,
  PushpinFilled,
  PushpinOutlined,
  SettingOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import {
  Badge,
  Button,
  Drawer,
  Dropdown,
  Empty,
  Input,
  Popover,
  Select,
  Space,
  Tabs,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useThemedMessage } from '../../utils/message';
import {
  canDownloadLinkAttachment,
  canPreviewMarkdownLinkAttachment,
  LinkAttachmentGlyph,
  type LinkAttachmentTarget,
  targetForLinkAttachment,
} from '../Links/LinkAttachmentCard';
import { LinkImagePreviewModal, type LinkImagePreviewTarget } from '../Links/LinkImagePreviewModal';
import {
  LinkMarkdownPreviewModal,
  type LinkMarkdownPreviewTarget,
} from '../Links/LinkMarkdownPreviewModal';
import {
  downloadLinkContent,
  getLinkContentAction,
  getSafeLinkContentLabel,
} from '../Links/linkContent';
import {
  LINK_CATEGORY_TAB_LABELS,
  LINK_SORT_LABELS,
  type LinkCategoryTabKey,
  type LinkDisplayItem,
  type LinkSortKey,
} from '../Links/linkDisplay';

export type SessionAttachmentKind =
  | 'issue'
  | 'pr'
  | 'kb_ref'
  | 'internal'
  | 'image'
  | 'document'
  | 'url';
export type SessionAttachmentSource = 'branch' | 'manual' | 'parsed' | 'upload';

type LinksCategoryTab = LinkCategoryTabKey;
type LinksSort = LinkSortKey;

interface AssistantAttachmentActionState {
  isPromoted: boolean;
  assistantLinkId?: string;
  disabled?: boolean;
  loading?: boolean;
  unavailableReason?: string | null;
}

export interface SessionAttachmentItem {
  key: string;
  name: string;
  url?: string | null;
  refUri?: string | null;
  filePath?: string | null;
  mimeType?: string | null;
  linkId?: string | null;
  targetKey?: string | null;
  kind?: SessionAttachmentKind;
  source?: SessionAttachmentSource;
  ownerScope?: 'branch' | 'session';
  isPinned?: boolean;
  createdAt?: string;
  updatedAt?: string;
  disabled?: boolean;
  subtitle?: string;
  note?: string;
  originSessionLabel?: string | null;
  /**
   * Store-backed normalized item that powers mutations/previews while this
   * component preserves the #1823 attachment-specific visual structure.
   */
  displayItem?: LinkDisplayItem;
}

interface Props {
  items: SessionAttachmentItem[];
  pinningLinkId?: string | null;
  onTogglePinned?: (item: SessionAttachmentItem) => void | Promise<void>;
  onRegisterOpenPinnedManager?: (openPinnedManager: (() => void) | null) => void;
  getAssistantActionState?: (item: SessionAttachmentItem) => AssistantAttachmentActionState | null;
  onPromoteToAssistant?: (item: SessionAttachmentItem) => void | Promise<void>;
  onRemoveFromAssistant?: (
    item: SessionAttachmentItem,
    assistantLinkId: string
  ) => void | Promise<void>;
  assistantPromotionBusyKey?: string | null;
}

function attachmentKindForDisplayItem(item: LinkDisplayItem): SessionAttachmentKind {
  if (item.category === 'issue') return 'issue';
  if (item.category === 'pr') return 'pr';
  if (item.category === 'knowledge') return 'kb_ref';
  if (item.category === 'internal') return 'internal';
  if (item.category === 'image') return 'image';
  if (item.category === 'url') return 'url';
  return 'document';
}

export function displayItemToSessionAttachmentItem(item: LinkDisplayItem): SessionAttachmentItem {
  const contentAction = getLinkContentAction(item);
  const isUnsupportedFileBacked =
    Boolean(item.filePath) && !item.href && !contentAction && item.source === 'upload';

  return {
    key: item.key,
    name: item.name,
    url: item.url,
    refUri: item.refUri,
    filePath: item.filePath,
    mimeType: item.mimeType,
    linkId: item.linkId,
    targetKey: item.targetKey,
    kind: attachmentKindForDisplayItem(item),
    source: item.source === 'branch' ? 'branch' : item.source,
    ownerScope: item.ownerScope,
    isPinned: item.isPinned,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    disabled: isUnsupportedFileBacked,
    note: isUnsupportedFileBacked ? 'Preview/download unavailable' : undefined,
    originSessionLabel: item.sourceSessionId ? item.sourceSessionId.slice(0, 8) : undefined,
    displayItem: item,
  };
}

function targetForItem(item: SessionAttachmentItem): LinkAttachmentTarget | null {
  return targetForLinkAttachment({ url: item.url, refUri: item.refUri });
}

function canPreviewImage(item: SessionAttachmentItem): boolean {
  return (
    item.kind === 'image' && item.source === 'upload' && Boolean(item.linkId) && !item.disabled
  );
}

function canPreviewMarkdown(item: SessionAttachmentItem): boolean {
  return canPreviewMarkdownLinkAttachment({
    source: item.source,
    linkId: item.linkId,
    kind: item.kind,
    mimeType: item.mimeType,
    title: item.name,
    filePath: item.filePath,
    refUri: item.refUri,
  });
}

function canDownloadFile(item: SessionAttachmentItem): boolean {
  return (
    canDownloadLinkAttachment({
      source: item.source,
      linkId: item.linkId,
      filePath: item.filePath,
    }) &&
    !canPreviewImage(item) &&
    !canPreviewMarkdown(item)
  );
}

function disabledReasonForItem(item: SessionAttachmentItem): string | null {
  if (item.disabled) return item.note || 'Preview/download unavailable';
  if (canPreviewImage(item)) return null;
  if (canPreviewMarkdown(item) || canDownloadFile(item)) return null;
  if (item.source === 'upload' || item.filePath || item.kind === 'image') {
    return item.note || 'Preview/download unavailable';
  }
  if (!targetForItem(item)) return 'No safe route is available for this item yet.';
  return null;
}

function getTargetDisplay(item: SessionAttachmentItem): string {
  if (item.subtitle) return item.subtitle;
  if (item.url) {
    try {
      const parsed = new URL(item.url);
      return `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return item.url;
    }
  }
  if (item.refUri) return item.refUri;
  if (item.filePath) return getSafeLinkContentLabel(item.filePath) || 'Uploaded file';
  return 'No target';
}

function getOwnerScope(item: SessionAttachmentItem): 'branch' | 'session' {
  if (item.ownerScope) return item.ownerScope;
  return item.source === 'branch' ? 'branch' : 'session';
}

function isFileItem(item: SessionAttachmentItem): boolean {
  return item.kind === 'image' || item.kind === 'document' || item.source === 'upload';
}

function isKnowledgeItem(item: SessionAttachmentItem): boolean {
  return item.kind === 'kb_ref' || item.kind === 'internal';
}

function isIssuePrItem(item: SessionAttachmentItem): boolean {
  return item.kind === 'issue' || item.kind === 'pr';
}

function isWebLinkItem(item: SessionAttachmentItem): boolean {
  return !isFileItem(item) && !isKnowledgeItem(item) && !isIssuePrItem(item);
}

function getIcon(item: SessionAttachmentItem): React.ReactNode {
  if (isKnowledgeItem(item)) return <BookOutlined />;
  if (item.kind === 'image') return <FileImageOutlined />;
  if (item.kind === 'document') return <FileTextOutlined />;

  const target = item.url ?? item.refUri ?? '';
  try {
    const { hostname } = new URL(target);
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) return <GithubOutlined />;
  } catch {
    // ignore
  }
  return item.kind === 'url' ? <GlobalOutlined /> : <LinkOutlined />;
}

function renderAttachmentGlyph(
  item: SessionAttachmentItem,
  disabled: boolean,
  size: 'sm' | 'md' = 'sm'
) {
  if (isFileItem(item) || isKnowledgeItem(item)) {
    return (
      <LinkAttachmentGlyph
        kind={item.kind}
        mimeType={item.mimeType}
        title={item.name}
        filePath={item.filePath}
        refUri={item.refUri}
        disabled={disabled}
        size={size}
      />
    );
  }
  return disabled ? <StopOutlined /> : getIcon(item);
}

function uniqueByTarget(items: SessionAttachmentItem[]): SessionAttachmentItem[] {
  const seen = new Set<string>();
  const result: SessionAttachmentItem[] = [];
  for (const item of items) {
    const target = item.url ?? item.refUri ?? item.filePath ?? item.key;
    const key = `${item.kind ?? 'link'}:${target}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function getCategoryCounts(items: SessionAttachmentItem[]): Record<LinksCategoryTab, number> {
  return {
    all: items.length,
    files: items.filter(isFileItem).length,
    links: items.filter(isWebLinkItem).length,
    knowledge: items.filter(isKnowledgeItem).length,
    issues: items.filter(isIssuePrItem).length,
  };
}

function matchesCategory(item: SessionAttachmentItem, category: LinksCategoryTab): boolean {
  switch (category) {
    case 'files':
      return isFileItem(item);
    case 'links':
      return isWebLinkItem(item);
    case 'knowledge':
      return isKnowledgeItem(item);
    case 'issues':
      return isIssuePrItem(item);
    default:
      return true;
  }
}

function getItemTimestamp(item: SessionAttachmentItem): string {
  return item.updatedAt || item.createdAt || '';
}

function compareDrawerItems(a: SessionAttachmentItem, b: SessionAttachmentItem, sort: LinksSort) {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;

  const nameOrder = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  if (sort === 'za') return nameOrder !== 0 ? -nameOrder : a.key.localeCompare(b.key);

  if (sort === 'recent' || sort === 'oldest') {
    const timestampOrder = getItemTimestamp(a).localeCompare(getItemTimestamp(b));
    if (timestampOrder !== 0) return sort === 'recent' ? -timestampOrder : timestampOrder;
  }

  return nameOrder || a.key.localeCompare(b.key);
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function itemMatchesSearch(item: SessionAttachmentItem, query: string): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  const fields = [
    item.name,
    item.subtitle,
    getTargetDisplay(item),
    item.url,
    item.refUri,
    item.filePath ? getSafeLinkContentLabel(item.filePath) : null,
    item.originSessionLabel,
  ];
  return fields.some((field) => field?.toLowerCase().includes(normalizedQuery));
}

export const SessionAttachmentsDropdown: React.FC<Props> = ({
  items,
  pinningLinkId = null,
  onTogglePinned,
  onRegisterOpenPinnedManager,
  getAssistantActionState,
  onPromoteToAssistant,
  onRemoveFromAssistant,
  assistantPromotionBusyKey = null,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { showError } = useThemedMessage();
  const [popoverOpen, setPopoverOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [activeCategory, setActiveCategory] = React.useState<LinksCategoryTab>('all');
  const [sortOrder, setSortOrder] = React.useState<LinksSort>('az');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [previewTarget, setPreviewTarget] = React.useState<LinkImagePreviewTarget | null>(null);
  const [markdownTarget, setMarkdownTarget] = React.useState<LinkMarkdownPreviewTarget | null>(
    null
  );

  const visibleItems = React.useMemo(() => uniqueByTarget(items), [items]);
  const hasItems = visibleItems.length > 0;
  const pinnedItems = visibleItems.filter((item) => item.isPinned);
  const files = visibleItems.filter(isFileItem);
  const nonPinnedNonFiles = visibleItems.filter((item) => !item.isPinned && !isFileItem(item));
  const categoryCounts = React.useMemo(() => getCategoryCounts(visibleItems), [visibleItems]);
  const categoryTabs = React.useMemo(
    () =>
      (['all', 'files', 'links', 'knowledge', 'issues'] as const).map((key) => ({
        key,
        label: `${LINK_CATEGORY_TAB_LABELS[key]} ${categoryCounts[key]}`,
      })),
    [categoryCounts]
  );

  const openPinnedManager = React.useCallback(() => {
    setActiveCategory('all');
    setDrawerOpen(true);
  }, []);

  React.useEffect(() => {
    onRegisterOpenPinnedManager?.(openPinnedManager);
    return () => onRegisterOpenPinnedManager?.(null);
  }, [onRegisterOpenPinnedManager, openPinnedManager]);

  if (!hasItems) return null;

  const fileReserve = files.length > 0 ? Math.min(2, files.length) : 0;
  const quickPinned = pinnedItems.slice(0, Math.min(3, pinnedItems.length));
  const quickPinnedKeys = new Set(quickPinned.map((item) => item.key));
  const quickRecent = nonPinnedNonFiles.slice(0, Math.max(0, 7 - quickPinned.length - fileReserve));
  const quickRecentKeys = new Set(quickRecent.map((item) => item.key));
  const quickFiles = files
    .filter((item) => !quickPinnedKeys.has(item.key) && !quickRecentKeys.has(item.key))
    .slice(0, Math.max(0, 7 - quickPinned.length - quickRecent.length));
  const quickItems = [...quickPinned, ...quickRecent, ...quickFiles];

  const openTarget = (item: SessionAttachmentItem) => {
    if (canPreviewImage(item) && item.linkId) {
      setPopoverOpen(false);
      setPreviewTarget({ linkId: item.linkId, title: item.name, subtitle: getTargetDisplay(item) });
      return;
    }
    if (canPreviewMarkdown(item) && item.linkId) {
      setPopoverOpen(false);
      setMarkdownTarget({
        linkId: item.linkId,
        title: item.name,
        subtitle: getTargetDisplay(item),
      });
      return;
    }
    if (canDownloadFile(item) && item.linkId) {
      setPopoverOpen(false);
      downloadLinkContent(item.linkId, item.name).catch((err) => {
        showError(err instanceof Error ? err.message : 'Download failed');
      });
      return;
    }
    const target = targetForItem(item);
    if (!target || disabledReasonForItem(item)) return;
    setPopoverOpen(false);
    if (target.navigation === 'spa') {
      navigate(target.href);
      return;
    }
    window.open(target.href, '_blank', 'noopener,noreferrer');
  };

  const stopNavigation: React.MouseEventHandler<HTMLElement> = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleRowKeyDown =
    (item: SessionAttachmentItem): React.KeyboardEventHandler<HTMLElement> =>
    (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openTarget(item);
    };

  const canTogglePinned = (item: SessionAttachmentItem) => {
    return getOwnerScope(item) === 'session' && Boolean(item.linkId) && Boolean(onTogglePinned);
  };

  const getPinActionLabel = (item: SessionAttachmentItem): string => {
    const scope = getOwnerScope(item);
    if (!canTogglePinned(item)) {
      return scope === 'branch' ? 'Pin is read-only here' : 'Pin unavailable';
    }
    if (scope === 'session') return item.isPinned ? 'Unpin from session header' : 'Pin in session';
    return item.isPinned ? 'Unpin from branch card' : 'Pin to branch card';
  };

  const renderMiniPin = (item: SessionAttachmentItem) => {
    const toggleable = canTogglePinned(item);
    const isPinning = Boolean(item.linkId && pinningLinkId === item.linkId);
    return (
      <Tooltip title={getPinActionLabel(item)}>
        <button
          type="button"
          aria-label={getPinActionLabel(item)}
          aria-disabled={!toggleable || isPinning || undefined}
          onClick={(event) => {
            stopNavigation(event);
            if (!toggleable || isPinning) return;
            void onTogglePinned?.(item);
          }}
          style={{
            border: 0,
            background: 'transparent',
            padding: 0,
            color: item.isPinned ? token.colorWarning : token.colorTextQuaternary,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            justifySelf: 'center',
            width: 18,
            flex: '0 0 auto',
            cursor: toggleable && !isPinning ? 'pointer' : 'default',
            opacity: isPinning ? 0.6 : 1,
          }}
        >
          {item.isPinned ? <PushpinFilled /> : <PushpinOutlined />}
        </button>
      </Tooltip>
    );
  };

  const renderQuietRow = (item: SessionAttachmentItem) => {
    const disabledReason = disabledReasonForItem(item);
    const disabled = Boolean(disabledReason);
    return (
      <Tooltip
        key={item.key}
        title={
          disabledReason ??
          (canPreviewImage(item)
            ? 'Preview image'
            : canDownloadFile(item)
              ? 'Download file'
              : 'Open link')
        }
        placement="left"
      >
        <div
          className="agor-action-link-row"
          role={disabled ? undefined : 'link'}
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled || undefined}
          onClick={() => openTarget(item)}
          onKeyDown={handleRowKeyDown(item)}
          style={
            {
              '--agor-link-title-color': disabled ? token.colorTextDisabled : token.colorText,
              '--agor-link-icon-color': disabled
                ? token.colorTextDisabled
                : token.colorTextTertiary,
              '--agor-link-row-hover-bg': token.colorFillTertiary,
              '--agor-link-row-hover-color': token.colorPrimary,
              width: '100%',
              boxSizing: 'border-box',
              border: 0,
              borderRadius: token.borderRadius,
              cursor: disabled ? 'not-allowed' : 'pointer',
              padding: `${token.sizeXXS}px ${token.sizeXS}px`,
              textAlign: 'left',
            } as React.CSSProperties
          }
        >
          <span
            style={{
              display: 'grid',
              gridTemplateColumns: '34px minmax(0, 1fr) 24px',
              columnGap: token.sizeXS,
              alignItems: 'center',
              minWidth: 0,
            }}
          >
            <span
              className="agor-action-link-icon"
              style={{
                width: 34,
                color: 'var(--agor-link-icon-color)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {renderAttachmentGlyph(item, disabled)}
            </span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <Typography.Text
                className={disabled ? undefined : 'agor-action-link-title'}
                ellipsis
                style={{
                  display: 'block',
                  color: disabled ? token.colorTextDisabled : 'var(--agor-link-title-color)',
                  fontSize: 13,
                }}
              >
                {item.name}
              </Typography.Text>
            </span>
            {renderMiniPin(item)}
          </span>
        </div>
      </Tooltip>
    );
  };

  const renderAssistantPromotionMenu = (item: SessionAttachmentItem) => {
    if (!getAssistantActionState) return <span aria-hidden />;

    const state = getAssistantActionState(item);
    if (!state) return <span aria-hidden />;

    const busyKey = state.assistantLinkId ?? item.linkId ?? item.key;
    const busy = state.loading || assistantPromotionBusyKey === busyKey;
    const disabled = state.disabled || busy || (state.isPromoted && !state.assistantLinkId);
    const actionLabel = state.isPromoted ? 'Remove from assistant' : 'Promote to assistant';
    const menuItems: MenuProps['items'] = [
      {
        key: state.isPromoted ? 'remove-assistant' : 'promote-assistant',
        label: actionLabel,
        disabled,
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
              if (disabled) return;
              if (state.isPromoted) {
                if (state.assistantLinkId)
                  void onRemoveFromAssistant?.(item, state.assistantLinkId);
              } else {
                void onPromoteToAssistant?.(item);
              }
            },
          }}
        >
          <Button
            type="text"
            size="small"
            aria-label={`Assistant actions for ${item.name}`}
            loading={busy}
            icon={<EllipsisOutlined />}
            onClick={stopNavigation}
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
  };

  const renderDrawerRow = (item: SessionAttachmentItem) => {
    const disabledReason = disabledReasonForItem(item);
    const disabled = Boolean(disabledReason);
    return (
      <div
        key={item.key}
        className="agor-action-link-row"
        role={disabled ? undefined : 'link'}
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        onClick={() => openTarget(item)}
        onKeyDown={handleRowKeyDown(item)}
        style={
          {
            '--agor-link-title-color': disabled ? token.colorTextDisabled : token.colorText,
            '--agor-link-icon-color': disabled ? token.colorTextDisabled : token.colorTextTertiary,
            '--agor-link-row-hover-bg': token.colorFillTertiary,
            '--agor-link-row-hover-color': token.colorPrimary,
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 32px 32px',
            gap: token.sizeSM,
            alignItems: 'center',
            padding: `${token.sizeSM}px ${token.sizeXS}px`,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadius,
            cursor: disabled ? 'not-allowed' : 'pointer',
          } as React.CSSProperties
        }
      >
        <div style={{ display: 'flex', gap: token.sizeSM, minWidth: 0, alignItems: 'flex-start' }}>
          <span
            className="agor-action-link-icon"
            style={{
              width: 28,
              height: 28,
              borderRadius: token.borderRadius,
              background: token.colorFillTertiary,
              color: 'var(--agor-link-icon-color)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: '0 0 auto',
            }}
          >
            {renderAttachmentGlyph(item, disabled)}
          </span>
          <span style={{ minWidth: 0 }}>
            <Typography.Link
              className={disabled ? undefined : 'agor-action-link-title'}
              strong
              ellipsis
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                openTarget(item);
              }}
              style={{
                display: 'block',
                color: disabled ? token.colorTextDisabled : 'var(--agor-link-title-color)',
              }}
            >
              {item.name}
            </Typography.Link>
            <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
              {getTargetDisplay(item)}
            </Typography.Text>
            {disabled && (
              <Typography.Text
                type="warning"
                style={{ display: 'block', fontSize: 12, marginTop: 2 }}
              >
                {disabledReason}
              </Typography.Text>
            )}
          </span>
        </div>
        {renderMiniPin(item)}
        {renderAssistantPromotionMenu(item)}
      </div>
    );
  };

  const drawerItems = visibleItems
    .filter((item) => matchesCategory(item, activeCategory))
    .filter((item) => itemMatchesSearch(item, searchQuery))
    .sort((a, b) => compareDrawerItems(a, b, sortOrder));

  const quickContent = (
    <div style={{ width: 312 }} data-testid="links-organizer-popover">
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <Typography.Text strong>Links</Typography.Text>
        </div>
        <Tooltip title="Manage links">
          <Button
            type="text"
            size="small"
            aria-label="Manage links"
            icon={<SettingOutlined />}
            onClick={() => {
              setPopoverOpen(false);
              setDrawerOpen(true);
            }}
            style={{ color: token.colorTextTertiary }}
          />
        </Tooltip>
      </div>

      {!hasItems ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No links collected yet."
          style={{ margin: `${token.sizeSM}px 0` }}
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gap: token.sizeXXS,
            marginTop: token.sizeSM,
            maxHeight: 308,
            overflowY: 'auto',
            paddingRight: token.sizeXXS,
          }}
        >
          {quickItems.map(renderQuietRow)}
        </div>
      )}
    </div>
  );

  return (
    <>
      <Space size={4} align="center" style={{ minWidth: 0 }}>
        <Popover
          open={popoverOpen}
          onOpenChange={setPopoverOpen}
          content={quickContent}
          trigger="click"
          placement="bottomRight"
          overlayInnerStyle={{
            border: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Tooltip title="Attachments">
            <Badge
              count={visibleItems.length}
              color={token.colorPrimary}
              size="small"
              offset={[-4, 4]}
            >
              <Button
                type="text"
                aria-label="Open links organizer"
                icon={<LinkOutlined style={{ color: token.colorTextSecondary }} />}
              />
            </Badge>
          </Tooltip>
        </Popover>
      </Space>

      <LinkImagePreviewModal target={previewTarget} onClose={() => setPreviewTarget(null)} />
      <LinkMarkdownPreviewModal target={markdownTarget} onClose={() => setMarkdownTarget(null)} />

      <Drawer
        title="Manage links"
        open={drawerOpen}
        width={720}
        onClose={() => setDrawerOpen(false)}
      >
        <div data-testid="links-organizer-manage">
          <Space direction="vertical" size={token.sizeMD} style={{ width: '100%' }}>
            <Tabs
              className="agor-link-category-tabs"
              activeKey={activeCategory}
              items={categoryTabs}
              onChange={(key) => setActiveCategory(key as LinksCategoryTab)}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: token.sizeSM,
                width: '100%',
                flexWrap: 'wrap',
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
                <Select<LinksSort>
                  size="small"
                  value={sortOrder}
                  options={(Object.keys(LINK_SORT_LABELS) as LinksSort[]).map((key) => ({
                    value: key,
                    label: LINK_SORT_LABELS[key],
                  }))}
                  onChange={setSortOrder}
                  style={{ width: 128 }}
                />
              </Space>
            </div>
            {drawerItems.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No links in this view." />
            ) : (
              <div
                style={{
                  maxHeight: 'min(58vh, 560px)',
                  overflowY: 'auto',
                  paddingRight: token.sizeXS,
                }}
              >
                {drawerItems.map(renderDrawerRow)}
              </div>
            )}
          </Space>
        </div>
      </Drawer>
    </>
  );
};
