import { PlusOutlined } from '@ant-design/icons';
import { Button, Tooltip, theme } from 'antd';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { CreateMenu, type CreateModalKind } from '../CreateMenu';

// Board "New" trigger style. Flip to 'pill' to A/B the compact labeled pill
// (matches the homepage) against the circular "+". One-line change — Kasia
// wants to compare both live.
const BOARD_TRIGGER_VARIANT = 'circle' as 'circle' | 'pill';

export interface NewSessionButtonProps {
  /** Fired with the picked flow; the host opens the matching modal. */
  onSelect: (kind: CreateModalKind) => void;
}

/**
 * Floating board entry point. Opens the same shared CreateMenu as the homepage,
 * so both surfaces offer identical creation flows.
 */
export const NewSessionButton: React.FC<NewSessionButtonProps> = ({ onSelect }) => {
  const connectionDisabled = useConnectionDisabled();
  const { token } = theme.useToken();
  const tooltip = connectionDisabled ? 'Disconnected from daemon' : 'Create new...';

  const baseStyle: React.CSSProperties = {
    position: 'absolute',
    right: 24,
    top: 24,
    boxShadow: token.boxShadowSecondary,
    zIndex: 100,
  };

  const trigger =
    BOARD_TRIGGER_VARIANT === 'pill' ? (
      <Button
        type="primary"
        icon={<PlusOutlined />}
        disabled={connectionDisabled}
        style={baseStyle}
      >
        New
      </Button>
    ) : (
      <Button
        type="primary"
        shape="circle"
        size="large"
        icon={<PlusOutlined />}
        disabled={connectionDisabled}
        style={baseStyle}
      />
    );

  return (
    <Tooltip title={tooltip} placement="left">
      <CreateMenu onSelect={onSelect} disabled={connectionDisabled}>
        {trigger}
      </CreateMenu>
    </Tooltip>
  );
};
