import type { User } from '@agor-live/client';
import { Space, theme } from 'antd';
import { Tag } from '../Tag';
import { UserAvatar } from './UserAvatar';

export interface OwnersTagProps {
  owners: User[];
  currentUserId?: string;
}

export const OwnersTag: React.FC<OwnersTagProps> = ({ owners, currentUserId }) => {
  const { token } = theme.useToken();

  if (owners.length === 0) return null;

  // Hide when the only owner is the current user
  if (owners.length === 1 && owners[0].user_id === currentUserId) return null;

  return (
    <Tag color="blue" style={{ fontSize: 11 }}>
      <Space size={token.sizeXXS}>
        {owners.map((owner) => (
          <UserAvatar key={owner.user_id} user={owner} showName size="small" />
        ))}
      </Space>
    </Tag>
  );
};
