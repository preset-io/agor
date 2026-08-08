import { CheckCircleFilled } from '@ant-design/icons';
import {
  Alert,
  Button,
  Collapse,
  ColorPicker,
  Form,
  type FormInstance,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Typography,
  theme,
} from 'antd';
import type { AggregationColor } from 'antd/es/color-picker/color';
import { useEffect, useRef, useState } from 'react';
import { hasBoardStyling } from '../../utils/boardBackground';
import { validateBoardCss } from '../../utils/sanitizeCss';
import { BoardBackgroundPreview } from './BoardBackgroundPreview';
import { ANIMATION_PRESETS, BACKGROUND_PRESETS, findPresetByValue } from './boardBackgroundPresets';

export type BackgroundMode = 'default' | 'preset' | 'custom';

/** Derive which editing mode a board's stored values correspond to. */
export function deriveBackgroundMode(
  backgroundColor: string | undefined | null,
  customCss: string | undefined | null
): BackgroundMode {
  if (!hasBoardStyling(backgroundColor, customCss)) return 'default';
  if (!customCss?.trim() && findPresetByValue(backgroundColor)) return 'preset';
  return 'custom';
}

export interface BoardBackgroundEditorProps {
  form: FormInstance;
  /**
   * Changing this value re-syncs the mode from the current form values. Pass a
   * per-board identity (e.g. the board id) so reopening the editor for a board
   * always reflects its saved state — this is what fixes the checkbox/mode
   * losing its state on reopen.
   */
  resetSignal?: string;
}

/**
 * Board background editor with three clear modes:
 *
 *  - **Default** — clears background_color + custom_css; the board renders the
 *    theme-aware default.
 *  - **Preset**  — a gallery rendered with the ACTUAL background CSS (not fake
 *    illustrations) so each thumbnail is a faithful mini-board.
 *  - **Custom**  — raw CSS for power users, plus a compact gradient helper and
 *    optional animation presets.
 *
 * A live preview using the same sanitize/scope path as the canvas sits at the
 * top so readability against representative cards/zones is always visible.
 */
export function BoardBackgroundEditor({ form, resetSignal }: BoardBackgroundEditorProps) {
  const { token } = theme.useToken();

  const backgroundColor = Form.useWatch('background_color', { form, preserve: true }) as
    | string
    | AggregationColor
    | undefined;
  const customCss = Form.useWatch('custom_css', { form, preserve: true }) as string | undefined;

  // Normalize the watched background to a string for preview + preset matching
  // (ColorPicker stores an AggregationColor object until re-serialized on save).
  const bgString =
    typeof backgroundColor === 'string'
      ? backgroundColor
      : backgroundColor
        ? backgroundColor.toHexString()
        : undefined;

  const [mode, setMode] = useState<BackgroundMode>(() =>
    deriveBackgroundMode(form.getFieldValue('background_color'), form.getFieldValue('custom_css'))
  );

  // Re-sync the mode from the freshly-loaded form values whenever the board
  // identity changes. Without this the mode would keep its initial value even
  // after the async board load populates the form (the reopen bug).
  const lastSignal = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal !== lastSignal.current) {
      lastSignal.current = resetSignal;
      setMode(
        deriveBackgroundMode(
          form.getFieldValue('background_color'),
          form.getFieldValue('custom_css')
        )
      );
    }
  }, [resetSignal, form]);

  const selectMode = (next: BackgroundMode) => {
    setMode(next);
    if (next === 'default') {
      form.setFieldsValue({ background_color: undefined, custom_css: undefined });
    } else if (next === 'preset') {
      // Presets are pure backgrounds — drop any layered animation CSS so the
      // "preset" state stays unambiguous and round-trips cleanly on reopen.
      form.setFieldsValue({ custom_css: undefined });
      const asColor = form.getFieldValue('background_color');
      if (asColor && typeof asColor !== 'string') {
        form.setFieldsValue({ background_color: asColor.toHexString() });
      }
    } else if (next === 'custom') {
      const asColor = form.getFieldValue('background_color');
      if (asColor && typeof asColor !== 'string') {
        form.setFieldsValue({ background_color: asColor.toHexString() });
      }
    }
  };

  const bgIssues = validateBoardCss(bgString);
  const cssIssues = validateBoardCss(customCss);
  const allIssues = [...bgIssues, ...cssIssues];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Text
          type="secondary"
          style={{ fontSize: 12, display: 'block', marginBottom: 8 }}
        >
          Live preview
        </Typography.Text>
        <BoardBackgroundPreview
          backgroundColor={bgString}
          customCss={customCss}
          height={150}
          ariaLabel="Live board background preview with sample cards and zone"
        />
      </div>

      <Segmented<BackgroundMode>
        block
        value={mode}
        onChange={selectMode}
        options={[
          { label: 'Default', value: 'default' },
          { label: 'Preset', value: 'preset' },
          { label: 'Custom CSS', value: 'custom' },
        ]}
        aria-label="Background mode"
      />

      {mode === 'default' && (
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          Uses the built-in theme-aware background — a sober, mostly-dark surface that adapts to
          light and dark themes. Nothing is stored on the board.
        </Typography.Text>
      )}

      {mode === 'preset' && (
        <PresetGallery
          selectedValue={bgString}
          onSelect={(value) => form.setFieldsValue({ background_color: value })}
          token={token}
        />
      )}

      {mode === 'custom' && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Typography.Text strong style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>
              Background
            </Typography.Text>
            <Form.Item name="background_color" noStyle>
              <Input.TextArea
                aria-label="Custom background CSS"
                placeholder="e.g. linear-gradient(180deg, #0f131a, #090b10)"
                rows={3}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
            </Form.Item>
          </div>

          <GradientHelper onApply={(value) => form.setFieldsValue({ background_color: value })} />

          <div>
            <Typography.Text strong style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>
              Animation CSS <Typography.Text type="secondary">(optional)</Typography.Text>
            </Typography.Text>
            <Select
              placeholder="Load an animation preset…"
              style={{ width: '100%', marginBottom: 8 }}
              allowClear
              showSearch
              optionFilterProp="label"
              options={ANIMATION_PRESETS.map((preset) => ({
                label: preset.label,
                value: preset.value,
              }))}
              onChange={(value) => form.setFieldsValue({ custom_css: value || undefined })}
            />
            <Form.Item name="custom_css" noStyle>
              <Input.TextArea
                aria-label="Custom animation CSS"
                placeholder="background-size, animation, @keyframes…"
                rows={5}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
            </Form.Item>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Animations are disabled automatically for visitors who prefer reduced motion.
            </Typography.Text>
          </div>
        </Space>
      )}

      {allIssues.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="Some CSS will be removed for safety"
          description={
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {allIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          }
        />
      )}
    </Space>
  );
}

