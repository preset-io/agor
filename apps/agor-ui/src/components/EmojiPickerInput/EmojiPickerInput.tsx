import { SmileOutlined } from '@ant-design/icons';
import { Button, Form, Input, Popover } from 'antd';
import EmojiPicker, {
  type EmojiClickData,
  EmojiStyle,
  type PickerProps,
  Theme,
} from 'emoji-picker-react';
import { useState } from 'react';

/**
 * Shared <EmojiPicker /> wrapper that pins CSP-safe and visually-consistent
 * defaults. Always use this instead of importing EmojiPicker directly — the
 * library defaults to EmojiStyle.APPLE which lazy-loads PNGs from
 * cdn.jsdelivr.net, blocked by Agor's default img-src CSP.
 */
export const AgorEmojiPicker: React.FC<Pick<PickerProps, 'onEmojiClick'>> = ({ onEmojiClick }) => (
  <EmojiPicker
    onEmojiClick={onEmojiClick}
    theme={Theme.DARK}
    emojiStyle={EmojiStyle.NATIVE}
    width={350}
    height={400}
  />
);

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
        content={<AgorEmojiPicker onEmojiClick={handleEmojiClick} />}
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
