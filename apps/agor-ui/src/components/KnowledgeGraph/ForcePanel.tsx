/**
 * Collapsible force-tuning panel rendered as a React Flow overlay. Each slider
 * maps to one knob on the d3-force simulation (see `useForceLayout`), retuning
 * the live layout as you drag. Collapsed by default so it stays out of the way.
 */

import { Button, Segmented, Slider, Space, Typography, theme } from 'antd';
import { useState } from 'react';
import { DEFAULT_FORCE_PARAMS, type ForceParams } from './useForceLayout';

const { Text } = Typography;

interface SliderRowProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}

function SliderRow({ label, min, max, step, value, onChange }: SliderRowProps) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 11 }}>{label}</Text>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {value}
        </Text>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
        tooltip={{ open: false }}
      />
    </div>
  );
}

export interface ForcePanelProps {
  params: ForceParams;
  onChange: (params: ForceParams) => void;
  onReset: () => void;
}

export function ForcePanel({ params, onChange, onReset }: ForcePanelProps) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<ForceParams>) => onChange({ ...params, ...patch });

  if (!open) {
    return (
      <Button size="small" onClick={() => setOpen(true)}>
        Forces
      </Button>
    );
  }

  return (
    <div
      style={{
        width: 220,
        padding: 12,
        borderRadius: token.borderRadiusLG,
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorder}`,
        boxShadow: token.boxShadowSecondary,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <Text strong style={{ fontSize: 12 }}>
          Force layout
        </Text>
        <Button
          type="text"
          size="small"
          aria-label="Collapse force layout panel"
          onClick={() => setOpen(false)}
        >
          ✕
        </Button>
      </div>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <SliderRow
          label="Repulsion"
          min={-1500}
          max={-50}
          step={10}
          value={params.chargeStrength}
          onChange={(v) => set({ chargeStrength: v })}
        />
        <SliderRow
          label="Link distance"
          min={40}
          max={400}
          step={5}
          value={params.linkDistance}
          onChange={(v) => set({ linkDistance: v })}
        />
        <SliderRow
          label="Link strength"
          min={0}
          max={1}
          step={0.05}
          value={params.linkStrength}
          onChange={(v) => set({ linkStrength: v })}
        />
        <SliderRow
          label="Center gravity"
          min={0}
          max={1}
          step={0.05}
          value={params.centerStrength}
          onChange={(v) => set({ centerStrength: v })}
        />
        <SliderRow
          label="Collision radius"
          min={20}
          max={120}
          step={2}
          value={params.collideRadius}
          onChange={(v) => set({ collideRadius: v })}
        />
        <SliderRow
          label="Settle speed"
          min={0.01}
          max={0.1}
          step={0.005}
          value={params.alphaDecay}
          onChange={(v) => set({ alphaDecay: v })}
        />
        <SliderRow
          label="Hub centering"
          min={0}
          max={0.3}
          step={0.01}
          value={params.radialStrength}
          onChange={(v) => set({ radialStrength: v })}
        />
        <SliderRow
          label="Vertical flow"
          min={0}
          max={40}
          step={1}
          value={params.verticalStrength}
          onChange={(v) => set({ verticalStrength: v })}
        />
        <div>
          <Text style={{ fontSize: 11 }}>Centrality by</Text>
          <Segmented
            size="small"
            block
            options={[
              { label: 'In-links', value: 'in' },
              { label: 'All links', value: 'total' },
            ]}
            value={params.degreeMode}
            onChange={(v) => set({ degreeMode: v as ForceParams['degreeMode'] })}
          />
        </div>
        <Button size="small" block onClick={onReset} disabled={isDefault(params)}>
          Reset defaults
        </Button>
      </Space>
    </div>
  );
}

function isDefault(params: ForceParams): boolean {
  return (Object.keys(DEFAULT_FORCE_PARAMS) as (keyof ForceParams)[]).every(
    (key) => params[key] === DEFAULT_FORCE_PARAMS[key]
  );
}
