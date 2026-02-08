/**
 * Gateway connector layer
 *
 * Platform-specific connectors for sending/receiving messages
 * through messaging platforms (Slack, Discord, etc.)
 */

export type { GatewayConnector, InboundMessage } from './connector';
export { getConnector, hasConnector, registerConnector } from './connector-registry';
export { SlackConnector } from './connectors/slack';
