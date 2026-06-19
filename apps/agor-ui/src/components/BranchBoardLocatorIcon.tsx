import type { Branch } from '@agor-live/client';
import { AimOutlined } from '@ant-design/icons';
import { Tooltip } from 'antd';
import type React from 'react';
import { useRecenterMap } from '../contexts/CanvasNavigationContext';

interface BranchBoardLocatorIconProps {
  branch: Branch | undefined;
  size?: number;
  /** When false, the icon is hidden (opacity 0, no pointer events). Defaults to true. */
  visible?: boolean;
  /** Called after zooming to the card — use to open the session in the right panel. */
  onSessionClick?: () => void;
}

export const BranchBoardLocatorIcon: React.FC<BranchBoardLocatorIconProps> = ({
  branch,
  size = 12,
  visible = true,
  onSessionClick,
}) => {
  const recenterMap = useRecenterMap();
  const boardId = branch?.board_id;

  if (!branch || !boardId) return null;

  return (
    <Tooltip title="Go to card on board">
      <AimOutlined
        style={{
          fontSize: size,
          cursor: 'pointer',
          flexShrink: 0,
          opacity: visible ? 0.5 : 0,
          pointerEvents: visible ? 'auto' : 'none',
          transition: 'opacity 0.15s ease-in-out',
        }}
        onClick={(e) => {
          e.stopPropagation();
          recenterMap(branch.branch_id, { boardId });
          onSessionClick?.();
        }}
      />
    </Tooltip>
  );
};
