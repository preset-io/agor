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

import { Form, Select } from 'antd';
import type React from 'react';
import { CodexNetworkAccessToggle } from '../CodexNetworkAccessToggle';
import { CODEX_APPROVAL_POLICIES, CODEX_SANDBOX_MODES } from '../PermissionModeSelector';

export interface CodexSettingsFormProps {
  showHelpText?: boolean;
}

export const CodexSettingsForm: React.FC<CodexSettingsFormProps> = ({ showHelpText = true }) => {
  return (
    <>
      <Form.Item
        name="codexSandboxMode"
        label="Sandbox Mode"
        help={
          showHelpText
            ? 'Controls where Codex can write files (workspace vs. full access)'
            : undefined
        }
      >
        <Select
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
        help={
          showHelpText ? 'Controls whether Codex must ask before executing commands' : undefined
        }
      >
        <Select
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
      >
        <CodexNetworkAccessToggle showWarning={showHelpText} />
      </Form.Item>
    </>
  );
};
