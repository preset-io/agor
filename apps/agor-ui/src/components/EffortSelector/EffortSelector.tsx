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
 * - Max: Maximum effort (Opus only)
 */

import type { EffortLevel } from '@agor-live/client';
import { BulbOutlined } from '@ant-design/icons';
import { Select, Space, Tooltip, Typography, theme } from 'antd';
import type React from 'react';

interface EffortSelectorProps {
  value?: EffortLevel;
  onChange?: (effort: EffortLevel) => void;
  size?: 'small' | 'middle' | 'large';
  compact?: boolean;
}

const EFFORT_OPTIONS: {
  value: EffortLevel;
  shortLabel: string;
  label: string;
  description: string;
}[] = [
  {
    value: 'low',
    shortLabel: 'Lo',
    label: 'Low',
    description: 'Minimal thinking, fastest responses',
  },
  { value: 'medium', shortLabel: 'Md', label: 'Medium', description: 'Moderate thinking' },
  { value: 'high', shortLabel: 'Hi', label: 'High', description: 'Deep reasoning (default)' },
  { value: 'max', shortLabel: 'Mx', label: 'Max', description: 'Maximum effort (Opus only)' },
];

/**
 * EffortSelector - Dropdown for selecting Claude reasoning effort level
 */
export const EffortSelector: React.FC<EffortSelectorProps> = ({
  value = 'high',
  onChange,
  size = 'middle',
  compact = false,
}) => {
  const { token } = theme.useToken();

  return (
    <Tooltip title="Reasoning effort level">
      <Select
        value={value}
        onChange={onChange}
        size={size}
        style={{
          width: compact ? undefined : 160,
          fontSize: compact ? token.fontSizeSM : undefined,
        }}
        popupMatchSelectWidth={false}
        optionLabelProp="label"
        options={EFFORT_OPTIONS.map((opt) => ({
          value: opt.value,
          label: compact ? (
            <span style={{ fontSize: token.fontSizeSM }}>
              <BulbOutlined style={{ fontSize: token.fontSizeSM - 1, marginRight: 2 }} />
              {opt.shortLabel}
            </span>
          ) : (
            <span>
              <BulbOutlined style={{ fontSize: 12, marginRight: 6 }} />
              {opt.label} effort
            </span>
          ),
        }))}
        optionRender={(option) => {
          const opt = EFFORT_OPTIONS.find((o) => o.value === option.value);
          return (
            <Space size={6} align="start">
              <BulbOutlined style={{ marginTop: 3 }} />
              <div style={{ lineHeight: 1.3 }}>
                <div>{opt?.label}</div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {opt?.description}
                </Typography.Text>
              </div>
            </Space>
          );
        }}
      />
    </Tooltip>
  );
};
