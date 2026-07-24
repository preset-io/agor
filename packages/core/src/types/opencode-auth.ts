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
  type: 'api' | 'oauth';
  label: string;
  prompts?: OpenCodeProviderAuthPrompt[];
}

export type OpenCodeProviderConnectionStatus = 'configured' | 'disconnected' | 'unknown';

export interface OpenCodeProviderConnection {
  id: string;
  name: string;
  configured: boolean;
  status: OpenCodeProviderConnectionStatus;
  authMethods: OpenCodeProviderAuthMethod[];
}

export interface OpenCodeProviderDiscovery {
  runtime: 'available';
  runtimeVersion: string;
  providers: OpenCodeProviderConnection[];
}

export type OpenCodeCredentialIsolation = {
  mode: 'simple' | 'insulated' | 'strict';
  boundary: 'logical' | 'os';
};

export type OpenCodeProviderSettings = OpenCodeProviderDiscovery & {
  isolation: OpenCodeCredentialIsolation;
};
