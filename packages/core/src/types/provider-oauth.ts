/** Backend-only personal grants. Never project secret envelopes into user data. */
export type ProviderOAuthProvider = 'claude-code';
export type ProviderOAuthGrantState =
  | 'idle'
  | 'refreshing'
  | 'ambiguous'
  | 'reauth_required'
  | 'disconnected';

export interface ProviderOAuthVersion {
  grantGeneration: number;
  bindingFingerprint: string;
  refreshGeneration: number;
}

export interface ProviderOAuthRefreshFence extends ProviderOAuthVersion {
  claimId: string;
}

export interface ManagedOAuthSelector {
  provider: ProviderOAuthProvider;
}

/** Public deployment readiness, never a user's grant status or config dump. */
export interface ClaudeOAuthCapability {
  available: boolean;
  storage: 'backend' | 'local_file' | null;
  reason?:
    | 'operator_disabled'
    | 'unsupported_execution'
    | 'durable_authority_unavailable'
    | 'runtime_channel_unavailable'
    | 'local_isolation_unavailable';
}

export interface ClaudeBackendOAuthTarget {
  kind: 'backend_grant';
  bindingVersion: 1;
  bindingFingerprint: string;
}
