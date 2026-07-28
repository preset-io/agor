import type { Database } from '../db/client';
import {
  AgenticToolPresetRepository,
  TenantAgenticToolSettingsRepository,
  UsersRepository,
} from '../db/repositories';
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
  parent?: Pick<Session, 'agentic_tool' | 'permission_config' | 'model_config'> | null;
  branch?: { mcp_server_ids?: string[] | null } | null;
  mcpServerIds?: string[];
  now?: Date;
}

export interface MaterializedAgenticToolConfiguration {
  agentic_tool_preset_id: AgenticToolPresetID | null;
  permission_config: NonNullable<Session['permission_config']>;
  model_config: Session['model_config'];
  mcp_server_ids: string[];
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

/**
 * Materialize the one selected source against same-tool lineage, the execution
 * owner, and finally system defaults. Callers persist the returned effective
 * snapshot; only a concrete preset ID remains a live reference.
 */
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

  const owner = args.executionOwnerId
    ? await new UsersRepository(db).findById(args.executionOwnerId)
    : null;

  let preset: AgenticToolPreset | undefined;
  let source: DefaultAgenticToolConfig;
  if (hasReference) {
    const resolved = await resolveAgenticConfigurationReferenceForUser(
      db,
      args.tool,
      args.source.reference as AgenticToolConfigurationReference,
      owner
    );
    preset = resolved.preset;
    source = preset?.configuration ?? resolved.configuration ?? {};
  } else {
    await assertInlineAgenticConfigurationAllowed(db, args.tool);
    source = args.source.configuration ?? {};
  }

  const resolved = resolveSessionDefaults({
    agenticTool: args.tool,
    source,
    parent: args.parent,
    // A user-default reference has already interpreted the owner's selected
    // source. Feeding the owner's legacy inline values back in would turn a
    // workspace/preset selection into an accidental overlay (or recursion).
    user: args.source.reference === USER_DEFAULT_AGENTIC_CONFIGURATION ? null : owner,
    branch: args.branch,
    mcpServerIds: args.mcpServerIds,
    now: args.now,
  });

  return {
    agentic_tool_preset_id: preset?.preset_id ?? null,
    permission_config: resolved.permission_config,
    model_config: resolved.model_config ?? null,
    mcp_server_ids: resolved.mcp_server_ids,
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
