import type { AgorClient, Board, BoardID, User } from '@agor-live/client';
import { Divider } from 'antd';
import { useMemo } from 'react';
import { PRESENCE_CONFIG } from '../../config/presence';
import { usePresence } from '../../hooks/usePresence';
import { Facepile } from '../Facepile';

interface GlobalPresenceFacepileProps {
  client: AgorClient | null;
  currentBoardId?: BoardID | null;
  users: User[];
  currentUser?: User | null;
  boardById: Map<string, Board>;
  onUserClick?: (
    userId: string,
    boardId?: BoardID,
    cursorPosition?: { x: number; y: number }
  ) => void;
}

export const GlobalPresenceFacepile: React.FC<GlobalPresenceFacepileProps> = ({
  client,
  currentBoardId,
  users,
  currentUser,
  boardById,
  onUserClick,
}) => {
  const { activeUsers } = usePresence({
    client,
    boardId: currentBoardId ?? null,
    users,
    enabled: !!client,
    globalPresence: true,
    presenceMinUpdateIntervalMs: PRESENCE_CONFIG.FACEPILE_REFRESH_MS,
  });

  const allActiveUsers = useMemo(() => {
    if (!currentUser) return activeUsers;

    return [
      {
        user: currentUser,
        lastSeen: Date.now(),
        boardId: currentBoardId ?? undefined,
        cursor: undefined,
      },
      ...activeUsers.filter((activeUser) => activeUser.user.user_id !== currentUser.user_id),
    ];
  }, [activeUsers, currentBoardId, currentUser]);

  if (allActiveUsers.length === 0) return null;

  return (
    <>
      <Facepile
        activeUsers={allActiveUsers}
        currentUserId={currentUser?.user_id}
        maxVisible={5}
        boardById={boardById}
        onUserClick={onUserClick}
        style={{
          marginRight: 8,
        }}
      />
      <Divider orientation="vertical" style={{ height: 32, margin: '0 8px' }} />
    </>
  );
};
