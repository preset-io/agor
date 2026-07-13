import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { AgenticToolPresetRepository, TenantAgenticToolSettingsRepository } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type {
  Params,
  TenantAgenticToolName,
  TenantAgenticToolSettings,
  TenantAgenticToolSettingsPatch,
  UserID,
} from '@agor/core/types';
import {
  DEFAULT_PROVIDER_RESOLUTION_POLICY,
  isProviderConnectionTool,
  PROVIDER_RESOLUTION_POLICIES,
  TENANT_AGENTIC_TOOL_NAMES,
  TENANT_PROVIDER_CONNECTION_FIELDS,
} from '@agor/core/types';

function parseTool(id: string): TenantAgenticToolName {
  if ((TENANT_AGENTIC_TOOL_NAMES as readonly string[]).includes(id)) {
    return id as TenantAgenticToolName;
  }
  throw new BadRequest(`Unsupported agentic tool: ${id}`);
}

export class TenantAgenticToolSettingsService {
  private repository: TenantAgenticToolSettingsRepository;
  private presets: AgenticToolPresetRepository;

  constructor(db: TenantScopeAwareDatabase) {
    this.repository = new TenantAgenticToolSettingsRepository(db);
    this.presets = new AgenticToolPresetRepository(db);
  }

  private async publicSettings(tool: TenantAgenticToolName): Promise<TenantAgenticToolSettings> {
    const stored = await this.repository.find(tool);
    const connection: TenantAgenticToolSettings['connection'] = {};
    if (isProviderConnectionTool(tool)) {
      for (const field of TENANT_PROVIDER_CONNECTION_FIELDS[tool]) {
        connection[field] = { configured: Boolean(stored.connection?.[field]) };
      }
    }
    return {
      tool,
      enabled: stored.enabled !== false,
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
    if (data.enabled !== undefined && typeof data.enabled !== 'boolean') {
      throw new BadRequest('enabled must be a boolean');
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

export function createTenantAgenticToolSettingsService(db: TenantScopeAwareDatabase) {
  return new TenantAgenticToolSettingsService(db);
}
