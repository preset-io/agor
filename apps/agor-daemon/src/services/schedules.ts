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
 *
 * See docs/internal/schedules-first-class-design-2026-05-24.md §4.4.
 */

import {
  AgenticConfigurationResolutionError,
  assertInlineAgenticConfigurationAllowed,
  InvalidScheduleAgenticToolConfigError,
  normalizeScheduleAgenticToolConfig,
  PAGINATION,
  resolveAgenticConfigurationReference,
  resolveAgenticToolPreset,
} from '@agor/core/config';
import { ScheduleRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  BranchID,
  QueryParams,
  Schedule,
  UserID,
  UUID,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

export type ScheduleParams = QueryParams<{
  branch_id?: BranchID;
  enabled?: boolean;
  created_by?: UUID;
}> &
  AuthenticatedParams & { schedule?: Schedule };

export class SchedulesService extends DrizzleService<Schedule, Partial<Schedule>, ScheduleParams> {
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
    config: Schedule['agentic_tool_config'],
    userId?: UserID
  ): Promise<Schedule['agentic_tool_config']> {
    try {
      if (config.configuration_reference !== undefined) {
        await resolveAgenticConfigurationReference(
          this.db,
          config.agentic_tool,
          config.configuration_reference,
          userId
        );
        return config;
      } else if (config.preset_id !== undefined) {
        const preset = await resolveAgenticToolPreset(
          this.db,
          config.agentic_tool,
          config.preset_id
        );
        return { ...config, preset_id: preset.preset_id };
      } else {
        await assertInlineAgenticConfigurationAllowed(this.db, config.agentic_tool);
        return config;
      }
    } catch (error) {
      if (error instanceof AgenticConfigurationResolutionError) {
        throw new BadRequest('Selected agentic configuration is not available');
      }
      throw error;
    }
  }

  private normalizeConfig(
    config: Schedule['agentic_tool_config']
  ): Schedule['agentic_tool_config'] {
    try {
      return normalizeScheduleAgenticToolConfig(config);
    } catch (error) {
      if (error instanceof InvalidScheduleAgenticToolConfigError) {
        throw new BadRequest(error.message);
      }
      throw error;
    }
  }

  async create(data: Partial<Schedule>, params?: ScheduleParams) {
    if (data.agentic_tool_config) {
      let agenticToolConfig = this.normalizeConfig(data.agentic_tool_config);
      const creatorId = (data.created_by ?? params?.user?.user_id) as UserID | undefined;
      agenticToolConfig = await this.validateConfig(agenticToolConfig, creatorId);
      data = {
        ...data,
        agentic_tool_config: agenticToolConfig,
      };
    }
    return super.create(data, params);
  }

  async patch(id: string | null, data: Partial<Schedule>, params?: ScheduleParams) {
    if (data.agentic_tool_config) {
      if (id === null) throw new BadRequest('Schedule configuration cannot be multi-patched');
      const current = params?.schedule ?? (await this.get(id, params));
      let agenticToolConfig = this.normalizeConfig(data.agentic_tool_config);
      agenticToolConfig = await this.validateConfig(
        agenticToolConfig,
        current.created_by as UserID
      );
      data = {
        ...data,
        agentic_tool_config: agenticToolConfig,
      };
    }
    return super.patch(id, data, params);
  }

  async update(id: string, data: Partial<Schedule>, params?: ScheduleParams) {
    return this.patch(id, data, params) as Promise<Schedule>;
  }
}

export function createSchedulesService(db: TenantScopeAwareDatabase): SchedulesService {
  return new SchedulesService(db);
}
