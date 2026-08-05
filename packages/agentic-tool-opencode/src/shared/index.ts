export const OPENCODE_INTEGRATION = Object.freeze({
  name: 'opencode',
  displayName: 'OpenCode',
  capabilities: {
    supportsSessionFork: false,
    supportsChildSpawn: true,
    supportsSessionImport: false,
  },
  authentication: 'none',
  requiresRemoteTerminationEvidence: true,
} as const);
