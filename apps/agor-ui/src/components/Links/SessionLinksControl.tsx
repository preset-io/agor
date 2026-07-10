import { GithubOutlined, PushpinFilled } from '@ant-design/icons';
import { Flex, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useThemedMessage } from '../../utils/message';
import { LinkPinAction } from './LinkActions';
import { LinkImagePreviewModal } from './LinkImagePreviewModal';
import { LinkMarkdownPreviewModal } from './LinkMarkdownPreviewModal';
import {
  downloadLinkContent,
  getLinkContentAction,
  getLinkPreviewKind,
  type LinkPreviewKind,
} from './linkContent';
import {
  getCompactLinkDisplayName,
  getLinkDisplayGlyphLabel,
  getLinkDisplaySecondaryLabel,
  type LinkDisplayItem,
} from './linkDisplay';

type PreviewState = {
  item: LinkDisplayItem;
  kind: LinkPreviewKind;
};

function LinkGlyph({ item }: { item: LinkDisplayItem }) {
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
  pinning?: boolean;
}) {
  const { token } = theme.useToken();
  const title = getCompactLinkDisplayName(item);
  const targetLabel = getLinkDisplaySecondaryLabel(item);
  const contentAction = getLinkContentAction(item);
  const canTogglePin = Boolean(item.linkId && onTogglePinned);
  const isActionable = Boolean(item.href || contentAction);
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
  const linkBody = (
    <Flex align="center" gap="small" style={{ minWidth: 0 }}>
      <LinkGlyph item={item} />
      <Flex vertical style={{ minWidth: 0, flex: 1 }}>
        <Flex align="center" gap="small" style={{ minWidth: 0 }}>
          <Typography.Text
            ellipsis
            style={{
              color: isActionable ? token.colorText : token.colorTextSecondary,
              lineHeight: 1.25,
              flex: 1,
            }}
          >
            {title}
          </Typography.Text>
          {item.isPinned && !canTogglePin && (
            <Tooltip title="Pinned">
              <PushpinFilled style={{ color: token.colorWarning, fontSize: 11 }} />
            </Tooltip>
          )}
        </Flex>
        {!compact && targetLabel && (
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, lineHeight: 1.2 }}>
            {targetLabel}
          </Typography.Text>
        )}
      </Flex>
    </Flex>
  );
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
      >
        {linkBody}
      </button>
    ) : (
      <span aria-disabled style={nonNavigableStyle}>
        {linkBody}
      </span>
    );

  return (
    <Flex
      align="center"
      gap="small"
      aria-disabled={isActionable ? undefined : true}
      style={{
        minWidth: 0,
        width: inline ? 'auto' : '100%',
        borderRadius: token.borderRadiusSM,
        padding: compact
          ? `${token.sizeUnit}px ${token.sizeUnit * 1.5}px`
          : `${token.sizeUnit}px 0`,
      }}
    >
      {mainTarget}
      {canTogglePin && (
        <LinkPinAction
          pinned={item.isPinned}
          label={`${getPinActionLabel(item)} ${title}`}
          loading={pinning}
          onToggle={() => onTogglePinned?.(item)}
        />
      )}
    </Flex>
  );
}

export function useLinkFileActions() {
  const { showError } = useThemedMessage();
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const openPreview = (item: LinkDisplayItem) => {
    const kind = getLinkPreviewKind(item);
    if (!kind) return;
    setPreview({ item, kind });
  };

  const downloadItem = async (item: LinkDisplayItem) => {
    if (!item.linkId) return;
    try {
      await downloadLinkContent(item.linkId, getCompactLinkDisplayName(item));
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to download file');
    }
  };

  return { preview, setPreview, openPreview, downloadItem };
}

export function LinkPreviewModal({
  preview,
  onClose,
}: {
  preview: PreviewState | null;
  onClose: () => void;
}) {
  if (!preview?.item.linkId) return null;
  const target = {
    linkId: preview.item.linkId,
    title: getCompactLinkDisplayName(preview.item),
    subtitle: getLinkDisplaySecondaryLabel(preview.item),
  };
  return preview.kind === 'image' ? (
    <LinkImagePreviewModal target={target} onClose={onClose} />
  ) : (
    <LinkMarkdownPreviewModal
      target={target}
      plainText={preview.kind === 'text'}
      onClose={onClose}
    />
  );
}
