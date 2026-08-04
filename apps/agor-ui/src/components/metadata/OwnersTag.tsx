import type { User } from '@agor-live/client';
import { Space } from 'antd';
import { Tag } from '../Tag';
import { UserAvatar } from './UserAvatar';

export interface OwnersTagProps {
  owners: User[];
  currentUserId?: string;
}

export const OwnersTag: React.FC<OwnersTagProps> = ({ owners, currentUserId }) => {
  if (owners.length === 0) return null;

  // Hide when the only owner is the current user
  if (owners.length === 1 && owners[0].user_id === currentUserId) return null;

  if (owners.length === 1) {
    return (
      <Tag color="blue" style={{ fontSize: 11 }}>
        <UserAvatar user={owners[0]} showName size="small" />
      </Tag>
    );
  }

  return (
    <Tag color="blue" style={{ fontSize: 11 }}>
      <Space size={2}>
        {owners.map((owner) => (
          <UserAvatar key={owner.user_id} user={owner} showName size="small" />
        ))}
      </Space>
    </Tag>
  );
};
