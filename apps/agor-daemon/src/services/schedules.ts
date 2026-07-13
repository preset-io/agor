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
  assertInlineAgenticConfigurationAllowed,
  PAGINATION,
  presetConfigurationToScheduleConfig,
  resolveAgenticConfigurationReference,
  resolveAgenticToolPreset,
} from '@agor/core/config';
import { ScheduleRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type { AuthenticatedParams, BranchID, QueryParams, Schedule, UUID } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

export type ScheduleParams = QueryParams<{
  branch_id?: BranchID;
  enabled?: boolean;
  created_by?: UUID;
}> &
  AuthenticatedParams;

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

  private async validateConfig(config: Schedule['agentic_tool_config']): Promise<void> {
    if (config.preset_id) {
      await resolveAgenticToolPreset(this.db, config.agentic_tool, config.preset_id);
      const hasOverrides = Object.entries(config).some(
        ([key, value]) => !['agentic_tool', 'preset_id'].includes(key) && value !== undefined
      );
      if (hasOverrides) {
        throw new BadRequest('Preset-backed schedules cannot contain inline overrides');
      }
    } else {
      await assertInlineAgenticConfigurationAllowed(this.db, config.agentic_tool);
    }
  }

  private async normalizeConfig(
    config: Schedule['agentic_tool_config'],
    params?: ScheduleParams
  ): Promise<Schedule['agentic_tool_config']> {
    if (!config.preset_id) return config;
    const resolved = await resolveAgenticConfigurationReference(
      this.db,
      config.agentic_tool,
      config.preset_id,
      params?.user?.user_id as import('@agor/core/types').UserID | undefined
    );
    const configuration = resolved.preset?.configuration ?? resolved.configuration ?? {};
    if (resolved.preset) {
      return {
        agentic_tool: config.agentic_tool,
        preset_id: resolved.preset.preset_id,
      };
    }
    const normalized = presetConfigurationToScheduleConfig(
      config.agentic_tool,
      config.preset_id,
      configuration
    );
    const { preset_id: _presetId, ...inline } = normalized;
    return inline;
  }

  async create(data: Partial<Schedule>, params?: ScheduleParams) {
    if (data.agentic_tool_config) {
      await this.validateConfig(data.agentic_tool_config);
      const agenticToolConfig = await this.normalizeConfig(data.agentic_tool_config, params);
      data = {
        ...data,
        agentic_tool_config: agenticToolConfig,
      };
    }
    return super.create(data, params);
  }

  async patch(id: string | null, data: Partial<Schedule>, params?: ScheduleParams) {
    if (data.agentic_tool_config) {
      await this.validateConfig(data.agentic_tool_config);
      const agenticToolConfig = await this.normalizeConfig(data.agentic_tool_config, params);
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
