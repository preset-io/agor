/**
 * Agentic Tool Configuration Form
 *
 * Reusable form section for configuring agentic tool settings:
 * - Model selection (Claude/Codex/Gemini specific)
 * - Permission mode
 * - Codex-specific fields (sandbox, approval, network) — only in full mode
 *
 * Used by session creation, settings, defaults, schedules, gateway channels,
 * forks/spawns, and zone triggers.
 *
 * In compact mode:
 * - PermissionModeSelector renders as a dropdown instead of radio group
 * - Codex-specific fields are omitted (rendered separately via CodexSettingsForm)
 */

import { AGENTIC_TOOL_CAPABILITIES, getAgenticToolModelSelectionError } from '@agor/agentic-tools';
import { getAgenticToolUIIntegration } from '@agor/agentic-tools/ui';
import type { AgenticToolName, AgorClient } from '@agor-live/client';
import { DEFAULT_CLAUDE_MODEL } from '@agor-live/client';
import { Form, Select } from 'antd';
import { CodexNetworkAccessToggle } from '../CodexNetworkAccessToggle';
import { EffortSelector } from '../EffortSelector';
import { ModelSelector } from '../ModelSelector';
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  PermissionModeSelector,
} from '../PermissionModeSelector';
import { FIELD_WIDTHS } from '../SettingsModal/panelPrimitives';

export interface AgenticToolConfigFormProps {
  /** The agentic tool being configured */
  agenticTool: AgenticToolName;
  /** Whether to show help text under each field */
  showHelpText?: boolean;
  /**
   * Compact mode for edit contexts (e.g., SessionSettingsModal).
   * - Permission mode renders as a Select dropdown instead of radio group.
   * - Codex-specific fields (sandbox, approval, network) are omitted.
   *   Use CodexSettingsForm separately for those.
   */
  compact?: boolean;
  /**
   * Optional Feathers client. When set, the embedded ModelSelector can fetch
   * dynamic Copilot models via `/copilot-models`. Without it, the picker
   * silently uses the static fallback — fine for forms that don't need
   * dynamic discovery (e.g., default-settings preview, schedule editor).
   */
  client?: AgorClient | null;
  /** Optional authorized branch scope for integration-owned model discovery. */
  branchId?: string;
  /**
   * Render the Claude advisor model inline with the model selector. Surfaces
   * that relocate it into their own "Advanced" area pass `false`.
   */
  showAdvisor?: boolean;
}

const MODEL_LABELS: Record<string, string> = {
  codex: 'Codex Model',
  gemini: 'Gemini Model',
  copilot: 'Copilot Model',
  cursor: 'Cursor Model',
};

/** The rendered label of a tool's model/provider selector (defaults to Claude). */
export const modelLabelForTool = (tool: AgenticToolName): string =>
  getAgenticToolUIIntegration(tool)?.modelLabel ?? MODEL_LABELS[tool] ?? 'Claude Model';

export const AgenticToolConfigForm: React.FC<AgenticToolConfigFormProps> = ({
  agenticTool,
  showHelpText = true,
  compact = false,
  client,
  branchId,
  showAdvisor = true,
}) => {
  const modelLabel = modelLabelForTool(agenticTool);
  const showCodexFields = agenticTool === 'codex' && !compact;
  const toolCapabilities = AGENTIC_TOOL_CAPABILITIES[agenticTool];
  const effortLevels = toolCapabilities.reasoningEffortLevels;

  return (
    <>
      <Form.Item
        name="modelConfig"
        label={modelLabel}
        // Model / Permission were full-bleed; cap to `short`. Effort keeps its
        // intrinsic 160 — a 5-option enum shouldn't be stretched to match.
        style={FIELD_WIDTHS.short}
        rules={[
          {
            validator: (_, value) => {
              const error = getAgenticToolModelSelectionError(agenticTool, value);
              return error ? Promise.reject(new Error(error)) : Promise.resolve();
            },
          },
        ]}
        help={
          showHelpText && agenticTool === 'claude-code'
            ? `Choose which Claude model to use (defaults to ${DEFAULT_CLAUDE_MODEL})`
            : undefined
        }
      >
        <ModelSelector
          agentic_tool={agenticTool}
          client={client}
          branchId={branchId}
          showAdvisor={showAdvisor}
        />
      </Form.Item>

      <Form.Item
        name="permissionMode"
        label="Permission Mode"
        style={FIELD_WIDTHS.short}
        help={showHelpText ? 'Control how the agent handles tool execution approvals' : undefined}
      >
        <PermissionModeSelector agentic_tool={agenticTool} compact={compact} fullWidth />
      </Form.Item>

      {effortLevels && (
        <Form.Item
          name="effort"
          label="Reasoning Effort"
          help={
            showHelpText
              ? toolCapabilities.defaultReasoningEffort
                ? 'Control how much reasoning the agent applies'
                : 'Control how much reasoning the agent applies; inherited uses the runtime configuration'
              : undefined
          }
        >
          <EffortSelector
            levels={effortLevels}
            fallbackValue={toolCapabilities.defaultReasoningEffort}
            allowInherited={!toolCapabilities.defaultReasoningEffort}
          />
        </Form.Item>
      )}

      {showCodexFields && (
        <Form.Item
          name="codexSandboxMode"
          label="Sandbox Mode"
          style={FIELD_WIDTHS.medium}
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
          style={FIELD_WIDTHS.medium}
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
    </>
  );
};
