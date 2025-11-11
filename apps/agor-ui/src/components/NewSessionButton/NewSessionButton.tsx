import { PlusOutlined } from '@ant-design/icons';
import { FloatButton } from 'antd';
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
    <FloatButton
      icon={<PlusOutlined />}
      type="primary"
      onClick={onClick}
      tooltip={tooltip}
      disabled={connectionDisabled}
      style={{ right: 24, top: 80 }}
    />
  );
};
