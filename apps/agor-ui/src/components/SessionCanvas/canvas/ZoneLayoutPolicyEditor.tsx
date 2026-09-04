import {
  defaultZoneLayoutSortDirection,
  normalizeZoneLayoutPolicy,
  setZoneLayoutMode,
  ZONE_LAYOUT_PRESET_LABELS,
  ZONE_LAYOUT_SORT_FIELDS,
  ZONE_LAYOUT_SORT_LABELS,
  ZONE_OVERFLOW_STRATEGIES,
  ZONE_OVERFLOW_STRATEGY_LABELS,
  zoneLayoutSortDirectionOptions,
} from '@agor/core/layout/zone-layout';
import type {
  ZoneLayoutPolicy,
  ZoneLayoutPreset,
  ZoneLayoutSortBy,
  ZoneOverflowStrategy,
} from '@agor-live/client';
import { Flex, Form, InputNumber, Segmented, Select, Switch } from 'antd';

export interface ZoneLayoutPolicyEditorProps {
  value: ZoneLayoutPolicy;
  onChange: (value: ZoneLayoutPolicy) => void;
  disabled?: boolean;
  idPrefix: string;
}

/** Shared editor for board defaults and explicit per-zone overrides. */
export function ZoneLayoutPolicyEditor({
  value,
  onChange,
  disabled = false,
  idPrefix,
}: ZoneLayoutPolicyEditorProps) {
  const policy = normalizeZoneLayoutPolicy(value);
  const update = (next: Partial<ZoneLayoutPolicy>) =>
    onChange(normalizeZoneLayoutPolicy({ ...policy, ...next }));
  const autoResize = policy.resize !== 'fixed';

  return (
    <>
      <Form.Item
        label="Auto Zone"
        help={
          policy.mode === 'auto'
            ? 'On: keeps contents arranged with this policy. It pauses for one minute while a stacked worktree is in use.'
            : 'Off: preserves spatial memory. The settings below remain saved and apply when you choose Tidy up contents.'
        }
      >
        <Switch
          aria-label="Auto Zone"
          checked={policy.mode === 'auto'}
          disabled={disabled}
          onChange={(checked) => onChange(setZoneLayoutMode(policy, checked ? 'auto' : 'manual'))}
        />
      </Form.Item>

      <Form.Item
        label="Presentation"
        help={
          policy.preset === 'compact_list'
            ? 'List uses one column and collapses worktree and capable generic-card details; header-only cards and canvas objects keep their natural size.'
            : 'Grid keeps natural card detail and can use one or more columns.'
        }
      >
        <Segmented
          block
          aria-label="Presentation"
          value={policy.preset}
          disabled={disabled}
          options={[
            { label: ZONE_LAYOUT_PRESET_LABELS.grid, value: 'grid' },
            { label: ZONE_LAYOUT_PRESET_LABELS.compact_list, value: 'compact_list' },
          ]}
          onChange={(preset) =>
            update({
              preset: preset as ZoneLayoutPreset,
              ...(preset === 'compact_list' ? { columns: 1 } : {}),
            })
          }
        />
      </Form.Item>

      <Flex gap="middle" wrap>
        <Form.Item label="Sort by" style={{ flex: '1 1 220px' }}>
          <Select
            aria-label="Sort by"
            value={policy.sortBy}
            disabled={disabled}
            options={ZONE_LAYOUT_SORT_FIELDS.map((sortBy) => ({
              value: sortBy,
              label: ZONE_LAYOUT_SORT_LABELS[sortBy],
            }))}
            onChange={(sortBy: ZoneLayoutSortBy) =>
              update({
                sortBy,
                sortDirection: defaultZoneLayoutSortDirection(sortBy),
              })
            }
          />
        </Form.Item>
        <Form.Item label="Order" style={{ flex: '1 1 150px' }}>
          <Select
            aria-label="Order"
            value={policy.sortDirection}
            disabled={disabled}
            options={zoneLayoutSortDirectionOptions(policy.sortBy)}
            onChange={(sortDirection) => update({ sortDirection })}
          />
        </Form.Item>
      </Flex>

      <Flex gap="large" wrap align="start">
        {policy.preset === 'grid' && (
          <Form.Item
            label="Columns"
            help="Leave blank to fit as many columns as the zone allows."
            style={{ flex: '1 1 200px' }}
          >
            <InputNumber
              aria-label="Columns"
              min={1}
              precision={0}
              value={policy.columns}
              disabled={disabled}
              style={{ width: '100%' }}
              placeholder="Auto"
              onChange={(columns) => update({ columns: columns ?? undefined })}
            />
          </Form.Item>
        )}
        <Form.Item
          label="Spacing"
          help="Exact boundary space between arranged items."
          style={{ flex: '1 1 160px' }}
        >
          <InputNumber
            aria-label="Spacing"
            min={0}
            max={96}
            precision={0}
            step={4}
            value={policy.gap}
            disabled={disabled}
            suffix="px"
            style={{ width: '100%' }}
            onChange={(gap) => update({ gap: gap ?? 0 })}
          />
        </Form.Item>
        <Form.Item
          label="Grow to fit"
          help="On: content may grow the zone; a manual resize remains its floor. Off: impossible layouts report overflow without moving anything."
          style={{ flex: '1 1 200px' }}
        >
          <Switch
            aria-label="Grow to fit"
            checked={autoResize}
            disabled={disabled}
            onChange={(checked) =>
              update({
                resize: checked ? (policy.resize === 'both' ? 'both' : 'height') : 'fixed',
                autoResizeHeight: checked,
                ...(checked ? { onOverflow: 'reflow_board' } : {}),
              })
            }
          />
        </Form.Item>
        <Form.Item
          label="When growth overlaps"
          help={
            autoResize
              ? 'Report covered zones or move neighboring zones out of the way.'
              : 'Enable Grow to fit before choosing an overlap action.'
          }
          style={{ flex: '1 1 240px' }}
        >
          <Select
            id={`${idPrefix}-overflow`}
            aria-label="When growth overlaps"
            value={policy.onOverflow}
            disabled={disabled || !autoResize}
            options={ZONE_OVERFLOW_STRATEGIES.map((strategy) => ({
              value: strategy,
              label: ZONE_OVERFLOW_STRATEGY_LABELS[strategy],
            }))}
            onChange={(onOverflow: ZoneOverflowStrategy) => update({ onOverflow })}
          />
        </Form.Item>
      </Flex>
    </>
  );
}
