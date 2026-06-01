import type { AgorClient, BoardID, User } from '@agor-live/client';
import { theme } from 'antd';
import { useMemo } from 'react';
import { useViewport } from 'reactflow';
import { useBoardPresenceRoom } from '../../../hooks/useBoardPresenceRoom';
import { usePresence } from '../../../hooks/usePresence';

interface RemoteCursorLayerProps {
  client: AgorClient | null;
  boardId: BoardID | null;
  users: User[];
  enabled?: boolean;
}

export const RemoteCursorLayer: React.FC<RemoteCursorLayerProps> = ({
  client,
  boardId,
  users,
  enabled = true,
}) => {
  const { token } = theme.useToken();
  const viewport = useViewport();

  useBoardPresenceRoom({
    client,
    boardId,
    enabled,
  });

  const { remoteCursors } = usePresence({
    client,
    boardId,
    users,
    enabled,
  });

  const cursors = useMemo(() => Array.from(remoteCursors.entries()), [remoteCursors]);
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
      {cursors.map(([userId, { x, y, user }]) => {
        const screenX = x * viewport.zoom + viewport.x;
        const screenY = y * viewport.zoom + viewport.y;

        return (
          <div
            key={userId}
            style={{
              position: 'absolute',
              transform: `translate3d(${screenX}px, ${screenY}px, 0)`,
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
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                style={{
                  color: token.colorPrimary,
                  filter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3))',
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
                  background: token.colorBgElevated,
                  color: token.colorText,
                  boxShadow: token.boxShadowSecondary,
                }}
              >
                <span style={{ fontSize: '14px' }}>{user.emoji || '👤'}</span>
                <span style={{ fontWeight: 500 }}>{user.name || user.email}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
