/**
 * EffortSelector - Compact selector for Claude's effort level
 *
 * Effort controls how much reasoning Claude applies to responses.
 * Maps to the SDK's effort parameter (output_config.effort in the API).
 *
 * Levels:
 * - Low: Minimal thinking, fastest responses
 * - Medium: Moderate thinking
 * - High: Deep reasoning (default)
 * - Max: Maximum effort (Opus 4.6 only)
 */

import type { EffortLevel } from '@agor-live/client';
import { ThunderboltOutlined } from '@ant-design/icons';
import { Select, Tooltip } from 'antd';
import type React from 'react';

interface EffortSelectorProps {
  value?: EffortLevel;
  onChange?: (effort: EffortLevel) => void;
  size?: 'small' | 'middle' | 'large';
  compact?: boolean;
}

/**
 * EffortSelector - Dropdown for selecting Claude reasoning effort level
 */
export const EffortSelector: React.FC<EffortSelectorProps> = ({
  value = 'high',
  onChange,
  size = 'middle',
  compact = false,
}) => {
  const options = [
    {
      value: 'low' as EffortLevel,
      label: compact ? 'Low' : 'Low effort',
      description: 'Minimal thinking, fastest responses',
    },
    {
      value: 'medium' as EffortLevel,
      label: compact ? 'Med' : 'Medium effort',
      description: 'Moderate thinking',
    },
    {
      value: 'high' as EffortLevel,
      label: compact ? 'High' : 'High effort',
      description: 'Deep reasoning (default)',
    },
    {
      value: 'max' as EffortLevel,
      label: compact ? 'Max' : 'Max effort',
      description: 'Maximum effort (Opus 4.6 only)',
    },
  ];

  return (
    <Tooltip title="Reasoning effort level">
      <Select
        value={value}
        onChange={onChange}
        size={size}
        style={{ width: compact ? 80 : 160 }}
        options={options.map((opt) => ({
          value: opt.value,
          label: (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ThunderboltOutlined style={{ fontSize: 12 }} />
              <span>{opt.label}</span>
            </div>
          ),
        }))}
      />
    </Tooltip>
  );
};
