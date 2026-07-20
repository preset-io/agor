import type { ScheduleAgenticToolConfig } from '../types';
import {
  normalizeAgenticToolDefaultConfigurationReference,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '../types';

const LEGACY_WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION = '___workspace_default___';
const SOURCE_FIELDS = new Set(['agentic_tool', 'preset_id', 'configuration_reference']);

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

function hasDefinedInlineFields(config: ScheduleAgenticToolConfig): boolean {
  return Object.entries(config).some(
    ([key, value]) => !SOURCE_FIELDS.has(key) && value !== undefined
  );
}

/** Canonicalize and enforce the exactly-one-source schedule configuration contract. */
export function normalizeScheduleAgenticToolConfig(
  config: ScheduleAgenticToolConfig
): ScheduleAgenticToolConfig {
  const hasReference = config.configuration_reference !== undefined;
  const hasPreset = config.preset_id !== undefined;
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
    return { agentic_tool: config.agentic_tool, configuration_reference: reference };
  }

  if (!hasPreset) return config;
  if (hasInline) {
    throw new InvalidScheduleAgenticToolConfigError(
      'Preset-backed schedules cannot contain inline overrides'
    );
  }
  const reference = normalizeDefaultReference(config.preset_id as string);
  if (!reference) return config;
  return { agentic_tool: config.agentic_tool, configuration_reference: reference };
}
