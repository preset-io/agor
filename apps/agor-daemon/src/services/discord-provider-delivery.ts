import type {
  DiscordDeliveryChunkRequest,
  DiscordNonceRecoveryWindow,
  GatewayConnector,
} from '@agor/core/gateway';

export interface DiscordDeliveryConnector extends GatewayConnector {
  sendDeliveryChunk(
    req: DiscordDeliveryChunkRequest,
    options: {
      recoveryWindow?: DiscordNonceRecoveryWindow;
      signal?: AbortSignal;
      beforeProviderCall?: () => Promise<void>;
    }
  ): Promise<string>;
}

export function isDiscordDeliveryConnector(
  connector: GatewayConnector
): connector is DiscordDeliveryConnector {
  return typeof (connector as Partial<DiscordDeliveryConnector>).sendDeliveryChunk === 'function';
}
