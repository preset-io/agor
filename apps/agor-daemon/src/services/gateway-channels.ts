/**
 * Gateway Channels Service
 *
 * Provides REST + WebSocket API for gateway channel management.
 * Uses DrizzleService adapter with GatewayChannelRepository.
 */

import { materializeAgenticToolConfiguration } from '@agor/agentic-tools/config';
import { AgenticConfigurationResolutionError, PAGINATION } from '@agor/core/config';
import {
  GatewayChannelRepository,
  isPostgresDatabase,
  ProviderProbeInProgressError,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import {
  DiscordGatewayConfigError,
  getConnector,
  isSlackWriteTargetAllowed,
  parseDiscordGatewayConfig,
} from '@agor/core/gateway';
import { isInvalidModelConfigError } from '@agor/core/models';
import {
  type AgenticToolConfigurationSource,
  type AuthenticatedParams,
  GATEWAY_CHANNEL_WRITE_FIELDS,
  GATEWAY_REDACTED_SENTINEL,
  type GatewayChannel,
  type GatewayChannelCreateData,
  type GatewayChannelPatchData,
  isCanonicalFullUuid,
  type NullableId,
  type Params,
  type PersistedGatewayAgenticConfig,
  resolveSlackAgentTools,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  type UserID,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import {
  gatewayAgenticConfigToInlineConfiguration,
  hasDefinedGatewayAgenticConfigInlineFields,
  materializedAgenticToolConfigurationToGatewayConfig,
} from '../utils/agentic-configuration-sources.js';
import { requireActiveAgenticTool } from '../utils/agentic-tool-runtime.js';
import { getUploadLimits } from '../utils/upload.js';
import { assertServiceWriteFields, pickWriteFields } from '../utils/write-data-boundary.js';

type PersistedGatewayChannelCreateData = Omit<GatewayChannelCreateData, 'agentic_config'> & {
  agentic_config?: PersistedGatewayAgenticConfig | null;
  created_by?: GatewayChannel['created_by'];
};

type PersistedGatewayChannelPatchData = Omit<GatewayChannelPatchData, 'agentic_config'> & {
  agentic_config?: PersistedGatewayAgenticConfig | null;
};

type PersistedGatewayChannelWriteData =
  | PersistedGatewayChannelCreateData
  | PersistedGatewayChannelPatchData;

/**
 * Public GatewayChannel transport surface. `update` is deliberately absent so
 * whole-row `PUT` never reaches the inherited DrizzleService implementation.
 */
export const GATEWAY_CHANNELS_SERVICE_TRANSPORT_METHODS = [
  'find',
  'get',
  'create',
  'patch',
  'remove',
  'uploadFileStreamFromExecutor',
] as const;

export class GatewayChannelsService extends DrizzleService<
  GatewayChannel,
  PersistedGatewayChannelWriteData
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
    channel: Pick<GatewayChannel, 'agor_user_id' | 'channel_type' | 'config'>
  ): boolean {
    const config = channel.config as Record<string, unknown>;
    if (channel.channel_type === 'discord') {
      // User alignment is on by default for Discord. In aligned mode each
      // admitted mention may run as a different mapped Agor user, so there is
      // no channel-wide owner whose personal defaults can be materialized.
      return config.align_discord_users === false && isCanonicalFullUuid(channel.agor_user_id);
    }
    return Boolean(
      channel.agor_user_id &&
        config.align_slack_users !== true &&
        config.align_github_users !== true &&
        config.align_shortcut_users !== true
    );
  }

  private async validateConfig(
    config: GatewayChannelPatchData['agentic_config'] | GatewayChannel['agentic_config'],
    channel: Pick<GatewayChannel, 'agor_user_id' | 'channel_type' | 'config'>,
    allowMaterializedSnapshot = false
  ): Promise<PersistedGatewayAgenticConfig | null> {
    if (!config) return null;
    const tool = requireActiveAgenticTool(config?.agent ?? 'claude-code');
    const hasInline = hasDefinedGatewayAgenticConfigInlineFields(config);
    if (config?.presetId && hasInline && !allowMaterializedSnapshot) {
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

    const source: AgenticToolConfigurationSource = config?.presetId
      ? { reference: config.presetId }
      : { configuration: gatewayAgenticConfigToInlineConfiguration(config) };
    try {
      const materialized = await materializeAgenticToolConfiguration(this.db, {
        tool,
        source,
        executionOwnerId: this.hasStableExecutionOwner(channel)
          ? (channel.agor_user_id as UserID)
          : undefined,
      });
      return materializedAgenticToolConfigurationToGatewayConfig(config, materialized);
    } catch (error) {
      if (
        isInvalidModelConfigError(error) ||
        error instanceof AgenticConfigurationResolutionError
      ) {
        throw new BadRequest(error.message);
      }
      throw error;
    }
  }

  private validateChannelConfig(
    channel: Pick<
      GatewayChannel,
      'agor_user_id' | 'channel_type' | 'config' | 'enabled' | 'provider_installation_id'
    >
  ): Record<string, unknown> {
    if (channel.channel_type !== 'discord') {
      return channel.config;
    }
    try {
      const parsed = parseDiscordGatewayConfig(channel.config, {
        enabled: channel.enabled,
        agorUserId: channel.agor_user_id,
        requireRunAsUser: true,
      });
      if (channel.enabled && !isPostgresDatabase(this.db)) {
        throw new BadRequest('Discord gateway runtime requires PostgreSQL');
      }
      if (channel.enabled && channel.provider_installation_id !== parsed.application_id) {
        throw new BadRequest('Test the Discord connection before enabling this gateway channel');
      }
      return { ...parsed };
    } catch (error) {
      if (error instanceof DiscordGatewayConfigError) {
        throw new BadRequest(error.message);
      }
      throw error;
    }
  }

  private async validateDiscordAlignmentUsers(
    channelType: GatewayChannel['channel_type'],
    config: Record<string, unknown>
  ): Promise<void> {
    if (channelType !== 'discord') return;
    const userMap = config.user_map;
    if (!userMap || typeof userMap !== 'object' || Array.isArray(userMap)) return;
    const requested = Object.values(userMap).filter(
      (userId): userId is string => typeof userId === 'string'
    );
    const existing = await new UsersRepository(this.db).findExistingIds(requested);
    if (requested.some((userId) => !existing.has(userId))) {
      throw new BadRequest('Discord User alignment contains an unavailable Agor user');
    }
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

    const normalizedConfig = this.validateChannelConfig({
      agor_user_id: data.agor_user_id as GatewayChannel['agor_user_id'],
      channel_type: data.channel_type,
      config: data.config ?? {},
      enabled: data.enabled ?? true,
      provider_installation_id: null,
    });
    const materializedAgenticConfig = await this.validateConfig(data.agentic_config ?? null, {
      agor_user_id: data.agor_user_id as GatewayChannel['agor_user_id'],
      channel_type: data.channel_type,
      config: normalizedConfig,
    });
    await this.validateDiscordAlignmentUsers(data.channel_type, normalizedConfig);
    const creatorId = (params as AuthenticatedParams | undefined)?.user?.user_id;
    const trustedCreatedBy =
      creatorId ?? (prepared ? (rawData.created_by as string | undefined) : undefined);
    const persistedData: PersistedGatewayChannelCreateData = {
      ...data,
      config: normalizedConfig,
      agentic_config: materializedAgenticConfig,
      ...(trustedCreatedBy ? { created_by: trustedCreatedBy } : {}),
    };
    return super.create(persistedData, params);
  }

  async patch(id: NullableId, data: GatewayChannelPatchData, params?: Params) {
    const rawData = data as Record<string, unknown>;
    assertServiceWriteFields('Gateway channel', rawData, GATEWAY_CHANNEL_WRITE_FIELDS, params);
    data = pickWriteFields<GatewayChannelPatchData>(rawData, GATEWAY_CHANNEL_WRITE_FIELDS);

    if (id === null || Array.isArray(id)) {
      if (
        data.agentic_config !== undefined ||
        data.agor_user_id !== undefined ||
        data.channel_type !== undefined ||
        data.config !== undefined ||
        data.enabled !== undefined
      ) {
        throw new BadRequest('Gateway configuration cannot be multi-patched');
      }
      return super.patch(id, data, params);
    }

    const current = await this.get(String(id), params);
    const mergedConfig = { ...current.config, ...data.config };
    // A redacted token round-tripped by the settings client means "unchanged".
    // Validate against the decrypted stored token rather than turning a safe
    // patch into a transient listener retry loop.
    if (
      (data.config?.bot_token === GATEWAY_REDACTED_SENTINEL || data.config?.bot_token === '') &&
      current.config.bot_token
    ) {
      mergedConfig.bot_token = current.config.bot_token;
    }
    const botTokenChanged =
      typeof data.config?.bot_token === 'string' &&
      data.config.bot_token !== '' &&
      data.config.bot_token !== GATEWAY_REDACTED_SENTINEL &&
      data.config.bot_token !== current.config.bot_token;
    const applicationChanged =
      data.config?.application_id !== undefined &&
      data.config.application_id !== current.config.application_id;
    const providerBindingChanged =
      (data.channel_type !== undefined && data.channel_type !== current.channel_type) ||
      botTokenChanged ||
      applicationChanged;
    const effectiveChannel = {
      agor_user_id: data.agor_user_id ?? current.agor_user_id,
      channel_type: data.channel_type ?? current.channel_type,
      config: mergedConfig,
      enabled: data.enabled ?? current.enabled,
      provider_installation_id: providerBindingChanged ? null : current.provider_installation_id,
    };
    const normalizedConfig = this.validateChannelConfig(effectiveChannel);

    let persistedData: PersistedGatewayChannelPatchData = {
      ...data,
      ...(effectiveChannel.channel_type === 'discord' &&
      (data.config !== undefined || data.channel_type !== undefined)
        ? { config: normalizedConfig }
        : {}),
    };
    if (
      data.agentic_config !== undefined ||
      data.agor_user_id !== undefined ||
      data.channel_type !== undefined ||
      data.config !== undefined
    ) {
      const materializedAgenticConfig = await this.validateConfig(
        data.agentic_config === undefined ? current.agentic_config : data.agentic_config,
        {
          agor_user_id: effectiveChannel.agor_user_id,
          channel_type: effectiveChannel.channel_type,
          config: normalizedConfig,
        },
        data.agentic_config === undefined
      );
      persistedData = { ...persistedData, agentic_config: materializedAgenticConfig };
    }
    await this.validateDiscordAlignmentUsers(effectiveChannel.channel_type, normalizedConfig);
    try {
      return await super.patch(id, persistedData, params);
    } catch (error) {
      if (error instanceof ProviderProbeInProgressError) {
        throw new BadRequest(error.message);
      }
      throw error;
    }
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

    const maxFileBytes = getUploadLimits().maxFileBytes;
    if (!Number.isSafeInteger(data.size) || data.size < 0 || data.size > maxFileBytes) {
      throw new BadRequest(`File exceeds the ${maxFileBytes}-byte upload limit`);
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
