import { App, type MenuProps } from 'antd';
import { LinkOverflowAction } from './LinkActions';
import type { LinkDisplayItem } from './linkDisplay';
import type { LinkPromotionAction, LinkPromotionSelection } from './linkPromotion';
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
  promotionActions?: readonly LinkPromotionAction[];
  onPromote?: (selection: LinkPromotionSelection) => Promise<unknown>;
}

export function LinkActionsMenu({
  item,
  busy = false,
  onEdit,
  onDelete,
  promotionActions = [],
  onPromote,
}: LinkActionsMenuProps) {
  const { modal } = App.useApp();
  const items: NonNullable<MenuProps['items']> = [
    { key: LINK_ACTION_KEY.edit, label: LINK_ACTION_LABEL.edit, disabled: busy },
    ...promotionActions.map((action) => ({
      key: action.key,
      label: action.label,
      disabled: busy || action.disabled,
    })),
    ...(onDelete
      ? [
          { type: 'divider' as const },
          {
            key: LINK_ACTION_KEY.delete,
            label: LINK_ACTION_LABEL.delete,
            danger: true,
            disabled: busy,
          },
        ]
      : []),
  ];

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === LINK_ACTION_KEY.edit) onEdit();
    const promotionAction = promotionActions.find((action) => action.key === key);
    if (promotionAction && onPromote) void onPromote(promotionAction);
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
    />
  );
}
