import type { FormInstance } from 'antd';
import { Checkbox, ColorPicker, Flex, Form, Input, Select, Space, Typography } from 'antd';
import { FormEmojiPickerInput } from '../EmojiPickerInput';

export const BACKGROUND_PRESETS = [
  {
    label: 'Rainbow (7 colors)',
    value:
      'linear-gradient(to right, #ff0000, #ff7f00, #ffff00, #00ff00, #0000ff, #4b0082, #9400d3)',
  },
  {
    label: 'Multi-color gradient',
    value:
      'linear-gradient(124deg, #ff2400, #e81d1d, #e8b71d, #e3e81d, #1de840, #1ddde8, #2b1de8, #dd00f3, #dd00f3)',
  },
  {
    label: 'Pink to blue gradient',
    value:
      'linear-gradient(180deg, #f093fb 0%, #f5576c 25%, #4facfe 50%, #00f2fe 75%, #43e97b 100%)',
  },
  {
    label: 'Gold shimmer',
    value: 'linear-gradient(135deg, #f5af19 0%, #f12711 30%, #f5af19 60%, #f12711 100%)',
  },
  {
    label: 'Cyan/magenta grid',
    value:
      'repeating-linear-gradient(0deg, transparent, transparent 2px, #0ff 2px, #0ff 4px), repeating-linear-gradient(90deg, transparent, transparent 2px, #f0f 2px, #f0f 4px), linear-gradient(180deg, #000, #001a1a)',
  },
  {
    label: 'Diagonal stripes (colorful)',
    value:
      'repeating-linear-gradient(45deg, #ff006e 0px, #ff006e 10px, #ffbe0b 10px, #ffbe0b 20px, #8338ec 20px, #8338ec 30px, #3a86ff 30px, #3a86ff 40px)',
  },
  {
    label: 'Conic gradient (warm colors)',
    value:
      'conic-gradient(from 45deg, #ff0080, #ff8c00, #40e0d0, #ff0080, #ff8c00, #40e0d0, #ff0080)',
  },
  {
    label: 'Dark with purple/pink spots',
    value:
      'radial-gradient(ellipse at top, #1b2735 0%, #090a0f 100%), radial-gradient(circle at 20% 50%, rgba(120, 0, 255, 0.3) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(255, 0, 120, 0.3) 0%, transparent 50%)',
  },
  {
    label: 'Quadrant blocks (conic)',
    value:
      'repeating-conic-gradient(from 0deg at 50% 50%, #ff006e 0deg 90deg, #8338ec 90deg 180deg, #3a86ff 180deg 270deg, #fb5607 270deg 360deg)',
  },
  {
    label: 'RGB stripes',
    value:
      'linear-gradient(90deg, #000 0%, #f00 20%, #000 21%, #0f0 40%, #000 41%, #00f 60%, #000 61%, #fff 80%, #000 81%)',
  },
  {
    label: 'Fine diagonal lines (B&W)',
    value: 'repeating-linear-gradient(45deg, #000, #000 1px, #fff 1px, #fff 2px)',
  },
  {
    label: 'Dark with magenta/cyan glow',
    value:
      'radial-gradient(circle at 30% 50%, rgba(255, 0, 255, 0.5), transparent 50%), radial-gradient(circle at 70% 70%, rgba(0, 255, 255, 0.5), transparent 50%), linear-gradient(180deg, #0a0a0a, #1a1a2e)',
  },
  {
    label: 'Sunburst (conic)',
    value:
      'conic-gradient(from 0deg, #ffbe0b 0deg, #fb5607 60deg, #ff006e 120deg, #8338ec 180deg, #3a86ff 240deg, #ffbe0b 300deg, #fb5607 360deg)',
  },
  {
    label: 'Checkerboard (purple)',
    value: 'repeating-linear-gradient(45deg, #606dbc, #606dbc 10px, #465298 10px, #465298 20px)',
  },
];

/**
 * Animation CSS presets — each sets background-size + animation + @keyframes.
 * Designed to pair with gradient backgrounds from BACKGROUND_PRESETS.
 */
export const ANIMATION_PRESETS = [
  {
    label: 'Slow gradient shift (12s)',
    value: `background-size: 400% 400%;
animation: agorGradientShift 12s ease infinite;

@keyframes agorGradientShift {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}`,
  },
  {
    label: 'Fast gradient shift (4s)',
    value: `background-size: 400% 400%;
animation: agorGradientFast 4s ease infinite;

@keyframes agorGradientFast {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}`,
  },
  {
    label: 'Diagonal sweep (8s)',
    value: `background-size: 400% 400%;
animation: agorDiagonalSweep 8s linear infinite;

@keyframes agorDiagonalSweep {
  0% { background-position: 0% 0%; }
  50% { background-position: 100% 100%; }
  100% { background-position: 0% 0%; }
}`,
  },
  {
    label: 'Pulse zoom (6s)',
    value: `background-size: 200% 200%;
animation: agorPulse 6s ease-in-out infinite;

@keyframes agorPulse {
  0%, 100% { background-size: 200% 200%; background-position: center; }
  50% { background-size: 300% 300%; background-position: center; }
}`,
  },
  {
    label: 'Horizontal scroll (20s)',
    value: `background-size: 200% 100%;
animation: agorHScroll 20s linear infinite;

@keyframes agorHScroll {
  0% { background-position: 0% 50%; }
  100% { background-position: 200% 50%; }
}`,
  },
  {
    label: 'Rotate (conic, 10s)',
    value: `animation: agorRotate 10s linear infinite;

@keyframes agorRotate {
  0% { filter: hue-rotate(0deg); }
  100% { filter: hue-rotate(360deg); }
}`,
  },
];

