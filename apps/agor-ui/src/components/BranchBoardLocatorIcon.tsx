import type { Branch } from '@agor-live/client';
import { AimOutlined } from '@ant-design/icons';
import { Tooltip } from 'antd';
import type React from 'react';
import { useRecenterMap } from '../contexts/CanvasNavigationContext';

interface BranchBoardLocatorIconProps {
  branch: Branch | undefined;
  size?: number;
}

export const BranchBoardLocatorIcon: React.FC<BranchBoardLocatorIconProps> = ({
  branch,
  size = 12,
}) => {
  const recenterMap = useRecenterMap();
  const boardId = branch?.board_id;

  if (!branch || !boardId) return null;

  return (
    <Tooltip title="Go to card on board">
      <AimOutlined
        style={{ fontSize: size, cursor: 'pointer', flexShrink: 0, opacity: 0.5 }}
        onClick={(e) => {
          e.stopPropagation();
          recenterMap(branch.branch_id, { boardId });
        }}
      />
    </Tooltip>
  );
};
