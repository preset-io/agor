// biome-ignore-all lint/plugin/noHardcodedColorLiteral: centralized categorical avatar-tile palette (muted mid-tones, tuned to Agor) — not expressible as semantic theme tokens
import type { User } from '@agor-live/client';
import { Avatar, type AvatarProps, theme } from 'antd';
import type { CSSProperties } from 'react';
import { getContrastingTextColor } from '../utils/theme';

type IdentityUser = Pick<
  User,
  'user_id' | 'avatar_url' | 'avatar_source' | 'name' | 'email' | 'preferences'
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

// Muted, modern avatar palette (Mixpanel-ish, tuned to Agor). A centralized
// categorical tile palette is an allowed exact-color exception per
// context/guidelines/frontend.md — these mid-tones can't be expressed with
// semantic theme tokens, and contrast-aware text keeps initials legible.
const AVATAR_PALETTE = [
  '#6E7BA6', // muted indigo
  '#5B8A8F', // muted teal
  '#7E9A6B', // sage
  '#A6767E', // dusty rose
  '#8A7BA6', // mauve-purple
  '#B0916A', // warm sand
  '#6C89A6', // dusty blue
  '#9A7B9E', // muted mauve
];

/** Deterministic palette color keyed off a stable user identifier. */
export function getUserAvatarColor(
  user: Pick<User, 'user_id' | 'email' | 'name'> | null | undefined
): string {
  const key = user?.user_id || user?.email || user?.name || '';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
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

  // Humans always show photo-or-initials — a user's emoji is never their face
  // (emoji identity is reserved for assistants).
  const initials = getUserInitials(user);
  const useInitials = !avatarUrl;
  const bgColor = avatarUrl ? token.colorBgContainer : getUserAvatarColor(user);

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
      {initials}
    </Avatar>
  );
};
