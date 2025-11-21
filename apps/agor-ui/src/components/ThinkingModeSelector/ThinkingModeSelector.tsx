/**
 * ThinkingModeSelector - Compact selector for Claude's extended thinking mode
 *
 * Modes:
 * - Auto: Detects keywords ("think", "think hard", "ultrathink") for token budgets
 * - Manual: Fixed token budget (user-specified)
 * - Off: Disable extended thinking
 */

import { BulbOutlined } from '@ant-design/icons';
import { Select, Tooltip } from 'antd';
import type React from 'react';

export type ThinkingMode = 'auto' | 'manual' | 'off';

interface ThinkingModeSelectorProps {
  value?: ThinkingMode;
  onChange?: (mode: ThinkingMode) => void;
  size?: 'small' | 'middle' | 'large';
  compact?: boolean; // Ultra-compact mode for footer
}

/**
 * ThinkingModeSelector - Dropdown for selecting thinking mode
 */
export const ThinkingModeSelector: React.FC<ThinkingModeSelectorProps> = ({
  value = 'auto',
  onChange,
  size = 'middle',
  compact = false,
}) => {
  const options = [
    {
      value: 'auto' as ThinkingMode,
      label: compact ? 'Auto' : 'Auto (keyword detection)',
      description: 'Detects "think", "think hard", "ultrathink" in prompts',
    },
    {
      value: 'manual' as ThinkingMode,
      label: compact ? 'Manual' : 'Manual (fixed budget)',
      description: 'Set fixed thinking token budget',
    },
    {
      value: 'off' as ThinkingMode,
      label: 'Off',
      description: 'Disable extended thinking',
    },
  ];

  return (
    <Tooltip title="Extended thinking mode">
      <Select
        value={value}
        onChange={onChange}
        size={size}
        style={{ width: compact ? 90 : 200 }}
        options={options.map(opt => ({
          value: opt.value,
          label: (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {opt.value !== 'off' && <BulbOutlined style={{ fontSize: 12 }} />}
              <span>{opt.label}</span>
            </div>
          ),
        }))}
      />
    </Tooltip>
  );
};
