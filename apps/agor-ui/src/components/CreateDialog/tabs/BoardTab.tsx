import type { Board } from '@agor/core/types';
import { Checkbox, ColorPicker, Flex, Form, Input, Select, Space, Typography } from 'antd';
import { useCallback, useState } from 'react';
import { FormEmojiPickerInput } from '../../EmojiPickerInput';

const BACKGROUND_PRESETS = [
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
    label: 'Dark with purple/pink spots',
    value:
      'radial-gradient(ellipse at top, #1b2735 0%, #090a0f 100%), radial-gradient(circle at 20% 50%, rgba(120, 0, 255, 0.3) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(255, 0, 120, 0.3) 0%, transparent 50%)',
  },
  {
    label: 'Dark with magenta/cyan glow',
    value:
      'radial-gradient(circle at 30% 50%, rgba(255, 0, 255, 0.5), transparent 50%), radial-gradient(circle at 70% 70%, rgba(0, 255, 255, 0.5), transparent 50%), linear-gradient(180deg, #0a0a0a, #1a1a2e)',
  },
];

export interface BoardTabProps {
  onValidityChange: (valid: boolean) => void;
  formRef: React.MutableRefObject<(() => Promise<Partial<Board> | null>) | null>;
}

export const BoardTab: React.FC<BoardTabProps> = ({ onValidityChange, formRef }) => {
  const [form] = Form.useForm();
  const [useCustomCSS, setUseCustomCSS] = useState(false);

  const handleValuesChange = useCallback(() => {
    setTimeout(() => {
      const values = form.getFieldsValue();
      onValidityChange(!!values.name?.trim());
    }, 0);
  }, [form, onValidityChange]);

  formRef.current = async () => {
    try {
      const values = await form.validateFields();
      return {
        name: values.name,
        icon: values.icon || '📋',
        description: values.description,
        background_color: values.background_color
          ? typeof values.background_color === 'string'
            ? values.background_color
            : values.background_color.toHexString()
          : undefined,
      };
    } catch {
      return null;
    }
  };

  return (
    <Form form={form} layout="vertical" onValuesChange={handleValuesChange}>
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
            <Input placeholder="My Board" style={{ flex: 1 }} autoFocus />
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
              setUseCustomCSS(e.target.checked);
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
              : 'Choose a preset or enter any valid CSS background property'}
          </Typography.Text>
        </Space>
      </Form.Item>
    </Form>
  );
};
