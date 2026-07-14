import { EllipsisOutlined, PushpinFilled, PushpinOutlined } from '@ant-design/icons';
import { Button, Dropdown, type MenuProps, Tooltip, theme } from 'antd';
import { LINK_ACTION_KEY, LINK_ACTION_LABEL, LINK_MANAGER_COPY } from './linkUiConstants';

interface LinkPinActionProps {
  pinned: boolean;
  ariaLabel: string;
  onToggle: () => void | Promise<void>;
  disabled?: boolean;
  loading?: boolean;
}

export function LinkPinAction({
  pinned,
  ariaLabel,
  onToggle,
  disabled = false,
  loading = false,
}: LinkPinActionProps) {
  const { token } = theme.useToken();

  return (
    <Tooltip title={pinned ? LINK_ACTION_LABEL.unpin : LINK_ACTION_LABEL.pin}>
      <Button
        type="text"
        size="small"
        shape="circle"
        disabled={disabled}
        loading={loading}
        aria-label={ariaLabel}
        icon={
          pinned ? (
            <PushpinFilled style={{ color: token.colorPrimary }} />
          ) : (
            <PushpinOutlined style={{ color: token.colorTextTertiary }} />
          )
        }
        onClick={() => void onToggle()}
      />
    </Tooltip>
  );
}

interface LinkOverflowActionBaseProps {
  ariaLabel: string;
  tooltip?: string;
  disabled?: boolean;
  loading?: boolean;
  onOpenChange?: (open: boolean) => void;
}

type LinkOverflowActionProps = LinkOverflowActionBaseProps &
  (
    | {
        actionLabel: string;
        onAction: () => unknown;
        items?: never;
        onMenuClick?: never;
      }
    | {
        actionLabel?: never;
        onAction?: never;
        items: NonNullable<MenuProps['items']>;
        onMenuClick: NonNullable<MenuProps['onClick']>;
      }
  );

export function LinkOverflowAction({
  ariaLabel,
  actionLabel,
  onAction,
  items,
  onMenuClick,
  tooltip = LINK_MANAGER_COPY.actionsTooltip,
  disabled = false,
  loading = false,
  onOpenChange,
}: LinkOverflowActionProps) {
  return (
    <Tooltip title={tooltip}>
      <Dropdown
        trigger={['click']}
        disabled={disabled}
        onOpenChange={onOpenChange}
        menu={{
          items: items ?? [{ key: LINK_ACTION_KEY.default, label: actionLabel, disabled }],
          onClick:
            onMenuClick ??
            (() => {
              if (!disabled) void onAction?.();
            }),
        }}
      >
        <Button
          type="text"
          size="small"
          shape="circle"
          disabled={disabled}
          loading={loading}
          aria-label={ariaLabel}
          icon={<EllipsisOutlined />}
        />
      </Dropdown>
    </Tooltip>
  );
}
