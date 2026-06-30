/**
 * Facepile - shows active users on a board
 *
 * Displays user avatars with tooltips and optional cursor panning
 *
 * Note: activeUsers already contains full User objects with cursor positions,
 * so no Map lookup is needed for this component.
 */

import type { ActiveUser, Board, BoardID, SessionID } from '@agor-live/client';
import { Avatar, Tooltip, theme } from 'antd';
import type { CSSProperties } from 'react';
import { slackAvatarRadius, UserIdentityAvatar } from '../UserIdentityAvatar';
import './Facepile.css';

export interface FacepileProps {
  activeUsers: ActiveUser[];
  currentUserId?: string;
  /** User currently being observed in watch mode. When set, that avatar gets a
   *  visual ring and the current user's avatar becomes a "return home" control. */
  watchedUserId?: string;
  maxVisible?: number;
  onUserClick?: (
    userId: string,
    boardId?: BoardID,
    cursorPosition?: { x: number; y: number },
    sessionId?: SessionID
  ) => void;
  boardById?: Map<string, Board>; // For looking up board names
  style?: CSSProperties;
}

/**
 * Facepile component showing active users with Slack-style user avatars
 */
export const Facepile: React.FC<FacepileProps> = ({
  activeUsers,
  currentUserId,
  watchedUserId,
  maxVisible = 5,
  onUserClick,
  boardById,
  style,
}) => {
  const { token } = theme.useToken();

  const isWatchMode = !!watchedUserId;

  // Show first N users, with overflow count
  const visibleUsers = activeUsers.slice(0, maxVisible);
  const overflowUsers = activeUsers.slice(maxVisible);
  const overflowCount = overflowUsers.length;

  if (activeUsers.length === 0) {
    return null;
  }

  return (
    <div className="facepile" style={style}>
      {visibleUsers.map(({ user, cursor, boardId, sessionId }) => {
        const isSelf = user.user_id === currentUserId;
        const isWatched = user.user_id === watchedUserId;
        const board = boardId && boardById ? boardById.get(boardId) : null;
        const boardName = board?.name || 'Unknown Board';
        const boardIcon = board?.icon || '📋';

        // Own avatar is always clickable (to exit watch mode when watching)
        const canClick = isSelf ? isWatchMode : !!(onUserClick && boardId);

        let clickHint: string;
        if (isSelf && isWatchMode) {
          clickHint = 'Click to return to your workspace';
        } else if (isWatched) {
          clickHint = 'Watching — click to stop';
        } else if (sessionId) {
          clickHint = 'Click to open their session';
        } else if (cursor) {
          clickHint = 'Click to go to their location';
        } else {
          clickHint = 'Click to go to board';
        }

        // Watched avatar: blue ring. Own avatar in watch mode: orange ring.
        const ringStyle: CSSProperties = isWatched
          ? {
              outline: `2px solid ${token.colorPrimary}`,
              outlineOffset: '2px',
              borderRadius: slackAvatarRadius(40),
            }
          : isSelf && isWatchMode
            ? {
                outline: `2px solid ${token.colorWarning}`,
                outlineOffset: '2px',
                borderRadius: slackAvatarRadius(40),
              }
            : {};

        return (
          <Tooltip
            key={user.user_id}
            title={
              <div>
                <div>{user.name || user.email}</div>
                {boardId && !isSelf && (
                  <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '4px' }}>
                    {boardIcon} {boardName}
                  </div>
                )}
                {canClick && (
                  <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '4px' }}>
                    {clickHint}
                  </div>
                )}
              </div>
            }
          >
            <span style={ringStyle}>
              <UserIdentityAvatar
                user={user}
                style={{
                  cursor: canClick ? 'pointer' : 'default',
                  display: 'block',
                }}
                onClick={() => {
                  if (isSelf && isWatchMode) {
                    // Self-click exits watch mode; handler checks isSelf
                    onUserClick?.(user.user_id, boardId, cursor, sessionId);
                  } else if (canClick && onUserClick && boardId) {
                    onUserClick(user.user_id, boardId, cursor, sessionId);
                  }
                }}
              />
            </span>
          </Tooltip>
        );
      })}

      {overflowCount > 0 && (
        <Tooltip
          title={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {overflowUsers.map(({ user }) => (
                <div key={user.user_id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <UserIdentityAvatar user={user} size={20} fontSize="16px" />
                  <span>{user.name || user.email}</span>
                </div>
              ))}
            </div>
          }
        >
          <span>
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
          </span>
        </Tooltip>
      )}
    </div>
  );
};
