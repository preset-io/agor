/**
 * Gateway Channels App Info Service (`gateway-channels/app-info`)
 *
 * Admin-only sub-path service that resolves the platform app behind an
 * existing gateway channel's stored credentials (Slack app id + team id via
 * `auth.test` → `bots.info`), so the UI can deep-link to the app's manifest
 * editor.
 *
 * Token resolution reads DECRYPTED credentials from the repository directly
 * (never through the gateway-channels Feathers service, whose after-hook
 * redacts secrets to the `••••••••` sentinel). The response carries only
 * `{ appId, teamId }` — never token values. Resolution is best-effort: any
 * failure (missing token, connector error, Slack API error) yields nulls
 * rather than an error, so the UI degrades to a generic Slack link.
 */

import { GatewayChannelRepository, type TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest, NotFound } from '@agor/core/feathers';
import { getConnector } from '@agor/core/gateway';
import type { AuthenticatedParams, SlackAppInfo } from '@agor/core/types';

export interface GatewayChannelAppInfoInput {
  gatewayChannelId?: string;
}

const UNRESOLVED: SlackAppInfo = { appId: null, teamId: null };

/**
 * Factory for the `gateway-channels/app-info` service.
 */
export function createGatewayChannelsAppInfoService(db: TenantScopeAwareDatabase) {
  const channelRepo = new GatewayChannelRepository(db);

  return {
    async create(
      data: GatewayChannelAppInfoInput,
      _params?: AuthenticatedParams
    ): Promise<SlackAppInfo> {
      if (!data.gatewayChannelId) {
        throw new BadRequest('gatewayChannelId is required');
      }
      const channel = await channelRepo.findById(data.gatewayChannelId);
      if (!channel) {
        throw new NotFound(`Gateway channel not found: ${data.gatewayChannelId}`);
      }

      try {
        const connector = getConnector(channel.channel_type, channel.config);
        if (!connector.getAppInfo) return UNRESOLVED;
        return await connector.getAppInfo();
      } catch {
        // Connector construction fails when no bot token is stored yet; app
        // identity is a nice-to-have, so report "unresolved" instead of erroring.
        return UNRESOLVED;
      }
    },
  };
}
