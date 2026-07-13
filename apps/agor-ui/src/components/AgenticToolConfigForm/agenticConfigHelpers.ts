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
import { getDefaultPermissionMode } from '@agor-live/client';

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
    };
  }

  return {
    modelConfig: config.modelConfig,
    effort: config.modelConfig?.effort,
    permissionMode: config.permissionMode || getDefaultPermissionMode(tool),
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
    ...(cfg.agentic_tool === 'codex' && {
      codexSandboxMode: cfg.codex_sandbox_mode,
      codexApprovalPolicy: cfg.codex_approval_policy,
      codexNetworkAccess: cfg.codex_network_access,
    }),
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
    // Selecting inline configuration must detach any previously selected
    // live preset; otherwise the daemon correctly rejects the mixed payload.
    preset_id: undefined,
    agentic_tool: tool,
    permission_mode: builtDefault.permissionMode,
    model_config: builtDefault.modelConfig,
    context_files: previous?.context_files,
    // Codex fields: set when tool is codex, clear when switching away
    // (prevents stale values lingering from a previous codex config).
    codex_sandbox_mode: tool === 'codex' ? builtDefault.codexSandboxMode : undefined,
    codex_approval_policy: tool === 'codex' ? builtDefault.codexApprovalPolicy : undefined,
    codex_network_access: tool === 'codex' ? builtDefault.codexNetworkAccess : undefined,
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
    ...(tool === 'codex' && {
      codexSandboxMode: undefined,
      codexApprovalPolicy: undefined,
      codexNetworkAccess: undefined,
    }),
  };
}
