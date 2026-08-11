import { theme } from 'antd';
import { useState } from 'react';
import { PanelResizeHandle } from 'react-resizable-panels';

interface WorkspaceResizeHandleProps {
  /** Render as an inert 0-width divider (used while the adjacent panel is collapsed). */
  disabled?: boolean;
  onDragging?: (isDragging: boolean) => void;
}

/** Vertical panel divider: 4px visible line, 12px grab target. */
export function WorkspaceResizeHandle({
  disabled = false,
  onDragging,
}: WorkspaceResizeHandleProps) {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);

  return (
    <PanelResizeHandle
      style={{
        position: 'relative',
        width: disabled ? '0px' : '4px',
        background: !disabled && hovered ? token.colorPrimary : token.colorBorderSecondary,
        cursor: disabled ? 'default' : 'col-resize',
        transition: 'background 0.2s',
        pointerEvents: disabled ? 'none' : 'auto',
        overflow: 'visible',
        zIndex: 10,
      }}
      onDragging={onDragging}
    >
      {!disabled && (
        <div
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{ position: 'absolute', top: 0, bottom: 0, left: -4, right: -4 }}
        />
      )}
    </PanelResizeHandle>
  );
}
