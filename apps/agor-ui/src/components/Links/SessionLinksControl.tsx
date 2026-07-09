import {
  EllipsisOutlined,
  GithubOutlined,
  LinkOutlined,
  PushpinFilled,
  PushpinOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  Badge,
  Button,
  Drawer,
  Dropdown,
  Empty,
  Modal,
  Popover,
  Select,
  Space,
  Spin,
  Tabs,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { getAuthHeaders } from '../../utils/authHeaders';
import { useThemedMessage } from '../../utils/message';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { LinkImagePreviewModal, type LinkImagePreviewTarget } from './LinkImagePreviewModal';
import {
  LinkMarkdownPreviewModal,
  type LinkMarkdownPreviewTarget,
} from './LinkMarkdownPreviewModal';
import {
  downloadLinkContent,
  getLinkContentAction,
  getLinkContentUrl,
  getLinkPreviewKind,
  getSafeLinkContentLabel,
  type LinkPreviewKind,
} from './linkContent';
import {
  compareLinkDisplayItemsBySort,
  getCompactLinkDisplayName,
  getLinkCategoryCounts,
  getLinkCategorySummary,
  getLinkDisplayGlyphLabel,
  getLinkDisplaySecondaryLabel,
  isFileLinkDisplayItem,
  isKnowledgeLinkDisplayItem,
  LINK_CATEGORY_TAB_LABELS,
  LINK_SORT_LABELS,
  type LinkCategoryTabKey,
  type LinkDisplayItem,
  type LinkSortKey,
  matchesLinkCategoryTab,
} from './linkDisplay';

const QUICK_LINK_LIMIT = 7;

export interface SessionLinksControlProps {
  items: LinkDisplayItem[];
  loading?: boolean;
  error?: string | null;
  quickLimit?: number;
  onTogglePinned?: (item: LinkDisplayItem) => void | Promise<void>;
  pinningLinkId?: string | null;
  onRegisterOpenManager?: (openManager: (() => void) | null) => void;
  getAssistantActionState?: (item: LinkDisplayItem) => AssistantLinkActionState | null;
  onPromoteToAssistant?: (item: LinkDisplayItem) => void;
  onRemoveFromAssistant?: (item: LinkDisplayItem, assistantLinkId: string) => void;
}

export interface PinnedLinksStripProps {
  items: LinkDisplayItem[];
  onTogglePinned?: (item: LinkDisplayItem) => void | Promise<void>;
  pinningLinkId?: string | null;
  label?: string;
  'data-testid'?: string;
}

export interface LinksManagementDrawerProps {
  items: LinkDisplayItem[];
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  emptyDescription?: React.ReactNode;
  onTogglePinned?: (item: LinkDisplayItem) => void | Promise<void>;
  pinningLinkId?: string | null;
  getAssistantActionState?: (item: LinkDisplayItem) => AssistantLinkActionState | null;
  onPromoteToAssistant?: (item: LinkDisplayItem) => void;
  onRemoveFromAssistant?: (item: LinkDisplayItem, assistantLinkId: string) => void;
  width?: number | string;
}

export interface AssistantLinkActionState {
  isPromoted: boolean;
  assistantLinkId?: string;
  disabled?: boolean;
  loading?: boolean;
  unavailableReason?: string | null;
}

type PreviewState = {
  item: LinkDisplayItem;
  kind: LinkPreviewKind;
  loading: boolean;
  error?: string | null;
  text?: string;
  objectUrl?: string;
};

export function LinkGlyph({ item }: { item: LinkDisplayItem }) {
  const { token } = theme.useToken();
  const isGitHubLink = item.category === 'issue' || item.category === 'pr';
  return (
    <span
      className="agor-action-link-icon"
      aria-hidden="true"
      style={{
        width: 34,
        height: 24,
        borderRadius: token.borderRadiusSM,
        background: token.colorFillTertiary,
        color: `var(--agor-link-icon-color, ${token.colorTextSecondary})`,
        border: `1px solid ${token.colorBorderSecondary}`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.2,
        flex: '0 0 auto',
      }}
    >
      {isGitHubLink ? (
        <GithubOutlined style={{ fontSize: 14 }} />
      ) : (
        getLinkDisplayGlyphLabel(item.category)
      )}
    </span>
  );
}

function SmallLinkGlyph({ item, disabled = false }: { item: LinkDisplayItem; disabled?: boolean }) {
  const { token } = theme.useToken();
  const isGitHubLink = item.category === 'issue' || item.category === 'pr';
  return (
    <span
      className="agor-action-link-icon"
      aria-hidden="true"
      style={{
        width: 24,
        height: 24,
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

function getLinkContentTarget(item: LinkDisplayItem): LinkImagePreviewTarget {
  return {
    linkId: item.linkId!,
    title: getCompactLinkDisplayName(item),
    subtitle: getSafeLinkContentLabel(getLinkDisplaySecondaryLabel(item) ?? item.filePath),
  };
}

async function fetchLinkContent(item: LinkDisplayItem, disposition: 'inline' | 'attachment') {
  if (!item.linkId) throw new Error('Missing link id');
  const response = await fetch(getLinkContentUrl(item.linkId, disposition), {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    let message = `Failed to load file (${response.status})`;
    try {
      const body = await response.json();
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // Response may be plain text/HTML from an intermediary; keep status fallback.
    }
    throw new Error(message);
  }
  return response;
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getPinActionLabel(item: LinkDisplayItem): string {
  if (item.ownerScope === 'branch') {
    return item.isPinned ? 'Unpin from branch card' : 'Pin to branch card';
  }
  return item.isPinned ? 'Unpin from session' : 'Pin in session';
}

export function LinkRow({
  item,
  compact = false,
  inline = false,
  onPreview,
  onDownload,
  onTogglePinned,
  pinning = false,
}: {
  item: LinkDisplayItem;
  compact?: boolean;
  inline?: boolean;
  onPreview?: (item: LinkDisplayItem) => void;
  onDownload?: (item: LinkDisplayItem) => void;
  onTogglePinned?: (item: LinkDisplayItem) => void | Promise<void>;
  busy?: boolean;
  pinning?: boolean;
}) {
  const { token } = theme.useToken();
  const title = getCompactLinkDisplayName(item);
  const targetLabel = getLinkDisplaySecondaryLabel(item);
  const contentAction = getLinkContentAction(item);
  const pinActionLabel = getPinActionLabel(item);
  const canTogglePin = Boolean(item.linkId && onTogglePinned);

  const pinActionButton = canTogglePin ? (
    <Tooltip title={pinActionLabel}>
      <Button
        className="agor-action-link-affordance"
        type="text"
        size="small"
        loading={pinning}
        aria-label={`${pinActionLabel} ${title}`}
        icon={item.isPinned ? <PushpinFilled /> : <PushpinOutlined />}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onTogglePinned?.(item);
        }}
        style={{
          color: item.isPinned ? token.colorWarning : token.colorTextTertiary,
          flex: '0 0 auto',
        }}
      />
    </Tooltip>
  ) : null;

  const showPassivePinIndicator = item.isPinned && !canTogglePin;
  const isActionable = Boolean(item.href || contentAction);

  const linkBody = (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: token.sizeUnit * 2,
        minWidth: 0,
        flex: '1 1 auto',
      }}
    >
      <LinkGlyph item={item} />
      <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: token.sizeUnit, minWidth: 0 }}>
          <Typography.Text
            className={isActionable ? 'agor-action-link-title' : undefined}
            ellipsis
            style={{
              color: 'var(--agor-link-title-color)',
              lineHeight: 1.25,
              flex: 1,
            }}
          >
            {title}
          </Typography.Text>
          {showPassivePinIndicator && (
            <Tooltip title="Pinned">
              <PushpinFilled
                style={{ color: token.colorWarning, fontSize: 11, flex: '0 0 auto' }}
              />
            </Tooltip>
          )}
        </span>
        {!compact && targetLabel && (
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, lineHeight: 1.2 }}>
            {targetLabel}
          </Typography.Text>
        )}
      </span>
    </span>
  );

  const commonStyle: React.CSSProperties = {
    color: token.colorText,
    textDecoration: 'none',
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    flex: inline ? '0 1 auto' : '1 1 auto',
    borderRadius: token.borderRadiusSM,
    maxWidth: inline ? '100%' : undefined,
  };

  const nonNavigableStyle: React.CSSProperties = {
    ...commonStyle,
    color: contentAction ? token.colorText : token.colorTextSecondary,
    cursor: contentAction ? 'pointer' : 'default',
    border: 0,
    background: 'transparent',
    padding: 0,
    font: 'inherit',
    textAlign: 'left',
  };

  const mainTarget =
    item.href && item.navigation === 'spa' ? (
      <RouterLink to={item.href} style={commonStyle} title={title}>
        {linkBody}
      </RouterLink>
    ) : item.href ? (
      <a href={item.href} target="_blank" rel="noreferrer" style={commonStyle} title={title}>
        {linkBody}
      </a>
    ) : contentAction ? (
      <button
        type="button"
        aria-label={`${contentAction === 'preview' ? 'Preview' : 'Download'} ${title}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (contentAction === 'preview') onPreview?.(item);
          else onDownload?.(item);
        }}
        style={nonNavigableStyle}
        title={title}
      >
        {linkBody}
      </button>
    ) : (
      <span aria-disabled style={nonNavigableStyle} title={title}>
        {linkBody}
      </span>
    );

  const row = (
    <span
      className="agor-action-link-row"
      aria-disabled={isActionable ? undefined : true}
      style={
        {
          '--agor-link-title-color': isActionable ? token.colorText : token.colorTextSecondary,
          '--agor-link-icon-color': token.colorTextTertiary,
          '--agor-link-row-hover-bg': token.colorFillTertiary,
          '--agor-link-row-hover-color': token.colorPrimary,
          display: 'flex',
          alignItems: 'center',
          gap: token.sizeUnit * 2,
          minWidth: 0,
          width: inline ? 'auto' : '100%',
          borderRadius: token.borderRadiusSM,
          padding: compact
            ? `${token.sizeUnit}px ${token.sizeUnit * 1.5}px`
            : `${token.sizeUnit}px 0`,
        } as React.CSSProperties
      }
    >
      {mainTarget}
      {pinActionButton}
    </span>
  );

  return row;
}

export function useLinkFileActions() {
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  useEffect(() => {
    return () => {
      if (preview?.objectUrl) URL.revokeObjectURL(preview.objectUrl);
    };
  }, [preview?.objectUrl]);

  const openPreview = async (item: LinkDisplayItem) => {
    const kind = getLinkPreviewKind(item);
    if (!kind) return;
    setPreview({ item, kind, loading: true });
    setBusyLinkId(item.linkId ?? null);
    try {
      const response = await fetchLinkContent(item, 'inline');
      if (kind === 'image') {
        const objectUrl = URL.createObjectURL(await response.blob());
        setPreview({ item, kind, loading: false, objectUrl });
      } else {
        setPreview({ item, kind, loading: false, text: await response.text() });
      }
    } catch (err) {
      setPreview({
        item,
        kind,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load preview',
      });
    } finally {
      setBusyLinkId(null);
    }
  };

  const downloadItem = async (item: LinkDisplayItem) => {
    setBusyLinkId(item.linkId ?? null);
    try {
      const response = await fetchLinkContent(item, 'attachment');
      triggerBlobDownload(await response.blob(), getCompactLinkDisplayName(item));
    } catch (err) {
      setPreview({
        item,
        kind: 'text',
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to download file',
      });
    } finally {
      setBusyLinkId(null);
    }
  };

  return { busyLinkId, preview, setPreview, openPreview, downloadItem };
}

export function LinkPreviewModal({
  preview,
  onClose,
}: {
  preview: PreviewState | null;
  onClose: () => void;
}) {
  const { token } = theme.useToken();
  return (
    <Modal
      title={preview ? getCompactLinkDisplayName(preview.item) : 'Preview'}
      open={!!preview}
      onCancel={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
      width={preview?.kind === 'image' ? 840 : 900}
    >
      {preview?.loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: token.paddingXL }}>
          <Spin />
        </div>
      ) : preview?.error ? (
        <Typography.Text type="danger">{preview.error}</Typography.Text>
      ) : preview?.kind === 'image' && preview.objectUrl ? (
        <img
          src={preview.objectUrl}
          alt={getCompactLinkDisplayName(preview.item)}
          style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', margin: '0 auto' }}
        />
      ) : preview?.kind === 'markdown' ? (
        <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <MarkdownRenderer content={preview.text ?? ''} />
        </div>
      ) : preview?.kind === 'text' ? (
        <pre
          style={{
            maxHeight: '70vh',
            overflow: 'auto',
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: token.colorText,
          }}
        >
          {preview.text ?? ''}
        </pre>
      ) : null}
    </Modal>
  );
}

type LinkManagementCategory = LinkCategoryTabKey;
type LinkManagementSort = LinkSortKey;

function isFileDisplayItem(item: LinkDisplayItem): boolean {
  return isFileLinkDisplayItem(item);
}

function isKnowledgeDisplayItem(item: LinkDisplayItem): boolean {
  return isKnowledgeLinkDisplayItem(item);
}

function getQuickCategoryRank(item: LinkDisplayItem): number {
  if (item.category === 'issue') return 0;
  if (item.category === 'pr') return 1;
  if (isKnowledgeDisplayItem(item)) return 2;
  if (item.category === 'url' || item.category === 'internal') return 3;
  if (isFileDisplayItem(item)) return 4;
  return 5;
}

function compareQuickItems(a: LinkDisplayItem, b: LinkDisplayItem): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  const createdOrder = (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  if (createdOrder !== 0) return createdOrder;
  const categoryOrder = getQuickCategoryRank(a) - getQuickCategoryRank(b);
  if (categoryOrder !== 0) return categoryOrder;
  const nameOrder = getCompactLinkDisplayName(a).localeCompare(
    getCompactLinkDisplayName(b),
    undefined,
    { sensitivity: 'base' }
  );
  if (nameOrder !== 0) return nameOrder;
  return a.key.localeCompare(b.key);
}

function selectQuickItems(items: LinkDisplayItem[], limit: number): LinkDisplayItem[] {
  const ordered = [...items].sort(compareQuickItems);
  if (limit < 5) return ordered.slice(0, limit);

  const files = ordered.filter(isFileDisplayItem);
  const fileReserve = files.length > 0 ? Math.min(2, files.length, Math.max(1, limit - 5)) : 0;
  const nonFiles = ordered.filter((item) => !isFileDisplayItem(item));
  const selected = nonFiles.slice(0, Math.max(0, limit - fileReserve));
  const selectedKeys = new Set(selected.map((item) => item.key));
  selected.push(
    ...files.filter((item) => !selectedKeys.has(item.key)).slice(0, limit - selected.length)
  );
  return selected;
}

function getSummary(items: LinkDisplayItem[]): string {
  return getLinkCategorySummary(items);
}

function getTypeLabel(item: LinkDisplayItem): string {
  switch (item.category) {
    case 'issue':
      return 'Issue';
    case 'pr':
      return 'PR';
    case 'knowledge':
      return 'KB';
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
    case 'url':
      return 'URL';
    case 'internal':
      return 'Ref';
    default:
      return 'Link';
  }
}

function getDomain(value?: string): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function getSourceOrDomainLabel(item: LinkDisplayItem): string {
  const domain = getDomain(item.url);
  if (domain) return domain;
  if (isKnowledgeDisplayItem(item)) return 'Knowledge';
  if (item.source === 'upload' || item.filePath) return 'Upload';
  return item.ownerScope === 'branch' ? 'Branch' : 'This session';
}

function getScopeDomainLabel(item: LinkDisplayItem): string {
  const ownerLabel = item.ownerScope === 'branch' ? 'Branch' : 'This session';
  const sourceOrDomain = getSourceOrDomainLabel(item);
  return sourceOrDomain === ownerLabel ? ownerLabel : `${ownerLabel} · ${sourceOrDomain}`;
}

function getQuickSecondaryLabel(item: LinkDisplayItem): string {
  return getScopeDomainLabel(item);
}

function getUnavailableReason(item: LinkDisplayItem): string | null {
  if (item.href || getLinkContentAction(item)) return null;
  if (isFileDisplayItem(item)) return 'Preview/download not available yet.';
  return 'No safe route is available for this item yet.';
}

function getTypePillColors(item: LinkDisplayItem): { background: string; color: string } {
  switch (item.category) {
    case 'issue':
    case 'pr':
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

function TypePill({ item, compact = false }: { item: LinkDisplayItem; compact?: boolean }) {
  const { token } = theme.useToken();
  const colors = getTypePillColors(item);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: compact ? 'flex-end' : 'flex-start',
        minWidth: compact ? 34 : 66,
        maxWidth: compact ? 44 : 88,
        borderRadius: token.borderRadiusSM,
        padding: compact ? 0 : '2px 8px',
        background: compact ? 'transparent' : colors.background,
        color: compact ? token.colorTextTertiary : colors.color,
        fontSize: 12,
        lineHeight: 1.25,
        whiteSpace: 'nowrap',
      }}
    >
      {getTypeLabel(item)}
    </span>
  );
}

function shouldIgnoreRowActivation(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('a,button,[role="button"]'));
}

function activateLinkItem(
  item: LinkDisplayItem,
  navigate: (to: string) => void,
  onPreview?: (item: LinkDisplayItem) => void,
  onDownload?: (item: LinkDisplayItem) => void,
  onNavigate?: () => void
) {
  const contentAction = getLinkContentAction(item);
  if (contentAction === 'preview') {
    onPreview?.(item);
    return;
  }
  if (contentAction === 'download') {
    onDownload?.(item);
    return;
  }
  if (item.href && item.navigation === 'spa') {
    onNavigate?.();
    navigate(item.href);
    return;
  }
  if (item.href) {
    onNavigate?.();
    window.open(item.href, '_blank', 'noopener,noreferrer');
  }
}

function activateContentAction(
  item: LinkDisplayItem,
  onPreview?: (item: LinkDisplayItem) => void,
  onDownload?: (item: LinkDisplayItem) => void
) {
  const contentAction = getLinkContentAction(item);
  if (contentAction === 'preview') onPreview?.(item);
  else if (contentAction === 'download') onDownload?.(item);
}

function getPinnedChipActionLabel(item: LinkDisplayItem): string {
  const contentAction = getLinkContentAction(item);
  if (contentAction === 'preview') return 'Preview pinned';
  if (contentAction === 'download') return 'Download pinned';
  return 'Open pinned';
}

function getPinnedChipTitle(item: LinkDisplayItem): string {
  return getCompactLinkDisplayName(item).replace(/^(Issue|PR|Knowledge|Link|URL):\s*/i, '');
}

function TitleTarget({
  item,
  accent = false,
  onPreview,
  onDownload,
  onNavigate,
}: {
  item: LinkDisplayItem;
  accent?: boolean;
  onPreview?: (item: LinkDisplayItem) => void;
  onDownload?: (item: LinkDisplayItem) => void;
  onNavigate?: () => void;
}) {
  const { token } = theme.useToken();
  const title = getCompactLinkDisplayName(item);
  const contentAction = getLinkContentAction(item);
  const disabled = Boolean(getUnavailableReason(item));
  const baseStyle: React.CSSProperties = {
    display: 'block',
    minWidth: 0,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 600,
    fontSize: 13,
    lineHeight: 1.25,
    color: disabled
      ? token.colorTextDisabled
      : `var(--agor-link-title-color, ${accent ? token.colorPrimary : token.colorText})`,
  };

  if (item.href && item.navigation === 'spa') {
    return (
      <RouterLink
        className="agor-action-link-title"
        to={item.href}
        onClick={onNavigate}
        style={{ ...baseStyle, textDecoration: 'none' }}
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
        onClick={onNavigate}
        style={{ ...baseStyle, textDecoration: 'none' }}
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
        onClick={() => activateContentAction(item, onPreview, onDownload)}
        style={{
          ...baseStyle,
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
    <Typography.Text disabled ellipsis style={baseStyle} title={title}>
      {title}
    </Typography.Text>
  );
}

function PinAction({
  item,
  onTogglePinned,
  pinning = false,
}: {
  item: LinkDisplayItem;
  onTogglePinned?: (item: LinkDisplayItem) => void | Promise<void>;
  pinning?: boolean;
}) {
  const { token } = theme.useToken();
  const title = getCompactLinkDisplayName(item);
  const canTogglePin = Boolean(item.linkId && onTogglePinned);
  if (!canTogglePin && !item.isPinned) return <span aria-hidden />;
  const label = canTogglePin ? getPinActionLabel(item) : 'Pinned';
  return (
    <Tooltip title={label}>
      <button
        type="button"
        aria-label={`${label} ${title}`}
        disabled={!canTogglePin || pinning}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onTogglePinned?.(item);
        }}
        style={{
          width: 22,
          height: 22,
          border: 0,
          background: 'transparent',
          padding: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: canTogglePin && !pinning ? 'pointer' : 'default',
          color: item.isPinned ? token.colorWarning : token.colorTextQuaternary,
          opacity: pinning ? 0.55 : 1,
        }}
      >
        {item.isPinned ? <PushpinFilled /> : <PushpinOutlined />}
      </button>
    </Tooltip>
  );
}

function QuickLinkRow({
  item,
  onPreview,
  onDownload,
  onTogglePinned,
  pinning = false,
  onNavigate,
}: {
  item: LinkDisplayItem;
  onPreview?: (item: LinkDisplayItem) => void;
  onDownload?: (item: LinkDisplayItem) => void;
  onTogglePinned?: (item: LinkDisplayItem) => void | Promise<void>;
  pinning?: boolean;
  onNavigate?: () => void;
}) {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const disabled = Boolean(getUnavailableReason(item));
  const canTogglePin = Boolean(item.linkId && onTogglePinned);
  const pinLabel = canTogglePin ? getPinActionLabel(item) : 'Pin unavailable';
  return (
    <Tooltip
      title={
        getUnavailableReason(item) ??
        (getLinkContentAction(item) === 'preview'
          ? 'Preview file'
          : getLinkContentAction(item) === 'download'
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
        onClick={(event) => {
          if (disabled || shouldIgnoreRowActivation(event.target)) return;
          activateLinkItem(item, navigate, onPreview, onDownload, onNavigate);
        }}
        onKeyDown={(event) => {
          if (disabled || shouldIgnoreRowActivation(event.target)) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          activateLinkItem(item, navigate, onPreview, onDownload, onNavigate);
        }}
        style={
          {
            '--agor-link-title-color': disabled ? token.colorTextDisabled : token.colorText,
            '--agor-link-icon-color': disabled ? token.colorTextDisabled : token.colorTextTertiary,
            '--agor-link-row-hover-bg': token.colorFillTertiary,
            '--agor-link-row-hover-color': token.colorPrimary,
            display: 'grid',
            gridTemplateColumns: '34px minmax(0, 1fr) 44px 24px',
            columnGap: token.sizeSM,
            alignItems: 'center',
            minWidth: 0,
            minHeight: 58,
            cursor: disabled ? 'default' : 'pointer',
            padding: `${token.sizeXS}px ${token.sizeXS}px`,
            borderRadius: token.borderRadius,
          } as React.CSSProperties
        }
      >
        <SmallLinkGlyph item={item} disabled={disabled} />
        <span
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: token.sizeXXS,
            minWidth: 0,
          }}
        >
          <TitleTarget
            item={item}
            onPreview={onPreview}
            onDownload={onDownload}
            onNavigate={onNavigate}
          />
          <Typography.Text
            type="secondary"
            ellipsis
            style={{ display: 'block', fontSize: 12, lineHeight: 1.35 }}
          >
            {getQuickSecondaryLabel(item)}
          </Typography.Text>
        </span>
        <TypePill item={item} compact />
        <Tooltip title={pinLabel}>
          <button
            type="button"
            aria-label={`${pinLabel} ${getCompactLinkDisplayName(item)}`}
            disabled={!canTogglePin || pinning}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (canTogglePin) onTogglePinned?.(item);
            }}
            style={{
              border: 0,
              background: 'transparent',
              padding: 0,
              color: item.isPinned ? token.colorWarning : token.colorTextQuaternary,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              flex: '0 0 auto',
              cursor: canTogglePin && !pinning ? 'pointer' : 'default',
              opacity: pinning ? 0.6 : 1,
            }}
          >
            {item.isPinned ? <PushpinFilled /> : <PushpinOutlined />}
          </button>
        </Tooltip>
      </div>
    </Tooltip>
  );
}

function ManagementLinkRow({
  item,
  onPreview,
  onDownload,
  onTogglePinned,
  onNavigate,
  pinning = false,
  assistantAction,
  onPromoteToAssistant,
  onRemoveFromAssistant,
}: {
  item: LinkDisplayItem;
  onPreview?: (item: LinkDisplayItem) => void;
  onDownload?: (item: LinkDisplayItem) => void;
  onTogglePinned?: (item: LinkDisplayItem) => void | Promise<void>;
  onNavigate?: () => void;
  pinning?: boolean;
  assistantAction?: AssistantLinkActionState | null;
  onPromoteToAssistant?: (item: LinkDisplayItem) => void;
  onRemoveFromAssistant?: (item: LinkDisplayItem, assistantLinkId: string) => void;
}) {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const targetLabel = getLinkDisplaySecondaryLabel(item);
  const disabledReason = getUnavailableReason(item);
  const disabled = Boolean(disabledReason);
  const hasAssistantAction = Boolean(assistantAction);
  return (
    <div
      className="agor-action-link-row"
      role={disabled ? undefined : 'link'}
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        if (disabled || shouldIgnoreRowActivation(event.target)) return;
        activateLinkItem(item, navigate, onPreview, onDownload, onNavigate);
      }}
      onKeyDown={(event) => {
        if (disabled || shouldIgnoreRowActivation(event.target)) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activateLinkItem(item, navigate, onPreview, onDownload, onNavigate);
      }}
      style={
        {
          '--agor-link-title-color': disabled ? token.colorTextDisabled : token.colorText,
          '--agor-link-icon-color': disabled ? token.colorTextDisabled : token.colorTextTertiary,
          '--agor-link-row-hover-bg': token.colorFillTertiary,
          '--agor-link-row-hover-color': token.colorPrimary,
          display: 'grid',
          gridTemplateColumns: hasAssistantAction
            ? 'minmax(0, 1.35fr) minmax(110px, 0.45fr) 94px 24px 24px'
            : 'minmax(0, 1.35fr) minmax(110px, 0.45fr) 94px 24px',
          columnGap: token.sizeMD,
          alignItems: 'center',
          padding: `${token.sizeSM}px 0`,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          cursor: disabled ? 'default' : 'pointer',
          minWidth: 0,
        } as React.CSSProperties
      }
    >
      <span style={{ display: 'flex', gap: token.sizeSM, minWidth: 0, alignItems: 'flex-start' }}>
        <SmallLinkGlyph item={item} disabled={disabled} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <TitleTarget
            item={item}
            accent
            onPreview={onPreview}
            onDownload={onDownload}
            onNavigate={onNavigate}
          />
          {targetLabel && (
            <Typography.Text
              type="secondary"
              ellipsis
              style={{ display: 'block', fontSize: 12, lineHeight: 1.25 }}
            >
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
      </span>
      <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
        {getScopeDomainLabel(item)}
      </Typography.Text>
      <TypePill item={item} />
      <PinAction item={item} onTogglePinned={onTogglePinned} pinning={pinning} />
      {assistantAction ? (
        <Tooltip title={assistantAction.unavailableReason ?? 'Assistant link actions'}>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: assistantAction.isPromoted ? 'remove-assistant' : 'promote-assistant',
                  label: assistantAction.isPromoted
                    ? 'Remove from assistant'
                    : 'Promote to assistant',
                  danger: assistantAction.isPromoted,
                  disabled: assistantAction.disabled || assistantAction.loading,
                  title: assistantAction.unavailableReason ?? undefined,
                },
              ],
              onClick: ({ domEvent }) => {
                domEvent.preventDefault();
                domEvent.stopPropagation();
                if (assistantAction.disabled || assistantAction.loading) return;
                if (assistantAction.isPromoted && assistantAction.assistantLinkId) {
                  onRemoveFromAssistant?.(item, assistantAction.assistantLinkId);
                } else {
                  onPromoteToAssistant?.(item);
                }
              },
            }}
          >
            <Button
              type="text"
              size="small"
              aria-label={`Assistant actions for ${getCompactLinkDisplayName(item)}`}
              icon={<EllipsisOutlined />}
              loading={assistantAction.loading}
              onClick={(event) => event.stopPropagation()}
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
      ) : hasAssistantAction ? (
        <span aria-hidden />
      ) : null}
    </div>
  );
}

export const RichPinnedLinksStrip: React.FC<PinnedLinksStripProps> = ({
  items,
  onTogglePinned,
  pinningLinkId = null,
  label = 'Pinned',
  'data-testid': dataTestId,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { busyLinkId, preview, setPreview, openPreview, downloadItem } = useLinkFileActions();

  if (items.length === 0) return null;

  const openItem = (item: LinkDisplayItem) => {
    const contentAction = getLinkContentAction(item);
    if (contentAction === 'preview') {
      void openPreview(item);
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
  };

  return (
    <>
      <div
        data-testid={dataTestId}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: token.sizeSM,
          flexWrap: 'wrap',
          minWidth: 0,
          marginBottom: 0,
          padding: `${token.paddingXXS + 2}px ${token.paddingXS}px`,
        }}
      >
        <Typography.Text
          type="secondary"
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.2,
            flex: '0 0 auto',
            paddingTop: 4,
          }}
        >
          {label}
        </Typography.Text>
        <div
          data-testid={dataTestId ? `${dataTestId}-links` : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: token.sizeXXS,
            flexWrap: 'wrap',
            minWidth: 0,
            flex: '1 1 0',
          }}
        >
          {items.map((item) => {
            const disabledReason = getUnavailableReason(item);
            const disabled = Boolean(disabledReason);
            const title = getPinnedChipTitle(item);
            const canTogglePin = Boolean(item.linkId && onTogglePinned);
            const pinActionLabel = canTogglePin ? getPinActionLabel(item) : 'Pinned';
            const isBusy = item.linkId === busyLinkId;
            const isPinning = item.linkId === pinningLinkId;
            const secondaryLabel = getLinkDisplaySecondaryLabel(item);
            const tooltipTitle = disabledReason
              ? disabledReason
              : secondaryLabel
                ? `${title} · ${secondaryLabel}`
                : title;
            return (
              <Tooltip key={item.key} title={tooltipTitle} mouseEnterDelay={0.45}>
                <span
                  className="agor-action-link-chip"
                  aria-disabled={disabled || undefined}
                  style={
                    {
                      '--agor-link-chip-bg': disabled
                        ? token.colorFillQuaternary
                        : token.colorPrimaryBg,
                      '--agor-link-chip-border': disabled
                        ? token.colorBorderSecondary
                        : token.colorPrimaryBorder,
                      '--agor-link-chip-color': disabled
                        ? token.colorTextDisabled
                        : token.colorText,
                      '--agor-link-chip-accent-color': disabled
                        ? token.colorTextDisabled
                        : token.colorTextTertiary,
                      '--agor-link-chip-hover-bg': token.colorPrimaryBg,
                      '--agor-link-chip-hover-border': token.colorPrimaryBorder,
                      '--agor-link-chip-hover-color': token.colorPrimary,
                      '--agor-link-chip-hover-accent-color': token.colorTextTertiary,
                      height: 26,
                      minWidth: 0,
                      maxWidth: 156,
                      border: '1px solid var(--agor-link-chip-border)',
                      borderRadius: 999,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      lineHeight: 1,
                      flex: '0 1 auto',
                      opacity: isBusy ? 0.65 : 1,
                      overflow: 'hidden',
                    } as React.CSSProperties
                  }
                >
                  <button
                    type="button"
                    disabled={!canTogglePin || isPinning}
                    aria-label={`${pinActionLabel} ${title}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onTogglePinned?.(item);
                    }}
                    style={{
                      width: 20,
                      height: 24,
                      border: 0,
                      background: 'transparent',
                      color: 'var(--agor-link-chip-accent-color)',
                      cursor: canTogglePin && !isPinning ? 'pointer' : 'default',
                      padding: '0 0 0 8px',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flex: '0 0 auto',
                      opacity: isPinning ? 0.55 : 1,
                    }}
                  >
                    <PushpinFilled style={{ fontSize: 11 }} />
                  </button>
                  <button
                    type="button"
                    disabled={disabled || isBusy}
                    aria-label={
                      disabled
                        ? `${title}: ${disabledReason}`
                        : `${getPinnedChipActionLabel(item)} ${title}`
                    }
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openItem(item);
                    }}
                    style={{
                      minWidth: 0,
                      border: 0,
                      background: 'transparent',
                      color: 'var(--agor-link-chip-color)',
                      cursor: disabled || isBusy ? 'not-allowed' : 'pointer',
                      padding: `0 ${token.paddingXS}px 0 0`,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      font: 'inherit',
                      lineHeight: 1,
                      flex: '1 1 auto',
                      overflow: 'hidden',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="agor-action-link-icon"
                      style={{
                        width: 18,
                        color: 'var(--agor-link-chip-accent-color)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flex: '0 0 auto',
                        fontSize: item.category === 'issue' || item.category === 'pr' ? 13 : 9,
                        fontWeight: 800,
                        letterSpacing: 0.2,
                      }}
                    >
                      {item.category === 'issue' || item.category === 'pr' ? (
                        <GithubOutlined />
                      ) : (
                        getLinkDisplayGlyphLabel(item.category)
                      )}
                    </span>
                    <Typography.Text
                      className={disabled ? undefined : 'agor-action-link-title'}
                      ellipsis
                      style={{
                        fontSize: 12,
                        maxWidth: 96,
                        color: 'var(--agor-link-chip-color)',
                      }}
                    >
                      {title}
                    </Typography.Text>
                  </button>
                </span>
              </Tooltip>
            );
          })}
        </div>
      </div>
      <LinkPreviewModal preview={preview} onClose={() => setPreview(null)} />
    </>
  );
};

