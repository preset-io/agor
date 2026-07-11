/**
 * Facepile - shows active users on a board
 *
 * Displays user avatars with tooltips and optional cursor panning
 *
 * Note: activeUsers already contains full User objects with cursor positions,
 * so no Map lookup is needed for this component.
 */

import type { ActiveUser, Board, BoardID } from '@agor-live/client';
import { Avatar, Flex, Tooltip, theme } from 'antd';
import type { CSSProperties } from 'react';
import { slackAvatarRadius, UserIdentityAvatar } from '../UserIdentityAvatar';

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
 * Facepile component showing active users with Slack-style user avatars
 */
export const Facepile: React.FC<FacepileProps> = ({
  activeUsers,
  maxVisible = 5,
  onUserClick,
  boardById,
  style,
}) => {
  const { token } = theme.useToken();

  // Show first N users, with overflow count
  const visibleUsers = activeUsers.slice(0, maxVisible);
  const overflowUsers = activeUsers.slice(maxVisible);
  const overflowCount = overflowUsers.length;

  if (activeUsers.length === 0) {
    return null;
  }

  return (
    <Flex
      component="span"
      align="center"
      gap={8}
      style={{ display: 'inline-flex', lineHeight: 1, verticalAlign: 'middle', ...style }}
    >
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
            <Flex component="span" style={{ lineHeight: 1 }}>
              <UserIdentityAvatar
                user={user}
                style={{
                  cursor: canClick ? 'pointer' : 'default',
                }}
                onClick={() => {
                  if (canClick) {
                    onUserClick(user.user_id, boardId, cursor);
                  }
                }}
              />
            </Flex>
          </Tooltip>
        );
      })}

      {overflowCount > 0 && (
        <Tooltip
          title={
            <Flex vertical gap={6}>
              {overflowUsers.map(({ user }) => (
                <Flex key={user.user_id} align="center" gap={6}>
                  <UserIdentityAvatar user={user} size={20} fontSize="16px" />
                  <span>{user.name || user.email}</span>
                </Flex>
              ))}
            </Flex>
          }
        >
          <Flex component="span" style={{ lineHeight: 1 }}>
            <Avatar
              shape="square"
              size={40}
              style={{
                borderRadius: slackAvatarRadius(40),
                backgroundColor: token.colorPrimaryBg,
                color: token.colorText,
                fontSize: 12,
                fontWeight: 'bold',
              }}
            >
              +{overflowCount}
            </Avatar>
          </Flex>
        </Tooltip>
      )}
    </Flex>
  );
};
