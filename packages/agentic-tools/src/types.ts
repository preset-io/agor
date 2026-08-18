import type { AgenticToolModelConfigurationPolicy } from '@agor/core/models/browser';
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
  authentication: 'api-key' | 'runtime-managed';
  apiKeyName?: ApiKeyName;
  keyCreationUrl?: string;
  billingUrl?: string;
  sdkVersion?: string;
  unverifiedTerminationReason?: string;
  /** Integration-owned model resolution and persisted-shape policy. */
  modelConfiguration?: AgenticToolModelConfigurationPolicy;
}

export type AgenticToolIntegrationRegistry = Readonly<
  Record<AgenticToolName, AgenticToolIntegration>
>;

export type AgenticToolDisplayNames = Readonly<Record<PersistedAgenticToolName, string>>;
