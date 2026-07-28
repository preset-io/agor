/**
 * Gateway Channels Service
 *
 * Provides REST + WebSocket API for gateway channel management.
 * Uses DrizzleService adapter with GatewayChannelRepository.
 */

import {
  AgenticConfigurationResolutionError,
  materializeAgenticToolConfiguration,
  PAGINATION,
} from '@agor/core/config';
import { GatewayChannelRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import { InvalidModelConfigError } from '@agor/core/models';
import type {
  AgenticToolConfigurationSource,
  GatewayChannel,
  NullableId,
  Params,
  UserID,
} from '@agor/core/types';
import { USER_DEFAULT_AGENTIC_CONFIGURATION } from '@agor/core/types';
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

  private hasStableExecutionOwner(
    channel: Pick<GatewayChannel, 'agor_user_id' | 'config'>
  ): boolean {
    const config = channel.config as Record<string, unknown>;
    return Boolean(
      channel.agor_user_id &&
        config.align_slack_users !== true &&
        config.align_github_users !== true &&
        config.align_shortcut_users !== true
    );
  }

  private async validateConfig(
    config: GatewayChannel['agentic_config'],
    channel: Pick<GatewayChannel, 'agor_user_id' | 'config'>
  ): Promise<void> {
    const tool = config?.agent ?? 'claude-code';
    const hasInline = Object.entries(config ?? {}).some(
      ([key, value]) => !['agent', 'presetId', 'envVars'].includes(key) && value !== undefined
    );
    if (config?.presetId && hasInline) {
      throw new BadRequest('Referenced gateway channels cannot contain inline values');
    }
    if (
      config?.presetId === USER_DEFAULT_AGENTIC_CONFIGURATION &&
      !this.hasStableExecutionOwner(channel)
    ) {
      throw new BadRequest(
        'Gateway channels without a stable execution owner cannot use My default'
      );
    }

    const source = (
      config?.presetId
        ? { reference: config.presetId }
        : {
            configuration: {
              modelConfig: config?.modelConfig,
              permissionMode: config?.permissionMode,
              codexSandboxMode: config?.codexSandboxMode,
              codexApprovalPolicy: config?.codexApprovalPolicy,
              codexNetworkAccess: config?.codexNetworkAccess,
            },
          }
    ) as AgenticToolConfigurationSource;

    try {
      await materializeAgenticToolConfiguration(this.db, {
        tool,
        source,
        executionOwnerId: this.hasStableExecutionOwner(channel)
          ? (channel.agor_user_id as UserID)
          : undefined,
      });
    } catch (error) {
      if (
        error instanceof InvalidModelConfigError ||
        error instanceof AgenticConfigurationResolutionError
      ) {
        throw new BadRequest(error.message);
      }
      throw error;
    }
  }

  async create(data: Partial<GatewayChannel>, params?: Params) {
    await this.validateConfig(data.agentic_config ?? null, {
      agor_user_id: data.agor_user_id as GatewayChannel['agor_user_id'],
      config: data.config ?? {},
    });
    return super.create(data, params);
  }

  async patch(id: NullableId, data: Partial<GatewayChannel>, params?: Params) {
    if (
      data.agentic_config !== undefined ||
      data.agor_user_id !== undefined ||
      data.config !== undefined
    ) {
      if (id === null || Array.isArray(id)) {
        throw new BadRequest('Gateway agentic configuration cannot be multi-patched');
      }
      const current = await this.get(String(id), params);
      await this.validateConfig(
        data.agentic_config === undefined ? current.agentic_config : data.agentic_config,
        {
          agor_user_id: data.agor_user_id ?? current.agor_user_id,
          config: { ...current.config, ...data.config },
        }
      );
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
