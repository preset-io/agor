import type { AgenticToolModelConfigurationPolicy } from '@agor/core/models';
import type {
  AgenticToolCapabilities,
  AgenticToolName,
  ApiKeyName,
  PersistedAgenticToolName,
} from '@agor/core/types';

export type AgenticToolModelConfiguration = AgenticToolModelConfigurationPolicy;

export interface AgenticToolIntegration {
  name: AgenticToolName;
  displayName: string;
  capabilities: AgenticToolCapabilities;
  apiKeyName?: ApiKeyName;
  keyCreationUrl?: string;
  authentication: 'api-key' | 'runtime-managed';
  configuration: AgenticToolModelConfiguration;
}

export type AgenticToolIntegrationRegistry = Readonly<
  Record<AgenticToolName, AgenticToolIntegration>
>;

export type AgenticToolDisplayNames = Readonly<Record<PersistedAgenticToolName, string>>;
