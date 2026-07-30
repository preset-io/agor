import {
  hasCompleteOpenCodeModelConfig,
  OPENCODE_MODEL_CONFIG_PAIR_ERROR,
  OPENCODE_MODEL_CONFIGURATION,
  resolveOpenCodeModelConfig,
} from './model-configuration.js';

export {
  hasCompleteOpenCodeModelConfig,
  OPENCODE_MODEL_CONFIG_PAIR_ERROR,
  OPENCODE_MODEL_CONFIGURATION,
  resolveOpenCodeModelConfig,
};

export const OPENCODE_INTEGRATION = {
  name: 'opencode',
  displayName: 'OpenCode',
  capabilities: {
    supportsSessionFork: false,
    supportsChildSpawn: true,
    supportsSessionImport: false,
  },
  authentication: 'runtime-managed',
  configuration: OPENCODE_MODEL_CONFIGURATION,
} as const;
