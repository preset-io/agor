/**
 * Gateway Channels Service
 *
 * Provides REST + WebSocket API for gateway channel management.
 * Uses DrizzleService adapter with GatewayChannelRepository.
 */

import { materializeAgenticToolConfiguration } from '@agor/agentic-tools/config';
import { AgenticConfigurationResolutionError, PAGINATION, validateEnvVar } from '@agor/core/config';
import {
  GatewayChannelRepository,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import {
  evaluateDiscordConnectionVerification,
  getConnector,
  isSlackWriteTargetAllowed,
  validateDiscordSetup,
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
  isGatewayProviderAuthorityPatch,
  mergeGatewayChannelConfigPatch,
  type NullableId,
  type Params,
  type PersistedGatewayAgenticConfig,
  resolveSlackAgentTools,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  type UserID,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { gatewaySlackUploadExecutorCommandId } from '../auth/executor-command-ids.js';
import { matchesExecutorCommandRuntimeScope } from '../auth/executor-runtime-scope.js';
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
  private readonly channelRepo: GatewayChannelRepository;

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
    this.channelRepo = repo;
  }

  /**
   * Gateway patching may probe a provider, so the service is registered on
   * the identity-only tenant boundary. Keep each database phase short and
   * let the provider call happen after this scope has committed.
   */
  private async withTenantDatabase<T>(params: Params | undefined, work: () => Promise<T>) {
    const tenantId =
      (params as (Params & { tenant?: { tenant_id?: string } }) | undefined)?.tenant?.tenant_id ??
      getCurrentTenantId();
    return runWithTenantDatabaseScope(this.db, tenantId, async () => work());
  }

  private hasStableExecutionOwner(
    channel: Pick<GatewayChannel, 'agor_user_id' | 'config'>
  ): boolean {
    const config = channel.config as Record<string, unknown>;
    return Boolean(
      channel.agor_user_id &&
        config.align_slack_users !== true &&
        config.align_github_users !== true &&
        config.align_shortcut_users !== true &&
        config.align_discord_users !== true
    );
  }

  private assertValidEnvironmentVariables(config: PersistedGatewayAgenticConfig | null): void {
    const seen = new Set<string>();
    for (const variable of config?.envVars ?? []) {
      if (seen.has(variable.key)) {
        throw new BadRequest(`Duplicate gateway environment variable: ${variable.key}`);
      }
      seen.add(variable.key);
      if (variable.value === GATEWAY_REDACTED_SENTINEL) {
        // The transport hook must resolve preservation sentinels to the current
        // plaintext before this authoritative service boundary. A sentinel
        // reaching a direct/provider-less call is never a credential.
        throw new BadRequest(
          `Gateway environment variable ${variable.key} contains an unresolved redaction sentinel`
        );
      }
      const errors = validateEnvVar(variable.key, variable.value);
      if (errors.length > 0) {
        throw new BadRequest(
          `Invalid gateway environment variable ${variable.key}: ${errors.map((error) => error.message).join('; ')}`
        );
      }
    }
  }

  private async validateConfig(
    config: GatewayChannelPatchData['agentic_config'] | GatewayChannel['agentic_config'],
    channel: Pick<GatewayChannel, 'agor_user_id' | 'config'>,
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
      const resolved = materializedAgenticToolConfigurationToGatewayConfig(config, materialized);
      this.assertValidEnvironmentVariables(resolved);
      return resolved;
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

    return this.withTenantDatabase(params, async () => {
      const materializedAgenticConfig = await this.validateConfig(data.agentic_config ?? null, {
        agor_user_id: data.agor_user_id as GatewayChannel['agor_user_id'],
        config: data.config ?? {},
      });
      const creatorId = (params as AuthenticatedParams | undefined)?.user?.user_id;
      const trustedCreatedBy =
        creatorId ?? (prepared ? (rawData.created_by as string | undefined) : undefined);
      const persistedData: PersistedGatewayChannelCreateData = {
        ...data,
        agentic_config: materializedAgenticConfig,
        ...(trustedCreatedBy ? { created_by: trustedCreatedBy } : {}),
      };
      return super.create(persistedData, params);
    });
  }

  async find(params?: Params) {
    return this.withTenantDatabase(params, () => super.find(params));
  }

  async get(id: string, params?: Params) {
    return this.withTenantDatabase(params, () => super.get(id, params));
  }

  async patch(id: NullableId, data: GatewayChannelPatchData, params?: Params) {
    return this.patchInternal(id, data, params);
  }

  /** Internal token-widget seam; provider identity is never a public write field. */
  async patchWithVerifiedDiscordInstallation(
    id: string,
    data: GatewayChannelPatchData,
    providerInstallationId: string,
    expectedProviderConfigGeneration: number,
    params?: Params
  ) {
    return this.patchInternal(
      id,
      data,
      params,
      providerInstallationId,
      expectedProviderConfigGeneration
    );
  }

  private async patchInternal(
    id: NullableId,
    data: GatewayChannelPatchData,
    params?: Params,
    verifiedProviderInstallationId?: string,
    expectedProviderConfigGeneration?: number
  ) {
    const rawData = data as Record<string, unknown>;
    assertServiceWriteFields('Gateway channel', rawData, GATEWAY_CHANNEL_WRITE_FIELDS, params);
    data = pickWriteFields<GatewayChannelPatchData>(rawData, GATEWAY_CHANNEL_WRITE_FIELDS);

    const authorityPatch = isGatewayProviderAuthorityPatch(data);
    if ((id === null || Array.isArray(id)) && authorityPatch) {
      throw new BadRequest('Gateway provider-authority changes cannot be multi-patched');
    }

    const needsCurrent =
      id !== null &&
      !Array.isArray(id) &&
      (authorityPatch ||
        data.agentic_config !== undefined ||
        data.agor_user_id !== undefined ||
        data.config !== undefined);
    const prepared = needsCurrent
      ? await this.withTenantDatabase(params, async () => {
          const current = await this.channelRepo.findById(String(id));
          if (!current) throw new BadRequest('Gateway channel was not found');

          let persistedData: PersistedGatewayChannelPatchData = data;
          if (
            data.agentic_config !== undefined ||
            data.agor_user_id !== undefined ||
            data.config !== undefined
          ) {
            const materializedAgenticConfig = await this.validateConfig(
              data.agentic_config === undefined ? current.agentic_config : data.agentic_config,
              {
                agor_user_id:
                  data.agor_user_id !== undefined ? data.agor_user_id : current.agor_user_id,
                config: mergeGatewayChannelConfigPatch(
                  current.config,
                  data.config,
                  data.channel_type ?? current.channel_type,
                  data.enabled ?? current.enabled
                ),
              },
              data.agentic_config === undefined
            );
            // Validation may need the current agentic configuration to resolve the
            // effective execution owner, but an authority patch did not request an
            // agentic write. Keep that derived snapshot out of the repository patch
            // so it cannot overwrite a concurrent sparse non-authority update.
            if (data.agentic_config !== undefined) {
              persistedData = { ...data, agentic_config: materializedAgenticConfig };
            }
          }
          return { current, persistedData };
        })
      : { current: undefined, persistedData: data as PersistedGatewayChannelPatchData };
    const { current, persistedData } = prepared;

    // Public Discord authority changes probe the exact merged configuration
    // before using the repository's verified-installation CAS seam. The secure
    // token widget already supplies that verified result and therefore skips a
    // redundant second provider call.
    if (authorityPatch && current && current.channel_type !== undefined) {
      const effectiveType = data.channel_type ?? current.channel_type;
      const effectiveEnabled = data.enabled ?? current.enabled;
      const effectiveConfig = mergeGatewayChannelConfigPatch(
        current.config,
        data.config,
        effectiveType,
        effectiveEnabled
      );
      const effectiveAgorUserId =
        data.agor_user_id !== undefined ? data.agor_user_id : current.agor_user_id;
      if (
        verifiedProviderInstallationId === undefined &&
        effectiveType === 'discord' &&
        effectiveEnabled
      ) {
        const validation = validateDiscordSetup(effectiveConfig, effectiveAgorUserId);
        if (!validation.ok) {
          throw new BadRequest(
            `Invalid Discord gateway configuration: ${validation.errors.join('; ')}`
          );
        }
        const result = await getConnector('discord', effectiveConfig).testConnection?.();
        const verification = evaluateDiscordConnectionVerification(
          result,
          effectiveConfig.application_id
        );
        if (!verification.verified) {
          const reason = verification.failure.warnings.join('; ') || verification.failure.reason;
          throw new BadRequest(`Discord verification failed: ${reason}`);
        }
        verifiedProviderInstallationId = verification.installationId;
        expectedProviderConfigGeneration = current.provider_config_generation;
      }
    }
    if (verifiedProviderInstallationId !== undefined) {
      if (id === null || Array.isArray(id)) {
        throw new BadRequest('Discord installation verification requires one channel');
      }
      if (expectedProviderConfigGeneration === undefined) {
        throw new BadRequest('Discord installation verification requires a config generation');
      }
      return this.withTenantDatabase(params, () =>
        this.channelRepo.updateWithVerifiedDiscordInstallation(
          String(id),
          persistedData,
          verifiedProviderInstallationId,
          expectedProviderConfigGeneration
        )
      );
    }
    return this.withTenantDatabase(params, () => super.patch(id, persistedData, params));
  }

  async remove(id: NullableId, params?: Params) {
    return this.withTenantDatabase(params, () => super.remove(id, params));
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
    if (!caller) throw new NotAuthenticated('Authentication required');
    if (
      !matchesExecutorCommandRuntimeScope(
        params,
        gatewaySlackUploadExecutorCommandId(data.gatewayChannelId, data.channel),
        (params.authentication?.payload as { branch_id?: string } | undefined)?.branch_id
      )
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
    if (
      (params.authentication?.payload as { branch_id?: string } | undefined)?.branch_id !==
      gatewayChannel.target_branch_id
    ) {
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
