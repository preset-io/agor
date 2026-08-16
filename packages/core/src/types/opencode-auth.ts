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

export type OpenCodeCredentialIsolation = {
  // Mirrors the non-delegated UnixUserMode values (delegated has no native-state
  // home boundary). `sandbox` = no OS impersonation, logical boundary.
  mode: 'simple' | 'insulated' | 'strict' | 'sandbox';
  boundary: 'logical' | 'os';
};

export type OpenCodeProviderSettings = OpenCodeProviderDiscovery & {
  isolation: OpenCodeCredentialIsolation;
};
