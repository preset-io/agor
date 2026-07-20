import type { Database } from '../db/client';
import {
  AgenticToolPresetRepository,
  TenantAgenticToolSettingsRepository,
  UsersRepository,
} from '../db/repositories';
import { resolveSessionDefaults } from '../sessions/resolve-session-defaults';
import type {
  AgenticToolName,
  AgenticToolPreset,
  AgenticToolPresetID,
  DefaultAgenticToolConfig,
  UserID,
} from '../types';
import {
  canonicalTenantAgenticTool,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '../types';

export interface ResolvedAgenticConfigurationReference {
  preset?: AgenticToolPreset;
  configuration?: DefaultAgenticToolConfig;
}

/** Expected user-facing failure while selecting or resolving an agentic configuration source. */
export class AgenticConfigurationResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgenticConfigurationResolutionError';
  }
}

/** Resolve canonical default or preset references at the caller-selected materialization boundary. */
export async function resolveAgenticConfigurationReference(
  db: Database,
  tool: AgenticToolName,
  reference: string,
  userId?: UserID
): Promise<ResolvedAgenticConfigurationReference> {
  const canonical = canonicalTenantAgenticTool(tool);
  if (reference === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION) {
    const preset = await new AgenticToolPresetRepository(db).findDefault(canonical);
    if (preset) return { preset };
    // A workspace preset is optional while inline configuration is allowed.
    // Resolve the built-in configuration explicitly so fresh/upgraded users'
    // implicit "workspace default" remains usable. When governance requires
    // presets, the tenant setting invariant below fails closed instead.
    await assertInlineAgenticConfigurationAllowed(db, tool);
    return { configuration: {} };
  }
  if (reference !== USER_DEFAULT_AGENTIC_CONFIGURATION) {
    return { preset: await resolveAgenticToolPreset(db, tool, reference) };
  }
  if (!userId) {
    throw new AgenticConfigurationResolutionError(
      'Authenticated user required to resolve the user default'
    );
  }
  const user = await new UsersRepository(db).findById(userId);
  if (!user) throw new AgenticConfigurationResolutionError(`User not found: ${userId}`);
  const selection =
    user.default_agentic_selection?.[tool] ??
    user.default_agentic_selection?.[canonical] ??
    ((user.default_agentic_config?.[tool] ?? user.default_agentic_config?.[canonical])
      ? ({ source: 'inline' } as const)
      : ({ source: 'workspace_default' } as const));
  if (selection.source === 'workspace_default') {
    return resolveAgenticConfigurationReference(
      db,
      tool,
      WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
      userId
    );
  }
  if (selection.source === 'preset') {
    return { preset: await resolveAgenticToolPreset(db, tool, selection.preset_id) };
  }
  await assertInlineAgenticConfigurationAllowed(db, tool);
  return {
    configuration:
      user.default_agentic_config?.[tool] ?? user.default_agentic_config?.[canonical] ?? {},
  };
}

export async function resolveAgenticToolPreset(
  db: Database,
  tool: AgenticToolName,
  presetId: AgenticToolPresetID | string
): Promise<AgenticToolPreset> {
  const preset = await new AgenticToolPresetRepository(db).findById(presetId);
  if (!preset) {
    throw new AgenticConfigurationResolutionError(`Agentic tool preset not found: ${presetId}`);
  }
  const canonical = canonicalTenantAgenticTool(tool);
  if (preset.tool !== canonical) {
    throw new AgenticConfigurationResolutionError(
      `Preset '${preset.name}' belongs to ${preset.tool}, not ${canonical}`
    );
  }
  return preset;
}

export async function assertInlineAgenticConfigurationAllowed(
  db: Database,
  tool: AgenticToolName
): Promise<void> {
  const settings = await new TenantAgenticToolSettingsRepository(db).find(
    canonicalTenantAgenticTool(tool)
  );
  if (settings.inline_configuration_allowed === false) {
    throw new AgenticConfigurationResolutionError(
      `${tool} requires an administrator-managed preset in this workspace`
    );
  }
}

export function presetConfigurationToSessionPatch(
  tool: AgenticToolName,
  configuration: DefaultAgenticToolConfig
) {
  const resolved = resolveSessionDefaults({
    agenticTool: tool,
    user: null,
    overrides: {
      modelConfig: configuration.modelConfig,
      permissionMode: configuration.permissionMode,
      codexSandboxMode: configuration.codexSandboxMode,
      codexApprovalPolicy: configuration.codexApprovalPolicy,
      codexNetworkAccess: configuration.codexNetworkAccess,
    },
  });
  return {
    permission_config: resolved.permission_config,
    model_config: resolved.model_config ?? null,
  };
}

export function presetConfigurationToScheduleConfig(
  tool: AgenticToolName,
  presetId: AgenticToolPresetID | string,
  configuration: DefaultAgenticToolConfig
) {
  return {
    agentic_tool: tool,
    preset_id: presetId as AgenticToolPresetID,
    model_config: configuration.modelConfig,
    permission_mode: configuration.permissionMode,
    codex_sandbox_mode: configuration.codexSandboxMode,
    codex_approval_policy: configuration.codexApprovalPolicy,
    codex_network_access: configuration.codexNetworkAccess,
  };
}
