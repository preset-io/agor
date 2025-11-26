import { PlusOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';

export interface NewSessionButtonProps {
  onClick?: () => void;
  hasRepos?: boolean;
}

export const NewSessionButton: React.FC<NewSessionButtonProps> = ({ onClick, hasRepos = true }) => {
  const connectionDisabled = useConnectionDisabled();
  const tooltip = connectionDisabled
    ? 'Disconnected from daemon'
    : hasRepos
      ? 'Create new worktree'
      : 'Create a repository first';

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
          top: 80,
          width: 56,
          height: 56,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          zIndex: 100,
        }}
      />
    </Tooltip>
  );
};
