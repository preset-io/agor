/**
 * Callback Configuration Form
 *
 * Allows configuring parent session callback behavior for child session completions:
 * - Enable/disable callbacks
 * - Customize callback message template
 * - Control last message inclusion
 */

import { Form, Input, Select, Switch, Typography } from 'antd';
import type React from 'react';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

export interface CallbackConfigFormProps {
  showHelpText?: boolean;
}

/**
 * Callback Configuration Form Component
 *
 * Used in SessionSettingsModal to configure callback behavior
 */
export const CallbackConfigForm: React.FC<CallbackConfigFormProps> = ({ showHelpText = false }) => {
  return (
    <>
      {/* Enable/Disable Callbacks */}
      <Form.Item
        name={['callbackConfig', 'enabled']}
        label="Enable Completion Callbacks"
        valuePropName="checked"
      >
        <Switch />
      </Form.Item>
      {showHelpText && (
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: -16, marginBottom: 16 }}>
          When this session completes a task, notify its configured callback target. Child sessions
          keep their own callback settings; changing this does not transfer their results.
        </Paragraph>
      )}

      <Form.Item
        name={['callbackConfig', 'mode']}
        label="Callback mode"
        extra="Use Persistent for coordinators awaiting child results: C completes → B processes the result → B completes → A is notified. B's initial delegation turn can also notify A. Once is consumed by the first completion, not the end of a descendant chain."
      >
        <Select
          virtual={false}
          options={[
            { value: 'persistent', label: 'Persistent — every completion until unlinked' },
            { value: 'once', label: 'Once — next completion only' },
          ]}
        />
      </Form.Item>

      {/* Include Last Message Toggle */}
      <Form.Item
        name={['callbackConfig', 'includeLastMessage']}
        label="Include Child's Final Answer"
        valuePropName="checked"
      >
        <Switch defaultChecked />
      </Form.Item>
      {showHelpText && (
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: -16, marginBottom: 16 }}>
          Include the child session's last assistant message in the callback. Disable if you only
          want task status and statistics.
        </Paragraph>
      )}

      {/* Custom Template (Optional) */}
      <Form.Item
        name={['callbackConfig', 'template']}
        label={
          <>
            Custom Template <Text type="secondary">(Optional)</Text>
          </>
        }
      >
        <TextArea
          placeholder="Leave empty to use default template..."
          autoSize={{ minRows: 4, maxRows: 12 }}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Form.Item>
      {showHelpText && (
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: -16 }}>
          Advanced: Customize the callback message template using Handlebars syntax. Available
          variables: <Text code>childSessionId</Text>, <Text code>childSessionTitle</Text>,{' '}
          <Text code>spawnPrompt</Text>, <Text code>status</Text>, <Text code>messageCount</Text>,{' '}
          <Text code>toolUseCount</Text>, <Text code>lastAssistantMessage</Text>
        </Paragraph>
      )}
    </>
  );
};
