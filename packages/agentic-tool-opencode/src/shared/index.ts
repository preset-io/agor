export {
  createOpenCodeExecutorContext,
  type OpenCodeExecutorContext,
  parseOpenCodeExecutorContext,
} from './executor-context.js';
export { createOpenCodeKnownModelCatalog, OPENCODE_VERSION } from './known-models.js';

export {
  hasCompleteOpenCodeModelConfig,
  OPENCODE_MODEL_CONFIG_PAIR_ERROR,
  OPENCODE_MODEL_CONFIGURATION,
  resolveOpenCodeCatalogFallback,
  resolveOpenCodeModelConfig,
} from './model-configuration.js';

import { OPENCODE_MODEL_CONFIGURATION } from './model-configuration.js';

export const OPENCODE_INTEGRATION = Object.freeze({
  name: 'opencode',
  displayName: 'OpenCode',
  capabilities: {
    supportsSessionFork: false,
    supportsChildSpawn: true,
    reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  authentication: 'runtime-managed',
  sdkVersion: '@opencode-ai/sdk@1.14.33',
  unverifiedTerminationReason: 'OpenCode server-side execution termination is not verified.',
  modelConfiguration: OPENCODE_MODEL_CONFIGURATION,
} as const);
