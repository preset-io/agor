import type { User } from '@agor/core/types';
import { Tag } from '../Tag';
import { UserAvatar } from './UserAvatar';

export interface CreatedByTagProps {
  createdBy: string; // user_id
  currentUserId?: string; // logged-in user's ID
  userById: Map<string, User>; // all users for lookup
  prefix?: string; // e.g., "Created by" or "Prompted by"
}

/**
 * CreatedByTag - Shows user metadata tag when creator differs from current user
 *
 * Only renders if createdBy !== currentUserId (or if currentUserId is undefined)
 * Used in SessionCard, SessionDrawer, and task views to show multiplayer attribution
 */
export const CreatedByTag: React.FC<CreatedByTagProps> = ({
  createdBy,
  currentUserId,
  userById,
  prefix = 'Created by',
}) => {
  // Don't show tag if current user created it
  if (createdBy === currentUserId) {
    return null;
  }

  // Look up the user
  const user = userById.get(createdBy);

  // If user not found or is anonymous, show minimal tag
  if (!user || createdBy === 'anonymous') {
    return (
      <Tag color="default" style={{ fontSize: 11 }}>
        {createdBy === 'anonymous' ? 'Anonymous' : 'Unknown User'}
      </Tag>
    );
  }

  return (
    <Tag color="blue" style={{ fontSize: 11 }}>
      <UserAvatar user={user} showName={true} size="small" />
    </Tag>
  );
};
