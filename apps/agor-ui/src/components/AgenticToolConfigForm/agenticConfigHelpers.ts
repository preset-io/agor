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
