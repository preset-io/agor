import { App, type MenuProps } from 'antd';
import { LinkOverflowAction } from './LinkActions';
import type { LinkDisplayItem } from './linkDisplay';
import type { LinkPromotionAction } from './linkPromotion';
import {
  getLinkActionsAriaLabel,
  LINK_ACTION_KEY,
  LINK_ACTION_LABEL,
  LINK_CONFIRM_COPY,
} from './linkUiConstants';

export interface LinkMenuAction {
  key: string;
  label: string;
  disabled?: boolean;
}

interface LinkActionsMenuProps {
  item: LinkDisplayItem;
  busy?: boolean;
  onEdit: () => void;
  onDelete?: () => Promise<unknown>;
  deleteLabel?: string;
  placementActions?: readonly LinkPromotionAction[];
  onPlacementAction?: (action: LinkPromotionAction) => Promise<unknown>;
  onOpenPlacements?: () => unknown | Promise<unknown>;
  additionalActions?: readonly LinkMenuAction[];
  onAdditionalAction?: (action: LinkMenuAction) => void;
}

export function LinkActionsMenu({
  item,
  busy = false,
  onEdit,
  onDelete,
  deleteLabel = LINK_ACTION_LABEL.delete,
  placementActions = [],
  onPlacementAction,
  onOpenPlacements,
  additionalActions = [],
  onAdditionalAction,
}: LinkActionsMenuProps) {
  const { modal } = App.useApp();
  const items: NonNullable<MenuProps['items']> = [
    { key: LINK_ACTION_KEY.edit, label: LINK_ACTION_LABEL.edit, disabled: busy },
    ...placementActions.map((action) => ({
      key: action.key,
      label: action.label,
      disabled: busy || action.disabled,
    })),
    ...additionalActions.map((action) => ({
      key: action.key,
      label: action.label,
      disabled: busy || action.disabled,
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
    const placementAction = placementActions.find((action) => action.key === key);
    if (placementAction && onPlacementAction) void onPlacementAction(placementAction);
    const additionalAction = additionalActions.find((action) => action.key === key);
    if (additionalAction) onAdditionalAction?.(additionalAction);
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
