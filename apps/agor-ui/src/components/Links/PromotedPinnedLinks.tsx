import {
  BookOutlined,
  FileImageOutlined,
  FileTextOutlined,
  GithubOutlined,
  GlobalOutlined,
  LinkOutlined,
  PushpinFilled,
  StopOutlined,
} from '@ant-design/icons';
import { Button, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useThemedMessage } from '../../utils/message';
import {
  canDownloadLinkAttachment,
  canPreviewMarkdownLinkAttachment,
  type LinkAttachmentTarget,
  targetForLinkAttachment,
} from './LinkAttachmentCard';
import { LinkImagePreviewModal, type LinkImagePreviewTarget } from './LinkImagePreviewModal';
import {
  LinkMarkdownPreviewModal,
  type LinkMarkdownPreviewTarget,
} from './LinkMarkdownPreviewModal';
import { downloadLinkContent, getSafeLinkContentLabel } from './linkContent';

export interface PromotedPinnedLinkItem {
  key: string;
  name: string;
  url?: string | null;
  refUri?: string | null;
  filePath?: string | null;
  mimeType?: string | null;
  linkId?: string | null;
  kind?: string | null;
  source?: string | null;
  disabled?: boolean;
  note?: string | null;
}

interface PromotedPinnedLinksProps {
  items: PromotedPinnedLinkItem[];
  max?: number;
  variant?: 'session-header' | 'branch-card';
  overflowLabel?: string;
  onOverflow?: () => void;
  onOpenTarget?: (target: LinkAttachmentTarget) => void;
  empty?: React.ReactNode;
  'data-testid'?: string;
}

function canPreviewImage(item: PromotedPinnedLinkItem): boolean {
  return (
    item.kind === 'image' && item.source === 'upload' && Boolean(item.linkId) && !item.disabled
  );
}

