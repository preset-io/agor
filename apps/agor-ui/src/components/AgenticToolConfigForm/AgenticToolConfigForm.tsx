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
import { Form } from 'antd';
import { CodexNetworkAccessToggle } from '../CodexNetworkAccessToggle';
import { MCPServerSelect } from '../MCPServerSelect';
import { ModelSelector } from '../ModelSelector';
import { PermissionModeSelector } from '../PermissionModeSelector';

export interface AgenticToolConfigFormProps {
  /** The agentic tool being configured */
  agenticTool: AgenticToolName;
  /** Available MCP servers */
  mcpServers: MCPServer[];
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
  mcpServers,
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
        <MCPServerSelect mcpServers={mcpServers} placeholder="No MCP servers attached" />
      </Form.Item>
    </>
  );
};
