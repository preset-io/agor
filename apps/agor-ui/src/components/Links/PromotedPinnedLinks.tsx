import {
  BookOutlined,
  FileImageOutlined,
  FileTextOutlined,
  GithubOutlined,
  GlobalOutlined,
  LinkOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Button, Flex, Tooltip, theme } from 'antd';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { getLinkContentAction, getLinkUnavailableReason } from './linkContent';
import {
  getCompactLinkDisplayName,
  getLinkDisplaySecondaryLabel,
  type LinkDisplayItem,
} from './linkDisplay';
import { PinnedLinkButton } from './PinnedLinkButton';
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
  return (
    <>
      <Flex
        align="center"
        gap={token.sizeXXS}
        data-testid={dataTestId}
        style={{
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
              <PinnedLinkButton
                disabled={disabled}
                disabledReason={disabledReason}
                label={getCompactLinkDisplayName(item)}
                icon={getIcon(item, disabled)}
                onOpen={() => openItem(item)}
              />
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
      </Flex>
      <LinkPreviewModal preview={preview} onClose={() => setPreview(null)} />
    </>
  );
};
