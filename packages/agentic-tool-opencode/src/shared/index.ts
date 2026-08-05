export const OPENCODE_INTEGRATION = Object.freeze({
  name: 'opencode',
  displayName: 'OpenCode',
  capabilities: {
    supportsSessionFork: false,
    supportsChildSpawn: true,
    supportsSessionImport: false,
  },
  authentication: 'none',
  sdkVersion: '@opencode-ai/sdk@1.14.33',
  unverifiedTerminationReason: 'OpenCode server-side execution termination is not verified.',
} as const);
