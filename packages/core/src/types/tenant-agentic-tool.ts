import type { AgenticToolName } from './agentic-tool';
import type { AgenticToolConfigField, AgenticToolsConfig } from './user';

/** Tenant-configurable tools. */
export const TENANT_AGENTIC_TOOL_NAMES = [
  'claude-code',
  'codex',
  'gemini',
  'copilot',
  'cursor',
  'opencode',
  'workload',
] as const;

export type TenantAgenticToolName = (typeof TENANT_AGENTIC_TOOL_NAMES)[number];
export type ProviderConnectionTool = Exclude<TenantAgenticToolName, 'opencode' | 'workload'>;

/** Provider tools default on for compatibility; the built-in workload is opt-in per tenant. */
export function isTenantAgenticToolEnabledByDefault(tool: TenantAgenticToolName): boolean {
  return tool !== 'workload';
}

export const PROVIDER_RESOLUTION_POLICIES = [
  'user_required',
  'user_preferred',
  'tenant_preferred',
  'tenant_required',
] as const;
export type ProviderResolutionPolicy = (typeof PROVIDER_RESOLUTION_POLICIES)[number];
export const DEFAULT_PROVIDER_RESOLUTION_POLICY: ProviderResolutionPolicy = 'user_preferred';

export type ProviderConnection<T extends ProviderConnectionTool = ProviderConnectionTool> = Partial<
  NonNullable<AgenticToolsConfig[T]>
>;

export const PROVIDER_CONNECTION_FIELDS = {
  'claude-code': [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  gemini: ['GEMINI_API_KEY'],
  copilot: ['COPILOT_GITHUB_TOKEN'],
  cursor: ['CURSOR_API_KEY'],
} as const satisfies Record<ProviderConnectionTool, readonly AgenticToolConfigField[]>;

/** Credential-bearing subset of each atomic provider connection (excludes endpoints). */
export const PROVIDER_CREDENTIAL_FIELDS = {
  'claude-code': ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  copilot: ['COPILOT_GITHUB_TOKEN'],
  cursor: ['CURSOR_API_KEY'],
} as const satisfies Record<ProviderConnectionTool, readonly AgenticToolConfigField[]>;

export const TENANT_PROVIDER_CONNECTION_FIELDS = {
  ...PROVIDER_CONNECTION_FIELDS,
  'claude-code': PROVIDER_CONNECTION_FIELDS['claude-code'].filter(
    (field) => field !== 'CLAUDE_CODE_OAUTH_TOKEN'
  ),
} as const satisfies Record<ProviderConnectionTool, readonly AgenticToolConfigField[]>;

export interface StoredTenantAgenticToolSettings {
  /** Durable generation incremented on every workspace settings patch. */
  revision?: number;
  /** Omitted values inherit the per-tool built-in default. */
  enabled?: boolean;
  /** Omitted values inherit Agor's built-in user-preferred policy. */
  resolution_policy?: ProviderResolutionPolicy;
  /** Defaults to true. False requires a preset anywhere runtime configuration is selected. */
  inline_configuration_allowed?: boolean;
  connection?: Record<string, string>;
}

export interface TenantAgenticToolFieldStatus {
  configured: boolean;
}

export interface TenantAgenticToolSettings {
  tool: TenantAgenticToolName;
  /** Non-secret durable generation used to invalidate client-side status probes. */
  revision?: number;
  /** Whether the deployment operator selected and installed this tool package. */
  deployment_available: boolean;
  /** Effective workspace availability: deployment_available and not tenant-disabled. */
  enabled: boolean;
  resolution_policy: ProviderResolutionPolicy;
  inline_configuration_allowed: boolean;
  connection: Partial<Record<AgenticToolConfigField, TenantAgenticToolFieldStatus>>;
}

export interface TenantAgenticToolSettingsPatch {
  enabled?: boolean;
  resolution_policy?: ProviderResolutionPolicy;
  inline_configuration_allowed?: boolean;
  connection?: Partial<Record<AgenticToolConfigField, string | null>>;
}

export function canonicalTenantAgenticTool(tool: AgenticToolName): TenantAgenticToolName {
  return tool;
}

export function isProviderConnectionTool(
  tool: TenantAgenticToolName
): tool is ProviderConnectionTool {
  return tool !== 'opencode' && tool !== 'workload';
}

export function providerToolForField(field: AgenticToolConfigField): ProviderConnectionTool | null {
  for (const [tool, fields] of Object.entries(PROVIDER_CONNECTION_FIELDS) as Array<
    [ProviderConnectionTool, readonly AgenticToolConfigField[]]
  >) {
    if (fields.includes(field)) return tool;
  }
  return null;
}
