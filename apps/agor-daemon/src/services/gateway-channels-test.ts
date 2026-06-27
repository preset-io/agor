/**
 * Gateway Channels Test Service (`gateway-channels/test`)
 *
 * Admin-only sub-path service that runs a best-effort connection probe against
 * a gateway channel's effective config and returns a {@link SlackTestResult}.
 *
 * Token resolution reads DECRYPTED credentials from the repository directly
 * (never through the gateway-channels Feathers service, whose after-hook
 * redacts secrets to the `••••••••` sentinel). The response contains no token
 * values.
 */

import { type Database, GatewayChannelRepository } from '@agor/core/db';
import { NotFound } from '@agor/core/feathers';
import { getConnector } from '@agor/core/gateway';
import type { AuthenticatedParams, ChannelType, SlackTestResult } from '@agor/core/types';
import { GATEWAY_REDACTED_SENTINEL, GATEWAY_SENSITIVE_CONFIG_FIELDS } from '@agor/core/types';

export interface GatewayChannelTestInput {
  gatewayChannelId?: string;
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
export function createGatewayChannelsTestService(db: Database) {
  const channelRepo = new GatewayChannelRepository(db);

  return {
    async create(
      data: GatewayChannelTestInput,
      _params?: AuthenticatedParams
    ): Promise<SlackTestResult> {
      let channelType: ChannelType = 'slack';
      let storedConfig: Record<string, unknown> = {};

      if (data.gatewayChannelId) {
        const channel = await channelRepo.findById(data.gatewayChannelId);
        if (!channel) {
          throw new NotFound(`Gateway channel not found: ${data.gatewayChannelId}`);
        }
        channelType = channel.channel_type;
        storedConfig = channel.config;
      }

      const config = resolveEffectiveConfig(storedConfig, data.config);

      let connector: ReturnType<typeof getConnector>;
      try {
        connector = getConnector(channelType, config);
      } catch (error) {
        return {
          ok: false,
          failures: [
            {
              capability: 'config',
              reason: error instanceof Error ? error.message : String(error),
            },
          ],
          notVerifiable: [],
        };
      }

      if (!connector.testConnection) {
        return {
          ok: false,
          failures: [
            {
              capability: 'connector',
              reason: `Connection testing is not supported for channel type "${channelType}".`,
            },
          ],
          notVerifiable: [],
        };
      }

      return connector.testConnection();
    },
  };
}
