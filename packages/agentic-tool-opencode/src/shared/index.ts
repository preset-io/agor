export {
  createOpenCodeExecutorContext,
  type OpenCodeExecutorContext,
  parseOpenCodeExecutorContext,
} from './executor-context.js';
export { createOpenCodeKnownModelCatalog, OPENCODE_VERSION } from './known-models.js';

export const OPENCODE_MODEL_CONFIG_PAIR_ERROR =
  'Select an exact OpenCode provider and model in Agor before running this session';

export function hasCompleteOpenCodeModelConfig(
  input: { provider?: string; model?: string } | null | undefined
): boolean {
  return Boolean(input?.provider?.trim() && input.model?.trim());
}

export const OPENCODE_INTEGRATION = Object.freeze({
  name: 'opencode',
  displayName: 'OpenCode',
  capabilities: {
    supportsSessionFork: false,
    supportsChildSpawn: true,
    supportsSessionImport: false,
  },
  authentication: 'runtime-managed',
  sdkVersion: '@opencode-ai/sdk@1.14.33',
  unverifiedTerminationReason: 'OpenCode server-side execution termination is not verified.',
  modelSelection: {
    isComplete: hasCompleteOpenCodeModelConfig,
    missingError: OPENCODE_MODEL_CONFIG_PAIR_ERROR,
  },
} as const);
