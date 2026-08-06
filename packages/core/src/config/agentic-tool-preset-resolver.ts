import type { Database } from '../db/client';
import {
  AgenticToolPresetRepository,
  TenantAgenticToolSettingsRepository,
  UsersRepository,
} from '../db/repositories';
import type {
  AgenticToolModelConfigurationPolicy,
  ModelConfigInput,
} from '../models/resolve-config';
import { InvalidModelConfigError, isResolvedModelConfig } from '../models/resolve-config';
import { resolveSessionDefaults } from '../sessions/resolve-session-defaults';
import type {
  AgenticToolConfigurationReference,
  AgenticToolConfigurationSource,
  AgenticToolName,
  AgenticToolPreset,
  AgenticToolPresetID,
  DefaultAgenticToolConfig,
  Session,
  User,
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

export interface MaterializeAgenticToolConfigurationArgs {
  tool: AgenticToolName;
  source: AgenticToolConfigurationSource;
  executionOwnerId?: UserID;
  executionOwner?: User | null;
  parent?: Pick<Session, 'agentic_tool' | 'permission_config' | 'model_config'> | null;
  now?: Date;
  modelConfiguration?: AgenticToolModelConfigurationPolicy;
  modelFallback?: ModelConfigInput;
}

export interface MaterializedAgenticToolConfiguration {
  agentic_tool_preset_id: AgenticToolPresetID | null;
  permission_config: NonNullable<Session['permission_config']>;
  model_config: Session['model_config'];
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
  const user = userId ? await new UsersRepository(db).findById(userId) : null;
  if (userId && !user) {
    throw new AgenticConfigurationResolutionError(`User not found: ${userId}`);
  }
  return resolveAgenticConfigurationReferenceForUser(db, tool, reference, user);
}

async function resolveAgenticConfigurationReferenceForUser(
  db: Database,
  tool: AgenticToolName,
  reference: string,
  user: User | null
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
  if (!user) {
    throw new AgenticConfigurationResolutionError(
      'Authenticated user required to resolve the user default'
    );
  }
  const selection =
    user.default_agentic_selection?.[tool] ??
    user.default_agentic_selection?.[canonical] ??
    ((user.default_agentic_config?.[tool] ?? user.default_agentic_config?.[canonical])
      ? ({ source: 'inline' } as const)
      : ({ source: 'workspace_default' } as const));
  if (selection.source === 'workspace_default') {
    return resolveAgenticConfigurationReferenceForUser(
      db,
      tool,
      WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
      user
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

/** Resolve one selected source into a complete session-ready snapshot. */
export async function materializeAgenticToolConfiguration(
  db: Database,
  args: MaterializeAgenticToolConfigurationArgs
): Promise<MaterializedAgenticToolConfiguration> {
  const hasReference = args.source.reference != null;
  const hasInline = args.source.configuration !== undefined;
  if (hasReference && hasInline) {
    throw new AgenticConfigurationResolutionError(
      'Agentic configuration must contain a reference or inline values, never both'
    );
  }

  if (
    args.executionOwnerId &&
    args.executionOwner &&
    args.executionOwner.user_id !== args.executionOwnerId
  ) {
    throw new AgenticConfigurationResolutionError(
      'Agentic configuration execution owner does not match the selected subject'
    );
  }
  const owner =
    args.executionOwner !== undefined
      ? args.executionOwner
      : args.executionOwnerId
        ? await new UsersRepository(db).findById(args.executionOwnerId)
        : null;
  if (args.executionOwnerId && !owner) {
    throw new AgenticConfigurationResolutionError(`User not found: ${args.executionOwnerId}`);
  }
  let preset: AgenticToolPreset | undefined;
  let configuration: DefaultAgenticToolConfig;
  if (hasReference) {
    const resolved = await resolveAgenticConfigurationReferenceForUser(
      db,
      args.tool,
      args.source.reference as AgenticToolConfigurationReference,
      owner
    );
    preset = resolved.preset;
    configuration = preset?.configuration ?? resolved.configuration ?? {};
  } else {
    await assertInlineAgenticConfigurationAllowed(db, args.tool);
    configuration = args.source.configuration ?? {};
  }

  const resolved = resolveSessionDefaults({
    agenticTool: args.tool,
    // A selected reference is one atomic configuration. Once resolved, its
    // missing fields cannot borrow a parent or the execution owner's defaults.
    user: hasReference ? null : owner,
    parent: hasReference ? null : args.parent,
    overrides: {
      modelConfig: configuration.modelConfig,
      permissionMode: configuration.permissionMode,
      codexSandboxMode: configuration.codexSandboxMode,
      codexApprovalPolicy: configuration.codexApprovalPolicy,
      codexNetworkAccess: configuration.codexNetworkAccess,
    },
    now: args.now,
    modelConfiguration: args.modelConfiguration,
    modelFallback: preset ? undefined : args.modelFallback,
  });

  if (
    args.modelConfiguration?.isResolved &&
    !isResolvedModelConfig(resolved.model_config, args.modelConfiguration)
  ) {
    throw new InvalidModelConfigError(
      args.modelConfiguration.missingSelectionError ?? 'model_config is not resolved'
    );
  }

  return {
    agentic_tool_preset_id: preset?.preset_id ?? null,
    permission_config: resolved.permission_config,
    model_config: resolved.model_config ?? null,
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
