/**
 * Schedules Service
 *
 * Provides REST + WebSocket API for first-class schedules. Uses the
 * DrizzleService adapter with `ScheduleRepository`. RBAC is wired in
 * `register-hooks.ts` and mirrors the sessions service shape:
 *   - find:    view (via scopeScheduleQuery)
 *   - get:     view (via loadScheduleAndBranch + ensureBranchPermission)
 *   - create:  session
 *   - patch:   session for own / all for others
 *   - remove:  all
 *   - run-now: all (custom REST verb in register-routes.ts)
 */

import { materializeAgenticToolConfiguration } from '@agor/agentic-tools/config';
import {
  AgenticConfigurationResolutionError,
  InvalidScheduleAgenticToolConfigError,
  normalizeScheduleAgenticToolConfig,
  PAGINATION,
} from '@agor/core/config';
import {
  MCPServerRepository,
  ScheduleRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest, Forbidden } from '@agor/core/feathers';
import { isMCPServerUsableBy } from '@agor/core/mcp';
import { isInvalidModelConfigError } from '@agor/core/models';
import type {
  AuthenticatedParams,
  BranchID,
  PersistedScheduleAgenticToolConfig,
  QueryParams,
  Schedule,
  ScheduleAgenticToolConfig,
  ScheduleCreateData,
  SchedulePatchData,
  UserID,
  UUID,
} from '@agor/core/types';
import { SCHEDULE_CREATE_WRITE_FIELDS, SCHEDULE_PATCH_WRITE_FIELDS } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import {
  materializedAgenticToolConfigurationToScheduleConfig,
  scheduleAgenticToolConfigToSource,
} from '../utils/agentic-configuration-sources.js';
import { assertServiceWriteFields, pickWriteFields } from '../utils/write-data-boundary.js';

/**
 * Public Schedule transport surface. `update` is deliberately absent so
 * whole-row `PUT` never reaches the inherited DrizzleService implementation.
 */
export const SCHEDULES_SERVICE_TRANSPORT_METHODS = [
  'find',
  'get',
  'create',
  'patch',
  'remove',
] as const;

export type ScheduleParams = QueryParams<{
  branch_id?: BranchID;
  enabled?: boolean;
  created_by?: UUID;
}> &
  AuthenticatedParams & { schedule?: Schedule };

type PersistedScheduleCreateData = Omit<ScheduleCreateData, 'agentic_tool_config'> & {
  agentic_tool_config?: PersistedScheduleAgenticToolConfig;
  created_by?: Schedule['created_by'];
  next_run_at?: Schedule['next_run_at'];
};

type PersistedSchedulePatchData = Omit<SchedulePatchData, 'agentic_tool_config'> & {
  agentic_tool_config?: PersistedScheduleAgenticToolConfig;
  next_run_at?: Schedule['next_run_at'];
};

type PersistedScheduleWriteData = PersistedScheduleCreateData | PersistedSchedulePatchData;

export class SchedulesService extends DrizzleService<
  Schedule,
  PersistedScheduleWriteData,
  ScheduleParams
