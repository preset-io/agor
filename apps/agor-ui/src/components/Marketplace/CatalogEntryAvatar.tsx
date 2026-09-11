import { Avatar } from 'antd';
import type { CSSProperties } from 'react';

interface CatalogEntryAvatarProps {
  iconUrl?: string;
  style?: CSSProperties;
  title: string;
}

/** Catalog logo with Ant's image-error fallback kept as accessible text. */
export const CatalogEntryAvatar: React.FC<CatalogEntryAvatarProps> = ({
  iconUrl,
  style,
  title,
}) => (
  <Avatar
    shape="square"
    size={40}
    src={iconUrl}
    alt={iconUrl ? `${title} logo` : undefined}
    style={style}
  >
    {title.charAt(0).toUpperCase()}
  </Avatar>
);
