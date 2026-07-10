import type { LinkKind, LinkSource } from '@agor-live/client';
import { DownloadOutlined } from '@ant-design/icons';
import { Button, Flex, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useThemedMessage } from '../../utils/message';
import type { LinkImagePreviewTarget } from './LinkImagePreviewModal';
import { LinkImageThumbnail } from './LinkImageThumbnail';
import { getLinkCategoryIcon, getLinkCategoryLabel } from './LinkVisual';
import {
  downloadLinkContent,
  getLinkContentAction,
  getLinkPreviewKind,
  getLinkUnavailableReason,
  getSafeLinkContentLabel,
  type LinkContentItem,
} from './linkContent';
import {
  getLinkDisplayCategory,
  type LinkDisplayCategory,
  type LinkDisplayTarget,
  targetForLinkDisplay,
} from './linkDisplay';
import styles from './linkUi.module.css';

export type LinkAttachmentTarget = LinkDisplayTarget;

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
  disabledReason?: string | null;
  compact?: boolean;
  onDark?: boolean;
  imageThumbnail?: boolean;
  onOpenImage?: (target: LinkImagePreviewTarget) => void;
  onOpenMarkdown?: (target: LinkImagePreviewTarget) => void;
  onOpenTarget?: (target: LinkAttachmentTarget) => void;
}

type AttachmentCategory = LinkDisplayCategory;

export function targetForLinkAttachment(args: {
  url?: string | null;
  refUri?: string | null;
}): LinkAttachmentTarget | null {
  return targetForLinkDisplay(args);
}

function inferLinkAttachmentCategory(args: {
  kind?: LinkKind | string | null;
  mimeType?: string | null;
  title?: string | null;
  filePath?: string | null;
  refUri?: string | null;
}): AttachmentCategory {
  return getLinkDisplayCategory(args);
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
  const category = inferLinkAttachmentCategory({ kind, mimeType, title, filePath, refUri });
  const dimension = size === 'sm' ? 28 : 38;
  return (
    <span
      className={`${styles.glyph} ${styles.glyphStacked} ${onDark ? styles.onDarkGlyph : ''}`}
      aria-hidden
      style={{
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
        <span className={styles.glyphLabelSmall}>{getLinkCategoryLabel(category)}</span>
      ) : (
        <>
          <span className={styles.glyphIcon}>{getLinkCategoryIcon(category, disabled)}</span>
          <span className={styles.glyphLabel}>{getLinkCategoryLabel(category)}</span>
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
  onOpenImage,
  onOpenMarkdown,
  onOpenTarget,
}) => {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const target = targetForLinkAttachment({ url, refUri });
  const contentItem: LinkContentItem = {
    category: inferLinkAttachmentCategory({ kind, mimeType, title, filePath, refUri }),
    source: source === 'upload' ? 'upload' : undefined,
    linkId: linkId ?? undefined,
    filePath: filePath ?? undefined,
    kind: kind ?? undefined,
    href: target?.href,
  };
  const previewKind = disabledReason ? null : getLinkPreviewKind(contentItem);
  const contentAction = disabledReason ? null : getLinkContentAction(contentItem);
  const canPreviewImage = previewKind === 'image';
  const canPreviewMarkdown = previewKind === 'markdown' || previewKind === 'text';
  const canDownload = contentAction === 'download';
  const reason = disabledReason ?? getLinkUnavailableReason(contentItem);
  const disabled = Boolean(reason);
  const description = getSafeLinkContentLabel(subtitle ?? refUri ?? url ?? filePath);

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

  const open = (event: React.MouseEvent<HTMLElement>) => {
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
        className={styles.attachmentButton}
        type="text"
        block
        disabled={disabled}
        aria-label={disabled ? `${title}: ${reason}` : `Open ${title}`}
        onClick={open}
        style={{
          width: compact ? '100%' : 'min(100%, 360px)',
          border: `1px solid ${borderColor}`,
          borderRadius: token.borderRadiusLG,
          background: disabled ? token.colorFillQuaternary : surfaceColor,
          color: textColor,
          cursor: disabled ? 'not-allowed' : canPreviewImage ? 'zoom-in' : 'pointer',
          padding: compact ? `${token.paddingXXS + 2}px ${token.paddingXS}px` : token.paddingSM,
        }}
      >
        <Flex component="span" className={styles.fullWidth} align="center" gap="small">
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
          <span className={styles.attachmentContent}>
            <Typography.Text
              className={styles.blockText}
              strong={!compact}
              ellipsis
              style={{
                color: disabled ? token.colorTextSecondary : textColor,
                fontSize: compact ? token.fontSizeSM : undefined,
              }}
            >
              {title}
            </Typography.Text>
            {description && (
              <Typography.Text
                className={`${styles.blockText} ${onDark ? styles.onDarkSecondary : ''}`}
                ellipsis
                style={{
                  color: onDark ? textColor : token.colorTextSecondary,
                  fontSize: token.fontSizeSM,
                }}
              >
                {description}
              </Typography.Text>
            )}
            {reason && (
              <Typography.Text
                className={`${styles.blockText} ${onDark ? styles.onDarkTertiary : ''}`}
                ellipsis
                style={{
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
                className={styles.downloadIndicator}
                aria-hidden
                style={{
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
