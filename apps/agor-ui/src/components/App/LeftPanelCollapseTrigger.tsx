import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { Tooltip } from 'antd';
import type React from 'react';

const LEFT_PANEL_TOGGLE_HIT_SIZE_PX = 44;
const LEFT_PANEL_TOGGLE_KNOB_SIZE_PX = 30;

export interface LeftPanelCollapseTriggerProps {
  collapsed: boolean;
  panelSizePercent: number;
  collapsedPanelSizePercent: number;
  onToggle: () => void;
}

export const LeftPanelCollapseTrigger: React.FC<LeftPanelCollapseTriggerProps> = ({
  collapsed,
  panelSizePercent,
  collapsedPanelSizePercent,
  onToggle,
}) => {
  const label = collapsed ? 'Open side panel' : 'Close side panel';
  const left = collapsed
    ? collapsedPanelSizePercent > 0
      ? `calc(${collapsedPanelSizePercent}% + 2px)`
      : 0
    : `calc(${panelSizePercent}% + 2px)`;

  return (
    <Tooltip title={label} placement="right" getPopupContainer={() => document.body}>
      <button
        type="button"
        aria-label={label}
        onClick={onToggle}
        style={{
          position: 'absolute',
          top: '50%',
          left,
          transform: 'translate(-50%, -50%)',
          width: LEFT_PANEL_TOGGLE_HIT_SIZE_PX,
          height: LEFT_PANEL_TOGGLE_HIT_SIZE_PX,
          padding: 0,
          border: 0,
          background: 'transparent',
          cursor: 'pointer',
          pointerEvents: 'auto',
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: LEFT_PANEL_TOGGLE_KNOB_SIZE_PX,
            height: LEFT_PANEL_TOGGLE_KNOB_SIZE_PX,
            borderRadius: '50%',
            border: '1px solid var(--ant-color-border)',
            background: 'var(--ant-color-bg-container)',
            boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
            color: 'var(--ant-color-text)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {collapsed ? (
            <RightOutlined style={{ fontSize: 12 }} />
          ) : (
            <LeftOutlined style={{ fontSize: 12 }} />
          )}
        </span>
      </button>
    </Tooltip>
  );
};
