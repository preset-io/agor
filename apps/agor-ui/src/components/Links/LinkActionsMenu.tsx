import { App, Flex, type MenuProps, Typography } from 'antd';
import { LinkOverflowAction } from './LinkActions';
import type { LinkDisplayItem } from './linkDisplay';
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
  branchSave?: {
    disabled: boolean;
    reason?: string | null;
    onSave: () => Promise<unknown>;
  };
  teammateAction?: {
    label: string;
    disabled: boolean;
    reason?: string | null;
    removal?: boolean;
    onAction: () => Promise<unknown>;
  };
}

function actionLabel(label: string, reason?: string | null) {
  if (!reason) return label;
  return (
    <Flex vertical gap={0}>
      <span>{label}</span>
      <Typography.Text type="secondary">{reason}</Typography.Text>
    </Flex>
  );
}

export function LinkActionsMenu({
  item,
  busy = false,
  onEdit,
  onDelete,
  branchSave,
  teammateAction,
}: LinkActionsMenuProps) {
  const { modal } = App.useApp();
  const items: NonNullable<MenuProps['items']> = [
    { key: LINK_ACTION_KEY.edit, label: LINK_ACTION_LABEL.edit, disabled: busy },
    ...(branchSave
      ? [
          {
            key: LINK_ACTION_KEY.saveToBranch,
            label: actionLabel(LINK_ACTION_LABEL.saveToBranch, branchSave.reason),
            disabled: busy || branchSave.disabled,
          },
        ]
      : []),
    ...(teammateAction
      ? [
          {
            key: teammateAction.removal
              ? LINK_ACTION_KEY.removeFromTeammate
              : LINK_ACTION_KEY.saveToTeammate,
            label: actionLabel(teammateAction.label, teammateAction.reason),
            disabled: busy || teammateAction.disabled,
          },
        ]
      : []),
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
    if (key === LINK_ACTION_KEY.saveToBranch) void branchSave?.onSave();
    if (key === LINK_ACTION_KEY.saveToTeammate || key === LINK_ACTION_KEY.removeFromTeammate) {
      void teammateAction?.onAction();
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
    />
  );
}
