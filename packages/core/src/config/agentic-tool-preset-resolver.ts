import type { Database } from '../db/client';
import {
  AgenticToolPresetRepository,
  TenantAgenticToolSettingsRepository,
  UsersRepository,
} from '../db/repositories';
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

/** Resolve reserved default references at write time; callers persist only the concrete result. */
export async function resolveAgenticConfigurationReference(
  db: Database,
  tool: AgenticToolName,
  reference: string,
  userId?: UserID
): Promise<ResolvedAgenticConfigurationReference> {
  const canonical = canonicalTenantAgenticTool(tool);
  if (reference === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION) {
    const preset = await new AgenticToolPresetRepository(db).findDefault(canonical);
    if (!preset) throw new Error(`No workspace default preset is configured for ${canonical}`);
    return { preset };
  }
  if (reference !== USER_DEFAULT_AGENTIC_CONFIGURATION) {
    return { preset: await resolveAgenticToolPreset(db, tool, reference) };
  }
  if (!userId) throw new Error('Authenticated user required to resolve the user default');
  const user = await new UsersRepository(db).findById(userId);
  if (!user) throw new Error(`User not found: ${userId}`);
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
  if (!preset) throw new Error(`Agentic tool preset not found: ${presetId}`);
  const canonical = canonicalTenantAgenticTool(tool);
  if (preset.tool !== canonical) {
    throw new Error(`Preset '${preset.name}' belongs to ${preset.tool}, not ${canonical}`);
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
    throw new Error(`${tool} requires an administrator-managed preset in this workspace`);
  }
}

export function presetConfigurationToSessionPatch(configuration: DefaultAgenticToolConfig) {
  const modelConfig = configuration.modelConfig;
  return {
    ...(modelConfig?.mode && modelConfig.model
      ? {
          model_config: {
            ...modelConfig,
            mode: modelConfig.mode,
            model: modelConfig.model,
            updated_at: new Date().toISOString(),
          },
        }
      : {}),
    ...(configuration.permissionMode ||
    (configuration.codexSandboxMode && configuration.codexApprovalPolicy)
      ? {
          permission_config: {
            mode: configuration.permissionMode,
            ...(configuration.codexSandboxMode && configuration.codexApprovalPolicy
              ? {
                  codex: {
                    sandboxMode: configuration.codexSandboxMode,
                    approvalPolicy: configuration.codexApprovalPolicy,
                    networkAccess: configuration.codexNetworkAccess,
                  },
                }
              : {}),
          },
        }
      : {}),
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
