/**
 * Codex Settings Form
 *
 * Codex-specific configuration fields:
 * - Sandbox Mode
 * - Approval Policy
 * - Network Access
 *
 * Extracted from AgenticToolConfigForm for use as a standalone
 * collapsible section in SessionSettingsModal.
 */

import type { DefaultAgenticToolConfig } from '@agor-live/client';
import { Form, Select } from 'antd';
import type React from 'react';
import { getEffectiveCodexFormValues } from '../AgenticToolConfigForm/agenticConfigHelpers';
import { CodexNetworkAccessToggle } from '../CodexNetworkAccessToggle';
import { CODEX_APPROVAL_POLICIES, CODEX_SANDBOX_MODES } from '../PermissionModeSelector';

export interface CodexSettingsFormProps {
  showHelpText?: boolean;
  /** Caller also materializes effective values on submit (e.g. spawning a child). */
  showEffectiveDefaults?: boolean;
}

export const CodexSettingsForm: React.FC<CodexSettingsFormProps> = ({
  showHelpText = true,
  showEffectiveDefaults = false,
}) => {
  const form = Form.useFormInstance();
  const permissionMode = Form.useWatch('permissionMode', {
    form,
    preserve: true,
  }) as DefaultAgenticToolConfig['permissionMode'];
  const defaults = showEffectiveDefaults
    ? getEffectiveCodexFormValues({ permissionMode })
    : undefined;
  return (
    <>
      <Form.Item
        name="codexSandboxMode"
        label="Sandbox Mode"
        getValueProps={(value) => ({ value: value ?? defaults?.codexSandboxMode })}
        help={
          showHelpText
            ? 'Controls where Codex can write files (workspace vs. full access)'
            : undefined
        }
      >
        <Select
          // onSelect also records choosing the already displayed derived value.
          onSelect={(value) => form.setFieldValue('codexSandboxMode', value)}
          placeholder="Select sandbox mode"
          options={CODEX_SANDBOX_MODES.map(({ value, label, description }) => ({
            value,
            label: `${label} · ${description}`,
          }))}
        />
      </Form.Item>

      <Form.Item
        name="codexApprovalPolicy"
        label="Approval Policy"
        getValueProps={(value) => ({ value: value ?? defaults?.codexApprovalPolicy })}
        help={
          showHelpText ? 'Controls whether Codex must ask before executing commands' : undefined
        }
      >
        <Select
          onSelect={(value) => form.setFieldValue('codexApprovalPolicy', value)}
          placeholder="Select approval policy"
          options={CODEX_APPROVAL_POLICIES.map(({ value, label, description }) => ({
            value,
            label: `${label} · ${description}`,
          }))}
        />
      </Form.Item>

      <Form.Item
        name="codexNetworkAccess"
        label="Network Access"
        help={
          showHelpText
            ? 'Allow outbound HTTP/HTTPS requests (workspace-write sandbox only)'
            : undefined
        }
        valuePropName="checked"
        getValueProps={(value) => ({ checked: value ?? defaults?.codexNetworkAccess })}
      >
        <CodexNetworkAccessToggle showWarning={showHelpText} />
      </Form.Item>
    </>
  );
};
