/** Admin-only reviewed Discord current-application settings mutation. */

import {
  GatewayChannelRepository,
  type GatewayProviderProbeClaimResult,
  generateId,
  ProviderInstallationConflictError,
  RepositoryError,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { BadRequest, Conflict, NotFound } from '@agor/core/feathers';
import {
  buildDiscordInstallUrl,
  DISCORD_GATEWAY_INTENT_NAMES,
  DISCORD_LAUNCH_PERMISSION_NAMES,
  DISCORD_LAUNCH_PERMISSIONS_DECIMAL,
  DiscordConnector,
  DiscordGatewayConfigError,
  parseDiscordGatewayConfig,
} from '@agor/core/gateway';
import type {
  AuthenticatedParams,
  DiscordGatewayConfig,
  GatewayDiscordApplicationSettingsApplyResult,
} from '@agor/core/types';
import {
  DISCORD_PROVIDER_PROBE_LEASE_MS,
  GatewayProviderProbeHeartbeat,
} from './gateway-provider-probe-heartbeat.js';

export interface GatewayDiscordApplicationSettingsApplyInput {
  gatewayChannelId: string;
}

function assertInput(value: unknown): asserts value is GatewayDiscordApplicationSettingsApplyInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequest('A saved Discord gateway channel is required');
  }
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== 1 ||
    typeof raw.gatewayChannelId !== 'string' ||
    !raw.gatewayChannelId.trim()
  ) {
    throw new BadRequest('Only gatewayChannelId is accepted');
  }
}

function ambiguousResult(
  applicationId: string,
  guildId: string
): GatewayDiscordApplicationSettingsApplyResult {
  return {
    ok: false,
    ambiguous: true,
    requiresRetest: true,
    applicationId,
    installUrl: buildDiscordInstallUrl(applicationId, guildId),
    messageContentAccess: false,
    guildInstallDefaults: false,
    intentNames: DISCORD_GATEWAY_INTENT_NAMES,
    permissionNames: DISCORD_LAUNCH_PERMISSION_NAMES,
    permissions: DISCORD_LAUNCH_PERMISSIONS_DECIMAL,
    code: 'configuration_changed_after_apply',
  };
}

export function createGatewayDiscordApplicationSettingsService(db: TenantScopeAwareDatabase) {
  const channelRepo = new GatewayChannelRepository(db);
  return {
    async create(
      data: GatewayDiscordApplicationSettingsApplyInput,
      _params?: AuthenticatedParams
    ): Promise<GatewayDiscordApplicationSettingsApplyResult> {
      assertInput(data);
      const channel = await channelRepo.findById(data.gatewayChannelId);
      if (!channel) throw new NotFound('Gateway channel not found');
      if (channel.channel_type !== 'discord') {
        throw new BadRequest('Gateway channel is not configured for Discord');
      }
      if (channel.enabled) {
        throw new BadRequest(
          'Disable and save the Discord channel before applying application settings'
        );
      }
      let config: DiscordGatewayConfig;
      try {
        config = parseDiscordGatewayConfig(channel.config, {
          enabled: true,
          agorUserId: channel.agor_user_id,
          requireRunAsUser: true,
        });
      } catch (error) {
        if (error instanceof DiscordGatewayConfigError) {
          throw new BadRequest(error.message);
        }
        throw error;
      }

      let claim: GatewayProviderProbeClaimResult;
      try {
        claim = await channelRepo.claimProviderProbe({
          channelId: channel.id,
          claimToken: generateId(),
          leaseDurationMs: DISCORD_PROVIDER_PROBE_LEASE_MS,
        });
      } catch (error) {
        if (
          error instanceof RepositoryError &&
          error.message === 'Discord setup probes require PostgreSQL'
        ) {
          throw new BadRequest(
            'Discord application settings require the PostgreSQL Cloud ownership path'
          );
        }
        throw new BadRequest('Discord application settings are temporarily unavailable');
      }
      if (claim.outcome === 'held') {
        throw new Conflict('Another Discord setup operation is already in progress');
      }
      if (claim.outcome !== 'claimed') {
        throw new BadRequest('Disable and save the Discord channel before applying settings');
      }

      const lease = claim.lease;
      const heartbeat = new GatewayProviderProbeHeartbeat(channelRepo, lease);
      heartbeat.start();
      let connector: DiscordConnector | undefined;
      let effectiveConfigGeneration = lease.provider_config_generation;
      let patchAdmitted = false;
      try {
        connector = new DiscordConnector({ ...config });
        const summary = await connector.applyRecommendedApplicationSettings({
          signal: heartbeat.signal,
          beforePatch: async (applicationId) => {
            const expectedGeneration =
              channel.provider_installation_id === applicationId
                ? lease.provider_config_generation
                : lease.provider_config_generation + 1;
            const transitioned = await heartbeat.transitionProviderConfigGeneration(async () => {
              try {
                const claimed = await channelRepo.claimProviderInstallationIdentity({
                  channelId: channel.id,
                  channelType: 'discord',
                  providerInstallationId: applicationId,
                  expectedConfig: {
                    application_id: config.application_id,
                    bot_token: config.bot_token,
                  },
                  expectedConfigGeneration: lease.provider_config_generation,
                  providerProbe: {
                    claimToken: lease.claim_token,
                    generation: lease.generation,
                  },
                  retainProviderProbeLeaseMs: DISCORD_PROVIDER_PROBE_LEASE_MS,
                });
                return claimed ? expectedGeneration : null;
              } catch (error) {
                if (error instanceof ProviderInstallationConflictError) throw error;
                return null;
              }
            });
            if (!transitioned) throw new Error('Discord setup ownership changed');
            effectiveConfigGeneration = expectedGeneration;
            patchAdmitted = true;
          },
        });

        const stillCurrent = await channelRepo.providerProbeClaimIsCurrent(
          channel.id,
          lease.claim_token,
          lease.generation,
          effectiveConfigGeneration
        );
        const current = stillCurrent ? await channelRepo.findById(channel.id) : null;
        if (
          !current ||
          current.enabled ||
          current.channel_type !== 'discord' ||
          current.provider_installation_id !== config.application_id ||
          current.provider_config_generation !== effectiveConfigGeneration ||
          current.config.application_id !== config.application_id ||
          current.config.bot_token !== config.bot_token
        ) {
          return ambiguousResult(config.application_id, config.guild_id);
        }
        return {
          ok: true,
          ambiguous: false,
          requiresRetest: true,
          applicationId: summary.applicationId,
          installUrl: summary.installUrl,
          messageContentAccess: summary.messageContentAccess,
          guildInstallDefaults: summary.guildInstallDefaults,
          intentNames: summary.intentNames,
          permissionNames: summary.permissionNames,
          permissions: summary.permissions,
          code: 'applied',
        };
      } catch (error) {
        if (error instanceof ProviderInstallationConflictError) {
          throw new Conflict('Provider installation is already connected');
        }
        if (patchAdmitted) return ambiguousResult(config.application_id, config.guild_id);
        const abortCode = heartbeat.abortCode();
        if (abortCode === 'probe_deadline_exceeded') {
          throw new BadRequest('Discord application settings exceeded the bounded deadline');
        }
        if (abortCode === 'probe_ownership_lost') {
          throw new Conflict('Discord setup ownership changed; save and try again');
        }
        throw new BadRequest('Discord application settings could not be applied safely');
      } finally {
        await connector?.stopListening().catch(() => undefined);
        await heartbeat.stop();
        await channelRepo
          .releaseProviderProbe(channel.id, lease.claim_token, lease.generation)
          .catch(() => undefined);
      }
    },
  };
}
