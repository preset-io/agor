/**
 * EffortSelector - Compact selector for reasoning effort level
 *
 * Effort controls how much reasoning the agent applies to responses.
 * Runtime adapters map the shared value to their native effort option.
 *
 * Levels:
 * - Low: Minimal thinking, fastest responses
 * - Medium: Moderate thinking
 * - High: Deep reasoning
 * - X-High: Extra reasoning depth, below maximum
 * - Max: Highest effort level (model-dependent)
 */

import type { EffortLevel } from '@agor-live/client';
import { BulbOutlined } from '@ant-design/icons';
import { Select, Space, Tooltip, Typography, theme } from 'antd';
import type React from 'react';

interface EffortSelectorProps {
  value?: EffortLevel;
  onChange?: (effort: EffortLevel | undefined) => void;
  levels?: readonly EffortLevel[];
  fallbackValue?: EffortLevel;
  allowInherited?: boolean;
  size?: 'small' | 'middle' | 'large';
  compact?: boolean;
  plain?: boolean;
  fullWidth?: boolean;
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
  { value: 'high', shortLabel: 'Hi', label: 'High', description: 'Deep reasoning' },
  {
    value: 'xhigh',
    shortLabel: 'Xh',
    label: 'X-High',
    description: 'Extra reasoning depth, below maximum',
  },
  {
    value: 'max',
    shortLabel: 'Mx',
    label: 'Max',
    description: 'Highest effort level (model-dependent)',
  },
];

/**
 * EffortSelector - Dropdown for selecting a supported reasoning effort level
 */
export const EffortSelector: React.FC<EffortSelectorProps> = ({
  value,
  onChange,
  levels,
  fallbackValue,
  allowInherited = false,
  size = 'middle',
  compact = false,
  plain = false,
  fullWidth = false,
}) => {
  const { token } = theme.useToken();
  const options = levels
    ? EFFORT_OPTIONS.filter((option) => levels.includes(option.value))
    : EFFORT_OPTIONS;
  const resolvedValue = value ?? fallbackValue;

  return (
    <Tooltip title="Reasoning effort level">
      <Select
        value={resolvedValue}
        onChange={onChange}
        allowClear={allowInherited}
        placeholder={allowInherited ? 'Inherited' : undefined}
        size={size}
        style={{
          width: fullWidth ? '100%' : compact ? undefined : 160,
          fontSize: compact ? token.fontSizeSM : undefined,
        }}
        popupMatchSelectWidth={false}
        optionLabelProp="label"
        options={options.map((opt) => ({
          value: opt.value,
          label: plain ? (
            opt.label
          ) : compact ? (
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
          const opt = options.find((o) => o.value === option.value);
          return (
            <Space size={6} align="start">
              <BulbOutlined style={{ marginTop: 3 }} />
              <div style={{ lineHeight: 1.3, whiteSpace: 'normal' }}>
                <div>{opt?.label}</div>
                <Typography.Text type="secondary" style={{ fontSize: 11, whiteSpace: 'normal' }}>
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
