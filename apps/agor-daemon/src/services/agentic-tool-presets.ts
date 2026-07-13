import {
  AgenticToolPresetRepository,
  GatewayChannelRepository,
  ScheduleRepository,
  SessionRepository,
  TenantAgenticToolSettingsRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type {
  AgenticToolPreset,
  CreateAgenticToolPreset,
  Params,
  PatchAgenticToolPreset,
  TenantAgenticToolName,
  UserID,
} from '@agor/core/types';
import { TENANT_AGENTIC_TOOL_NAMES } from '@agor/core/types';

function parseTool(value: unknown): TenantAgenticToolName | undefined {
  if (value === undefined) return undefined;
  if ((TENANT_AGENTIC_TOOL_NAMES as readonly unknown[]).includes(value)) {
    return value as TenantAgenticToolName;
  }
  throw new BadRequest(`Unsupported agentic tool: ${String(value)}`);
}

function actor(params?: Params): UserID {
  const userId = (params as { user?: { user_id?: UserID } } | undefined)?.user?.user_id;
  if (!userId) throw new NotAuthenticated('Authenticated user required');
  return userId;
}

function validateConfiguration(
  value: unknown
): asserts value is AgenticToolPreset['configuration'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequest('configuration must be an object');
  }
  const allowed = new Set([
    'modelConfig',
    'permissionMode',
    'codexSandboxMode',
    'codexApprovalPolicy',
    'codexNetworkAccess',
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new BadRequest(`Unknown preset configuration fields: ${unknown.join(', ')}`);
}

function isForeignKeyRestriction(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (record.code === '23503') return true;
    if (
      typeof record.message === 'string' &&
      /foreign key constraint|violates foreign key constraint/i.test(record.message)
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

export class AgenticToolPresetsService {
  private repository: AgenticToolPresetRepository;
  private db: TenantScopeAwareDatabase;

  constructor(db: TenantScopeAwareDatabase) {
    this.db = db;
    this.repository = new AgenticToolPresetRepository(db);
  }

  async find(params?: Params): Promise<AgenticToolPreset[]> {
    return this.repository.find(parseTool(params?.query?.tool));
  }

  async get(id: string): Promise<AgenticToolPreset> {
    const preset = await this.repository.findById(id);
    if (!preset) throw new BadRequest(`Agentic tool preset not found: ${id}`);
    return preset;
  }

  async create(data: CreateAgenticToolPreset, params?: Params): Promise<AgenticToolPreset> {
    const tool = parseTool(data.tool);
    if (!tool) throw new BadRequest('tool is required');
    validateConfiguration(data.configuration);
    return this.repository.create({ ...data, tool }, actor(params));
  }

  async patch(
    id: string,
    data: PatchAgenticToolPreset,
    params?: Params
  ): Promise<AgenticToolPreset> {
    if (data.configuration !== undefined) validateConfiguration(data.configuration);
    if (data.name !== undefined && !data.name.trim()) throw new BadRequest('name is required');
    if (data.is_default === false) {
      const current = await this.get(id);
      const settings = await new TenantAgenticToolSettingsRepository(this.db).find(current.tool);
      if (current.is_default && settings.inline_configuration_allowed === false) {
        throw new BadRequest(
          `Choose another default ${current.tool} preset before unsetting this one`
        );
      }
    }
    return this.repository.patch(id, data, actor(params));
  }

  async remove(id: string): Promise<AgenticToolPreset> {
    const current = await this.get(id);
    const settings = await new TenantAgenticToolSettingsRepository(this.db).find(current.tool);
    if (current.is_default && settings.inline_configuration_allowed === false) {
      throw new BadRequest(
        `Choose another default ${current.tool} preset before deleting this one`
      );
    }
    const [sessions, schedules, channels, users] = await Promise.all([
      new SessionRepository(this.db).findAll(),
      new ScheduleRepository(this.db).findAll(),
      new GatewayChannelRepository(this.db).findAll(),
      new UsersRepository(this.db).findAll(),
    ]);
    const references =
      sessions.filter((session) => session.agentic_tool_preset_id === id).length +
      schedules.filter((schedule) => schedule.agentic_tool_config.preset_id === id).length +
      channels.filter((channel) => channel.agentic_config?.presetId === id).length +
      users.filter((user) =>
        Object.values(user.default_agentic_selection ?? {}).some(
          (selection) => selection?.source === 'preset' && selection.preset_id === id
        )
      ).length;
    if (references > 0) {
      throw new BadRequest(
        `Preset is referenced by ${references} configuration${references === 1 ? '' : 's'}`
      );
    }
    try {
      return await this.repository.remove(id);
    } catch (error) {
      // A relational reference may be created after the best-effort scan.
      // The database remains authoritative via ON DELETE RESTRICT; never leak
      // a dialect-specific constraint error through the API.
      if (isForeignKeyRestriction(error)) {
        throw new BadRequest('Preset is still referenced and cannot be deleted');
      }
      throw error;
    }
  }
}

export function createAgenticToolPresetsService(db: TenantScopeAwareDatabase) {
  return new AgenticToolPresetsService(db);
}
