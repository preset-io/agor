import {
  isAgenticToolName,
  normalizeAgenticToolDefaultConfigurationReference,
  type PersistedScheduleAgenticToolConfig,
  type ScheduleAgenticToolConfig,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '../types';

const LEGACY_WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION = '___workspace_default___';
const SOURCE_FIELDS = new Set([
  'agentic_tool',
  'preset_id',
  'configuration_reference',
  'context_files',
]);

export class InvalidScheduleAgenticToolConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScheduleAgenticToolConfigError';
  }
}

function normalizeDefaultReference(reference: string) {
  return (
    normalizeAgenticToolDefaultConfigurationReference(reference) ??
    (reference === LEGACY_WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
      ? WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
      : undefined)
  );
}

function hasDefinedInlineFields(config: PersistedScheduleAgenticToolConfig): boolean {
  return Object.entries(config).some(
    ([key, value]) => !SOURCE_FIELDS.has(key) && value !== undefined
  );
}

/** Canonicalize and enforce the exactly-one-source schedule configuration contract. */
export function normalizeScheduleAgenticToolConfig(
  config: PersistedScheduleAgenticToolConfig
): ScheduleAgenticToolConfig {
  if (!isAgenticToolName(config.agentic_tool)) {
    throw new InvalidScheduleAgenticToolConfigError(
      `Removed or unsupported schedule agentic tool: ${String(config.agentic_tool)}`
    );
  }
  const hasReference = config.configuration_reference !== undefined;
  const presetId = config.preset_id;
  const hasPreset = presetId !== undefined;
  const hasInline = hasDefinedInlineFields(config);

  if (hasReference) {
    if (hasPreset || hasInline) {
      throw new InvalidScheduleAgenticToolConfigError(
        'Default-backed schedules cannot contain a preset or inline overrides'
      );
    }
    const reference = normalizeDefaultReference(config.configuration_reference as string);
    if (!reference) {
      throw new InvalidScheduleAgenticToolConfigError(
        `Invalid default configuration reference: ${String(config.configuration_reference)}`
      );
    }
    return {
      agentic_tool: config.agentic_tool,
      configuration_reference: reference,
      ...(config.context_files !== undefined ? { context_files: config.context_files } : {}),
    };
  }

  if (!hasPreset) {
    return {
      agentic_tool: config.agentic_tool,
      ...(config.context_files !== undefined ? { context_files: config.context_files } : {}),
      ...(config.permission_mode !== undefined ? { permission_mode: config.permission_mode } : {}),
      ...(config.model_config !== undefined ? { model_config: config.model_config } : {}),
      ...(config.codex_sandbox_mode !== undefined
        ? { codex_sandbox_mode: config.codex_sandbox_mode }
        : {}),
      ...(config.codex_approval_policy !== undefined
        ? { codex_approval_policy: config.codex_approval_policy }
        : {}),
      ...(config.codex_network_access !== undefined
        ? { codex_network_access: config.codex_network_access }
        : {}),
    };
  }
  if (hasInline) {
    throw new InvalidScheduleAgenticToolConfigError(
      'Preset-backed schedules cannot contain inline overrides'
    );
  }
  const reference = normalizeDefaultReference(presetId);
  if (!reference) {
    return {
      agentic_tool: config.agentic_tool,
      preset_id: presetId,
      ...(config.context_files !== undefined ? { context_files: config.context_files } : {}),
    };
  }
  return {
    agentic_tool: config.agentic_tool,
    configuration_reference: reference,
    ...(config.context_files !== undefined ? { context_files: config.context_files } : {}),
  };
}
