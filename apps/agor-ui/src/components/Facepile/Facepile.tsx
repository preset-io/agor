/**
 * Facepile - shows active users on a board
 *
 * Displays user avatars with tooltips and optional cursor panning
 *
 * Note: activeUsers already contains full User objects with cursor positions,
 * so no Map lookup is needed for this component.
 */

import type { ActiveUser, Board, BoardID } from '@agor/core/types';
import { Tooltip } from 'antd';
import type { CSSProperties } from 'react';
import { AgorAvatar } from '../AgorAvatar';
import './Facepile.css';

export interface FacepileProps {
  activeUsers: ActiveUser[];
  currentUserId?: string;
  maxVisible?: number;
  onUserClick?: (
    userId: string,
    boardId?: BoardID,
    cursorPosition?: { x: number; y: number }
  ) => void;
  boardById?: Map<string, Board>; // For looking up board names
  style?: CSSProperties;
}

/**
 * Facepile component showing active users with emoji avatars
 */
export const Facepile: React.FC<FacepileProps> = ({
  activeUsers,
  maxVisible = 5,
  onUserClick,
  boardById,
  style,
}) => {
  // Show first N users, with overflow count
  const visibleUsers = activeUsers.slice(0, maxVisible);
  const overflowCount = Math.max(0, activeUsers.length - maxVisible);

  if (activeUsers.length === 0) {
    return null;
  }

  return (
    <div className="facepile" style={style}>
      {visibleUsers.map(({ user, cursor, boardId }) => {
        const board = boardId && boardById ? boardById.get(boardId) : null;
        const boardName = board?.name || 'Unknown Board';
        const boardIcon = board?.icon || '📋';
        const canClick = onUserClick && boardId;

        return (
          <Tooltip
            key={user.user_id}
            title={
              <div>
                <div>{user.name || user.email}</div>
                {boardId && (
                  <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '4px' }}>
                    {boardIcon} {boardName}
                  </div>
                )}
                {canClick && (
                  <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '4px' }}>
                    Click to go to board
                  </div>
                )}
              </div>
            }
          >
            <span>
              <AgorAvatar
                style={{
                  cursor: canClick ? 'pointer' : 'default',
                }}
                onClick={() => {
                  if (canClick) {
                    onUserClick(user.user_id, boardId, cursor);
                  }
                }}
              >
                {user.emoji || '👤'}
              </AgorAvatar>
            </span>
          </Tooltip>
        );
      })}

      {overflowCount > 0 && (
        <Tooltip title={`+${overflowCount} more active users`}>
          <span>
            <AgorAvatar>+{overflowCount}</AgorAvatar>
          </span>
        </Tooltip>
      )}
    </div>
  );
};
