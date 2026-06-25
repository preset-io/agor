import type { User } from '@agor-live/client';
import { Space, Tooltip, theme } from 'antd';
import { UserIdentityAvatar } from '../UserIdentityAvatar';

export interface UserAvatarProps {
  user: User;
  showName?: boolean;
  size?: 'small' | 'default' | 'large';
}

const sizeMap = {
  small: { avatar: 18, font: 12 },
  default: { avatar: 22, font: 14 },
  large: { avatar: 28, font: 18 },
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
  const sizes = sizeMap[size];
  const { token } = theme.useToken();

  return (
    <Tooltip title={`${user.name || user.email} (${user.role})`}>
      <Space size={4}>
        <UserIdentityAvatar user={user} size={sizes.avatar} fontSize={`${sizes.font}px`} />
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
