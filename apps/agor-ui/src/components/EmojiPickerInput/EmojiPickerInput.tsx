import { SmileOutlined } from '@ant-design/icons';
import { Button, Form, Input, Popover } from 'antd';
import EmojiPicker, { type EmojiClickData, Theme } from 'emoji-picker-react';
import { useState } from 'react';

interface EmojiPickerInputProps {
  value?: string;
  onChange?: (value: string) => void;
  defaultEmoji?: string;
}

/**
 * Reusable emoji picker input — compact style with emoji preview + picker button.
 * Use directly with value/onChange, or use FormEmojiPickerInput for Ant Design forms.
 */
export const EmojiPickerInput: React.FC<EmojiPickerInputProps> = ({
  value,
  onChange,
  defaultEmoji = '📋',
}) => {
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    onChange?.(emojiData.emoji);
    setPickerOpen(false);
  };

  return (
    <div style={{ display: 'flex', gap: 0 }}>
      <Input
        prefix={<span style={{ fontSize: 14 }}>{value || defaultEmoji}</span>}
        readOnly
        style={{
          cursor: 'default',
          width: 40,
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
        }}
      />
      <Popover
        content={
          <EmojiPicker
            onEmojiClick={handleEmojiClick}
            theme={Theme.DARK}
            width={350}
            height={400}
          />
        }
        trigger="click"
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        placement="right"
      >
        <Button
          icon={<SmileOutlined />}
          style={{
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0,
            borderLeft: 'none',
          }}
        />
      </Popover>
    </div>
  );
};

/**
 * Form.Item wrapper that integrates with Ant Design forms.
 * Thin wrapper around EmojiPickerInput that reads/writes via form.setFieldValue.
 */
export const FormEmojiPickerInput: React.FC<{
  form: ReturnType<typeof Form.useForm>[0];
  fieldName: string;
  defaultEmoji?: string;
}> = ({ form, fieldName, defaultEmoji }) => {
  return (
    <Form.Item noStyle shouldUpdate>
      {() => (
        <EmojiPickerInput
          value={form.getFieldValue(fieldName)}
          onChange={(emoji) => form.setFieldValue(fieldName, emoji)}
          defaultEmoji={defaultEmoji}
        />
      )}
    </Form.Item>
  );
};
