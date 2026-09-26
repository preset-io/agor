/**
 * Advanced Settings Form
 *
 * Advanced configuration options for sessions:
 * - Custom Context (JSON)
 *
 * Used in SessionSettingsModal
 */

import { Form } from 'antd';
import type React from 'react';
import { JSONEditor, validateJSON } from '../JSONEditor';

export interface AdvancedSettingsFormProps {
  /** Whether to show help text under each field */
  showHelpText?: boolean;
  /** Read-only while the full custom context is loading */
  disabled?: boolean;
}

/**
 * Form fields for advanced session settings
 *
 * Expects to be used within a Form context with these field names:
 * - custom_context
 */
export const AdvancedSettingsForm: React.FC<AdvancedSettingsFormProps> = ({
  showHelpText = true,
  disabled = false,
}) => {
  return (
    <Form.Item
      name="custom_context"
      label="Custom Context (JSON)"
      help={
        showHelpText
          ? 'Add custom fields for use in zone trigger templates (e.g., {{ session.context.yourField }})'
          : undefined
      }
      rules={[{ validator: validateJSON }]}
    >
      <JSONEditor
        placeholder='{"teamName": "Backend", "sprintNumber": 42}'
        rows={4}
        disabled={disabled}
      />
    </Form.Item>
  );
};
