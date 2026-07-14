import { App, type MenuProps } from 'antd';
import { LinkOverflowAction } from './LinkActions';
import type { LinkDisplayItem } from './linkDisplay';
import {
  isLinkPromotionAction,
  type LinkPlacementMenuItem,
  type LinkPromotionAction,
} from './linkPromotion';
import {
  getLinkActionsAriaLabel,
  LINK_ACTION_KEY,
  LINK_ACTION_LABEL,
  LINK_CONFIRM_COPY,
} from './linkUiConstants';

interface LinkActionsMenuProps {
  item: LinkDisplayItem;
  busy?: boolean;
  onEdit: () => void;
  onDelete?: () => Promise<unknown>;
  deleteLabel?: string;
  placementItems?: readonly LinkPlacementMenuItem[];
  onPlacementAction?: (action: LinkPromotionAction) => Promise<unknown>;
  onOpenPlacements?: () => unknown | Promise<unknown>;
}

export function LinkActionsMenu({
  item,
  busy = false,
  onEdit,
  onDelete,
  deleteLabel = LINK_ACTION_LABEL.delete,
  placementItems = [],
  onPlacementAction,
  onOpenPlacements,
}: LinkActionsMenuProps) {
  const { modal } = App.useApp();
  const items: NonNullable<MenuProps['items']> = [
    { key: LINK_ACTION_KEY.edit, label: LINK_ACTION_LABEL.edit, disabled: busy },
    ...placementItems.map((item) => ({
      key: item.key,
      label: item.label,
      disabled: busy || item.disabled,
    })),
    ...(onDelete
      ? [
          { type: 'divider' as const },
          {
            key: LINK_ACTION_KEY.delete,
            label: deleteLabel,
            danger: true,
            disabled: busy,
          },
        ]
      : []),
  ];

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === LINK_ACTION_KEY.edit) onEdit();
    const placementItem = placementItems.find((item) => item.key === key);
    if (placementItem && isLinkPromotionAction(placementItem) && onPlacementAction) {
      void onPlacementAction(placementItem);
    }
    if (key === LINK_ACTION_KEY.delete && onDelete) {
      modal.confirm({
        title: LINK_CONFIRM_COPY.deleteTitle,
        content: LINK_CONFIRM_COPY.deleteContent,
        okText: LINK_CONFIRM_COPY.deleteOk,
        okButtonProps: { danger: true },
        cancelText: LINK_CONFIRM_COPY.cancel,
        onOk: onDelete,
      });
    }
  };

  return (
    <LinkOverflowAction
      ariaLabel={getLinkActionsAriaLabel(item.name)}
      items={items}
      onMenuClick={handleMenuClick}
      disabled={items.length === 0}
      loading={busy}
      onOpenChange={(open) => {
        if (open) void onOpenPlacements?.();
      }}
    />
  );
}