export const LinksManagementDrawer: React.FC<LinksManagementDrawerProps> = ({
  items,
  open,
  onClose,
  title = 'Manage links',
  emptyDescription = 'No links yet',
  onTogglePinned,
  pinningLinkId = null,
  getAssistantActionState,
  onPromoteToAssistant,
  onRemoveFromAssistant,
  width = 720,
}) => {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const [previewTarget, setPreviewTarget] = useState<LinkImagePreviewTarget | null>(null);
  const [markdownTarget, setMarkdownTarget] = useState<LinkMarkdownPreviewTarget | null>(null);
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<LinkManagementCategory>('all');
  const [sortOrder, setSortOrder] = useState<LinkManagementSort>('az');

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => compareLinkDisplayItemsBySort(a, b, sortOrder)),
    [items, sortOrder]
  );
  const visibleItems = useMemo(
    () => sortedItems.filter((item) => matchesLinkCategoryTab(item, activeCategory)),
    [activeCategory, sortedItems]
  );
  const categoryCounts = useMemo(() => getLinkCategoryCounts(items), [items]);
  const categoryTabs = useMemo(
    () =>
      (['all', 'files', 'links', 'knowledge', 'issues'] as const).map((key) => ({
        key,
        label: `${LINK_CATEGORY_TAB_LABELS[key]} ${categoryCounts[key]}`,
      })),
    [categoryCounts]
  );
  const openPreview = useCallback((item: LinkDisplayItem) => {
    if (!item.linkId) return;
    const previewKind = getLinkPreviewKind(item);
    const target = getLinkContentTarget(item);
    if (previewKind === 'image') setPreviewTarget(target);
    else if (previewKind === 'markdown' || previewKind === 'text') setMarkdownTarget(target);
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

  return (
    <>
      <Drawer
        title={title}
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {getSummary(items)}
          </Typography.Text>
        }
        open={open}
        onClose={onClose}
        width={width}
        styles={{ body: { paddingTop: token.sizeLG } }}
      >
        {items.length > 0 ? (
          <Space direction="vertical" size={token.sizeLG} style={{ width: '100%' }}>
            <div data-testid="links-management-category-row">
              <Tabs
                className="agor-link-category-tabs"
                activeKey={activeCategory}
                items={categoryTabs}
                onChange={(key) => setActiveCategory(key as LinkManagementCategory)}
              />
            </div>
            <Space wrap size={token.sizeSM} style={{ width: '100%' }}>
              <Space size={token.sizeXS}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Sort
                </Typography.Text>
                <Select<LinkManagementSort>
                  size="small"
                  value={sortOrder}
                  options={(Object.keys(LINK_SORT_LABELS) as LinkManagementSort[]).map((key) => ({
                    value: key,
                    label: LINK_SORT_LABELS[key],
                  }))}
                  onChange={setSortOrder}
                  style={{ width: 128 }}
                />
              </Space>
            </Space>

            {visibleItems.length > 0 ? (
              <div>
                {visibleItems.map((item) => (
                  <ManagementLinkRow
                    key={item.key}
                    item={item}
                    onPreview={openPreview}
                    onDownload={downloadItem}
                    onTogglePinned={onTogglePinned}
                    onNavigate={onClose}
                    pinning={item.linkId === pinningLinkId}
                    assistantAction={getAssistantActionState?.(item)}
                    onPromoteToAssistant={onPromoteToAssistant}
                    onRemoveFromAssistant={onRemoveFromAssistant}
                  />
                ))}
              </div>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No links match your filters"
              />
            )}
          </Space>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription} />
        )}
      </Drawer>

      <LinkImagePreviewModal target={previewTarget} onClose={() => setPreviewTarget(null)} />
      <LinkMarkdownPreviewModal target={markdownTarget} onClose={() => setMarkdownTarget(null)} />
    </>
  );
};

