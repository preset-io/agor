import type { OpenCodeCatalogModel, OpenCodeModelPair } from './opencode-models';

export type OpenCodeProviderAuthPrompt =
  | {
      type: 'text';
      key: string;
      message: string;
      placeholder?: string;
      when?: OpenCodeProviderAuthPromptCondition;
    }
  | {
      type: 'select';
      key: string;
      message: string;
      options: Array<{ label: string; value: string; hint?: string }>;
      when?: OpenCodeProviderAuthPromptCondition;
    };

export type OpenCodeProviderAuthPromptCondition = {
  key: string;
  op: 'eq' | 'neq';
  value: string;
};

export interface OpenCodeProviderAuthMethod {
  /** Stable index in the native OpenCode auth-method array. */
  index: number;
  type: 'api' | 'oauth';
  label: string;
  prompts?: OpenCodeProviderAuthPrompt[];
}

export type OpenCodeOAuthAuthorization = {
  url: string;
  method: 'auto' | 'code';
  instructions: string;
};

export type OpenCodeOAuthAttemptPhase =
  | 'authorizing'
  | 'awaiting_callback'
  | 'completing'
  | 'configured'
  | 'cancelled'
  | 'expired'
  | 'failed';

export interface OpenCodeOAuthAttempt {
  attemptId: string;
  providerId: string;
  phase: OpenCodeOAuthAttemptPhase;
  authorization?: OpenCodeOAuthAuthorization;
  expiresAt: string;
  settings?: OpenCodeProviderSettings;
}

export type OpenCodeOAuthConnectRequest = {
  operation: 'connect-oauth';
  providerId: string;
  method: number;
  inputs?: Record<string, string>;
};

export type OpenCodeOAuthAttemptPatch = { cancel: true } | { code: string };

export type OpenCodeCredentialPresence = 'present' | 'absent' | 'unknown';

export interface OpenCodeProviderConnection {
  id: string;
  name: string;
  runtimeAvailable: boolean;
  credentialPresence: OpenCodeCredentialPresence;
  authMethods: OpenCodeProviderAuthMethod[];
  suggestedModel?: string;
  models: OpenCodeCatalogModel[];
}

export interface OpenCodeProviderDiscovery {
  runtime: 'available';
  runtimeVersion: string;
  projectConfigured?: OpenCodeModelPair;
  suggestedSelection?: OpenCodeModelPair;
  providers: OpenCodeProviderConnection[];
}

export type OpenCodeCredentialIsolation =
  | {
      // Local native-file authority: credentials live in the daemon-owned
      // OpenCode namespace under the execution home.
      mode: 'simple' | 'sandbox';
      boundary: 'logical';
    }
  | {
      // Hosted managed-projection authority: keys are stored encrypted per
      // user and projected only into that user's own executor run.
      mode: 'managed-projection';
      boundary: 'executor-run';
    };

/**
 * Stable reasons a deployment cannot run OpenCode. Rendered by the UI as a
 * permanent capability notice (never a retry) and returned by session creation,
 * prompt admission, and the settings/catalog services alike.
 */
export type OpenCodeUnsupportedCode =
  | 'hosted_native_state_disabled'
  | 'persistent_user_home_required'
  | 'templated_transport'
  | 'delegated_execution'
  | 'hosted_tenancy';

export interface OpenCodeUnsupportedReason {
  code: OpenCodeUnsupportedCode;
  message: string;
}

/** Settings response for a deployment that cannot run OpenCode at all. */
export interface OpenCodeUnsupportedSettings {
  runtime: 'unsupported';
  runtimeVersion: string;
  unsupported: OpenCodeUnsupportedReason;
  providers: [];
}

export type OpenCodeProviderSettings =
  | (OpenCodeProviderDiscovery & {
      isolation: OpenCodeCredentialIsolation;
    })
  | OpenCodeUnsupportedSettings;
