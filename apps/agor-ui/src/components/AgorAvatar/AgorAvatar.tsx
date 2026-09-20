/**
 * AgorAvatar - Standardized avatar component wrapping Ant Design's Avatar
 *
 * Provides consistent styling for user avatars throughout the application,
 * using colorPrimaryBg for the background to match the facepile in the navbar.
 *
 * Standard size: 40px (do not override unless absolutely necessary)
 */

import { Avatar, type AvatarProps, theme } from 'antd';
import type { CSSProperties } from 'react';

const STANDARD_AVATAR_SIZE = 40;

export interface AgorAvatarProps extends Omit<AvatarProps, 'style' | 'size'> {
  /** Optional style overrides */
  style?: CSSProperties;
  /** Override font size (defaults to 60% of the avatar size, for emoji) */
  fontSize?: string;
  /** Override the standard size. Only for fixed layout columns (compact transcript gutter). */
  size?: number;
}

/**
 * Standardized avatar component with consistent Agor styling
 */
export const AgorAvatar: React.FC<AgorAvatarProps> = ({
  style,
  fontSize,
  size = STANDARD_AVATAR_SIZE,
  children,
  ...props
}) => {
  const { token } = theme.useToken();

  return (
    <Avatar
      {...props}
      size={size}
      style={{
        backgroundColor: token.colorPrimaryBg,
        color: token.colorText,
        fontSize: fontSize ?? `${Math.round(size * 0.6)}px`,
        ...style,
      }}
    >
      {children}
    </Avatar>
  );
};
