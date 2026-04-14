/**
 * Agentic Tool Configuration Form
 *
 * Reusable form section for configuring agentic tool settings:
 * - Model selection (Claude/Codex/Gemini specific)
 * - Permission mode
 * - MCP server attachments
 * - Codex-specific fields (sandbox, approval, network) — only in full mode
 *
 * Used in both NewSessionModal (full mode) and SessionSettingsModal (compact mode).
 *
 * In compact mode:
 * - PermissionModeSelector renders as a dropdown instead of radio group
 * - Codex-specific fields are omitted (rendered separately via CodexSettingsForm)
 */

import type { AgenticToolName, MCPServer } from '@agor-live/client';
import { Form, Select } from 'antd';
import { mapToArray } from '@/utils/mapHelpers';
import { useServiceReadable } from '../../hooks/useServicesConfig';
import { CodexNetworkAccessToggle } from '../CodexNetworkAccessToggle';
import { EffortSelector } from '../EffortSelector';
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
  /**
   * Compact mode for edit contexts (e.g., SessionSettingsModal).
   * - Permission mode renders as a Select dropdown instead of radio group.
   * - Codex-specific fields (sandbox, approval, network) are omitted.
   *   Use CodexSettingsForm separately for those.
   */
  compact?: boolean;
}

const MODEL_LABELS: Record<string, string> = {
  codex: 'Codex Model',
  gemini: 'Gemini Model',
  opencode: 'OpenCode LLM Provider',
  copilot: 'Copilot Model',
};

export const AgenticToolConfigForm: React.FC<AgenticToolConfigFormProps> = ({
  agenticTool,
  mcpServerById,
  showHelpText = true,
  compact = false,
}) => {
  const modelLabel = MODEL_LABELS[agenticTool] ?? 'Claude Model';
  const showCodexFields = agenticTool === 'codex' && !compact;
  const mcpReadable = useServiceReadable('mcp_servers');

  return (
    <>
      <Form.Item
        name="modelConfig"
        label={modelLabel}
        help={
          showHelpText && agenticTool === 'claude-code'
            ? 'Choose which Claude model to use (defaults to claude-sonnet-4-6)'
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
        <PermissionModeSelector agentic_tool={agenticTool} compact={compact} />
      </Form.Item>

      {agenticTool === 'claude-code' && (
        <Form.Item
          name="effort"
          label="Reasoning Effort"
          help={
            showHelpText
              ? 'Control how much reasoning Claude applies (low = fast, high = thorough, max = Opus only)'
              : undefined
          }
        >
          <EffortSelector />
        </Form.Item>
      )}

      {showCodexFields && (
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

      {showCodexFields && (
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

      {showCodexFields && (
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

      {mcpReadable && (
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
      )}
    </>
  );
};
