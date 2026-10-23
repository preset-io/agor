export {
  createOpenCodeExecutorContext,
  createOpenCodeManagedExecutorContext,
  isOpenCodeManagedExecutorContext,
  type OpenCodeExecutorContext,
  type OpenCodeNativeFileExecutorContext,
  parseOpenCodeExecutorContext,
} from './executor-context.js';
export { OPENCODE_VERSION } from './known-models.js';

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
    supportsSessionFork: true,
    supportsChildSpawn: true,
    reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  authentication: 'runtime-managed',
  sdkVersion: '@opencode/client@2.1.1',
  unverifiedTerminationReason: 'OpenCode server-side execution termination is not verified.',
  modelConfiguration: OPENCODE_MODEL_CONFIGURATION,
} as const);
