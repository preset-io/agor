import {
  DownloadOutlined,
  ExportOutlined,
  EyeOutlined,
  GithubOutlined,
  LinkOutlined,
  PushpinFilled,
  PushpinOutlined,
  RightOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  Badge,
  Button,
  Drawer,
  Empty,
  Modal,
  Popover,
  Segmented,
  Space,
  Spin,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { getAuthHeaders } from '../../utils/authHeaders';
import { MarkdownRenderer } from '../MarkdownRenderer';
import {
  getLinkContentAction,
  getLinkContentUrl,
  getLinkPreviewKind,
  type LinkPreviewKind,
} from './linkContent';
import {
  getCompactLinkDisplayName,
  getLinkDisplayGlyphLabel,
  getLinkDisplaySecondaryLabel,
  type LinkDisplayCategory,
  type LinkDisplayItem,
} from './linkDisplay';

const QUICK_LINK_LIMIT = 7;

export interface SessionLinksControlProps {
  items: LinkDisplayItem[];
  loading?: boolean;
  error?: string | null;
  quickLimit?: number;
  onTogglePinned?: (item: LinkDisplayItem) => void | Promise<void>;
  pinningLinkId?: string | null;
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
  width?: number | string;
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
      aria-hidden="true"
      style={{
        width: 34,
        height: 24,
        borderRadius: token.borderRadiusSM,
        background: token.colorFillTertiary,
        color: token.colorTextSecondary,
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
      aria-hidden="true"
      style={{
        width: 24,
        height: 24,
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
  busy = false,
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

  const actionButton = contentAction ? (
    <Tooltip title={contentAction === 'preview' ? 'Preview' : 'Download'}>
      <Button
        type="text"
        size="small"
        loading={busy}
        aria-label={`${contentAction === 'preview' ? 'Preview' : 'Download'} ${title}`}
        icon={contentAction === 'preview' ? <EyeOutlined /> : <DownloadOutlined />}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (contentAction === 'preview') onPreview?.(item);
          else onDownload?.(item);
        }}
        style={{ color: token.colorTextTertiary, flex: '0 0 auto' }}
      />
    </Tooltip>
  ) : null;

  const showPassivePinIndicator = item.isPinned && !canTogglePin;

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
          <Typography.Text ellipsis style={{ lineHeight: 1.25, flex: 1 }}>
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
      {item.href ? (
        item.navigation === 'spa' ? (
          <RightOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
        ) : (
          <ExportOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
        )
      ) : null}
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
    cursor: 'default',
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
    ) : (
      <span
        aria-disabled={contentAction ? undefined : true}
        style={nonNavigableStyle}
        title={title}
      >
        {linkBody}
      </span>
    );

  const row = (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: token.sizeUnit * 2,
        minWidth: 0,
        width: inline ? 'auto' : '100%',
        padding: compact
          ? `${token.sizeUnit}px ${token.sizeUnit * 1.5}px`
          : `${token.sizeUnit}px 0`,
      }}
    >
      {mainTarget}
      {pinActionButton}
      {actionButton}
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

type LinkManagementFilter =
  | 'all'
  | 'branch'
  | 'session'
  | 'files'
  | 'knowledge'
  | 'issues'
  | 'pinned';

const LINK_DOCUMENT_CATEGORIES = new Set<LinkDisplayCategory>([
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

function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function isFileDisplayItem(item: LinkDisplayItem): boolean {
  return (
    item.category === 'image' ||
    Boolean(item.filePath) ||
    LINK_DOCUMENT_CATEGORIES.has(item.category)
  );
}

function isKnowledgeDisplayItem(item: LinkDisplayItem): boolean {
  return item.category === 'knowledge' || Boolean(item.refUri?.startsWith('agor://kb/'));
}

function isIssuePrDisplayItem(item: LinkDisplayItem): boolean {
  return item.category === 'issue' || item.category === 'pr';
}

function matchesManagementFilter(item: LinkDisplayItem, filter: LinkManagementFilter): boolean {
  switch (filter) {
    case 'branch':
      return item.ownerScope === 'branch';
    case 'session':
      return item.ownerScope === 'session';
    case 'files':
      return isFileDisplayItem(item);
    case 'knowledge':
      return isKnowledgeDisplayItem(item);
    case 'issues':
      return isIssuePrDisplayItem(item);
    case 'pinned':
      return item.isPinned;
    default:
      return true;
  }
}

function compareManagementItems(a: LinkDisplayItem, b: LinkDisplayItem): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  const nameOrder = getCompactLinkDisplayName(a).localeCompare(
    getCompactLinkDisplayName(b),
    undefined,
    { sensitivity: 'base' }
  );
  if (nameOrder !== 0) return nameOrder;
  return a.key.localeCompare(b.key);
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
  const pinnedCount = items.filter((item) => item.isPinned).length;
  const fileCount = items.filter(isFileDisplayItem).length;
  return `${plural(items.length, 'link')} · ${plural(pinnedCount, 'pinned', 'pinned')} · ${plural(fileCount, 'file')}`;
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
      return { background: 'rgba(83, 29, 171, 0.18)', color: '#d3adf7' };
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
  return getCompactLinkDisplayName(item).replace(/^(Issue|PR|Knowledge|Saved URL):\s*/i, '');
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
    color: disabled ? token.colorTextDisabled : accent ? token.colorPrimary : token.colorText,
  };

  if (item.href && item.navigation === 'spa') {
    return (
      <RouterLink
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

function ActionControl({
  item,
  onPreview,
  onDownload,
  onNavigate,
  busy = false,
}: {
  item: LinkDisplayItem;
  onPreview?: (item: LinkDisplayItem) => void;
  onDownload?: (item: LinkDisplayItem) => void;
  onNavigate?: () => void;
  busy?: boolean;
}) {
  const { token } = theme.useToken();
  const title = getCompactLinkDisplayName(item);
  const contentAction = getLinkContentAction(item);
  const disabledReason = getUnavailableReason(item);
  const iconLinkStyle: React.CSSProperties = {
    width: 22,
    height: 22,
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
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            activateContentAction(item, onPreview, onDownload);
          }}
          style={{
            width: 22,
            minWidth: 22,
            height: 22,
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
        <RouterLink
          aria-label="Open link"
          to={item.href}
          onClick={onNavigate}
          style={iconLinkStyle}
        >
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
          onClick={onNavigate}
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
          color: item.isPinned ? token.colorPrimary : token.colorTextQuaternary,
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
  onNavigate,
  busy = false,
}: {
  item: LinkDisplayItem;
  onPreview?: (item: LinkDisplayItem) => void;
  onDownload?: (item: LinkDisplayItem) => void;
  onNavigate?: () => void;
  busy?: boolean;
}) {
  const { token } = theme.useToken();
  const disabled = Boolean(getUnavailableReason(item));
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '34px minmax(0, 1fr) 52px 28px',
        columnGap: token.sizeSM,
        alignItems: 'center',
        minWidth: 0,
        minHeight: 58,
        padding: `${token.sizeXS}px ${token.sizeXS}px`,
      }}
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
      <ActionControl
        item={item}
        onPreview={onPreview}
        onDownload={onDownload}
        onNavigate={onNavigate}
        busy={busy}
      />
    </div>
  );
}

function ManagementLinkRow({
  item,
  onPreview,
  onDownload,
  onTogglePinned,
  onNavigate,
  busy = false,
  pinning = false,
}: {
  item: LinkDisplayItem;
  onPreview?: (item: LinkDisplayItem) => void;
  onDownload?: (item: LinkDisplayItem) => void;
  onTogglePinned?: (item: LinkDisplayItem) => void | Promise<void>;
  onNavigate?: () => void;
  busy?: boolean;
  pinning?: boolean;
}) {
  const { token } = theme.useToken();
  const targetLabel = getLinkDisplaySecondaryLabel(item);
  const disabledReason = getUnavailableReason(item);
  const disabled = Boolean(disabledReason);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.35fr) minmax(110px, 0.45fr) 94px 28px 24px',
        columnGap: token.sizeMD,
        alignItems: 'center',
        padding: `${token.sizeSM}px 0`,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        minWidth: 0,
      }}
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
      <ActionControl
        item={item}
        onPreview={onPreview}
        onDownload={onDownload}
        onNavigate={onNavigate}
        busy={busy}
      />
      <PinAction item={item} onTogglePinned={onTogglePinned} pinning={pinning} />
    </div>
  );
}

