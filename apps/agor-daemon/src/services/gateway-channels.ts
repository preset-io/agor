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
import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import { getConnector, isSlackWriteTargetAllowed } from '@agor/core/gateway';
import {
  type AuthenticatedParams,
  type GatewayChannel,
  type NullableId,
  type Params,
  resolveSlackAgentTools,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { MAX_UPLOAD_FILE_SIZE } from '../utils/upload.js';

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

  async uploadFileFromExecutor(
    data: {
      gatewayChannelId: string;
      channel: string;
      threadTs?: string;
      fileBase64: string;
      filename: string;
      comment?: string;
    },
    params?: AuthenticatedParams
  ): Promise<unknown> {
    const caller = params?.user;
    const claims = params?.authentication?.payload as Record<string, unknown> | undefined;
    if (!caller) throw new NotAuthenticated('Authentication required');
    if (!caller._isServiceAccount) {
      throw new Forbidden('Only an executor service account may upload branch files');
    }
    if (
      claims?.executor_action !== 'gateway.slack-file-upload' ||
      claims.executor_gateway_channel_id !== data.gatewayChannelId ||
      claims.executor_slack_channel_id !== data.channel
    ) {
      throw new Forbidden('Executor token is not scoped to this Slack upload');
    }

    const gatewayChannel = (await this.get(data.gatewayChannelId, params)) as GatewayChannel;
    if (!gatewayChannel.enabled) {
      throw new Forbidden('Gateway channel is disabled');
    }
    if (gatewayChannel.channel_type !== 'slack') {
      throw new Forbidden('Gateway channel is not configured for Slack');
    }
    if (!resolveSlackAgentTools(gatewayChannel.config?.agent_tools).file_upload) {
      throw new Forbidden('Slack file uploads are disabled for this gateway channel');
    }
    if (claims.executor_branch_id !== gatewayChannel.target_branch_id) {
      throw new Forbidden('Executor token branch does not match the gateway channel target');
    }
    if (!isSlackWriteTargetAllowed(gatewayChannel.config, data.channel)) {
      throw new Forbidden('Slack channel is not an allowed write target');
    }

    const normalizedBase64 = data.fileBase64;
    if (normalizedBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalizedBase64)) {
      throw new BadRequest('File content must be valid Base64');
    }
    const padding = normalizedBase64.endsWith('==') ? 2 : normalizedBase64.endsWith('=') ? 1 : 0;
    const decodedSize = (normalizedBase64.length / 4) * 3 - padding;
    if (decodedSize > MAX_UPLOAD_FILE_SIZE) {
      throw new BadRequest(`File exceeds the ${MAX_UPLOAD_FILE_SIZE}-byte upload limit`);
    }
    const file = Buffer.from(normalizedBase64, 'base64');
    if (file.toString('base64') !== normalizedBase64) {
      throw new BadRequest('File content must be canonical Base64');
    }

    const connector = getConnector('slack', gatewayChannel.config);
    const uploader = connector as unknown as {
      uploadFile?: (input: {
        channel: string;
        threadTs?: string;
        file: Buffer;
        filename: string;
        comment?: string;
      }) => Promise<unknown>;
    };
    if (typeof uploader.uploadFile !== 'function') {
      throw new BadRequest('Configured Slack connector does not support file uploads');
    }
    return uploader.uploadFile({
      channel: data.channel,
      ...(data.threadTs ? { threadTs: data.threadTs } : {}),
      file,
      filename: data.filename,
      ...(data.comment ? { comment: data.comment } : {}),
    });
  }
}

/**
 * Service factory function
 */
export function createGatewayChannelsService(db: TenantScopeAwareDatabase): GatewayChannelsService {
  return new GatewayChannelsService(db);
}