> {
  private db: TenantScopeAwareDatabase;

  constructor(db: TenantScopeAwareDatabase) {
    const repo = new ScheduleRepository(db);
    super(repo, {
      id: 'schedule_id',
      resourceType: 'Schedule',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });
    this.db = db;
  }

  private async validateConfig(
    config: ScheduleAgenticToolConfig,
    userId?: UserID
  ): Promise<PersistedScheduleAgenticToolConfig> {
    try {
      const materialized = await materializeAgenticToolConfiguration(this.db, {
        tool: config.agentic_tool,
        source: scheduleAgenticToolConfigToSource(config),
        executionOwnerId: userId,
      });
      return materializedAgenticToolConfigurationToScheduleConfig(config, materialized);
    } catch (error) {
      if (error instanceof AgenticConfigurationResolutionError) {
        throw new BadRequest('Selected agentic configuration is not available');
      }
      if (isInvalidModelConfigError(error)) throw new BadRequest(error.message);
      throw error;
    }
  }

  /** Runs attach servers as the creator: reject unusable ones on save; missing ones are skipped at run time. */
  private async validateMcpServers(serverIds: string[], runAsUserId?: UserID): Promise<void> {
    const repo = new MCPServerRepository(this.db);
    for (const serverId of serverIds) {
      const server = await repo.getWriteAuthorityProjection(serverId);
      if (server && !isMCPServerUsableBy(server, runAsUserId)) {
        throw new Forbidden(
          `MCP server ${serverId} is private to another user. Schedules run as their creator, so only shared servers or servers the creator owns can be attached.`
        );
      }
    }
  }

  private normalizeConfig(config: PersistedScheduleAgenticToolConfig): ScheduleAgenticToolConfig {
    try {
      return normalizeScheduleAgenticToolConfig(config);
    } catch (error) {
      if (error instanceof InvalidScheduleAgenticToolConfigError) {
        throw new BadRequest(error.message);
      }
      throw error;
    }
  }

  async create(data: ScheduleCreateData, params?: ScheduleParams) {
    const rawData = data as unknown as Record<string, unknown>;
    const prepared = assertServiceWriteFields(
      'Schedule',
      rawData,
      SCHEDULE_CREATE_WRITE_FIELDS,
      params,
      ['created_by', 'next_run_at']
    );
    data = pickWriteFields<ScheduleCreateData>(rawData, SCHEDULE_CREATE_WRITE_FIELDS);

    const creatorId = params?.user?.user_id as UserID | undefined;
    const agenticToolConfig = data.agentic_tool_config
      ? await this.validateConfig(this.normalizeConfig(data.agentic_tool_config), creatorId)
      : undefined;
    const trustedCreatedBy =
      creatorId ?? (prepared ? (rawData.created_by as UserID | undefined) : undefined);
    if (data.mcp_server_ids?.length) {
      await this.validateMcpServers(data.mcp_server_ids, trustedCreatedBy);
    }
    const trustedData: PersistedScheduleCreateData = {
      ...data,
      ...(agenticToolConfig ? { agentic_tool_config: agenticToolConfig } : {}),
      ...(trustedCreatedBy ? { created_by: trustedCreatedBy } : {}),
      ...(prepared && typeof rawData.next_run_at === 'number'
        ? { next_run_at: rawData.next_run_at }
        : {}),
    };
    return super.create(trustedData, params);
  }

  async patch(id: string | null, data: SchedulePatchData, params?: ScheduleParams) {
    const rawData = data as Record<string, unknown>;
    const prepared = assertServiceWriteFields(
      'Schedule',
      rawData,
      SCHEDULE_PATCH_WRITE_FIELDS,
      params,
      ['next_run_at']
    );
    data = pickWriteFields<SchedulePatchData>(rawData, SCHEDULE_PATCH_WRITE_FIELDS);

    let agenticToolConfig: PersistedScheduleAgenticToolConfig | undefined;
    if (data.agentic_tool_config || data.mcp_server_ids?.length) {
      if (id === null) throw new BadRequest('Schedule configuration cannot be multi-patched');
      const current = params?.schedule ?? (await this.get(id, params));
      if (data.agentic_tool_config) {
        agenticToolConfig = await this.validateConfig(
          this.normalizeConfig(data.agentic_tool_config),
          current.created_by as UserID
        );
      }
      if (data.mcp_server_ids?.length) {
        await this.validateMcpServers(data.mcp_server_ids, current.created_by as UserID);
      }
    }
    const trustedData: PersistedSchedulePatchData = {
      ...data,
      ...(agenticToolConfig ? { agentic_tool_config: agenticToolConfig } : {}),
      ...(prepared && typeof rawData.next_run_at === 'number'
        ? { next_run_at: rawData.next_run_at }
        : {}),
    };
    return super.patch(id, trustedData, params);
  }
}

export function createSchedulesService(db: TenantScopeAwareDatabase): SchedulesService {
  return new SchedulesService(db);
}
