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
  PersistedScheduleAgenticToolConfig,
  QueryParams,
  Schedule,
  ScheduleAgenticToolConfig,
  ScheduleData,
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

export class SchedulesService extends DrizzleService<Schedule, ScheduleData, ScheduleParams> {
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
  ): Promise<ScheduleAgenticToolConfig> {
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

  async create(data: ScheduleData, params?: ScheduleParams) {
    const creatorId = params?.user?.user_id as UserID | undefined;
    if (data.agentic_tool_config) {
      let agenticToolConfig = this.normalizeConfig(data.agentic_tool_config);
      agenticToolConfig = await this.validateConfig(agenticToolConfig, creatorId);
      data = {
        ...data,
        agentic_tool_config: agenticToolConfig,
      };
    }
    // External Feathers calls are stamped by injectCreatedBy(). Direct service
    // consumers still receive the same trusted attribution from params rather
    // than exposing created_by in the public write DTO.
    const trustedData = creatorId ? { ...data, created_by: creatorId } : data;
    return super.create(trustedData, params);
  }

  async patch(id: string | null, data: ScheduleData, params?: ScheduleParams) {
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

  async update(id: string, data: ScheduleData, params?: ScheduleParams) {
    return this.patch(id, data, params) as Promise<Schedule>;
  }
}

export function createSchedulesService(db: TenantScopeAwareDatabase): SchedulesService {
  return new SchedulesService(db);
}
