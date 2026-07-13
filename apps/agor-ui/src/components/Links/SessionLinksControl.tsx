import { PushpinFilled } from '@ant-design/icons';
import { Flex, Tooltip, Typography, theme } from 'antd';
import { useCallback, useState } from 'react';
import { useThemedMessage } from '../../utils/message';
import { ActionLinkRow } from './ActionLinkRow';
import { LinkPinAction } from './LinkActions';
import { LinkContentPreviewModal } from './LinkContentPreviewModal';
import { LinkCategoryGlyph } from './LinkVisual';
import {
  downloadLinkContent,
  getLinkContentAction,
  getLinkPreviewKind,
  type LinkPreviewKind,
} from './linkContent';
import {
  getCompactLinkDisplayName,
  getLinkDisplaySecondaryLabel,
  type LinkDisplayItem,
} from './linkDisplay';
import { getLinkPinActionLabel } from './linkPinning';

type PreviewState = {
  item: LinkDisplayItem;
  kind: LinkPreviewKind;
};

export function LinkRow({
  item,
  compact = false,
  onPreview,
  onDownload,
  onTogglePinned,
  pinning = false,
}: {
  item: LinkDisplayItem;
  compact?: boolean;
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
  const actionLabel = contentAction === 'preview' ? `Preview ${title}` : `Download ${title}`;

  return (
    <ActionLinkRow
      compact={compact}
      disabled={!isActionable}
      ariaLabel={item.href ? `Open ${title}` : actionLabel}
      href={item.href}
      navigation={item.navigation}
      onActivate={
        contentAction
          ? () => {
              if (contentAction === 'preview') onPreview?.(item);
              else onDownload?.(item);
            }
          : undefined
      }
      actions={
        canTogglePin ? (
          <LinkPinAction
            pinned={item.isPinned}
            ariaLabel={getLinkPinActionLabel(item)}
            loading={pinning}
            onToggle={() => onTogglePinned?.(item)}
          />
        ) : undefined
      }
    >
      <Flex component="span" align="center" gap="small" style={{ minWidth: 0, flex: 1 }}>
        <LinkCategoryGlyph category={item.category} variant="row-compact" />
        <Flex component="span" vertical style={{ minWidth: 0, flex: 1 }}>
          <Flex component="span" align="center" gap="small" style={{ minWidth: 0 }}>
            <Typography.Text
              ellipsis
              style={{
                minWidth: 0,
                flex: 1,
                lineHeight: 1.25,
                color: isActionable ? token.colorText : token.colorTextSecondary,
              }}
            >
              {title}
            </Typography.Text>
            {item.isPinned && !canTogglePin && (
              <Tooltip title="Pinned">
                <PushpinFilled style={{ color: token.colorWarning, fontSize: token.fontSizeSM }} />
              </Tooltip>
            )}
          </Flex>
          {!compact && targetLabel && (
            <Typography.Text
              type="secondary"
              ellipsis
              style={{ lineHeight: 1.2, fontSize: token.fontSizeSM }}
            >
              {targetLabel}
            </Typography.Text>
          )}
        </Flex>
      </Flex>
    </ActionLinkRow>
  );
}

export function useLinkFileActions(navigate?: (href: string) => void) {
  const { showError } = useThemedMessage();
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const openPreview = useCallback((item: LinkDisplayItem) => {
    const kind = getLinkPreviewKind(item);
    if (!kind) return;
    setPreview({ item, kind });
  }, []);

  const downloadItem = useCallback(
    async (item: LinkDisplayItem) => {
      if (!item.linkId) return;
      try {
        await downloadLinkContent(item.linkId, getCompactLinkDisplayName(item));
      } catch (error) {
        showError(error instanceof Error ? error.message : 'Failed to download file');
      }
    },
    [showError]
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
        if (navigate) navigate(item.href);
        else window.location.assign(item.href);
        return;
      }
      if (item.href) window.open(item.href, '_blank', 'noopener,noreferrer');
    },
    [downloadItem, navigate, openPreview]
  );

  return { preview, setPreview, openPreview, downloadItem, openItem };
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
  return <LinkContentPreviewModal target={target} kind={preview.kind} onClose={onClose} />;
}
