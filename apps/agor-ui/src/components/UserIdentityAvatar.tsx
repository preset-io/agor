import type { User } from '@agor-live/client';
import { Avatar, type AvatarProps, theme } from 'antd';
import type { CSSProperties } from 'react';

export interface UserIdentityAvatarProps extends Omit<AvatarProps, 'src' | 'style'> {
  user?: Pick<
    User,
    'avatar_url' | 'avatar_source' | 'emoji' | 'name' | 'email' | 'preferences'
  > | null;
  size?: number;
  fontSize?: string;
  style?: CSSProperties;
}

export function getUserAvatarUrl(user?: Pick<User, 'avatar_url'> | null): string | undefined {
  return user?.avatar_url || undefined;
}

export function slackAvatarRadius(size: number): number {
  return Math.max(5, Math.round(size * 0.2));
}

export const UserIdentityAvatar: React.FC<UserIdentityAvatarProps> = ({
  user,
  size = 40,
  fontSize,
  style,
  ...props
}) => {
  const { token } = theme.useToken();
  const prefersSlackAvatar = user?.preferences?.use_slack_avatar !== false;
  const rawAvatarUrl = getUserAvatarUrl(user);
  const avatarUrl =
    user?.avatar_source === 'slack' && !prefersSlackAvatar ? undefined : rawAvatarUrl;

  return (
    <Avatar
      {...props}
      src={avatarUrl}
      shape="square"
      size={size}
      style={{
        borderRadius: slackAvatarRadius(size),
        backgroundColor: avatarUrl ? token.colorBgContainer : token.colorPrimaryBg,
        color: token.colorText,
        fontSize: fontSize ?? `${Math.round(size * 0.6)}px`,
        lineHeight: `${size}px`,
        overflow: 'hidden',
        ...style,
      }}
    >
      {user?.emoji || '👤'}
    </Avatar>
  );
};
