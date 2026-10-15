import { Avatar } from 'antd';
import type { CSSProperties } from 'react';

interface CatalogEntryAvatarProps {
  iconUrl?: string;
  /** Pixel size; defaults to the Catalog card's 40. */
  size?: number;
  style?: CSSProperties;
  title: string;
}

/** Catalog logo with Ant's image-error fallback kept as accessible text. */
export const CatalogEntryAvatar: React.FC<CatalogEntryAvatarProps> = ({
  iconUrl,
  size = 40,
  style,
  title,
}) => (
  <Avatar
    shape="square"
    size={size}
    src={iconUrl}
    alt={iconUrl ? `${title} logo` : undefined}
    style={style}
  >
    {title.charAt(0).toUpperCase()}
  </Avatar>
);
