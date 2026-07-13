import type { LinkKind } from '@agor-live/client';
import { DownloadOutlined } from '@ant-design/icons';
import { Button, Flex, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useThemedMessage } from '../../utils/message';
import type { LinkPreviewTarget } from './LinkContentPreviewModal';
import { LinkImageThumbnail } from './LinkImageThumbnail';
import { getLinkCategoryIcon } from './LinkVisual';
import {
  downloadLinkContent,
  getLinkContentAction,
  getLinkPreviewKind,
  getLinkUnavailableReason,
  getSafeLinkContentLabel,
  type LinkContentItem,
  type LinkPreviewKind,
} from './linkContent';
import {
  getLinkDisplayCategory,
  getLinkDisplayGlyphLabel,
  type LinkDisplayTarget,
  targetForLinkDisplay,
} from './linkDisplay';

export type LinkAttachmentTarget = LinkDisplayTarget;

export interface LinkAttachmentCardProps {
  kind?: LinkKind | null;
  source?: string | null;
  linkId?: string | null;
  title: string;
  subtitle?: string | null;
  url?: string | null;
  refUri?: string | null;
  filePath?: string | null;
  mimeType?: string | null;
  disabledReason?: string | null;
  compact?: boolean;
  onDark?: boolean;
  imageThumbnail?: boolean;
  onOpenPreview?: (target: LinkPreviewTarget, kind: LinkPreviewKind) => void;
  onOpenTarget?: (target: LinkAttachmentTarget) => void;
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
  const category = getLinkDisplayCategory({ kind, mimeType, title, filePath, refUri });
  const dimension = size === 'sm' ? 28 : 38;
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        flex: '0 0 auto',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        flexDirection: 'column',
        opacity: onDark ? 0.78 : undefined,
        width: dimension,
        height: dimension,
        borderRadius: token.borderRadiusLG,
        color: onDark
          ? token.colorTextLightSolid
          : disabled
            ? token.colorTextSecondary
            : token.colorTextTertiary,
        border: `1px solid ${
          onDark
            ? `color-mix(in srgb, ${token.colorTextLightSolid} 26%, transparent)`
            : token.colorBorderSecondary
        }`,
      }}
    >
      {size === 'sm' ? (
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.2 }}>
          {getLinkDisplayGlyphLabel(category)}
        </span>
      ) : (
        <>
          <span style={{ fontSize: 15 }}>{getLinkCategoryIcon(category, disabled)}</span>
          <span style={{ marginTop: 3, fontSize: 9, fontWeight: 700 }}>
            {getLinkDisplayGlyphLabel(category)}
          </span>
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
  disabledReason,
  compact = false,
  onDark = false,
  imageThumbnail = false,
  onOpenPreview,
  onOpenTarget,
}) => {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const target = targetForLinkDisplay({ url, refUri });
  const contentItem: LinkContentItem = {
    category: getLinkDisplayCategory({ kind, mimeType, title, filePath, refUri }),
    source: source === 'upload' ? 'upload' : undefined,
    linkId: linkId ?? undefined,
    filePath: filePath ?? undefined,
    mimeType: mimeType ?? undefined,
    kind: kind ?? undefined,
    href: target?.href,
  };
  const previewKind = disabledReason ? null : getLinkPreviewKind(contentItem);
  const contentAction = disabledReason ? null : getLinkContentAction(contentItem);
  const canPreviewImage = previewKind === 'image';
  const canDownload = contentAction === 'download';
  const reason = disabledReason ?? getLinkUnavailableReason(contentItem);
  const disabled = Boolean(reason);
  const description = getSafeLinkContentLabel(subtitle ?? refUri ?? url ?? filePath);

  if (imageThumbnail && canPreviewImage && linkId && onOpenPreview) {
    return (
      <LinkImageThumbnail
        linkId={linkId}
        title={title}
        subtitle={description}
        onOpen={(target) => onOpenPreview(target, 'image')}
      />
    );
  }

  const open = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;
    if (previewKind && linkId && onOpenPreview) {
      onOpenPreview({ linkId, title, subtitle: description }, previewKind);
      return;
    }
    if (target) onOpenTarget?.(target);
    if (canDownload && linkId) {
      downloadLinkContent(linkId, title).catch((err) => {
        showError(err instanceof Error ? err.message : 'Download failed');
      });
    }
  };

  const surfaceColor = onDark
    ? `color-mix(in srgb, ${token.colorTextLightSolid} 9%, transparent)`
    : token.colorBgContainer;
  const textColor = onDark ? token.colorTextLightSolid : token.colorText;
  const borderColor = onDark
    ? `color-mix(in srgb, ${token.colorTextLightSolid} 16%, transparent)`
    : disabled
      ? token.colorBorderSecondary
      : token.colorBorder;

  return (
    <Tooltip title={reason ?? description ?? title} mouseEnterDelay={0.6}>
      <Button
        type="text"
        block
        disabled={disabled}
        aria-label={disabled ? `${title}: ${reason}` : `Open ${title}`}
        onClick={open}
        style={{
          display: 'flex',
          height: 'auto',
          maxWidth: '100%',
          alignItems: 'center',
          justifyContent: 'flex-start',
          font: 'inherit',
          textAlign: 'left',
          width: compact ? '100%' : 'min(100%, 360px)',
          border: `1px solid ${borderColor}`,
          borderRadius: token.borderRadiusLG,
          background: disabled ? token.colorFillQuaternary : surfaceColor,
          color: textColor,
          cursor: disabled ? 'not-allowed' : canPreviewImage ? 'zoom-in' : 'pointer',
          padding: compact ? `${token.paddingXXS + 2}px ${token.paddingXS}px` : token.paddingSM,
        }}
      >
        <Flex component="span" align="center" gap="small" style={{ width: '100%' }}>
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
          <span
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr)',
              minWidth: 0,
              flex: 1,
            }}
          >
            <Typography.Text
              strong={!compact}
              ellipsis
              style={{
                display: 'block',
                color: disabled ? token.colorTextSecondary : textColor,
                fontSize: compact ? token.fontSizeSM : undefined,
              }}
            >
              {title}
            </Typography.Text>
            {description && (
              <Typography.Text
                ellipsis
                style={{
                  display: 'block',
                  opacity: onDark ? 0.68 : undefined,
                  color: onDark ? textColor : token.colorTextSecondary,
                  fontSize: token.fontSizeSM,
                }}
              >
                {description}
              </Typography.Text>
            )}
            {reason && (
              <Typography.Text
                ellipsis
                style={{
                  display: 'block',
                  opacity: onDark ? 0.58 : undefined,
                  marginTop: compact ? 0 : token.sizeXXS,
                  color: onDark ? textColor : token.colorTextTertiary,
                  fontSize: token.fontSizeSM,
                }}
              >
                {reason}
              </Typography.Text>
            )}
          </span>
          {canDownload && linkId && (
            <Tooltip title="Download file">
              <span
                aria-hidden
                style={{
                  display: 'inline-flex',
                  flex: '0 0 auto',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: token.controlHeightSM,
                  height: token.controlHeightSM,
                  color: onDark ? textColor : token.colorTextSecondary,
                }}
              >
                <DownloadOutlined />
              </span>
            </Tooltip>
          )}
        </Flex>
      </Button>
    </Tooltip>
  );
};
