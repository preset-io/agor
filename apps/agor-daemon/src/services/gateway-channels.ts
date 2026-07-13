/**
 * Gateway Channels Service
 *
 * Provides REST + WebSocket API for gateway channel management.
 * Uses DrizzleService adapter with GatewayChannelRepository.
 */

import {
  assertInlineAgenticConfigurationAllowed,
  PAGINATION,
  resolveAgenticConfigurationReference,
  resolveAgenticToolPreset,
} from '@agor/core/config';
import { GatewayChannelRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type { GatewayChannel, NullableId, Params } from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';

export class GatewayChannelsService extends DrizzleService<
  GatewayChannel,
  Partial<GatewayChannel>
> {
  private db: TenantScopeAwareDatabase;

  constructor(db: TenantScopeAwareDatabase) {
    const repo = new GatewayChannelRepository(db);
    super(repo, {
      id: 'id',
      resourceType: 'GatewayChannel',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
    });
    this.db = db;
  }

  private async validateConfig(config: GatewayChannel['agentic_config']): Promise<void> {
    if (!config) {
      await assertInlineAgenticConfigurationAllowed(this.db, 'claude-code');
      return;
    }
    if (config.presetId) {
      await resolveAgenticToolPreset(this.db, config.agent, config.presetId);
      const hasOverrides = Object.entries(config).some(
        ([key, value]) => !['agent', 'presetId', 'envVars'].includes(key) && value !== undefined
      );
      if (hasOverrides) {
        throw new BadRequest('Preset-backed gateway channels cannot contain inline overrides');
      }
    } else await assertInlineAgenticConfigurationAllowed(this.db, config.agent);
  }

  private async normalizeConfig(
    config: GatewayChannel['agentic_config'],
    params?: Params
  ): Promise<GatewayChannel['agentic_config']> {
    if (!config?.presetId) return config;
    const resolved = await resolveAgenticConfigurationReference(
      this.db,
      config.agent,
      config.presetId,
      (params as { user?: { user_id?: import('@agor/core/types').UserID } } | undefined)?.user
        ?.user_id
    );
    const configuration = resolved.preset?.configuration ?? resolved.configuration ?? {};
    if (resolved.preset) {
      return {
        agent: config.agent,
        presetId: resolved.preset.preset_id,
        ...(config.envVars ? { envVars: config.envVars } : {}),
      };
    }
    return {
      agent: config.agent,
      ...configuration,
      ...(config.envVars ? { envVars: config.envVars } : {}),
    };
  }

  async create(data: Partial<GatewayChannel>, params?: Params) {
    await this.validateConfig(data.agentic_config ?? null);
    const agenticConfig = await this.normalizeConfig(data.agentic_config ?? null, params);
    data = { ...data, agentic_config: agenticConfig };
    return super.create(data, params);
  }

  async patch(id: NullableId, data: Partial<GatewayChannel>, params?: Params) {
    if (data.agentic_config !== undefined) {
      await this.validateConfig(data.agentic_config);
      data = { ...data, agentic_config: await this.normalizeConfig(data.agentic_config, params) };
    }
    return super.patch(id, data, params);
  }

  async update(id: string, data: Partial<GatewayChannel>, params?: Params) {
    return this.patch(id, data, params) as Promise<GatewayChannel>;
  }
}

/**
 * Service factory function
 */
export function createGatewayChannelsService(db: TenantScopeAwareDatabase): GatewayChannelsService {
  return new GatewayChannelsService(db);
}
