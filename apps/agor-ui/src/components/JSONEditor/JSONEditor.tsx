import type React from 'react';
import { CodeEditor } from '../CodeEditor';

export interface JSONEditorProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  rows?: number;
}

/**
 * JSON Editor Component
 *
 * Backed by CodeMirror 6 (lazy-loaded — CM6 only ships when an editor is
 * actually rendered). Preserves the original textarea-era API so existing
 * call sites (CardsTable, BoardsTable, GatewayChannelsTable,
 * AdvancedSettingsForm, ThemeEditorModal) keep working unchanged.
 *
 * Pair with `validateJSON` as an Ant Design Form.Item validator.
 */
export const JSONEditor: React.FC<JSONEditorProps> = ({
  value,
  onChange,
  placeholder = '{"key": "value"}',
  rows = 4,
}) => (
  <CodeEditor
    value={value ?? ''}
    onChange={onChange}
    language="json"
    placeholder={placeholder}
    rows={rows}
  />
);

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
