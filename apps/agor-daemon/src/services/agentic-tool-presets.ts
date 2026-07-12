import {
  AgenticToolPresetRepository,
  GatewayChannelRepository,
  ScheduleRepository,
  SessionRepository,
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
    return this.repository.patch(id, data, actor(params));
  }

  async remove(id: string): Promise<AgenticToolPreset> {
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
    return this.repository.remove(id);
  }
}

export function createAgenticToolPresetsService(db: TenantScopeAwareDatabase) {
  return new AgenticToolPresetsService(db);
}
