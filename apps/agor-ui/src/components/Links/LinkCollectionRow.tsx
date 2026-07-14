import { Flex, Typography } from 'antd';
import { ActionLinkRow } from './ActionLinkRow';
import { LinkPinAction } from './LinkActions';
import { LinkActionsMenu } from './LinkActionsMenu';
import { LinkCategoryGlyph } from './LinkVisual';
import { getLinkUnavailableReason } from './linkContent';
import {
  getCompactLinkDisplayName,
  getLinkDisplaySecondaryLabel,
  type LinkDisplayItem,
} from './linkDisplay';
import { canPersistLinkPin, getLinkPinActionLabel } from './linkPinning';
import type { LinkPlacementMenuItem, LinkPromotionAction } from './linkPromotion';
import styles from './linkUi.module.css';

interface LinkCollectionRowProps {
  item: LinkDisplayItem;
  sourceLabel?: string | null;
  secondaryLabel?: string | null;
  placementItems?: readonly LinkPlacementMenuItem[];
  pinning?: boolean;
  lifecycleBusy?: boolean;
  bordered?: boolean;
  onOpen: (item: LinkDisplayItem) => void;
  onTogglePinned?: (item: LinkDisplayItem) => void | Promise<void>;
  onPlacementAction?: (item: LinkDisplayItem, action: LinkPromotionAction) => Promise<unknown>;
  onOpenPlacements?: (item: LinkDisplayItem) => unknown | Promise<unknown>;
  onEdit?: (item: LinkDisplayItem) => void;
  onDelete?: (item: LinkDisplayItem) => Promise<unknown>;
  deleteLabel?: string;
}

export function LinkCollectionRow({
  item,
  sourceLabel,
  secondaryLabel,
  placementItems,
  pinning = false,
  lifecycleBusy = false,
  bordered = false,
  onOpen,
  onTogglePinned,
  onPlacementAction,
  onOpenPlacements,
  onEdit,
  onDelete,
  deleteLabel,
}: LinkCollectionRowProps) {
  const disabledReason = getLinkUnavailableReason(item);
  const disabled = Boolean(disabledReason);
  const title = getCompactLinkDisplayName(item);
  const targetLabel = secondaryLabel ?? getLinkDisplaySecondaryLabel(item);
  const pinAvailable = canPersistLinkPin(item) && Boolean(onTogglePinned);

  return (
    <ActionLinkRow
      bordered={bordered}
      disabled={disabled}
      ariaLabel={disabledReason ? `${title}: ${disabledReason}` : `Open ${title}`}
      href={item.href}
      navigation={item.navigation}
      onActivate={item.href ? undefined : () => onOpen(item)}
      actions={
        <>
          <LinkPinAction
            pinned={item.isPinned}
            ariaLabel={getLinkPinActionLabel(item, { available: pinAvailable })}
            disabled={!pinAvailable}
            loading={pinning}
            onToggle={() => onTogglePinned?.(item)}
          />
          <LinkActionsMenu
            item={item}
            busy={lifecycleBusy}
            onEdit={onEdit ? () => onEdit(item) : undefined}
            onDelete={item.linkId && onDelete ? () => onDelete(item) : undefined}
            deleteLabel={deleteLabel}
            placementItems={placementItems}
            onPlacementAction={
              onPlacementAction ? (action) => onPlacementAction(item, action) : undefined
            }
            onOpenPlacements={onOpenPlacements ? () => onOpenPlacements(item) : undefined}
          />
        </>
      }
    >
      <Flex component="span" align="flex-start" gap="small" className={styles.collectionRowBody}>
        <LinkCategoryGlyph category={item.category} disabled={disabled} variant="row" />
        <Flex component="span" vertical className={styles.collectionRowText}>
          <Typography.Text
            strong
            ellipsis
            disabled={disabled}
            className={styles.collectionRowTitle}
          >
            {title}
          </Typography.Text>
          {targetLabel && (
            <Typography.Text type="secondary" ellipsis>
              {targetLabel}
            </Typography.Text>
          )}
          {sourceLabel && (
            <Typography.Text type="secondary" ellipsis className={styles.collectionRowDetail}>
              From {sourceLabel}
            </Typography.Text>
          )}
          {disabledReason && (
            <Typography.Text type="warning" className={styles.collectionRowDetail}>
              {disabledReason}
            </Typography.Text>
          )}
        </Flex>
      </Flex>
    </ActionLinkRow>
  );
}
