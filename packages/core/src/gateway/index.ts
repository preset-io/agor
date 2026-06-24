/**
 * Gateway connector layer
 *
 * Platform-specific connectors for sending/receiving messages
 * through messaging platforms (Slack, Discord, etc.)
 */

export type { GatewayConnector, InboundMessage, OutboundPayload } from './connector';
export { normalizeOutbound } from './connector';
export { getConnector, hasConnector, registerConnector } from './connector-registry';
export { GitHubConnector, parseThreadId as parseGitHubThreadId } from './connectors/github';
export type {
  SlackThreadHistoryMessage,
  SlackThreadHistoryRequest,
  SlackThreadHistoryResult,
} from './connectors/slack';
export { markdownToMrkdwn, SlackConnector } from './connectors/slack';
export {
  extractQuotedReplyText,
  parseThreadId as parseTeamsThreadId,
  TeamsConnector,
} from './connectors/teams';
export type { GatewayContext } from './context';
export { formatGatewayContext } from './context';
export {
  formatGatewayFollowUpRoutingMessage,
  formatGatewayMarkdownSessionReference,
  formatGatewaySessionCreatedMessage,
  formatGatewaySystemMessage,
  formatGatewaySystemPayload,
} from './system-message';
