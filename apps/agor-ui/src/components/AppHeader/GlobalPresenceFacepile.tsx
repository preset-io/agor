import type { ActiveUser, AgorClient, Board, BoardID, User } from '@agor-live/client';
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
  /** Demo/screenshot-only override: render a fixed facepile without live socket presence. */
  staticActiveUsers?: ActiveUser[];
  /** Optional screenshot/demo composition override. Omit to preserve the product default cap. */
  maxVisible?: number;
}

export const GlobalPresenceFacepile: React.FC<GlobalPresenceFacepileProps> = ({
  client,
  currentBoardId,
  users,
  currentUser,
  boardById,
  onUserClick,
  staticActiveUsers,
  maxVisible = 5,
}) => {
  const { activeUsers } = usePresence({
    client,
    boardId: currentBoardId ?? null,
    users,
    enabled: !!client && !staticActiveUsers,
    globalPresence: true,
    presenceMinUpdateIntervalMs: PRESENCE_CONFIG.FACEPILE_REFRESH_MS,
  });

  const allActiveUsers = useMemo(() => {
    if (staticActiveUsers) return staticActiveUsers;
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
  }, [activeUsers, currentBoardId, currentUser, staticActiveUsers]);

  if (allActiveUsers.length === 0) return null;

  return (
    <>
      <Facepile
        activeUsers={allActiveUsers}
        currentUserId={currentUser?.user_id}
        maxVisible={maxVisible}
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
