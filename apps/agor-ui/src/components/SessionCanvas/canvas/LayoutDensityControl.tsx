import {
  LAYOUT_DENSITY_POLICIES,
  LAYOUT_DENSITY_POLICY_LABELS,
} from '@agor/core/layout/zone-layout';
import type { LayoutDensityPolicy } from '@agor/core/types';
import { Select, Typography } from 'antd';
import { useId } from 'react';

const CANVAS_LAYOUT_CONTROLS_CLASS = 'canvas-layout-controls';

export interface LayoutDensityControlProps {
  value: LayoutDensityPolicy;
  onChange: (value: LayoutDensityPolicy) => void;
  disabled?: boolean;
  label?: string;
  compact?: boolean;
  disabledReason?: string;
}

/** Reusable, portaled density policy control for board, selection, and zone settings. */
export function LayoutDensityControl({
  value,
  onChange,
  disabled = false,
  label = 'Content expansion',
  compact = false,
  disabledReason,
}: LayoutDensityControlProps) {
  const labelId = useId();
  const helpId = useId();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Typography.Text id={labelId}>{label}</Typography.Text>
      <Select
        aria-labelledby={labelId}
        aria-describedby={compact ? undefined : helpId}
        value={value}
        disabled={disabled}
        virtual={false}
        classNames={{ popup: { root: CANVAS_LAYOUT_CONTROLS_CLASS } }}
        options={LAYOUT_DENSITY_POLICIES.map((policy) => ({
          value: policy,
          label: LAYOUT_DENSITY_POLICY_LABELS[policy],
        }))}
        onChange={onChange}
        style={{ width: '100%' }}
      />
      {!compact && (
        <Typography.Text id={helpId} type="secondary">
          {disabled && disabledReason
            ? disabledReason
            : value === 'preserve'
              ? 'Keeps every eligible worktree or body card exactly as expanded or collapsed now.'
              : value === 'expand'
                ? 'Expands eligible worktrees and cards with body content as part of the same layout.'
                : 'Collapses eligible worktrees and cards with body content as part of the same layout.'}
        </Typography.Text>
      )}
    </div>
  );
}
