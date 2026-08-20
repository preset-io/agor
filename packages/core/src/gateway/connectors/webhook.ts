import type { ChannelType } from '../../types/gateway';
import type { GatewayConnector } from '../connector';

/** Stateless inbound-only connector; HTTP ingress is owned by the daemon route. */
export class WebhookConnector implements GatewayConnector {
  readonly channelType: ChannelType = 'webhook';
  async sendMessage(): Promise<string> {
    throw new Error('Webhook gateway channels are inbound-only; outbound delivery is unsupported');
  }
  sessionEnv() {
    return [];
  }
}
