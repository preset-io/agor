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
  sdkVersion?: string;
  unverifiedTerminationReason?: string;
  /** Integration-owned validation for tools that require an exact model selection. */
  modelSelection?: {
    isComplete(input: { provider?: string; model?: string } | null | undefined): boolean;
    missingError: string;
  };
}

export type AgenticToolIntegrationRegistry = Readonly<
  Record<AgenticToolName, AgenticToolIntegration>
>;

export type AgenticToolDisplayNames = Readonly<Record<PersistedAgenticToolName, string>>;
