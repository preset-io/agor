import {
  type BoardLayoutSettings,
  boardLayoutTracks,
  MAX_LAYOUT_SPACING,
  normalizeBoardLayoutSettings,
} from '@agor/core/layout/board-layout-options';
import { AppstoreOutlined, CompressOutlined, InfoCircleOutlined } from '@ant-design/icons';
import {
  Button,
  Checkbox,
  Collapse,
  Flex,
  InputNumber,
  Segmented,
  Select,
  Space,
  Switch,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { LayoutDensityControl } from './LayoutDensityControl';

export const CANVAS_LAYOUT_CONTROLS_CLASS = 'canvas-layout-controls';

interface LayoutSpacingFieldsProps {
  columnGap: number;
  rowGap: number;
  onChange: (value: { columnGap: number; rowGap: number }) => void;
  outerMargin?: number;
  onOuterMarginChange?: (value: number) => void;
  padding?: number;
  onPaddingChange?: (value: number) => void;
  disabled?: boolean;
}

const ExactSpacingInput = ({
  label,
  ariaLabel,
  value,
  disabled,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) => (
  <Flex vertical gap={2} style={{ flex: '1 1 72px', minWidth: 0 }}>
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {label}
    </Typography.Text>
    <InputNumber
      aria-label={ariaLabel}
      min={0}
      max={MAX_LAYOUT_SPACING}
      step={4}
      value={value}
      disabled={disabled}
      suffix="px"
      onChange={(next) => onChange(next ?? 0)}
      style={{ width: '100%' }}
    />
  </Flex>
);

/** Shared exact-spacing controls for board/selection and zone policy editors. */
export function LayoutSpacingFields({
  columnGap,
  rowGap,
  onChange,
  outerMargin,
  onOuterMarginChange,
  padding,
  onPaddingChange,
  disabled = false,
}: LayoutSpacingFieldsProps) {
  return (
    <Flex gap="small" wrap="wrap">
      <ExactSpacingInput
        label="H gap"
        ariaLabel="Horizontal gap"
        value={columnGap}
        disabled={disabled}
        onChange={(next) => onChange({ columnGap: next, rowGap })}
      />
      <ExactSpacingInput
        label="V gap"
        ariaLabel="Vertical gap"
        value={rowGap}
        disabled={disabled}
        onChange={(next) => onChange({ columnGap, rowGap: next })}
      />
      {outerMargin !== undefined && onOuterMarginChange && (
        <ExactSpacingInput
          label="Margin"
          ariaLabel="Outer cluster margin"
          value={outerMargin}
          disabled={disabled}
          onChange={onOuterMarginChange}
        />
      )}
      {padding !== undefined && onPaddingChange && (
        <ExactSpacingInput
          label="Inset"
          ariaLabel="Zone inner padding"
          value={padding}
          disabled={disabled}
          onChange={onPaddingChange}
        />
      )}
    </Flex>
  );
}

interface LayoutOptionsEditorProps {
  value: BoardLayoutSettings;
  onChange: (value: BoardLayoutSettings) => void;
  itemCount: number;
  densityAvailable?: boolean;
  disabled?: boolean;
}

/** The single production editor used by Arrange Board and selected-item layout. */
export function LayoutOptionsEditor({
  value,
  onChange,
  itemCount,
  densityAvailable = true,
  disabled = false,
}: LayoutOptionsEditorProps) {
  const { token } = theme.useToken();
  const update = (patch: Partial<BoardLayoutSettings>) =>
    onChange(normalizeBoardLayoutSettings({ ...value, ...patch }, itemCount));
  const tracks = boardLayoutTracks(itemCount, value.trackAxis, value.trackCount);
  const gridDisabled = disabled || value.mode === 'compact';
  const packingDisabled = disabled || !value.packZoneContents;
  const infoButton = (title: string, label: string) => (
    <Tooltip title={title} mouseEnterDelay={0.25}>
      <Button
        type="text"
        size="small"
        aria-label={label}
        icon={<InfoCircleOutlined aria-hidden />}
        style={{ width: 24, height: 24, color: token.colorTextTertiary }}
      />
    </Tooltip>
  );

  const advanced = (
    <Flex
      vertical
      gap="small"
      style={{
        maxHeight: 'min(310px, calc(100vh - 360px))',
        overflowY: 'auto',
        paddingInlineEnd: 4,
      }}
    >
      <LayoutDensityControl
        compact
        value={value.density}
        onChange={(density) => update({ density })}
        disabled={disabled || !densityAvailable || !value.packZoneContents}
        disabledReason={
          !value.packZoneContents
            ? 'Unavailable while Pack contents is off.'
            : 'This scope has no worktrees or cards with expandable body content.'
        }
      />
      <Checkbox
        checked={value.resizeZoneFrames}
        disabled={packingDisabled}
        onChange={(event) => update({ resizeZoneFrames: event.target.checked })}
      >
        Match zone frames
      </Checkbox>
      <Checkbox
        checked={value.justifyRows}
        disabled={gridDisabled || packingDisabled || !value.resizeZoneFrames}
        onChange={(event) => update({ justifyRows: event.target.checked })}
      >
        Justify complete rows
      </Checkbox>
      <Select
        aria-label="Last row behavior"
        value={value.lastRow}
        disabled={gridDisabled}
        classNames={{ popup: { root: CANVAS_LAYOUT_CONTROLS_CLASS } }}
        options={[
          { label: 'Last row: left', value: 'start' },
          { label: 'Last row: center', value: 'center' },
          { label: 'Last row: right', value: 'end' },
          {
            label: 'Last row: justify',
            value: 'justify',
            disabled: !value.packZoneContents || !value.resizeZoneFrames,
          },
        ]}
        onChange={(lastRow) => update({ lastRow })}
      />
      <Flex justify="space-between" align="center" gap="small">
        <Typography.Text>Equal row heights</Typography.Text>
        <Switch
          size="small"
          aria-label="Match heights within rows"
          checked={value.matchRowHeights}
          disabled={gridDisabled || !value.resizeZoneFrames}
          onChange={(matchRowHeights) => update({ matchRowHeights })}
        />
      </Flex>
      <Flex justify="space-between" align="center" gap="small">
        <Typography.Text>Equal column widths</Typography.Text>
        <Switch
          size="small"
          aria-label="Match widths within columns"
          checked={value.matchColumnWidths}
          disabled={gridDisabled || !value.resizeZoneFrames}
          onChange={(matchColumnWidths) => update({ matchColumnWidths })}
        />
      </Flex>
    </Flex>
  );

  return (
    <Flex
      vertical
      gap="small"
      style={{ width: 'min(340px, calc(100vw - 44px))', maxWidth: '100%' }}
    >
      <Segmented
        block
        aria-label="Layout mode"
        options={[
          { label: 'Grid', value: 'grid', icon: <AppstoreOutlined aria-hidden /> },
          { label: 'Compact', value: 'compact', icon: <CompressOutlined aria-hidden /> },
        ]}
        value={value.mode}
        disabled={disabled}
        onChange={(mode) => update({ mode: mode as BoardLayoutSettings['mode'] })}
      />
      <Flex gap="small" align="center">
        <Space.Compact block style={{ flex: 1 }}>
          <Select
            aria-label="Grid tracks"
            value={value.trackAxis}
            disabled={gridDisabled}
            classNames={{ popup: { root: CANVAS_LAYOUT_CONTROLS_CLASS } }}
            options={[
              { label: 'Auto tracks', value: 'auto' },
              { label: 'Columns', value: 'columns' },
              { label: 'Rows', value: 'rows' },
            ]}
            onChange={(trackAxis) => update({ trackAxis })}
            style={{ width: '66%' }}
          />
          <InputNumber
            aria-label={
              value.trackAxis === 'rows'
                ? 'Number of rows'
                : value.trackAxis === 'columns'
                  ? 'Number of columns'
                  : 'Track count'
            }
            min={1}
            max={Math.max(1, itemCount)}
            value={value.trackCount}
            disabled={gridDisabled || value.trackAxis === 'auto'}
            onChange={(trackCount) => update({ trackCount: trackCount ?? 1 })}
            style={{ width: '34%' }}
          />
        </Space.Compact>
        {value.mode === 'grid' && value.trackAxis !== 'auto' && (
          <Typography.Text
            type="secondary"
            aria-label="Resolved grid tracks"
            style={{ whiteSpace: 'nowrap' }}
          >
            {tracks.columns}×{tracks.rows}
          </Typography.Text>
        )}
      </Flex>
      <Flex vertical gap={4}>
        <Flex align="center" gap={4}>
          <Typography.Text strong>Spacing</Typography.Text>
          {infoButton(
            'Horizontal and vertical gaps are between roots. Margin is the clear inset around a board layout; selection layouts retain their cluster anchor.',
            'Spacing help'
          )}
        </Flex>
        <LayoutSpacingFields
          columnGap={value.columnGap}
          rowGap={value.rowGap}
          outerMargin={value.outerMargin}
          disabled={disabled}
          onChange={(spacing) => update(spacing)}
          onOuterMarginChange={(outerMargin) => update({ outerMargin })}
        />
      </Flex>
      <Checkbox
        checked={value.packZoneContents}
        disabled={disabled}
        onChange={(event) => update({ packZoneContents: event.target.checked })}
      >
        Pack zone contents
      </Checkbox>
      <Collapse
        ghost
        size="small"
        items={[{ key: 'advanced', label: 'More layout options', children: advanced }]}
      />
    </Flex>
  );
}
