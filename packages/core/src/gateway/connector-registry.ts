/**
 * Connector Registry
 *
 * Simple factory for creating platform-specific connectors.
 * Register connector factories by channel type; the gateway service
 * looks up the right factory when routing outbound messages.
 */

import type { ChannelType } from '../types/gateway';
import type { GatewayConnector } from './connector';
import { SlackConnector } from './connectors/slack';

type ConnectorFactory = (config: Record<string, unknown>) => GatewayConnector;

const connectors = new Map<ChannelType, ConnectorFactory>();

// Register built-in connectors
connectors.set('slack', (config) => new SlackConnector(config));

/**
 * Get a connector instance for the given channel type
 */
export function getConnector(
  channelType: ChannelType,
  config: Record<string, unknown>
): GatewayConnector {
  const factory = connectors.get(channelType);
  if (!factory) {
    throw new Error(`No connector registered for channel type: ${channelType}`);
  }
  return factory(config);
}

/**
 * Register a custom connector factory (for plugins/extensions)
 */
export function registerConnector(channelType: ChannelType, factory: ConnectorFactory): void {
  connectors.set(channelType, factory);
}

/**
 * Check if a connector is registered for the given channel type
 */
export function hasConnector(channelType: ChannelType): boolean {
  return connectors.has(channelType);
}
