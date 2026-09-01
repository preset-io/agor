import {
  type DeploymentAgenticToolPolicy,
  isDeploymentAgenticToolAvailable,
} from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { AgenticToolPresetRepository, TenantAgenticToolSettingsRepository } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type {
  AgenticToolName,
  Params,
  TenantAgenticToolName,
  TenantAgenticToolSettings,
  TenantAgenticToolSettingsPatch,
  UserID,
} from '@agor/core/types';
import {
  DEFAULT_PROVIDER_RESOLUTION_POLICY,
  isBuiltInAgenticToolName,
  isProviderConnectionTool,
  isTenantAgenticToolEnabledByDefault,
  PROVIDER_RESOLUTION_POLICIES,
  TENANT_AGENTIC_TOOL_NAMES,
  TENANT_PROVIDER_CONNECTION_FIELDS,
} from '@agor/core/types';
import { deploymentAgenticToolUnavailableMessage } from './agentic-tool-deployment.js';

function parseTool(id: string): TenantAgenticToolName {
  if ((TENANT_AGENTIC_TOOL_NAMES as readonly string[]).includes(id)) {
    return id as TenantAgenticToolName;
  }
  throw new BadRequest(`Unsupported agentic tool: ${id}`);
}

export class TenantAgenticToolSettingsService {
  private repository: TenantAgenticToolSettingsRepository;
  private presets: AgenticToolPresetRepository;

  constructor(
    db: TenantScopeAwareDatabase,
    private deploymentAvailable: (tool: TenantAgenticToolName) => boolean = () => true
  ) {
    this.repository = new TenantAgenticToolSettingsRepository(db);
    this.presets = new AgenticToolPresetRepository(db);
  }

  private async publicSettings(tool: TenantAgenticToolName): Promise<TenantAgenticToolSettings> {
    const stored = await this.repository.find(tool);
    const deploymentEnabled = this.deploymentAvailable(tool);
    const connection: TenantAgenticToolSettings['connection'] = {};
    if (isProviderConnectionTool(tool)) {
      for (const field of TENANT_PROVIDER_CONNECTION_FIELDS[tool]) {
        connection[field] = { configured: Boolean(stored.connection?.[field]) };
      }
    }
    return {
      tool,
      revision: stored.revision ?? 0,
      deployment_available: deploymentEnabled,
      enabled: deploymentEnabled && (stored.enabled ?? isTenantAgenticToolEnabledByDefault(tool)),
      resolution_policy: stored.resolution_policy ?? DEFAULT_PROVIDER_RESOLUTION_POLICY,
      inline_configuration_allowed: stored.inline_configuration_allowed !== false,
      connection,
    };
  }

  async find(_params?: Params): Promise<TenantAgenticToolSettings[]> {
    return Promise.all(TENANT_AGENTIC_TOOL_NAMES.map((tool) => this.publicSettings(tool)));
  }

  async get(id: string, _params?: Params): Promise<TenantAgenticToolSettings> {
    return this.publicSettings(parseTool(id));
  }

  async patch(
    id: string,
    data: TenantAgenticToolSettingsPatch,
    params?: Params
  ): Promise<TenantAgenticToolSettings> {
    const tool = parseTool(id);
    if (data.enabled === true && !this.deploymentAvailable(tool)) {
      throw new BadRequest(deploymentAgenticToolUnavailableMessage(tool));
    }
    if (data.enabled !== undefined && typeof data.enabled !== 'boolean') {
      throw new BadRequest('enabled must be a boolean');
    }
    if (
      isBuiltInAgenticToolName(tool as AgenticToolName) &&
      (data.inline_configuration_allowed !== undefined ||
        data.resolution_policy !== undefined ||
        data.connection !== undefined)
    ) {
      throw new BadRequest(`${tool} only supports workspace enablement`);
    }
    if (
      data.inline_configuration_allowed !== undefined &&
      typeof data.inline_configuration_allowed !== 'boolean'
    ) {
      throw new BadRequest('inline_configuration_allowed must be a boolean');
    }
    if (data.inline_configuration_allowed === false) {
      const defaultPreset = await this.presets.findDefault(tool);
      if (!defaultPreset) {
        throw new BadRequest(`Set a default ${tool} preset before requiring presets`);
      }
    }
    if (
      data.resolution_policy !== undefined &&
      !(PROVIDER_RESOLUTION_POLICIES as readonly string[]).includes(data.resolution_policy)
    ) {
      throw new BadRequest('resolution_policy is invalid');
    }
    if (data.resolution_policy !== undefined && !isProviderConnectionTool(tool)) {
      throw new BadRequest(`${tool} does not use provider resolution`);
    }
    if (
      data.connection !== undefined &&
      (!data.connection || typeof data.connection !== 'object')
    ) {
      throw new BadRequest('connection must be an object');
    }
    try {
      await this.repository.patch(
        tool,
        data,
        (params as { user?: { user_id?: UserID } } | undefined)?.user?.user_id ?? null
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unsupported connection field')) {
        throw new BadRequest(error.message);
      }
      throw error;
    }
    return this.publicSettings(tool);
  }
}

export function createTenantAgenticToolSettingsService(
  db: TenantScopeAwareDatabase,
  policy: DeploymentAgenticToolPolicy
) {
  return new TenantAgenticToolSettingsService(db, (tool) =>
    isDeploymentAgenticToolAvailable(tool, policy)
  );
}
