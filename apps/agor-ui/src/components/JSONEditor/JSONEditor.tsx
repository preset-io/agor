import { Input } from 'antd';
import type React from 'react';

export interface JSONEditorProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  rows?: number;
}

/**
 * JSON Editor Component
 *
 * A text area for editing JSON with monospace font and validation support.
 * Meant to be used with Ant Design Form.Item validator.
 */
export const JSONEditor: React.FC<JSONEditorProps> = ({
  value,
  onChange,
  placeholder = '{"key": "value"}',
  rows = 4,
}) => {
  return (
    <Input.TextArea
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      style={{ fontFamily: 'monospace' }}
    />
  );
};

/**
 * JSON Validator for Ant Design Form
 *
 * Usage:
 * ```tsx
 * <Form.Item
 *   name="custom_context"
 *   rules={[{ validator: validateJSON }]}
 * >
 *   <JSONEditor />
 * </Form.Item>
 * ```
 */
export const validateJSON = (_: unknown, value: string) => {
  if (!value || value.trim() === '') return Promise.resolve();
  try {
    JSON.parse(value);
    return Promise.resolve();
  } catch (_error) {
    return Promise.reject(new Error('Invalid JSON'));
  }
};
