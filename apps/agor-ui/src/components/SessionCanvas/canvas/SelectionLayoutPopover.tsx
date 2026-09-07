import type { BoardZoneArrangementOptions } from '@agor/core/layout/board-zone-arrangement';
import type { LayoutDensityPolicy } from '@agor/core/types';
import { SettingOutlined } from '@ant-design/icons';
import { Button, InputNumber, Popover, Segmented, Select, Space, Switch, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutDensityControl } from './LayoutDensityControl';

export type SelectionLayoutMode = 'compact' | 'grid';
export type SelectionTrackAxis = 'columns' | 'rows';
export type SelectionRowDistribution = 'packed' | 'justify';

/** Marks portaled layout controls so canvas selection gestures ignore them. */
export const CANVAS_LAYOUT_CONTROLS_CLASS = 'canvas-layout-controls';

export interface SelectionLayoutSettings {
  mode: SelectionLayoutMode;
  trackAxis: SelectionTrackAxis;
  trackCount: number;
  matchRowHeights: boolean;
  matchColumnWidths: boolean;
  rowDistribution: SelectionRowDistribution;
  density: LayoutDensityPolicy;
}

export function selectionGridTracks(
  itemCount: number,
  axis: SelectionTrackAxis,
  requestedCount: number
): { columns: number; rows: number } {
  const count = Math.max(1, itemCount);
  const tracks = Math.max(1, Math.min(count, Math.floor(requestedCount)));
  return axis === 'columns'
    ? { columns: tracks, rows: Math.ceil(count / tracks) }
    : { columns: Math.ceil(count / tracks), rows: tracks };
}

/**
 * Translate selection UI tracks into the options understood by the one
 * board-zone planner used by both Apply layout and Arrange zones.
 */
export function selectionBoardZoneArrangementOptions(
  selectionCount: number,
  settings?: SelectionLayoutSettings
): Omit<BoardZoneArrangementOptions, 'looseItems'> {
  if (settings?.mode === 'compact') return { mode: 'compact', density: settings.density };
  if (!settings) {
    return {
      mode: 'grid',
      justifyRows: true,
      resizeZoneFrames: true,
      matchRowHeights: true,
      matchColumnWidths: true,
      density: 'preserve',
    };
  }
  const gridSettings = settings;
  const tracks = selectionGridTracks(
    selectionCount,
    gridSettings.trackAxis,
    gridSettings.trackCount
  );
  return {
    mode: 'grid',
    fixedItemsPerRow: tracks.columns,
    compactFixedGrid: true,
    justifyRows: gridSettings.rowDistribution === 'justify',
    justifyLastRow: gridSettings.rowDistribution === 'justify',
    matchRowHeights: gridSettings.matchRowHeights,
    matchColumnWidths: gridSettings.matchColumnWidths,
    resizeZoneFrames: gridSettings.matchRowHeights || gridSettings.matchColumnWidths,
    density: gridSettings.density,
  };
}

const defaultSelectionTrackCount = (selectionCount: number): number =>
  Math.min(3, Math.max(1, selectionCount));

interface SelectionLayoutPopoverProps {
  selectionCount: number;
  zoneOnlySelection: boolean;
  densityAvailable?: boolean;
  onApply: (settings: SelectionLayoutSettings) => void | Promise<void>;
}

