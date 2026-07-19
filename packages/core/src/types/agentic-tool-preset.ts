import type { UserID, UUID } from './id';
import type { TenantAgenticToolName } from './tenant-agentic-tool';
import type { DefaultAgenticToolConfig } from './user';

export type AgenticToolPresetID = UUID & { readonly __entity: 'AgenticToolPreset' };

/** A live, tenant-owned runtime behavior configuration. Credentials and MCP selection never belong here. */
export interface AgenticToolPreset {
  preset_id: AgenticToolPresetID;
  tool: TenantAgenticToolName;
  name: string;
  description?: string;
  is_default: boolean;
  configuration: DefaultAgenticToolConfig;
  created_by: UserID;
  updated_by: UserID;
  created_at: string;
  updated_at: string;
}

export interface CreateAgenticToolPreset {
  tool: TenantAgenticToolName;
  name: string;
  description?: string;
  is_default?: boolean;
  configuration: DefaultAgenticToolConfig;
}

export type PatchAgenticToolPreset = Partial<
  Pick<CreateAgenticToolPreset, 'name' | 'description' | 'configuration' | 'is_default'>
>;

export const USER_DEFAULT_AGENTIC_CONFIGURATION = '__user_default__';
export const WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION = '__workspace_default__';
export type AgenticToolDefaultConfigurationReference =
  | typeof USER_DEFAULT_AGENTIC_CONFIGURATION
  | typeof WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION;

export function normalizeAgenticToolDefaultConfigurationReference(
  reference: string
): AgenticToolDefaultConfigurationReference | undefined {
  if (reference === USER_DEFAULT_AGENTIC_CONFIGURATION) return USER_DEFAULT_AGENTIC_CONFIGURATION;
  if (reference === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION) {
    return WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION;
  }
  return undefined;
}

export function isAgenticToolDefaultConfigurationReference(
  reference: string
): reference is AgenticToolDefaultConfigurationReference {
  return normalizeAgenticToolDefaultConfigurationReference(reference) !== undefined;
}

export type UserAgenticDefaultSelection =
  | { source: 'workspace_default' }
  | { source: 'preset'; preset_id: AgenticToolPresetID }
  | { source: 'inline' };

/** Consumers choose exactly one source. Preset-backed values cannot be overridden inline. */
export type AgenticToolConfigurationSelection =
  | { source: 'preset'; preset_id: AgenticToolPresetID }
  | { source: 'inline'; configuration: DefaultAgenticToolConfig };
