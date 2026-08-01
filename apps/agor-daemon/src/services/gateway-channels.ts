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
  GATEWAY_CHANNEL_WRITE_FIELDS,
  type GatewayChannel,
  type GatewayChannelCreateData,
  type GatewayChannelPatchData,
  type NullableId,
  type Params,
  resolveSlackAgentTools,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { requireActiveAgenticTool } from '../utils/agentic-tool-runtime.js';
import { MAX_UPLOAD_FILE_SIZE } from '../utils/upload.js';
import { assertServiceWriteFields, pickWriteFields } from '../utils/write-data-boundary.js';

export class GatewayChannelsService extends DrizzleService<
  GatewayChannel,
  GatewayChannelPatchData
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

  private async validateConfig(config: GatewayChannelPatchData['agentic_config']): Promise<void> {
    if (!config) {
      await assertInlineAgenticConfigurationAllowed(this.db, 'claude-code');
      return;
    }
    requireActiveAgenticTool(config.agent);
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
    config: GatewayChannelPatchData['agentic_config'],
    params?: Params
  ): Promise<GatewayChannelPatchData['agentic_config']> {
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

  async create(data: GatewayChannelCreateData, params?: Params) {
    const rawData = data as unknown as Record<string, unknown>;
    const prepared = assertServiceWriteFields(
      'Gateway channel',
      rawData,
      GATEWAY_CHANNEL_WRITE_FIELDS,
      params,
      ['created_by']
    );
    data = pickWriteFields<GatewayChannelCreateData>(rawData, GATEWAY_CHANNEL_WRITE_FIELDS);

    await this.validateConfig(data.agentic_config ?? null);
    const agenticConfig = await this.normalizeConfig(data.agentic_config ?? null, params);
    data = { ...data, agentic_config: agenticConfig };
    const creatorId = (params as AuthenticatedParams | undefined)?.user?.user_id;
    const trustedCreatedBy =
      creatorId ?? (prepared ? (rawData.created_by as string | undefined) : undefined);
    return super.create(
      {
        ...data,
        ...(trustedCreatedBy ? { created_by: trustedCreatedBy } : {}),
      },
      params
    );
  }

  async patch(id: NullableId, data: GatewayChannelPatchData, params?: Params) {
    const rawData = data as Record<string, unknown>;
    assertServiceWriteFields('Gateway channel', rawData, GATEWAY_CHANNEL_WRITE_FIELDS, params);
    data = pickWriteFields<GatewayChannelPatchData>(rawData, GATEWAY_CHANNEL_WRITE_FIELDS);

    if (data.agentic_config !== undefined) {
      await this.validateConfig(data.agentic_config);
      data = { ...data, agentic_config: await this.normalizeConfig(data.agentic_config, params) };
    }
    return super.patch(id, data, params);
  }

  async uploadFileStreamFromExecutor(
    data: {
      gatewayChannelId: string;
      channel: string;
      threadTs?: string;
      filename: string;
      comment?: string;
      size: number;
    },
    file: NodeJS.ReadableStream | Buffer,
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

    if (!Number.isSafeInteger(data.size) || data.size < 0 || data.size > MAX_UPLOAD_FILE_SIZE) {
      throw new BadRequest(`File exceeds the ${MAX_UPLOAD_FILE_SIZE}-byte upload limit`);
    }

    const connector = getConnector('slack', gatewayChannel.config);
    const uploader = connector as unknown as {
      uploadFile?: (input: {
        channel: string;
        threadTs?: string;
        file: NodeJS.ReadableStream | Buffer;
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
