/**
 * Gateway Channels Test Service (`gateway-channels/test`)
 *
 * Admin-only sub-path service that runs a best-effort connection probe against
 * a gateway channel's effective config and returns a provider-neutral result.
 *
 * Token resolution reads DECRYPTED credentials from the repository directly
 * (never through the gateway-channels Feathers service, whose after-hook
 * redacts secrets to the `••••••••` sentinel). The response contains no token
 * values.
 */

import { isDeepStrictEqual } from 'node:util';
import {
  GatewayChannelRepository,
  type GatewayProviderProbeLease,
  generateId,
  ProviderInstallationConflictError,
  RepositoryError,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Conflict, NotFound } from '@agor/core/feathers';
import { DiscordConnector, getConnector, isDiscordSnowflake } from '@agor/core/gateway';
import type {
  AuthenticatedParams,
  ChannelType,
  GatewayChannelID,
  GatewayConnectionTestResult,
} from '@agor/core/types';
import { GATEWAY_REDACTED_SENTINEL, GATEWAY_SENSITIVE_CONFIG_FIELDS } from '@agor/core/types';
import {
  DISCORD_PROVIDER_PROBE_LEASE_MS,
  GatewayProviderProbeHeartbeat,
} from './gateway-provider-probe-heartbeat.js';

function failedResult(capability: string, reason: string): GatewayConnectionTestResult {
  return { ok: false, failures: [{ capability, reason }], notVerifiable: [] };
}

export interface GatewayChannelTestInput {
  gatewayChannelId?: string;
  /**
   * Connector type to probe when the channel does not exist yet (create wizard).
   * Ignored when `gatewayChannelId` is provided — the stored channel's type wins.
   * Defaults to `slack` for backward compatibility.
   */
  channelType?: ChannelType;
  config?: Record<string, unknown>;
}

/**
 * Merge caller-supplied config overrides onto the stored (decrypted) config.
 *
 * Mirrors the `patch` substitution rule: an omitted field, an explicit
 * redaction sentinel, or an empty sensitive field all mean "use the stored
 * value". Any other provided value overrides the stored one.
 */
function resolveEffectiveConfig(
  stored: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...stored };
  if (!overrides) return resolved;

  const sensitive = new Set<string>(GATEWAY_SENSITIVE_CONFIG_FIELDS);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    if (value === GATEWAY_REDACTED_SENTINEL) continue;
    if (sensitive.has(key) && value === '') continue;
    resolved[key] = value;
  }
  return resolved;
}

/**
 * Factory for the `gateway-channels/test` service.
 */