export const SessionLinksControl: React.FC<SessionLinksControlProps> = ({
  items,
  loading = false,
  error = null,
  quickLimit = QUICK_LINK_LIMIT,
  onTogglePinned,
  pinningLinkId = null,
  onRegisterOpenManager,
  getAssistantActionState,
  onPromoteToAssistant,
  onRemoveFromAssistant,
}) => {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<LinkImagePreviewTarget | null>(null);
  const [markdownTarget, setMarkdownTarget] = useState<LinkMarkdownPreviewTarget | null>(null);
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null);
  const quickItems = useMemo(() => selectQuickItems(items, quickLimit), [items, quickLimit]);
  const hiddenCount = Math.max(items.length - quickItems.length, 0);

  const openDrawer = useCallback(() => {
    setPopoverOpen(false);
    setDrawerOpen(true);
  }, []);

  useEffect(() => {
    onRegisterOpenManager?.(openDrawer);
    return () => onRegisterOpenManager?.(null);
  }, [onRegisterOpenManager, openDrawer]);

  const handlePreview = (item: LinkDisplayItem) => {
    if (!item.linkId) return;
    setPopoverOpen(false);
    const previewKind = getLinkPreviewKind(item);
    const target = getLinkContentTarget(item);
    if (previewKind === 'image') setPreviewTarget(target);
    else if (previewKind === 'markdown' || previewKind === 'text') setMarkdownTarget(target);
  };

  const handleDownload = async (item: LinkDisplayItem) => {
    if (!item.linkId || busyLinkId) return;
    setPopoverOpen(false);
    setBusyLinkId(item.linkId);
    try {
      await downloadLinkContent(item.linkId, getCompactLinkDisplayName(item));
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setBusyLinkId(null);
    }
  };

  const closePopover = () => setPopoverOpen(false);

  if (!loading && !error && items.length === 0) return null;

  const popoverContent = (
    <div style={{ width: 312 }} data-testid="links-organizer-popover">
      <div>
        <Typography.Text strong>Links</Typography.Text>
        <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          {getSummary(items)}
        </Typography.Text>
      </div>

      {error ? (
        <Typography.Text
          type="danger"
          style={{ display: 'block', fontSize: 12, marginTop: token.sizeSM }}
        >
          {error}
        </Typography.Text>
      ) : quickItems.length > 0 ? (
        <div
          style={{
            display: 'grid',
            gap: token.sizeXS,
            marginTop: token.sizeMD,
            maxHeight: 308,
            overflowY: 'auto',
            paddingRight: 2,
          }}
        >
          {quickItems.map((item) => (
            <QuickLinkRow
              key={item.key}
              item={item}
              onPreview={handlePreview}
              onDownload={handleDownload}
              onTogglePinned={onTogglePinned}
              pinning={item.linkId === pinningLinkId || item.linkId === busyLinkId}
              onNavigate={closePopover}
            />
          ))}
        </div>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No links yet"
          style={{ margin: `${token.sizeSM}px 0` }}
        />
      )}

      <div
        style={{
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          marginTop: token.sizeMD,
          paddingTop: token.sizeMD,
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hiddenCount > 0 ? `+${hiddenCount} more in ` : ''}
          <Button
            type="link"
            size="small"
            onClick={openDrawer}
            style={{ padding: 0, height: 'auto', fontSize: 12 }}
          >
            Manage links
          </Button>
        </Typography.Text>
      </div>
    </div>
  );

  return (
    <>
      <Popover
        content={popoverContent}
        trigger="click"
        placement="bottomRight"
        open={popoverOpen}
        onOpenChange={setPopoverOpen}
      >
        <Tooltip title="Attachments">
          <Badge count={items.length || 0} color={token.colorPrimary} size="small" offset={[-4, 4]}>
            <Button
              type="text"
              aria-label="Open links organizer"
              loading={loading}
              icon={<LinkOutlined style={{ color: token.colorTextSecondary }} />}
            />
          </Badge>
        </Tooltip>
      </Popover>

      <LinksManagementDrawer
        items={items}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onTogglePinned={onTogglePinned}
        pinningLinkId={pinningLinkId}
        getAssistantActionState={getAssistantActionState}
        onPromoteToAssistant={onPromoteToAssistant}
        onRemoveFromAssistant={onRemoveFromAssistant}
      />

      <LinkImagePreviewModal target={previewTarget} onClose={() => setPreviewTarget(null)} />
      <LinkMarkdownPreviewModal target={markdownTarget} onClose={() => setMarkdownTarget(null)} />
    </>
  );
};
