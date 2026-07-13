/**
 * Gateway connector layer
 *
 * Platform-specific connectors for sending/receiving messages
 * through messaging platforms (Slack, Discord, etc.)
 */

export type { GatewayConnector, InboundFile, InboundMessage, OutboundPayload } from './connector';
export { normalizeOutbound } from './connector';
export { getConnector, hasConnector, registerConnector } from './connector-registry';
export { GitHubConnector, parseThreadId as parseGitHubThreadId } from './connectors/github';
export type {
  SlackChannelHistoryRequest,
  SlackChannelHistoryResult,
  SlackFileInfo,
  SlackHistoryFile,
  SlackThreadHistoryMessage,
  SlackThreadHistoryRequest,
  SlackThreadHistoryResult,
} from './connectors/slack';
export {
  extractSlackInboundFiles,
  isChannelAllowedByWhitelist,
  isSlackDirectMessageId,
  isSlackFileSourceAllowed,
  isSlackWriteTargetAllowed,
  markdownToMrkdwn,
  SlackConnector,
} from './connectors/slack';
export type {
  SlackAppManifest,
  SlackBotEventSubscriptions,
  SlackWizardOptions,
} from './connectors/slack-manifest';
export {
  buildSlackManifest,
  requiredBotEvents,
  requiredBotScopes,
  SLACK_AGENT_TOOL_SCOPES,
} from './connectors/slack-manifest';
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
