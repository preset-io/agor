import { Button, Flex, Tooltip, theme } from 'antd';
import { useNavigate } from 'react-router-dom';
import { getLinkItemIcon } from './LinkVisual';
import { getLinkUnavailableReason } from './linkContent';
import {
  getCompactLinkDisplayName,
  getLinkDisplaySecondaryLabel,
  getPinnedLinkDisplayName,
  type LinkDisplayItem,
} from './linkDisplay';
import styles from './linkUi.module.css';
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

export const PromotedPinnedLinks: React.FC<PromotedPinnedLinksProps> = ({
  items,
  onOverflow,
  'data-testid': dataTestId,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { preview, setPreview, openItem } = useLinkFileActions(navigate);

  if (items.length === 0) return null;

  const visibleItems = items.slice(0, 3);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);

  return (
    <>
      <Flex
        align="center"
        gap={token.sizeXXS}
        data-testid={dataTestId}
        className={styles.pinnedLinksRow}
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
                label={getPinnedLinkDisplayName(item)}
                icon={getLinkItemIcon(item, disabled)}
                onOpen={() => openItem(item)}
              />
            </Tooltip>
          );
        })}
        {hiddenCount > 0 && (
          <Tooltip title={`${hiddenCount} more pinned link${hiddenCount === 1 ? '' : 's'}`}>
            <Button
              size="small"
              shape="round"
              type="text"
              onClick={(event) => {
                event.stopPropagation();
                onOverflow?.();
              }}
              className={styles.pinnedLinksOverflow}
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
