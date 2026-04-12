/**
 * CursorNode - renders a remote user's cursor as a React Flow node
 *
 * This allows cursors to appear in the minimap automatically
 */

import type { User } from '@agor-live/client';
import { theme } from 'antd';
import { useViewport } from 'reactflow';

const { useToken } = theme;

interface CursorNodeData {
  user: User;
}

export const CursorNode = ({ data }: { data: CursorNodeData }) => {
  const { token } = useToken();
  const { zoom } = useViewport();

  // Inverse scale to keep cursor at constant size regardless of zoom
  const scale = 1 / zoom;

  return (
    <div
      style={{
        pointerEvents: 'none',
        position: 'relative',
        width: '24px',
        height: '24px',
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
      }}
    >
      {/* Cursor SVG */}
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
        <title>{`${data.user.name || data.user.email}'s cursor`}</title>
        <path
          d="M5.5 3.5L18.5 12L11 14L8 20.5L5.5 3.5Z"
          fill="currentColor"
          stroke={token.colorBgElevated}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>

      {/* User label */}
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
        <span style={{ fontSize: '14px' }}>{data.user.emoji || '👤'}</span>
        <span style={{ fontWeight: 500 }}>{data.user.name || data.user.email}</span>
      </div>
    </div>
  );
};