export function createGatewayChannelsTestService(db: TenantScopeAwareDatabase) {
  const channelRepo = new GatewayChannelRepository(db);

  return {
    async create(
      data: GatewayChannelTestInput,
      _params?: AuthenticatedParams
    ): Promise<GatewayConnectionTestResult> {
      // Create wizard: no channel exists yet, so the caller states the type.
      // Edit: the stored channel's type is authoritative and overrides it below.
      let channelType: ChannelType = data.channelType ?? 'slack';
      let storedConfig: Record<string, unknown> = {};
      let storedChannelId: GatewayChannelID | undefined;
      let storedChannelEnabled: boolean | undefined;

      if (data.gatewayChannelId) {
        const channel = await channelRepo.findById(data.gatewayChannelId);
        if (!channel) {
          throw new NotFound(`Gateway channel not found: ${data.gatewayChannelId}`);
        }
        channelType = channel.channel_type;
        storedConfig = channel.config;
        storedChannelId = channel.id;
        storedChannelEnabled = channel.enabled;
      }

      const config = resolveEffectiveConfig(storedConfig, data.config);

      if (channelType === 'discord' && !storedChannelId) {
        return failedResult(
          'persisted_channel_required',
          'Save the Discord channel as disabled before testing the connection'
        );
      }
      if (channelType === 'discord' && storedChannelEnabled !== false) {
        return failedResult(
          'channel_must_be_disabled',
          'Disable and save the Discord channel before testing the connection'
        );
      }
      if (channelType === 'discord' && !isDeepStrictEqual(config, storedConfig)) {
        return failedResult(
          'config_must_be_saved',
          'Save the Discord configuration before testing the connection'
        );
      }

      let probeLease: GatewayProviderProbeLease | undefined;
      let probeHeartbeat: GatewayProviderProbeHeartbeat | undefined;
      if (channelType === 'discord') {
        try {
          const claim = await channelRepo.claimProviderProbe({
            channelId: storedChannelId!,
            claimToken: generateId(),
            leaseDurationMs: DISCORD_PROVIDER_PROBE_LEASE_MS,
          });
          if (claim.outcome === 'held') {
            return failedResult(
              'probe_in_progress',
              'Another Discord connection test is already in progress'
            );
          }
          if (claim.outcome !== 'claimed') {
            return failedResult(
              'channel_must_be_disabled',
              'Disable and save the Discord channel before testing the connection'
            );
          }
          probeLease = claim.lease;
          probeHeartbeat = new GatewayProviderProbeHeartbeat(channelRepo, probeLease);
          probeHeartbeat.start();
        } catch (error) {
          if (
            error instanceof RepositoryError &&
            error.message === 'Discord setup probes require PostgreSQL'
          ) {
            return failedResult(
              'postgresql_required',
              'Discord connection testing requires the PostgreSQL Cloud ownership path'
            );
          }
          return failedResult(
            'probe_unavailable',
            'Discord connection testing is temporarily unavailable'
          );
        }
      }

      let connector: ReturnType<typeof getConnector> | undefined;
      try {
        // The setup probe deliberately owns a short-lived connector while the
        // saved channel is disabled. It never borrows or races the live
        // listener-owned connector.
        connector =
          channelType === 'discord'
            ? new DiscordConnector(config)
            : getConnector(channelType, config);
      } catch (error) {
        if (channelType === 'discord' && storedChannelId && probeLease) {
          await probeHeartbeat?.stop();
          await channelRepo
            .releaseProviderProbe(storedChannelId, probeLease.claim_token, probeLease.generation)
            .catch(() => undefined);
        }
        return failedResult('config', error instanceof Error ? error.message : String(error));
      }
      try {
        if (!connector.testConnection) {
          return failedResult(
            'connector',
            `Connection testing is not supported for channel type "${channelType}".`
          );
        }

        let result: GatewayConnectionTestResult;
        try {
          result = await connector.testConnection({ signal: probeHeartbeat?.signal });
        } catch (error) {
          const abortCode = probeHeartbeat?.abortCode();
          if (abortCode) {
            return failedResult(
              abortCode,
              abortCode === 'probe_deadline_exceeded'
                ? 'Discord connection testing exceeded its bounded deadline'
                : 'Discord connection testing lost its setup owner'
            );
          }
          throw error;
        }
        if (channelType === 'discord' && storedChannelId && probeLease) {
          const abortCode = probeHeartbeat?.abortCode();
          if (abortCode) {
            return failedResult(
              abortCode,
              abortCode === 'probe_deadline_exceeded'
                ? 'Discord connection testing exceeded its bounded deadline'
                : 'Discord connection testing lost its setup owner'
            );
          }
          const current = await channelRepo.providerProbeClaimIsCurrent(
            storedChannelId,
            probeLease.claim_token,
            probeLease.generation,
            probeLease.provider_config_generation
          );
          if (!current) {
            return {
              ...result,
              ok: false,
              failures: [
                ...result.failures,
                {
                  capability: 'config_changed',
                  reason: 'Save the Discord configuration and test the connection again',
                },
              ],
            };
          }
          if (result.ok && !isDiscordSnowflake(result.providerInstallationId)) {
            return {
              ...result,
              ok: false,
              failures: [
                ...result.failures,
                {
                  capability: 'installation_identity_unverified',
                  reason: 'Discord did not return a verified application identity',
                },
              ],
            };
          }
          if (result.ok && result.providerInstallationId) {
            try {
              const claimed = await channelRepo.claimProviderInstallationIdentity({
                channelId: storedChannelId,
                channelType,
                providerInstallationId: result.providerInstallationId,
                expectedConfig: {
                  application_id: config.application_id,
                  bot_token: config.bot_token,
                },
                expectedConfigGeneration: probeLease.provider_config_generation,
                providerProbe: {
                  claimToken: probeLease.claim_token,
                  generation: probeLease.generation,
                },
              });
              if (!claimed) {
                return {
                  ...result,
                  ok: false,
                  failures: [
                    ...result.failures,
                    {
                      capability: 'config_changed',
                      reason: 'Save the Discord configuration and test the connection again',
                    },
                  ],
                };
              }
            } catch (error) {
              if (error instanceof ProviderInstallationConflictError) {
                throw new Conflict('Provider installation is already connected');
              }
              throw error;
            }
          }
        }
        return result;
      } finally {
        if (channelType === 'discord') {
          await connector.stopListening?.().catch(() => undefined);
          await probeHeartbeat?.stop();
          if (storedChannelId && probeLease) {
            await channelRepo
              .releaseProviderProbe(storedChannelId, probeLease.claim_token, probeLease.generation)
              .catch(() => undefined);
          }
        }
      }
    },
  };
}