export const PinnedLinksStrip: React.FC<PinnedLinksStripProps> = ({
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
                  style={{
                    height: 26,
                    minWidth: 0,
                    maxWidth: 156,
                    border: `1px solid ${
                      disabled ? token.colorBorderSecondary : token.colorPrimaryBorder
                    }`,
                    borderRadius: 999,
                    background: disabled ? token.colorFillQuaternary : token.colorPrimaryBg,
                    color: disabled ? token.colorTextDisabled : token.colorText,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    lineHeight: 1,
                    flex: '0 1 auto',
                    opacity: isBusy ? 0.65 : 1,
                    overflow: 'hidden',
                  }}
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
                      color: disabled ? token.colorTextDisabled : token.colorPrimary,
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
                      color: 'inherit',
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
                      style={{
                        width: 18,
                        color: disabled ? token.colorTextDisabled : token.colorPrimary,
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
                      ellipsis
                      style={{
                        fontSize: 12,
                        maxWidth: 96,
                        color: disabled ? token.colorTextDisabled : token.colorText,
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
  width = 720,
}) => {
  const { token } = theme.useToken();
  const { busyLinkId, preview, setPreview, openPreview, downloadItem } = useLinkFileActions();
  const [activeFilter, setActiveFilter] = useState<LinkManagementFilter>('all');

  const sortedItems = useMemo(() => [...items].sort(compareManagementItems), [items]);
  const visibleItems = useMemo(
    () => sortedItems.filter((item) => matchesManagementFilter(item, activeFilter)),
    [activeFilter, sortedItems]
  );
  const filterOptions = useMemo(
    () => [
      { label: `All ${items.length}`, value: 'all' as const },
      {
        label: `Branch ${items.filter((item) => item.ownerScope === 'branch').length}`,
        value: 'branch' as const,
      },
      {
        label: `This session ${items.filter((item) => item.ownerScope === 'session').length}`,
        value: 'session' as const,
      },
      { label: `Files ${items.filter(isFileDisplayItem).length}`, value: 'files' as const },
      {
        label: `Knowledge ${items.filter(isKnowledgeDisplayItem).length}`,
        value: 'knowledge' as const,
      },
      {
        label: `Issues/PRs ${items.filter(isIssuePrDisplayItem).length}`,
        value: 'issues' as const,
      },
      { label: `Pinned ${items.filter((item) => item.isPinned).length}`, value: 'pinned' as const },
    ],
    [items]
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
            <div data-testid="links-management-filter-row">
              <Segmented<LinkManagementFilter>
                size="middle"
                value={activeFilter}
                options={filterOptions}
                onChange={setActiveFilter}
              />
            </div>

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
                    busy={item.linkId === busyLinkId}
                    pinning={item.linkId === pinningLinkId}
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

      <LinkPreviewModal preview={preview} onClose={() => setPreview(null)} />
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
}) => {
  const { token } = theme.useToken();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { busyLinkId, preview, setPreview, openPreview, downloadItem } = useLinkFileActions();
  const quickItems = useMemo(() => selectQuickItems(items, quickLimit), [items, quickLimit]);
  const hiddenCount = Math.max(items.length - quickItems.length, 0);

  if (!loading && !error && items.length === 0) return null;

  const openDrawer = () => {
    setPopoverOpen(false);
    setDrawerOpen(true);
  };

  const handlePreview = (item: LinkDisplayItem) => {
    setPopoverOpen(false);
    openPreview(item);
  };

  const handleDownload = (item: LinkDisplayItem) => {
    setPopoverOpen(false);
    downloadItem(item);
  };

  const closePopover = () => setPopoverOpen(false);

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
              onNavigate={closePopover}
              busy={item.linkId === busyLinkId}
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
        <Tooltip title="Links">
          <Badge count={items.length || 0} color={token.colorPrimary} size="small" offset={[-4, 4]}>
            <Button
              type="text"
              aria-label="Links"
              loading={loading}
              icon={<LinkOutlined style={{ color: token.colorPrimary }} />}
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
      />

      <LinkPreviewModal preview={preview} onClose={() => setPreview(null)} />
    </>
  );
};
