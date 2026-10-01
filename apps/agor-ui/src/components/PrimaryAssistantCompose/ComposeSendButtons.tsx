import type { Branch } from '@agor-live/client';
import { DownOutlined } from '@ant-design/icons';
import { Button, Dropdown, Space, Tooltip } from 'antd';
import { teammateLabel } from '../../utils/teammateLabels';
import type { ComposeSendMode } from './usePrimaryAssistantSend';

interface ComposeSendButtonsProps {
  branch: Branch | null;
  submitting: ComposeSendMode | null;
  disabled?: boolean;
  /** A split "Send" (background) with "Send & open" in its menu, for narrow layouts. */
  compact?: boolean;
  onSend: (mode: ComposeSendMode) => void;
}

/** The two quick-compose actions shared by the navbar composer and Home's ask box. */
export const ComposeSendButtons: React.FC<ComposeSendButtonsProps> = ({
  branch,
  submitting,
  disabled,
  compact,
  onSend,
}) => {
  const board = branch ? `${teammateLabel(branch)}'s board` : "your primary assistant's board";
  const inactive = disabled || submitting !== null;
  const background = (
    <Tooltip title={`Creates the session in the background, on ${board} — check on it anytime.`}>
      <Button
        type="primary"
        aria-label={compact ? 'Send in background' : undefined}
        loading={submitting === 'background'}
        disabled={inactive}
        onClick={() => onSend('background')}
      >
        {compact ? 'Send' : 'Send in background'}
      </Button>
    </Tooltip>
  );
  if (compact) {
    return (
      <Space.Compact>
        {background}
        <Dropdown
          trigger={['click']}
          disabled={inactive}
          menu={{ items: [{ key: 'open', label: 'Send & open' }], onClick: () => onSend('open') }}
        >
          <Button
            type="primary"
            icon={<DownOutlined />}
            aria-label="More send options"
            loading={submitting === 'open'}
            disabled={inactive}
          />
        </Dropdown>
      </Space.Compact>
    );
  }
  // Primary last, so it sits on the right.
  return (
    <>
      <Tooltip title={`Creates the session and takes you there now, on ${board}.`}>
        <Button loading={submitting === 'open'} disabled={inactive} onClick={() => onSend('open')}>
          Send &amp; open
        </Button>
      </Tooltip>
      {background}
    </>
  );
};
