import type { AgorClient, BoardID, User } from '@agor-live/client';
import { theme } from 'antd';
import { useMemo } from 'react';
import { useViewport } from 'reactflow';
import { useBoardPresenceRoom } from '../../../hooks/useBoardPresenceRoom';
import { usePresence } from '../../../hooks/usePresence';
import { getContrastingTextColor } from '../../../utils/theme';
import { UserIdentityAvatar } from '../../UserIdentityAvatar';

export interface StaticRemoteCursor {
  userId: string;
  x: number;
  y: number;
  user: User;
  color?: string;
  /** Demo-only click affordance: 0 = idle, (0,1] = expanding ring progress. */
  ripple?: number;
}

interface RemoteCursorLayerProps {
  client: AgorClient | null;
  boardId: BoardID | null;
  users: User[];
  enabled?: boolean;
  /** Demo/screenshot-only override: render fixed cursors without socket presence. */
  staticCursors?: StaticRemoteCursor[];
  /** Demo/screenshot-only scale boost for static cursors. Live cursors default to 1. */
  staticCursorScale?: number;
}

export const RemoteCursorLayer: React.FC<RemoteCursorLayerProps> = ({
  client,
  boardId,
  users,
  enabled = true,
  staticCursors,
  staticCursorScale = 1,
}) => {
  const { token } = theme.useToken();
  const viewport = useViewport();

  useBoardPresenceRoom({
    client,
    boardId,
    enabled: enabled && !staticCursors,
  });

  const { remoteCursors } = usePresence({
    client,
    boardId,
    users,
    enabled: enabled && !staticCursors,
  });

  const cursors = useMemo(
    () =>
      staticCursors
        ? staticCursors.map((cursor) => [cursor.userId, cursor] as const)
        : Array.from(remoteCursors.entries()),
    [remoteCursors, staticCursors]
  );
  if (cursors.length === 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 2000,
      }}
    >
      {cursors.map(([userId, cursor]) => {
        const { x, y, user } = cursor;
        const color = 'color' in cursor ? cursor.color : undefined;
        const ripple = 'ripple' in cursor ? (cursor.ripple ?? 0) : 0;
        const screenX = x * viewport.zoom + viewport.x;
        const screenY = y * viewport.zoom + viewport.y;

        return (
          <div
            key={userId}
            style={{
              position: 'absolute',
              transform: `translate3d(${screenX}px, ${screenY}px, 0) scale(${staticCursorScale})`,
              transformOrigin: 'top left',
              willChange: 'transform',
            }}
          >
            <div
              style={{
                pointerEvents: 'none',
                position: 'relative',
                width: '24px',
                height: '24px',
              }}
            >
              {ripple > 0 && ripple <= 1 && (
                <span
                  style={{
                    position: 'absolute',
                    top: '4px',
                    left: '6px',
                    width: `${8 + ripple * 36}px`,
                    height: `${8 + ripple * 36}px`,
                    marginLeft: `${-(8 + ripple * 36) / 2}px`,
                    marginTop: `${-(8 + ripple * 36) / 2}px`,
                    borderRadius: '50%',
                    border: `2px solid ${color ?? token.colorPrimary}`,
                    opacity: 1 - ripple,
                  }}
                />
              )}
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                style={{
                  color: color ?? token.colorPrimary,
                  filter: `drop-shadow(0 2px 4px ${token.colorBgMask})`,
                }}
              >
                <title>{`${user.name || user.email}'s cursor`}</title>
                <path
                  d="M5.5 3.5L18.5 12L11 14L8 20.5L5.5 3.5Z"
                  fill="currentColor"
                  stroke={token.colorBgElevated}
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>

              <div
                style={{
                  position: 'absolute',
                  top: '24px',
                  left: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  whiteSpace: 'nowrap',
                  background: color ? color : token.colorBgElevated,
                  color: color ? getContrastingTextColor(color, token) : token.colorText,
                  boxShadow: token.boxShadowSecondary,
                }}
              >
                <UserIdentityAvatar user={user} size={18} fontSize="14px" />
                <span style={{ fontWeight: 500 }}>{user.name || user.email}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