export function SelectionLayoutPopover({
  selectionCount,
  zoneOnlySelection,
  densityAvailable = true,
  onApply,
}: SelectionLayoutPopoverProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SelectionLayoutMode>('grid');
  const [trackAxis, setTrackAxis] = useState<SelectionTrackAxis>('columns');
  const [trackCount, setTrackCount] = useState(defaultSelectionTrackCount(selectionCount));
  const trackCountWasEdited = useRef(false);
  const [matchRowHeights, setMatchRowHeights] = useState(zoneOnlySelection);
  const [matchColumnWidths, setMatchColumnWidths] = useState(zoneOnlySelection);
  const [rowDistribution, setRowDistribution] = useState<SelectionRowDistribution>('packed');
  const [density, setDensity] = useState<LayoutDensityPolicy>('preserve');
  const tracks = useMemo(
    () => selectionGridTracks(selectionCount, trackAxis, trackCount),
    [selectionCount, trackAxis, trackCount]
  );

  // The toolbar first appears when the second node is selected. Keep following
  // the compact three-track default as that selection grows, but never stomp a
  // count the user explicitly chose; only clamp it when nodes are removed.
  useEffect(() => {
    setTrackCount((current) =>
      trackCountWasEdited.current
        ? Math.max(1, Math.min(selectionCount, current))
        : defaultSelectionTrackCount(selectionCount)
    );
  }, [selectionCount]);

  useEffect(() => {
    setMatchRowHeights(zoneOnlySelection);
    setMatchColumnWidths(zoneOnlySelection);
  }, [zoneOnlySelection]);

  const content = (
    <Space orientation="vertical" size="middle" style={{ width: 280 }}>
      <Segmented
        block
        aria-label="Layout mode"
        options={[
          { label: 'Compact', value: 'compact' },
          { label: 'Grid', value: 'grid' },
        ]}
        value={mode}
        onChange={(value) => setMode(value as SelectionLayoutMode)}
      />
      <LayoutDensityControl
        value={density}
        onChange={setDensity}
        disabled={!densityAvailable}
        disabledReason="Unavailable because this selection has no worktrees or cards with body content."
      />
      {mode === 'compact' ? (
        <Typography.Text type="secondary">
          Packs measured shapes into the smallest stable, collision-free cluster.
        </Typography.Text>
      ) : (
        <>
          <Space.Compact block>
            <Select
              aria-label="Fixed grid axis"
              classNames={{ popup: { root: CANVAS_LAYOUT_CONTROLS_CLASS } }}
              value={trackAxis}
              options={[
                { label: 'Columns', value: 'columns' },
                { label: 'Rows', value: 'rows' },
              ]}
              onChange={setTrackAxis}
              style={{ width: '60%' }}
            />
            <InputNumber
              aria-label={`Number of ${trackAxis}`}
              min={1}
              max={Math.max(1, selectionCount)}
              value={trackCount}
              onChange={(value) => {
                trackCountWasEdited.current = true;
                setTrackCount(value ?? 1);
              }}
              style={{ width: '40%' }}
            />
          </Space.Compact>
          <Typography.Text type="secondary">
            {tracks.columns} column{tracks.columns === 1 ? '' : 's'} × {tracks.rows} row
            {tracks.rows === 1 ? '' : 's'}
          </Typography.Text>
          {zoneOnlySelection ? (
            <>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Typography.Text>Match zone frames to grid</Typography.Text>
                <Switch
                  aria-label="Match zone frames to grid"
                  checked={matchRowHeights && matchColumnWidths}
                  onChange={(checked) => {
                    setMatchRowHeights(checked);
                    setMatchColumnWidths(checked);
                  }}
                />
              </Space>
              <Typography.Text type="secondary">
                Aligns zone borders to column widths and row heights. Turn off to preserve packed
                sizes, which can leave extra space inside larger tracks.
              </Typography.Text>
            </>
          ) : (
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Typography.Text>Match heights within rows</Typography.Text>
              <Switch
                aria-label="Match heights within rows"
                checked={matchRowHeights}
                onChange={setMatchRowHeights}
              />
            </Space>
          )}
          <Select
            aria-label="Row distribution"
            classNames={{ popup: { root: CANVAS_LAYOUT_CONTROLS_CLASS } }}
            value={rowDistribution}
            options={[
              { label: 'Packed rows', value: 'packed' },
              { label: 'Justify rows', value: 'justify' },
            ]}
            onChange={setRowDistribution}
            style={{ width: '100%' }}
          />
        </>
      )}
      <Button
        type="primary"
        block
        onClick={() => {
          void onApply({
            mode,
            trackAxis,
            trackCount,
            matchRowHeights,
            matchColumnWidths,
            rowDistribution,
            density: densityAvailable ? density : 'preserve',
          });
          setOpen(false);
        }}
      >
        Apply layout
      </Button>
    </Space>
  );

  return (
    <Popover
      title="Layout selected items"
      content={content}
      trigger="click"
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setDensity('preserve');
        setOpen(nextOpen);
      }}
      destroyOnHidden
      placement="bottomRight"
      classNames={{ root: CANVAS_LAYOUT_CONTROLS_CLASS }}
    >
      <Button
        size="small"
        icon={<SettingOutlined />}
        aria-label="Layout options"
        aria-expanded={open}
        onMouseDown={(event) => event.stopPropagation()}
      />
    </Popover>
  );
}
