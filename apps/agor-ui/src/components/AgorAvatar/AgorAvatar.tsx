/**
 * AgorAvatar - Standardized avatar component wrapping Ant Design's Avatar
 *
 * Provides consistent styling for user avatars throughout the application,
 * using colorPrimaryBg for the background to match the facepile in the navbar.
 *
 * Sized from IDENTITY_AVATAR_SIZE so every speaker in the transcript shares
 * the navbar's avatar diameter. The size is deliberately not overridable.
 */

import { Avatar, type AvatarProps, theme } from 'antd';
import type { CSSProperties } from 'react';
import { IDENTITY_AVATAR_SIZE } from '../../constants/ui';

export interface AgorAvatarProps extends Omit<AvatarProps, 'style' | 'size'> {
  /** Optional style overrides */
  style?: CSSProperties;
  /** Override the emoji glyph size */
  fontSize?: string;
}

/**
 * Standardized avatar component with consistent Agor styling
 */
export const AgorAvatar: React.FC<AgorAvatarProps> = ({ style, fontSize, children, ...props }) => {
  const { token } = theme.useToken();

  return (
    <Avatar
      {...props}
      size={IDENTITY_AVATAR_SIZE}
      style={{
        backgroundColor: token.colorPrimaryBg,
        color: token.colorText,
        // Large enough for an emoji to read as a face inside the circle.
        fontSize: fontSize ?? token.fontSizeXL,
        ...style,
      }}
    >
      {children}
    </Avatar>
  );
};