function PresetGallery({
  selectedValue,
  onSelect,
  token,
}: {
  selectedValue: string | undefined;
  onSelect: (value: string) => void;
  token: { colorPrimary: string; colorTextSecondary: string; borderRadiusLG: number };
}) {
  return (
    <fieldset
      style={{
        border: 0,
        margin: 0,
        padding: 0,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
        gap: 12,
      }}
    >
      <legend
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        Background presets
      </legend>
      {BACKGROUND_PRESETS.map((preset) => {
        const selected = selectedValue?.trim() === preset.value;
        return (
          <button
            key={preset.id}
            type="button"
            aria-pressed={selected}
            aria-label={`${preset.label} (${preset.tone})`}
            onClick={() => onSelect(preset.value)}
            style={{
              position: 'relative',
              padding: 3,
              border: `2px solid ${selected ? token.colorPrimary : 'transparent'}`,
              borderRadius: token.borderRadiusLG + 3,
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <BoardBackgroundPreview
              backgroundColor={preset.value}
              height={72}
              variant="thumbnail"
              ariaLabel={`${preset.label} preview`}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginTop: 6,
                paddingInline: 2,
              }}
            >
              <Typography.Text style={{ fontSize: 12 }}>{preset.label}</Typography.Text>
              {selected && <CheckCircleFilled style={{ color: token.colorPrimary }} />}
            </div>
          </button>
        );
      })}
    </fieldset>
  );
}

function GradientHelper({ onApply }: { onApply: (value: string) => void }) {
  const [type, setType] = useState<'linear' | 'radial'>('linear');
  const [angle, setAngle] = useState(180);
  // biome-ignore lint/plugin/noHardcodedColorLiteral: default seed colors for the gradient helper, user-editable
  const [color1, setColor1] = useState('#10141f');
  // biome-ignore lint/plugin/noHardcodedColorLiteral: default seed colors for the gradient helper, user-editable
  const [color2, setColor2] = useState('#3a4a7a');

  const apply = () => {
    const value =
      type === 'linear'
        ? `linear-gradient(${angle}deg, ${color1}, ${color2})`
        : `radial-gradient(circle at 50% 30%, ${color1}, ${color2})`;
    onApply(value);
  };

  return (
    <Collapse
      ghost
      size="small"
      items={[
        {
          key: 'gradient',
          label: <Typography.Text style={{ fontSize: 13 }}>Gradient helper</Typography.Text>,
          children: (
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Space wrap size={10} align="center">
                <Select<'linear' | 'radial'>
                  value={type}
                  onChange={setType}
                  style={{ width: 110 }}
                  aria-label="Gradient type"
                  options={[
                    { label: 'Linear', value: 'linear' },
                    { label: 'Radial', value: 'radial' },
                  ]}
                />
                {type === 'linear' && (
                  <Space size={4} align="center">
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      Angle
                    </Typography.Text>
                    <InputNumber
                      value={angle}
                      onChange={(value) => setAngle(value ?? 0)}
                      min={0}
                      max={360}
                      style={{ width: 72 }}
                      aria-label="Gradient angle in degrees"
                    />
                  </Space>
                )}
                <ColorPicker
                  value={color1}
                  onChange={(c) => setColor1(c.toHexString())}
                  aria-label="Gradient color one"
                />
                <ColorPicker
                  value={color2}
                  onChange={(c) => setColor2(c.toHexString())}
                  aria-label="Gradient color two"
                />
                <Button size="small" onClick={apply}>
                  Apply to background
                </Button>
              </Space>
            </Space>
          ),
        },
      ]}
    />
  );
}
