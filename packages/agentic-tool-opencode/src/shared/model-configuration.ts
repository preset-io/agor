import {
  type AgenticToolModelConfigurationPolicy,
  InvalidModelConfigError,
  type ModelConfigInput,
  type ResolvedModelConfig,
  resolveModelConfig,
} from '@agor/core/models';

export const OPENCODE_MODEL_CONFIG_PAIR_ERROR =
  'Select an exact OpenCode provider and model in Agor before running this session';

export function hasCompleteOpenCodeModelConfig(
  input: ModelConfigInput | null | undefined
): boolean {
  return Boolean(input?.provider?.trim() && input.model?.trim());
}

export function resolveOpenCodeModelConfig(
  sources: Array<ModelConfigInput | undefined | null>,
  options?: { now?: Date }
): ResolvedModelConfig | undefined {
  for (const source of sources) {
    if (source == null) continue;
    const carriesPairField = source.provider !== undefined || source.model !== undefined;
    if (!carriesPairField) continue;
    if (!hasCompleteOpenCodeModelConfig(source)) {
      throw new InvalidModelConfigError(OPENCODE_MODEL_CONFIG_PAIR_ERROR);
    }
    return resolveModelConfig({ ...source, mode: 'exact' }, options);
  }
  return undefined;
}

export const OPENCODE_MODEL_CONFIGURATION = {
  missingSelectionError: OPENCODE_MODEL_CONFIG_PAIR_ERROR,
  isSelectionComplete: hasCompleteOpenCodeModelConfig,
  resolveSources: resolveOpenCodeModelConfig,
  isResolved: (input) =>
    input?.mode === 'exact' && Boolean(input.updated_at) && hasCompleteOpenCodeModelConfig(input),
} satisfies AgenticToolModelConfigurationPolicy;
