/**
 * Agentic Tool Configuration Form
 *
 * Reusable form section for configuring agentic tool settings:
 * - Model selection (Claude/Codex/Gemini specific)
 * - Permission mode
 * - MCP server attachments
 *
 * Used in both NewSessionModal and SessionSettingsModal
 */

import type { AgenticToolName, MCPServer } from '@agor/core/types';
import { Form, Select } from 'antd';
import { mapToArray } from '@/utils/mapHelpers';
import { CodexNetworkAccessToggle } from '../CodexNetworkAccessToggle';
import { MCPServerSelect } from '../MCPServerSelect';
import { ModelSelector } from '../ModelSelector';
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  PermissionModeSelector,
} from '../PermissionModeSelector';

export interface AgenticToolConfigFormProps {
  /** The agentic tool being configured */
  agenticTool: AgenticToolName;
  /** Available MCP servers */
  mcpServerById: Map<string, MCPServer>;
  /** Whether to show help text under each field */
  showHelpText?: boolean;
}

/**
 * Form fields for agentic tool configuration
 *
 * Expects to be used within a Form context with these field names:
 * - modelConfig
 * - permissionMode
 * - mcpServerIds
 */
export const AgenticToolConfigForm: React.FC<AgenticToolConfigFormProps> = ({
  agenticTool,
  mcpServerById,
  showHelpText = true,
}) => {
  // Get model label based on tool
  const getModelLabel = () => {
    switch (agenticTool) {
      case 'codex':
        return 'Codex Model';
      case 'gemini':
        return 'Gemini Model';
      case 'opencode':
        return 'OpenCode LLM Provider';
      default:
        return 'Claude Model';
    }
  };

  return (
    <>
      <Form.Item
        name="modelConfig"
        label={getModelLabel()}
        help={
          showHelpText
            ? agenticTool === 'claude-code'
              ? 'Choose which Claude model to use (defaults to claude-sonnet-4-5-latest)'
              : undefined
            : undefined
        }
      >
        <ModelSelector agentic_tool={agenticTool} />
      </Form.Item>

      <Form.Item
        name="permissionMode"
        label="Permission Mode"
        help={showHelpText ? 'Control how the agent handles tool execution approvals' : undefined}
      >
        <PermissionModeSelector agentic_tool={agenticTool} />
      </Form.Item>

      {agenticTool === 'codex' && (
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
      )}

      {agenticTool === 'codex' && (
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
      )}

      {agenticTool === 'codex' && (
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
      )}

      <Form.Item
        name="mcpServerIds"
        label="MCP Servers"
        help={showHelpText ? 'Select MCP servers to make available in this session' : undefined}
      >
        <MCPServerSelect
          mcpServers={mapToArray(mcpServerById)}
          placeholder="No MCP servers attached"
        />
      </Form.Item>
    </>
  );
};
