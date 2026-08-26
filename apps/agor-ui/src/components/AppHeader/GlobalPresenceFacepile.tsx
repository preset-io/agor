import type { ActiveUser, AgorClient, Board, BoardID, User } from '@agor-live/client';
import { useMemo } from 'react';
import { PRESENCE_CONFIG } from '../../config/presence';
import { useGlobalPresenceHeartbeat } from '../../hooks/useGlobalPresenceHeartbeat';
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
  const visibleBoardIds = useMemo(
    () =>
      [...boardById.values()]
        .filter((board) => !board.archived)
        .map((board) => board.board_id as BoardID),
    [boardById]
  );

  useGlobalPresenceHeartbeat({
    client,
    currentBoardId: currentBoardId ?? null,
    visibleBoardIds,
    enabled: !!client && !staticActiveUsers,
  });

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
    const visibleActiveUsers = activeUsers.map((activeUser) =>
      activeUser.boardId && !boardById.has(activeUser.boardId)
        ? { ...activeUser, boardId: undefined, cursor: undefined }
        : activeUser
    );
    if (!currentUser) return visibleActiveUsers;

    return [
      {
        user: currentUser,
        lastSeen: Date.now(),
        boardId: currentBoardId && boardById.has(currentBoardId) ? currentBoardId : undefined,
        cursor: undefined,
      },
      ...visibleActiveUsers.filter((activeUser) => activeUser.user.user_id !== currentUser.user_id),
    ];
  }, [activeUsers, boardById, currentBoardId, currentUser, staticActiveUsers]);

  if (allActiveUsers.length === 0) return null;

  return (
    <Facepile
      activeUsers={allActiveUsers}
      currentUserId={currentUser?.user_id}
      maxVisible={maxVisible}
      avatarSize={32}
      boardById={boardById}
      onUserClick={onUserClick}
      style={{
        marginRight: 8,
      }}
    />
  );
};
