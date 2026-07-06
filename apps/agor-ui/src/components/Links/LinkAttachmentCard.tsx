import { getSafeWebUrl, type LinkKind, type LinkSource } from '@agor-live/client';
import {
  BookOutlined,
  CodeOutlined,
  DownloadOutlined,
  FileExcelOutlined,
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import { Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { buildKnowledgeRoutePath } from '../../utils/knowledgeRoutes';
import { useThemedMessage } from '../../utils/message';
import type { LinkImagePreviewTarget } from './LinkImagePreviewModal';
import { LinkImageThumbnail } from './LinkImageThumbnail';
import { downloadLinkContent, getSafeLinkContentLabel } from './linkContent';

export interface LinkAttachmentTarget {
  href: string;
  navigation: 'spa' | 'external';
}

export interface LinkAttachmentCardProps {
  kind?: LinkKind | null;
  source?: LinkSource | 'branch' | 'fixture' | string | null;
  linkId?: string | null;
  title: string;
  subtitle?: string | null;
  url?: string | null;
  refUri?: string | null;
  filePath?: string | null;
  mimeType?: string | null;
  ownerLabel?: string | null;
  stateLabel?: string | null;
  disabledReason?: string | null;
  compact?: boolean;
  onDark?: boolean;
  imageThumbnail?: boolean;
  onOpenImage?: (target: LinkImagePreviewTarget) => void;
  onOpenMarkdown?: (target: LinkImagePreviewTarget) => void;
  onOpenTarget?: (target: LinkAttachmentTarget) => void;
  actions?: React.ReactNode;
}

type AttachmentCategory =
  | 'knowledge'
  | 'image'
  | 'pdf'
  | 'spreadsheet'
  | 'csv'
  | 'document'
  | 'markdown'
  | 'text'
  | 'code'
  | 'json'
  | 'log'
  | 'unknown';

const KNOWLEDGE_PREFIX = 'agor://kb/';

const extensionFromPath = (value?: string | null): string => {
  const cleaned = (value ?? '').split(/[?#]/)[0]?.split('/').pop() ?? '';
  const dot = cleaned.lastIndexOf('.');
  return dot >= 0 ? cleaned.slice(dot + 1).toLowerCase() : '';
};

export function routeForKnowledgeUri(uri?: string | null, basePath = '/kb'): string | null {
  if (!uri?.startsWith(KNOWLEDGE_PREFIX)) return null;
  const rest = uri.slice(KNOWLEDGE_PREFIX.length);
  const [namespaceSlug, ...pathParts] = rest.split('/').filter(Boolean);
  if (!namespaceSlug || namespaceSlug === 'document') return null;
  return buildKnowledgeRoutePath(basePath, namespaceSlug, pathParts.join('/'));
}

export function targetForLinkAttachment(args: {
  url?: string | null;
  refUri?: string | null;
}): LinkAttachmentTarget | null {
  if (args.refUri?.startsWith(KNOWLEDGE_PREFIX)) {
    const route = routeForKnowledgeUri(args.refUri);
    return route ? { href: route, navigation: 'spa' } : null;
  }
  const safeUrl = getSafeWebUrl(args.url);
  if (safeUrl) return { href: safeUrl, navigation: 'external' };
  return null;
}

export function canUseLinkContentRoute(args: {
  source?: LinkSource | 'branch' | 'fixture' | string | null;
  linkId?: string | null;
  filePath?: string | null;
}): boolean {
  return args.source === 'upload' && Boolean(args.linkId) && Boolean(args.filePath);
}

export function inferLinkAttachmentCategory(args: {
  kind?: LinkKind | string | null;
  mimeType?: string | null;
  title?: string | null;
  filePath?: string | null;
  refUri?: string | null;
}): AttachmentCategory {
  if (args.kind === 'kb_ref' || args.refUri?.startsWith(KNOWLEDGE_PREFIX)) return 'knowledge';
  if (args.kind === 'image' || args.mimeType?.startsWith('image/')) return 'image';

  const mime = args.mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const ext = extensionFromPath(args.filePath) || extensionFromPath(args.title);

  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime === 'text/csv' || ['csv', 'tsv'].includes(ext)) return 'csv';
  if (
    mime.includes('spreadsheet') ||
    mime.includes('excel') ||
    ['xls', 'xlsx', 'ods'].includes(ext)
  ) {
    return 'spreadsheet';
  }
  if (
    mime.includes('wordprocessingml') ||
    mime === 'application/msword' ||
    ['doc', 'docx', 'rtf', 'odt'].includes(ext)
  ) {
    return 'document';
  }
  if (mime === 'application/json' || ext === 'json') return 'json';
  if (ext === 'log') return 'log';
  if (['md', 'markdown'].includes(ext) || mime === 'text/markdown') return 'markdown';
  if (mime.startsWith('text/') || ['txt', 'adoc', 'rst'].includes(ext)) return 'text';
  if (
    [
      'js',
      'jsx',
      'ts',
      'tsx',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'c',
      'cc',
      'cpp',
      'h',
      'hpp',
      'css',
      'scss',
      'html',
      'xml',
      'yaml',
      'yml',
      'toml',
      'sql',
      'sh',
      'zsh',
    ].includes(ext)
  ) {
    return 'code';
  }
  return 'unknown';
}

export function canPreviewMarkdownLinkAttachment(args: {
  source?: LinkSource | 'branch' | 'fixture' | string | null;
  linkId?: string | null;
  kind?: LinkKind | string | null;
  mimeType?: string | null;
  title?: string | null;
  filePath?: string | null;
  refUri?: string | null;
}): boolean {
  const category = inferLinkAttachmentCategory(args);
  return canUseLinkContentRoute(args) && (category === 'markdown' || category === 'text');
}

export function canDownloadLinkAttachment(args: {
  source?: LinkSource | 'branch' | 'fixture' | string | null;
  linkId?: string | null;
  filePath?: string | null;
}): boolean {
  return canUseLinkContentRoute(args);
}

function visualForCategory(category: AttachmentCategory) {
  switch (category) {
    case 'knowledge':
      return { label: 'KB', color: '#722ed1', icon: <BookOutlined /> };
    case 'image':
      return { label: 'IMG', color: '#1677ff', icon: <FileImageOutlined /> };
    case 'pdf':
      return { label: 'PDF', color: '#cf1322', icon: <FilePdfOutlined /> };
    case 'spreadsheet':
      return { label: 'XLS', color: '#389e0d', icon: <FileExcelOutlined /> };
    case 'csv':
      return { label: 'CSV', color: '#389e0d', icon: <FileExcelOutlined /> };
    case 'document':
      return { label: 'DOC', color: '#0958d9', icon: <FileTextOutlined /> };
    case 'markdown':
      return { label: 'MD', color: '#531dab', icon: <FileTextOutlined /> };
    case 'text':
      return { label: 'TXT', color: '#531dab', icon: <FileTextOutlined /> };
    case 'json':
      return { label: 'JSON', color: '#d46b08', icon: <CodeOutlined /> };
    case 'log':
      return { label: 'LOG', color: '#ad6800', icon: <FileTextOutlined /> };
    case 'code':
      return { label: 'CODE', color: '#08979c', icon: <CodeOutlined /> };
    default:
      return { label: 'FILE', color: '#595959', icon: <FileOutlined /> };
  }
}

export function getLinkAttachmentKindLabel(args: {
  kind?: LinkKind | string | null;
  mimeType?: string | null;
  title?: string | null;
  filePath?: string | null;
  refUri?: string | null;
}): string {
  const category = inferLinkAttachmentCategory(args);
  return visualForCategory(category).label;
}

export const LinkAttachmentGlyph: React.FC<{
  kind?: LinkKind | string | null;
  mimeType?: string | null;
  title?: string | null;
  filePath?: string | null;
  refUri?: string | null;
  disabled?: boolean;
  onDark?: boolean;
  size?: 'sm' | 'md';
}> = ({
  kind,
  mimeType,
  title,
  filePath,
  refUri,
  disabled = false,
  onDark = false,
  size = 'md',
}) => {
  const { token } = theme.useToken();
  const visual = visualForCategory(
    inferLinkAttachmentCategory({ kind, mimeType, title, filePath, refUri })
  );
  const dimension = size === 'sm' ? 28 : 38;
  return (
    <span
      aria-hidden
      style={{
        width: dimension,
        height: dimension,
        borderRadius: token.borderRadiusLG,
        background: 'transparent',
        color: onDark
          ? 'rgba(255, 255, 255, 0.78)'
          : disabled
            ? token.colorTextSecondary
            : token.colorTextTertiary,
        border: `1px solid ${onDark ? 'rgba(255, 255, 255, 0.26)' : token.colorBorderSecondary}`,
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        flex: '0 0 auto',
      }}
    >
      {size === 'sm' ? (
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.2 }}>{visual.label}</span>
      ) : (
        <>
          <span style={{ fontSize: 15 }}>{visual.icon}</span>
          <span style={{ fontSize: 9, fontWeight: 700, marginTop: 3 }}>{visual.label}</span>
        </>
      )}
    </span>
  );
};

export const LinkAttachmentCard: React.FC<LinkAttachmentCardProps> = ({
  kind,
  source,
  linkId,
  title,
  subtitle,
  url,
  refUri,
  filePath,
  mimeType,
  ownerLabel,
  stateLabel,
  disabledReason,
  compact = false,
  onDark = false,
  imageThumbnail = false,
  onOpenImage,
  onOpenMarkdown,
  onOpenTarget,
  actions,
}) => {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const target = targetForLinkAttachment({ url, refUri });
  const canPreviewImage =
    kind === 'image' && source === 'upload' && Boolean(linkId) && !disabledReason;
  const canPreviewMarkdown =
    canPreviewMarkdownLinkAttachment({ source, linkId, kind, mimeType, title, filePath, refUri }) &&
    !disabledReason;
  const canDownload =
    canDownloadLinkAttachment({ source, linkId, filePath }) &&
    !canPreviewImage &&
    !canPreviewMarkdown;
  const disabled =
    Boolean(disabledReason) || (!canPreviewImage && !canPreviewMarkdown && !canDownload && !target);
  const reason =
    disabledReason ??
    (!target && !canPreviewImage && !canPreviewMarkdown && !canDownload
      ? 'Preview/download unavailable'
      : null);
  const description = getSafeLinkContentLabel(subtitle ?? refUri ?? url ?? filePath);
  const metaParts = [ownerLabel, stateLabel, reason].filter(Boolean).join(' · ');

  if (imageThumbnail && canPreviewImage && linkId && onOpenImage) {
    return (
      <LinkImageThumbnail
        linkId={linkId}
        title={title}
        subtitle={description}
        onOpen={onOpenImage}
      />
    );
  }

  const open = (event: React.MouseEvent | React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    if (canPreviewImage && linkId && onOpenImage) {
      onOpenImage({ linkId, title, subtitle: description });
      return;
    }
    if (canPreviewMarkdown && linkId && onOpenMarkdown) {
      onOpenMarkdown({ linkId, title, subtitle: description });
      return;
    }
    if (target) onOpenTarget?.(target);
    if (canDownload && linkId) {
      downloadLinkContent(linkId, title).catch((err) => {
        showError(err instanceof Error ? err.message : 'Download failed');
      });
    }
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLButtonElement> = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    open(event);
  };

  return (
    <Tooltip title={reason ?? description ?? title} mouseEnterDelay={0.6}>
      <button
        type="button"
        disabled={disabled}
        aria-label={disabled ? `${title}: ${reason}` : `Open ${title}`}
        onClick={open}
        onKeyDown={onKeyDown}
        style={{
          width: compact ? '100%' : 'min(100%, 360px)',
          maxWidth: '100%',
          border: `1px solid ${
            onDark
              ? 'rgba(255, 255, 255, 0.16)'
              : disabled
                ? token.colorBorderSecondary
                : token.colorBorder
          }`,
          borderRadius: token.borderRadiusLG,
          background: onDark
            ? 'rgba(255, 255, 255, 0.09)'
            : disabled
              ? token.colorFillQuaternary
              : token.colorBgContainer,
          color: onDark ? 'rgba(255, 255, 255, 0.92)' : token.colorText,
          cursor: disabled ? 'not-allowed' : canPreviewImage ? 'zoom-in' : 'pointer',
          padding: compact ? `${token.paddingXXS + 2}px ${token.paddingXS}px` : token.paddingSM,
          font: 'inherit',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: token.sizeSM,
          opacity: 1,
        }}
      >
        <LinkAttachmentGlyph
          kind={kind}
          mimeType={mimeType}
          title={title}
          filePath={filePath}
          refUri={refUri}
          disabled={disabled}
          onDark={onDark}
          size={compact ? 'sm' : 'md'}
        />
        <span style={{ minWidth: 0, flex: 1 }}>
          <Typography.Text
            strong={!compact}
            ellipsis
            style={{
              display: 'block',
              color: onDark
                ? 'rgba(255, 255, 255, 0.94)'
                : disabled
                  ? token.colorTextSecondary
                  : token.colorText,
              fontSize: compact ? 13 : undefined,
              minWidth: 0,
            }}
          >
            {title}
          </Typography.Text>
          {description && (
            <Typography.Text
              ellipsis
              style={{
                display: 'block',
                color: onDark ? 'rgba(255, 255, 255, 0.62)' : token.colorTextSecondary,
                fontSize: compact ? 11 : 12,
              }}
            >
              {description}
            </Typography.Text>
          )}
          {metaParts && (
            <Typography.Text
              ellipsis
              style={{
                display: 'block',
                marginTop: compact ? 0 : 4,
                color: onDark ? 'rgba(255, 255, 255, 0.58)' : token.colorTextTertiary,
                fontSize: 11,
              }}
            >
              {metaParts}
            </Typography.Text>
          )}
        </span>
        {(canDownload || actions) && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: token.sizeXXS }}>
            {canDownload && linkId && (
              <Tooltip title="Download file">
                <span
                  aria-hidden
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 999,
                    color: onDark ? 'rgba(255, 255, 255, 0.78)' : token.colorTextSecondary,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    flex: '0 0 auto',
                  }}
                >
                  <DownloadOutlined />
                </span>
              </Tooltip>
            )}
            {actions && <span onClick={(event) => event.stopPropagation()}>{actions}</span>}
          </span>
        )}
      </button>
    </Tooltip>
  );
};