export interface BoardFormFieldsProps {
  form: FormInstance;
  useCustomCSS: boolean;
  onCustomCSSChange: (checked: boolean) => void;
  /** Whether to auto-focus the name input */
  autoFocus?: boolean;
  /** Extra content rendered after the background section (e.g. custom context JSON) */
  extra?: React.ReactNode;
}

/**
 * Shared board form fields used in the CreateDialog BoardTab
 * and the SettingsModal BoardsTable create/edit modals.
 *
 * Renders: Name (icon + text), Description, Background (color picker / CSS presets).
 * Does NOT render a <Form> wrapper — the parent owns the form instance.
 */
export const BoardFormFields: React.FC<BoardFormFieldsProps> = ({
  form,
  useCustomCSS,
  onCustomCSSChange,
  autoFocus,
  extra,
}) => {
  return (
    <>
      <Form.Item label="Name" style={{ marginBottom: 24 }}>
        <Flex gap={8}>
          <Form.Item name="icon" noStyle>
            <FormEmojiPickerInput form={form} fieldName="icon" defaultEmoji="📋" />
          </Form.Item>
          <Form.Item
            name="name"
            noStyle
            style={{ flex: 1 }}
            rules={[{ required: true, message: 'Please enter a board name' }]}
          >
            <Input placeholder="My Board" style={{ flex: 1 }} autoFocus={autoFocus} />
          </Form.Item>
        </Flex>
      </Form.Item>

      <Form.Item label="Description" name="description">
        <Input.TextArea placeholder="Optional description..." rows={3} />
      </Form.Item>

      <Form.Item label="Background">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Checkbox
            checked={useCustomCSS}
            onChange={(e) => {
              onCustomCSSChange(e.target.checked);
              if (e.target.checked) {
                form.setFieldsValue({ background_color: undefined });
              }
            }}
          >
            Use custom CSS background
          </Checkbox>

          {!useCustomCSS ? (
            <Form.Item name="background_color" noStyle>
              <ColorPicker showText format="hex" allowClear />
            </Form.Item>
          ) : (
            <>
              <Select
                placeholder="Load a preset..."
                style={{ width: '100%', marginBottom: 8 }}
                allowClear
                showSearch
                options={BACKGROUND_PRESETS}
                onChange={(value) => {
                  if (value) {
                    form.setFieldsValue({ background_color: value });
                  }
                }}
              />
              <Form.Item name="background_color" noStyle>
                <Input.TextArea
                  placeholder="Enter custom CSS or select a preset above"
                  rows={3}
                  style={{ fontFamily: 'monospace', fontSize: '12px' }}
                />
              </Form.Item>
            </>
          )}

          <Typography.Text
            type="secondary"
            style={{ fontSize: '12px', display: 'block', marginTop: 4 }}
          >
            {!useCustomCSS
              ? 'Set a solid background color for the board canvas'
              : 'Choose a preset or enter any valid CSS background property (gradients, patterns, etc.)'}
          </Typography.Text>
        </Space>
      </Form.Item>

      {useCustomCSS && (
        <Form.Item
          label="Animation CSS"
          tooltip="Add @keyframes, animation, background-size, and other CSS properties. Rendered in a scoped <style> tag."
        >
          <Select
            placeholder="Load an animation preset..."
            style={{ width: '100%', marginBottom: 8 }}
            allowClear
            showSearch
            options={ANIMATION_PRESETS}
            onChange={(value) => {
              if (value) {
                form.setFieldsValue({ custom_css: value });
              }
            }}
          />
          <Form.Item name="custom_css" noStyle>
            <Input.TextArea
              placeholder={`@keyframes bioGlow {\n  0%, 100% { background-position: 0% 50%; }\n  50% { background-position: 100% 50%; }\n}\n\nbackground-size: 400% 400%;\nanimation: bioGlow 12s ease infinite;`}
              rows={6}
              style={{ fontFamily: 'monospace', fontSize: '12px' }}
            />
          </Form.Item>
          <Typography.Text
            type="secondary"
            style={{ fontSize: '12px', display: 'block', marginTop: 4 }}
          >
            Supports @keyframes, animation, background-size, and other CSS. Dangerous patterns (url,
            expression, @import) are blocked for security.
          </Typography.Text>
        </Form.Item>
      )}

      {extra}
    </>
  );
};
