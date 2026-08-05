import {
  type MaterializeAgenticToolConfigurationArgs,
  materializeAgenticToolConfiguration as materializeHostConfiguration,
} from '@agor/core/config';
import type { Database } from '@agor/core/db';
import {
  InvalidModelConfigError,
  isResolvedModelConfig,
  type ModelConfigInput,
  type ResolvedModelConfig,
  resolveModelConfig,
} from '@agor/core/models/browser';
import type { AgenticToolName } from '@agor/core/types';
import { getAgenticToolModelConfiguration } from './index.js';

export async function materializeAgenticToolConfiguration(
  db: Database,
  args: MaterializeAgenticToolConfigurationArgs
) {
  return materializeHostConfiguration(db, {
    ...args,
    modelConfiguration: getAgenticToolModelConfiguration(args.tool),
  });
}

/** Normalize one durable default/preset model selection through the package policy. */
export function normalizeAgenticToolModelConfiguration(
  tool: AgenticToolName,
  input: ModelConfigInput | null | undefined,
  options?: { now?: Date }
): ResolvedModelConfig | undefined {
  const policy = getAgenticToolModelConfiguration(tool);
  if (policy?.resolveSources) {
    const resolved = policy.resolveSources([input], options);
    if (
      (!resolved && policy.missingSelectionError) ||
      (policy.isResolved && !isResolvedModelConfig(resolved, policy))
    ) {
      throw new InvalidModelConfigError(
        policy.missingSelectionError ?? 'model_config is not resolved'
      );
    }
    return resolved;
  }
  return resolveModelConfig(input, options);
}

/** Validate the final session shape through the package descriptor. */
export function isResolvedAgenticToolModelConfiguration(
  tool: AgenticToolName,
  input: Partial<ResolvedModelConfig> | null | undefined
): input is ResolvedModelConfig {
  return isResolvedModelConfig(input, getAgenticToolModelConfiguration(tool));
}
