import { PlusOutlined } from '@ant-design/icons';
import { Button, Tooltip, theme } from 'antd';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';

export interface NewSessionButtonProps {
  onClick?: () => void;
}

export const NewSessionButton: React.FC<NewSessionButtonProps> = ({ onClick }) => {
  const connectionDisabled = useConnectionDisabled();
  const { token } = theme.useToken();
  const tooltip = connectionDisabled ? 'Disconnected from daemon' : 'Create new...';

  return (
    <Tooltip title={tooltip} placement="left">
      <Button
        type="primary"
        shape="circle"
        size="large"
        icon={<PlusOutlined style={{ fontSize: 20 }} />}
        onClick={onClick}
        disabled={connectionDisabled}
        style={{
          position: 'absolute',
          right: 24,
          top: 24,
          width: 56,
          height: 56,
          boxShadow: token.boxShadowSecondary,
          zIndex: 100,
        }}
      />
    </Tooltip>
  );
};
