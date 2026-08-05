import type {
  AgenticToolCapabilities,
  AgenticToolName,
  ApiKeyName,
  PersistedAgenticToolName,
} from '@agor/core/types';

export interface AgenticToolIntegration {
  name: AgenticToolName;
  displayName: string;
  capabilities: AgenticToolCapabilities;
  authentication: 'api-key' | 'none';
  apiKeyName?: ApiKeyName;
  keyCreationUrl?: string;
  sdkVersion?: string;
  unverifiedTerminationReason?: string;
}

export type AgenticToolIntegrationRegistry = Readonly<
  Record<AgenticToolName, AgenticToolIntegration>
>;

export type AgenticToolDisplayNames = Readonly<Record<PersistedAgenticToolName, string>>;
