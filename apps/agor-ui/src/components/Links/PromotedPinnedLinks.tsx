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
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { getLinkContentAction, getLinkUnavailableReason } from './linkContent';
import {
  getCompactLinkDisplayName,
  getLinkDisplaySecondaryLabel,
  type LinkDisplayItem,
} from './linkDisplay';
import { LinkPreviewModal, useLinkFileActions } from './SessionLinksControl';

export type PromotedPinnedLinkItem = LinkDisplayItem;

interface PromotedPinnedLinksProps {
  items: PromotedPinnedLinkItem[];
  onOverflow?: () => void;
  'data-testid'?: string;
}

function getTargetDisplay(item: PromotedPinnedLinkItem): string {
  return getLinkDisplaySecondaryLabel(item) || getCompactLinkDisplayName(item);
}

function getIcon(item: PromotedPinnedLinkItem, disabled: boolean): React.ReactNode {
  if (disabled) return <StopOutlined />;
  if (item.category === 'knowledge') return <BookOutlined />;
  if (item.category === 'image') return <FileImageOutlined />;
  if (['issue', 'pr'].includes(item.category)) return <GithubOutlined />;
  if (item.category === 'url') return <GlobalOutlined />;
  if (item.filePath) return <FileTextOutlined />;
  return <LinkOutlined />;
}

export const PromotedPinnedLinks: React.FC<PromotedPinnedLinksProps> = ({
  items,
  onOverflow,
  'data-testid': dataTestId,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { preview, setPreview, openPreview, downloadItem } = useLinkFileActions();

  if (items.length === 0) return null;

  const visibleItems = items.slice(0, 3);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);

  const openItem = (item: PromotedPinnedLinkItem) => {
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
      navigate(item.href);
      return;
    }
    if (item.href) window.open(item.href, '_blank', 'noopener,noreferrer');
  };

  const chipHeight = 26;
  const chipMaxWidth = 156;

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
          maxWidth: 500,
        }}
      >
        {visibleItems.map((item) => {
          const disabledReason = getLinkUnavailableReason(item);
          const disabled = Boolean(disabledReason);
          return (
            <Tooltip
              key={item.key}
              title={
                disabledReason ?? `${getCompactLinkDisplayName(item)} · ${getTargetDisplay(item)}`
              }
              mouseEnterDelay={0.45}
            >
              <button
                className="agor-action-link-chip"
                type="button"
                disabled={disabled}
                aria-label={
                  disabled ? `${item.name}: ${disabledReason}` : `Open pinned ${item.name}`
                }
                onClick={(event) => {
                  event.stopPropagation();
                  openItem(item);
                }}
                style={
                  {
                    '--agor-link-chip-bg': disabled
                      ? token.colorFillQuaternary
                      : token.colorPrimaryBg,
                    '--agor-link-chip-border': disabled
                      ? token.colorBorderSecondary
                      : token.colorPrimaryBorder,
                    '--agor-link-chip-color': disabled ? token.colorTextDisabled : token.colorText,
                    '--agor-link-chip-accent-color': disabled
                      ? token.colorTextDisabled
                      : token.colorTextTertiary,
                    '--agor-link-chip-hover-bg': token.colorPrimaryBgHover,
                    '--agor-link-chip-hover-border': token.colorPrimaryBorderHover,
                    '--agor-link-chip-hover-color': token.colorPrimary,
                    '--agor-link-chip-hover-accent-color': token.colorTextTertiary,
                    height: chipHeight,
                    minWidth: 0,
                    maxWidth: chipMaxWidth,
                    border: '1px solid var(--agor-link-chip-border)',
                    borderRadius: 999,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    padding: `0 ${token.paddingXS}px`,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    font: 'inherit',
                    lineHeight: 1,
                    flex: '0 1 auto',
                  } as React.CSSProperties
                }
              >
                <PushpinFilled
                  className="agor-action-link-affordance"
                  style={{
                    color: 'var(--agor-link-chip-accent-color)',
                    fontSize: 11,
                  }}
                />
                <span
                  className="agor-action-link-icon"
                  style={{
                    width: 14,
                    color: 'var(--agor-link-chip-accent-color)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: '0 0 auto',
                  }}
                >
                  {getIcon(item, disabled)}
                </span>
                <Typography.Text
                  className={disabled ? undefined : 'agor-action-link-title'}
                  ellipsis
                  style={{
                    fontSize: 12,
                    maxWidth: chipMaxWidth - 50,
                    color: 'var(--agor-link-chip-color)',
                  }}
                >
                  {getCompactLinkDisplayName(item)}
                </Typography.Text>
              </button>
            </Tooltip>
          );
        })}
        {hiddenCount > 0 && (
          <Tooltip title={`${hiddenCount} more pinned link${hiddenCount === 1 ? '' : 's'}`}>
            <Button
              size="small"
              type="text"
              onClick={(event) => {
                event.stopPropagation();
                onOverflow?.();
              }}
              style={{
                height: chipHeight,
                minWidth: 34,
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
      <LinkPreviewModal preview={preview} onClose={() => setPreview(null)} />
    </>
  );
};