function canPreviewMarkdown(item: PromotedPinnedLinkItem): boolean {
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

function canDownloadFile(item: PromotedPinnedLinkItem): boolean {
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

function disabledReasonForItem(item: PromotedPinnedLinkItem): string | null {
  if (item.disabled) return item.note || 'Preview/download unavailable';
  if (canPreviewImage(item)) return null;
  if (canPreviewMarkdown(item) || canDownloadFile(item)) return null;
  if (item.source === 'upload' || item.filePath || item.kind === 'image') {
    return item.note || 'Preview/download unavailable';
  }
  if (!targetForLinkAttachment({ url: item.url, refUri: item.refUri })) {
    return 'No safe route is available for this item yet.';
  }
  return null;
}

function getTargetDisplay(item: PromotedPinnedLinkItem): string {
  if (item.url) {
    try {
      const parsed = new URL(item.url);
      return `${parsed.hostname}${parsed.pathname}`;
    } catch {
      return item.url;
    }
  }
  if (item.refUri) return item.refUri;
  if (item.filePath) return getSafeLinkContentLabel(item.filePath) || item.name;
  return item.name;
}

function getIcon(item: PromotedPinnedLinkItem, disabled: boolean): React.ReactNode {
  if (disabled) return <StopOutlined />;
  if (item.kind === 'kb_ref' || item.refUri?.startsWith('agor://kb/')) return <BookOutlined />;
  if (item.kind === 'image') return <FileImageOutlined />;
  if (item.kind === 'document' || item.filePath) return <FileTextOutlined />;
  const target = item.url ?? item.refUri ?? '';
  try {
    const { hostname } = new URL(target);
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) return <GithubOutlined />;
  } catch {
    // ignore non-URL targets
  }
  return item.kind === 'url' ? <GlobalOutlined /> : <LinkOutlined />;
}

export const PromotedPinnedLinks: React.FC<PromotedPinnedLinksProps> = ({
  items,
  max = 3,
  variant = 'session-header',
  overflowLabel,
  onOverflow,
  onOpenTarget,
  empty = null,
  'data-testid': dataTestId,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { showError } = useThemedMessage();
  const [previewTarget, setPreviewTarget] = React.useState<LinkImagePreviewTarget | null>(null);
  const [markdownTarget, setMarkdownTarget] = React.useState<LinkMarkdownPreviewTarget | null>(
    null
  );

  if (items.length === 0) return <>{empty}</>;

  const visibleItems = items.slice(0, max);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);
  const isBranchCard = variant === 'branch-card';

  const openAttachmentTarget = (target: LinkAttachmentTarget) => {
    if (onOpenTarget) {
      onOpenTarget(target);
      return;
    }
    if (target.navigation === 'spa') {
      navigate(target.href);
      return;
    }
    window.open(target.href, '_blank', 'noopener,noreferrer');
  };

  const openItem = (item: PromotedPinnedLinkItem) => {
    if (canPreviewImage(item) && item.linkId) {
      setPreviewTarget({ linkId: item.linkId, title: item.name, subtitle: getTargetDisplay(item) });
      return;
    }
    if (canPreviewMarkdown(item) && item.linkId) {
      setMarkdownTarget({
        linkId: item.linkId,
        title: item.name,
        subtitle: getTargetDisplay(item),
      });
      return;
    }
    if (canDownloadFile(item) && item.linkId) {
      downloadLinkContent(item.linkId, item.name).catch((err) => {
        showError(err instanceof Error ? err.message : 'Download failed');
      });
      return;
    }
    const target = targetForLinkAttachment({ url: item.url, refUri: item.refUri });
    if (!target || disabledReasonForItem(item)) return;
    openAttachmentTarget(target);
  };

  const chipHeight = isBranchCard ? 22 : 26;
  const chipMaxWidth = isBranchCard ? 118 : 156;

  return (
    <>
      <div
        data-testid={dataTestId}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: token.sizeXXS,
          minWidth: 0,
          flexWrap: 'nowrap',
          overflow: 'hidden',
          maxWidth: isBranchCard ? '100%' : 500,
        }}
      >
        {visibleItems.map((item) => {
          const disabledReason = disabledReasonForItem(item);
          const disabled = Boolean(disabledReason);
          return (
            <Tooltip
              key={item.key}
              title={disabledReason ?? `${item.name} · ${getTargetDisplay(item)}`}
              mouseEnterDelay={0.45}
            >
              <button
                type="button"
                disabled={disabled}
                aria-label={
                  disabled ? `${item.name}: ${disabledReason}` : `Open pinned ${item.name}`
                }
                onClick={(event) => {
                  event.stopPropagation();
                  openItem(item);
                }}
                style={{
                  height: chipHeight,
                  minWidth: 0,
                  maxWidth: chipMaxWidth,
                  border: `1px solid ${disabled ? token.colorBorderSecondary : token.colorPrimaryBorder}`,
                  borderRadius: 999,
                  background: disabled ? token.colorFillQuaternary : token.colorPrimaryBg,
                  color: disabled ? token.colorTextDisabled : token.colorText,
                  cursor: disabled ? 'not-allowed' : canPreviewImage(item) ? 'zoom-in' : 'pointer',
                  padding: `0 ${token.paddingXS}px`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  font: 'inherit',
                  lineHeight: 1,
                  flex: '0 1 auto',
                }}
              >
                <PushpinFilled
                  style={{
                    color: disabled
                      ? token.colorTextDisabled
                      : isBranchCard
                        ? token.colorTextTertiary
                        : token.colorPrimary,
                    fontSize: isBranchCard ? 10 : 11,
                  }}
                />
                <span
                  style={{
                    width: 14,
                    color: disabled
                      ? token.colorTextDisabled
                      : isBranchCard
                        ? token.colorTextTertiary
                        : token.colorPrimary,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: '0 0 auto',
                  }}
                >
                  {getIcon(item, disabled)}
                </span>
                <Typography.Text
                  ellipsis
                  style={{
                    fontSize: isBranchCard ? 11 : 12,
                    maxWidth: chipMaxWidth - 50,
                    color: disabled
                      ? token.colorTextDisabled
                      : isBranchCard
                        ? token.colorTextSecondary
                        : token.colorText,
                  }}
                >
                  {item.name.replace(/^(Issue|PR|Knowledge|Saved URL):\s*/i, '')}
                </Typography.Text>
              </button>
            </Tooltip>
          );
        })}
        {hiddenCount > 0 && (
          <Tooltip
            title={
              overflowLabel ?? `${hiddenCount} more pinned link${hiddenCount === 1 ? '' : 's'}`
            }
          >
            <Button
              size="small"
              type="text"
              onClick={(event) => {
                event.stopPropagation();
                onOverflow?.();
              }}
              style={{
                height: chipHeight,
                minWidth: isBranchCard ? 30 : 34,
                padding: `0 ${token.paddingXXS}px`,
                borderRadius: 999,
                color: token.colorPrimary,
                flex: '0 0 auto',
              }}
            >
              +{hiddenCount}
            </Button>
          </Tooltip>
        )}
      </div>
      <LinkImagePreviewModal target={previewTarget} onClose={() => setPreviewTarget(null)} />
      <LinkMarkdownPreviewModal target={markdownTarget} onClose={() => setMarkdownTarget(null)} />
    </>
  );
};
