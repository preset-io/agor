/**
 * Gateway connector layer
 *
 * Platform-specific connectors for sending/receiving messages
 * through messaging platforms (Slack, Discord, etc.)
 */

export type {
  GatewayConnector,
  GatewayProviderHistoryMessage,
  GatewayProviderHistoryRequest,
  GatewayProviderHistoryResult,
  GatewaySendReceipt,
  GatewaySendResult,
  InboundFile,
  InboundMessage,
  InboundPreparationContext,
  OutboundPayload,
} from './connector';
export { normalizeOutbound, normalizeSendReceipt } from './connector';
export { getConnector, hasConnector, registerConnector } from './connector-registry';
export {
  chunkDiscordMessage,
  DiscordConnector,
  stripDiscordBotMention,
} from './connectors/discord';
export type {
  DiscordHistoryFailureKind,
  DiscordHistoryRestTransport,
} from './connectors/discord-history';
export { DiscordHistoryError, fetchDiscordProviderHistory } from './connectors/discord-history';
export type {
  DiscordConnectionVerification,
  DiscordSetupArtifact,
  DiscordSetupDecisions,
  DiscordVerificationFailure,
} from './connectors/discord-setup';
export {
  buildDiscordSetupArtifact,
  DISCORD_DEVELOPER_PORTAL_URL,
  DISCORD_MINIMUM_BOT_PERMISSION_BITMASK,
  DISCORD_MINIMUM_BOT_PERMISSION_NAMES,
  DISCORD_REQUIRED_GATEWAY_INTENTS,
  discordBotInviteUrl,
  evaluateDiscordConnectionVerification,
  validateDiscordSetup,
} from './connectors/discord-setup';
export { GitHubConnector, parseThreadId as parseGitHubThreadId } from './connectors/github';
export {
  buildThreadId as buildShortcutThreadId,
  commentMentionsAgent as shortcutCommentMentionsAgent,
  parseThreadId as parseShortcutThreadId,
  ShortcutConnector,
  stripAgentMention as stripShortcutAgentMention,
} from './connectors/shortcut';
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
export type { NormalizedTeamsActivity } from './connectors/teams';
export {
  createTeamsAuthConfiguration,
  createTeamsCloudAdapter,
  extractQuotedReplyText,
  normalizeTeamsActivity,
  parseThreadId as parseTeamsThreadId,
  TeamsConnector,
  teamsSafeInboundMetadata,
} from './connectors/teams';
export type { TeamsCatchUpActivity, TeamsCatchUpResult } from './connectors/teams-catch-up';
export { boundTeamsCatchUp } from './connectors/teams-catch-up';
export type { TeamsSetupManifestOptions } from './connectors/teams-manifest';
export {
  buildTeamsSetupManifest,
  TEAMS_BOT_SCOPES,
  TEAMS_RSC_APPLICATION_PERMISSIONS,
  teamsGatewayCallbackUrl,
} from './connectors/teams-manifest';
export type { GatewayContext } from './context';
export { formatGatewayContext } from './context';
export type {
  DiscordAuthorityMetadata,
  DiscordDeliveryNonce,
  DiscordMetadataKey,
  DiscordThreadKey,
  ParsedDiscordThreadKey,
} from './discord-identifiers';
export {
  buildDiscordDeliveryMetadata,
  buildDiscordDeliveryNonce,
  buildDiscordInboundMetadata,
  buildDiscordLegacyThreadKey,
  buildDiscordMessageThreadKey,
  buildDiscordVerifiedThreadMetadata,
  DISCORD_METADATA_KEY,
  extractDiscordStarterMessageId,
  parseDiscordAuthorityMetadata,
  parseDiscordDeliveryNonce,
  parseDiscordThreadKey,
} from './discord-identifiers';
export {
  GatewayListenerError,
  type GatewayListenerFailureKind,
  gatewayListenerFailure,
} from './listener-error';
export { gatewayFailureCode, sanitizeGatewayProviderError } from './provider-error';
export { redactGatewayChannelSecrets } from './redaction';
export {
  formatGatewayFollowUpRoutingMessage,
  formatGatewayMarkdownSessionReference,
  formatGatewaySessionCreatedMessage,
  formatGatewaySystemMessage,
  formatGatewaySystemPayload,
} from './system-message';
