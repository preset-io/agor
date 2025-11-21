import type { User } from '@agor/core/types';
import { Space, Tooltip, theme } from 'antd';

export interface UserAvatarProps {
  user: User;
  showName?: boolean;
  size?: 'small' | 'default' | 'large';
}

const sizeMap = {
  small: 12,
  default: 14,
  large: 18,
};

/**
 * UserAvatar - Displays user emoji/avatar with optional name
 *
 * Used in metadata tags and conversation views to show user identity
 */
export const UserAvatar: React.FC<UserAvatarProps> = ({
  user,
  showName = true,
  size = 'default',
}) => {
  const fontSize = sizeMap[size];
  const { token } = theme.useToken();

  return (
    <Tooltip title={`${user.name || user.email} (${user.role})`}>
      <Space size={4}>
        <span style={{ fontSize }}>{user.emoji || '👤'}</span>
        {showName && (
          <span
            style={{
              backgroundColor: token.colorBgTextHover,
              borderRadius: '3px',
              padding: '0 2px',
              fontWeight: 600,
            }}
          >
            {user.name || user.email.split('@')[0]}
          </span>
        )}
      </Space>
    </Tooltip>
  );
};
