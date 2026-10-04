import {
  type BoardLayoutSettings,
  boardLayoutTracks,
  boardZoneArrangementOptions,
  DEFAULT_BOARD_LAYOUT_SETTINGS,
  normalizeBoardLayoutSettings,
} from '@agor/core/layout/board-layout-options';
import type { BoardZoneArrangementOptions } from '@agor/core/layout/board-zone-arrangement';
import { SettingOutlined } from '@ant-design/icons';
import { Button, Popover, Space } from 'antd';
import { useRef, useState } from 'react';
import { CANVAS_LAYOUT_CONTROLS_CLASS, LayoutOptionsEditor } from './LayoutOptionsEditor';

export { CANVAS_LAYOUT_CONTROLS_CLASS };
export type SelectionLayoutMode = BoardLayoutSettings['mode'];
export type SelectionTrackAxis = Exclude<BoardLayoutSettings['trackAxis'], 'auto'>;
export type SelectionRowDistribution = 'packed' | 'justify';
export type SelectionLayoutSettings = BoardLayoutSettings;

/** Compatibility helper retained for callers while track math stays core-owned. */
export function selectionGridTracks(
  itemCount: number,
  axis: SelectionTrackAxis,
  requestedCount: number
): { columns: number; rows: number } {
  const tracks = boardLayoutTracks(itemCount, axis, requestedCount);
  return { columns: tracks.columns ?? 1, rows: tracks.rows ?? 1 };
}

/** Compatibility name; all translation is now owned by the core contract. */
export function selectionBoardZoneArrangementOptions(
  selectionCount: number,
  settings?: Partial<SelectionLayoutSettings>
): Omit<BoardZoneArrangementOptions, 'looseItems'> {
  return boardZoneArrangementOptions(settings, selectionCount);
}

interface SelectionLayoutPopoverProps {
  selectionCount: number;
  zoneOnlySelection: boolean;
  densityAvailable?: boolean;
  settings?: BoardLayoutSettings;
  onSettingsChange?: (settings: BoardLayoutSettings) => void;
  onApply: (settings: SelectionLayoutSettings) => void | Promise<void>;
}

export function SelectionLayoutPopover({
  selectionCount,
  densityAvailable = true,
  settings: controlledSettings,
  onSettingsChange,
  onApply,
}: SelectionLayoutPopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [localSettings, setLocalSettings] = useState(() =>
    normalizeBoardLayoutSettings(DEFAULT_BOARD_LAYOUT_SETTINGS, selectionCount)
  );
  const settings = normalizeBoardLayoutSettings(
    controlledSettings ?? localSettings,
    selectionCount
  );
  const setSettings = (next: BoardLayoutSettings) => {
    const normalized = normalizeBoardLayoutSettings(next, selectionCount);
    setLocalSettings(normalized);
    onSettingsChange?.(normalized);
  };

  return (
    <Popover
      title="Layout selected items"
      content={
        <Space orientation="vertical" size="middle">
          <LayoutOptionsEditor
            value={settings}
            onChange={setSettings}
            itemCount={selectionCount}
            densityAvailable={densityAvailable}
          />
          <Button
            type="primary"
            block
            onClick={() => {
              void onApply(settings);
              setOpen(false);
              triggerRef.current?.focus();
            }}
          >
            Apply layout
          </Button>
        </Space>
      }
      trigger="click"
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setSettings({ ...settings, density: 'preserve' });
        setOpen(nextOpen);
        if (!nextOpen) requestAnimationFrame(() => triggerRef.current?.focus());
      }}
      destroyOnHidden
      placement="bottomRight"
      classNames={{ root: CANVAS_LAYOUT_CONTROLS_CLASS }}
    >
      <Button
        ref={triggerRef}
        size="small"
        icon={<SettingOutlined />}
        aria-label="Layout options"
        aria-expanded={open}
        onMouseDown={(event) => event.stopPropagation()}
      />
    </Popover>
  );
}
