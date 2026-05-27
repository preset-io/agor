/**
 * Shared helpers for converting between DefaultAgenticToolConfig and Ant Design form values.
 *
 * These centralize the logic for:
 * - Initializing form fields from a stored config
 * - Building a config object from form values (for persistence)
 * - Clearing form fields to defaults
 *
 * Used by DefaultAgenticSettings, UserSettingsModal, and NewSessionModal.
 */

import type {
  AgenticToolName,
  DefaultAgenticToolConfig,
  DefaultModelConfig,
  EffortLevel,
  ScheduleAgenticToolConfig,
} from '@agor-live/client';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_GEMINI_MODEL,
  getDefaultPermissionMode,
} from '@agor-live/client';

/**
 * Default `modelConfig` for a tool when neither the user nor the form
 * has picked one. Mirrors `ModelSelector`'s visible default so the
 * submitted config matches what the picker displays.
 *
 * Returns undefined for tools whose default depends on async data
 * (`cursor` — model list fetched from the daemon; the caller can still
 * submit `undefined` and let the daemon side fall back). For `opencode`
 * we deliberately return undefined as well: the OpenCode picker needs
 * both provider and model, and there's no static "first valid combo" we
 * can hard-code without taking a stance the picker doesn't take itself.
 */
export function getDefaultModelConfigForTool(
  tool: AgenticToolName
): DefaultModelConfig | undefined {
  switch (tool) {
    case 'claude-code':
    case 'claude-code-cli':
      return { mode: 'alias', model: DEFAULT_CLAUDE_MODEL };
    case 'codex':
      return { mode: 'alias', model: DEFAULT_CODEX_MODEL };
    case 'gemini':
      return { mode: 'alias', model: DEFAULT_GEMINI_MODEL };
    case 'copilot':
      return { mode: 'alias', model: DEFAULT_COPILOT_MODEL };
    default:
      // cursor / opencode — defaults live elsewhere or require async data.
      return undefined;
  }
}

/**
 * Form field values shape used by AgenticToolConfigForm.
 *
 * `effort` is stored inside `modelConfig` in the DB but surfaced as a
 * separate form field so the EffortSelector can bind to it independently
 * of the ModelSelector.
 */
export interface AgenticFormValues {
  modelConfig?: DefaultModelConfig;
  effort?: EffortLevel;
  permissionMode?: string;
  mcpServerIds?: string[];
  codexSandboxMode?: string;
  codexApprovalPolicy?: string;
  codexNetworkAccess?: boolean;
}

/**
 * Convert a stored DefaultAgenticToolConfig into form field values.
 * Returns sensible defaults when config is undefined.
 */
export function getFormValuesFromConfig(
  tool: AgenticToolName,
  config?: DefaultAgenticToolConfig
): AgenticFormValues {
  if (!config) {
    return {
      permissionMode: getDefaultPermissionMode(tool),
      mcpServerIds: [],
    };
  }

  return {
    modelConfig: config.modelConfig,
    effort: config.modelConfig?.effort,
    permissionMode: config.permissionMode || getDefaultPermissionMode(tool),
    mcpServerIds: config.mcpServerIds || [],
    ...(tool === 'codex' && {
      codexSandboxMode: config.codexSandboxMode,
      codexApprovalPolicy: config.codexApprovalPolicy,
      codexNetworkAccess: config.codexNetworkAccess,
    }),
  };
}

/**
 * Convert form field values back into a DefaultAgenticToolConfig for persistence.
 * Merges the standalone `effort` field back into `modelConfig`.
 */
export function buildConfigFromFormValues(
  tool: AgenticToolName,
  values: AgenticFormValues
): DefaultAgenticToolConfig {
  // Merge effort back into modelConfig
  const modelConfig = values.modelConfig
    ? { ...values.modelConfig, effort: values.effort }
    : values.effort
      ? { effort: values.effort }
      : undefined;

  return {
    modelConfig,
    permissionMode: values.permissionMode as DefaultAgenticToolConfig['permissionMode'],
    mcpServerIds: values.mcpServerIds,
    ...(tool === 'codex' && {
      codexSandboxMode: values.codexSandboxMode as DefaultAgenticToolConfig['codexSandboxMode'],
      codexApprovalPolicy:
        values.codexApprovalPolicy as DefaultAgenticToolConfig['codexApprovalPolicy'],
      codexNetworkAccess: values.codexNetworkAccess,
    }),
  };
}

/**
 * Convert a schedule's snake_case `agentic_tool_config` blob into the
 * camelCase shape `getFormValuesFromConfig` expects. Now that
 * `ScheduleAgenticToolConfig.model_config` is `DefaultModelConfig`, the
 * structural conversion is one-to-one and TS-checks cleanly without
 * any unknown-casts.
 */
export function scheduleConfigToDefaultConfig(
  cfg?: ScheduleAgenticToolConfig
): DefaultAgenticToolConfig | undefined {
  if (!cfg) return undefined;
  return {
    modelConfig: cfg.model_config,
    permissionMode: cfg.permission_mode,
    mcpServerIds: cfg.mcp_server_ids,
    // Codex fields aren't surfaced in ScheduleAgenticToolConfig today;
    // promote them here if/when schedules grow codex sandbox controls.
  };
}

/**
 * Inverse: pack form values into a schedule's snake_case
 * `agentic_tool_config`, preserving caller-provided fields we don't
 * surface in the form (e.g. `context_files`).
 */
export function buildScheduleConfigFromFormValues(
  tool: AgenticToolName,
  values: AgenticFormValues,
  previous?: ScheduleAgenticToolConfig
): ScheduleAgenticToolConfig {
  const builtDefault = buildConfigFromFormValues(tool, values);
  return {
    ...previous,
    agentic_tool: tool,
    permission_mode: builtDefault.permissionMode,
    model_config: builtDefault.modelConfig,
    mcp_server_ids: builtDefault.mcpServerIds,
    context_files: previous?.context_files,
  };
}

/**
 * Return form values that represent a "cleared" / default state.
 */
export function getClearedFormValues(tool: AgenticToolName): AgenticFormValues {
  return {
    modelConfig: undefined,
    effort: undefined,
    permissionMode: getDefaultPermissionMode(tool),
    mcpServerIds: [],
    ...(tool === 'codex' && {
      codexSandboxMode: undefined,
      codexApprovalPolicy: undefined,
      codexNetworkAccess: undefined,
    }),
  };
}
