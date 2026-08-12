import type { User } from '@agor-live/client';
import { Avatar, type AvatarProps, theme } from 'antd';
import type { CSSProperties } from 'react';
import { getContrastingTextColor } from '../utils/theme';

type AvatarToken = ReturnType<typeof theme.useToken>['token'];

type IdentityUser = Pick<
  User,
  'user_id' | 'avatar_url' | 'avatar_source' | 'emoji' | 'name' | 'email' | 'preferences'
>;

export interface UserIdentityAvatarProps extends Omit<AvatarProps, 'src' | 'style'> {
  user?: IdentityUser | null;
  size?: number;
  fontSize?: string;
  style?: CSSProperties;
}

export function getUserAvatarUrl(user?: Pick<User, 'avatar_url'> | null): string | undefined {
  return user?.avatar_url || undefined;
}

/** Up to two uppercase letters from the user's name (else email local part). */
export function getUserInitials(user?: Pick<User, 'name' | 'email'> | null): string {
  const name = user?.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  const local = user?.email?.trim().split('@')[0];
  if (local) return local.slice(0, 2).toUpperCase();
  return '?';
}

// Preset -6 hues (mirrors the canvas color palette) give each user a stable,
// theme-aware tile color derived from tokens rather than a hardcoded hex.
function avatarPalette(token: AvatarToken): string[] {
  return [
    token.blue6 || token.colorPrimary,
    token.purple6 || token.colorPrimary,
    token.cyan6 || token.colorInfo,
    token.green6 || token.colorSuccess,
    token.magenta6 || token.colorError,
    token.orange6 || token.colorWarning,
    token.gold6 || token.colorWarning,
    token.geekblue6 || token.colorPrimary,
  ];
}

/** Deterministic palette color keyed off a stable user identifier. */
export function getUserAvatarColor(
  user: Pick<User, 'user_id' | 'email' | 'name'> | null | undefined,
  token: AvatarToken
): string {
  const key = user?.user_id || user?.email || user?.name || '';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const palette = avatarPalette(token);
  return palette[hash % palette.length];
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

  // A user-picked emoji is deliberate identity, so keep it; the empty case now
  // shows initials instead of a generic 👤 fallback.
  const customEmoji = user?.emoji?.trim() || undefined;
  const initials = getUserInitials(user);
  const useInitials = !avatarUrl && !customEmoji;
  const bgColor = avatarUrl
    ? token.colorBgContainer
    : customEmoji
      ? token.colorPrimaryBg
      : getUserAvatarColor(user, token);

  return (
    <Avatar
      {...props}
      src={avatarUrl}
      shape="circle"
      size={size}
      style={{
        backgroundColor: bgColor,
        color: useInitials ? getContrastingTextColor(bgColor, token) : token.colorText,
        fontSize: useInitials
          ? `${Math.round(size * 0.4)}px`
          : (fontSize ?? `${Math.round(size * 0.6)}px`),
        fontWeight: useInitials ? 600 : undefined,
        lineHeight: `${size}px`,
        overflow: 'hidden',
        ...style,
      }}
    >
      {customEmoji ?? initials}
    </Avatar>
  );
};
