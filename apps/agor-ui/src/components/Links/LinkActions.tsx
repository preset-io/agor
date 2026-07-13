import { EllipsisOutlined, PushpinFilled, PushpinOutlined } from '@ant-design/icons';
import { Button, Dropdown, Tooltip, theme } from 'antd';

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
    <Tooltip title={pinned ? 'Unpin' : 'Pin'}>
      <Button
        type="text"
        size="small"
        shape="circle"
        disabled={disabled}
        loading={loading}
        aria-label={ariaLabel}
        icon={pinned ? <PushpinFilled /> : <PushpinOutlined />}
        onClick={() => void onToggle()}
        style={{ color: pinned ? token.colorWarning : token.colorTextTertiary }}
      />
    </Tooltip>
  );
}

interface LinkOverflowActionProps {
  ariaLabel: string;
  actionLabel: string;
  onAction: () => void | Promise<void>;
  tooltip?: string;
  disabled?: boolean;
  loading?: boolean;
}

export function LinkOverflowAction({
  ariaLabel,
  actionLabel,
  onAction,
  tooltip = 'Link actions',
  disabled = false,
  loading = false,
}: LinkOverflowActionProps) {
  return (
    <Tooltip title={tooltip}>
      <Dropdown
        trigger={['click']}
        disabled={disabled}
        menu={{
          items: [{ key: 'action', label: actionLabel, disabled }],
          onClick: () => {
            if (!disabled) void onAction();
          },
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
