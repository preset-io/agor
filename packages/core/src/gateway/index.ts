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
  InboundSkippedFile,
  OutboundPayload,
} from './connector';
export { normalizeOutbound, normalizeSendReceipt } from './connector';
export { getConnector, hasConnector, registerConnector } from './connector-registry';
export {
  chunkDiscordMessage,
  DiscordConnector,
  DiscordDirectMessageError,
  DiscordThreadUnavailableError,
  isAllowedDiscordAttachmentUrl,
  partitionDiscordInboundFiles,
  stripDiscordBotMention,
} from './connectors/discord';
export type {
  DiscordHistoryFailureKind,
  DiscordHistoryRestTransport,
} from './connectors/discord-history';
export {
  DISCORD_CHANNEL_HISTORY_DEFAULT_LIMIT,
  DISCORD_CHANNEL_HISTORY_MAX_LIMIT,
  DISCORD_FORUM_POSTS_DEFAULT_LIMIT,
  DISCORD_FORUM_POSTS_MAX_LIMIT,
  DiscordHistoryError,
  fetchDiscordProviderHistory,
} from './connectors/discord-history';
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
  SlackAgorMessageMetadataEventType,
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
  parseThreadId as parseSlackThreadId,
  SLACK_AGOR_MESSAGE_METADATA_EVENT_TYPES,
  SLACK_REQUEST_TIMEOUT_METADATA_KEY,
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
export type {
  NormalizedTeamsActivity,
  TeamsMemberIdentity,
  TeamsMemberLookupRequest,
} from './connectors/teams';
export {
  createTeamsAuthConfiguration,
  extractQuotedReplyText,
  fetchTeamsMemberIdentity,
  normalizeTeamsActivity,
  parseThreadId as parseTeamsThreadId,
  probeTeamsCredentials,
  TEAMS_NOT_VERIFIABLE,
  TeamsConnector,
  TeamsMemberLookupError,
} from './connectors/teams';
export type { TeamsAddressRevocationEvent } from './connectors/teams-address-events';
export { teamsAddressRevocationFromActivity } from './connectors/teams-address-events';
export type {
  TeamsChannelHistoryErrorCode,
  TeamsChannelPostsRequest,
  TeamsThreadHistoryRequest,
} from './connectors/teams-channel-history';
export {
  TEAMS_CHANNEL_POSTS_DEFAULT_LIMIT,
  TEAMS_HISTORY_MAX_LIMIT,
  TEAMS_THREAD_HISTORY_DEFAULT_LIMIT,
  TeamsChannelHistoryError,
} from './connectors/teams-channel-history';
export type { TeamsTeamChannel } from './connectors/teams-graph';
export { resetTeamsGraphCaches, TEAMS_MESSAGE_ID } from './connectors/teams-graph';
export type { TeamsProviderHistoryContext } from './connectors/teams-history';
export { fetchTeamsProviderHistory } from './connectors/teams-history';
export type { TeamsSetupManifestOptions } from './connectors/teams-manifest';
export {
  buildTeamsSetupManifest,
  TEAMS_BOT_SCOPES,
  TEAMS_RSC_APPLICATION_PERMISSIONS,
  teamsGatewayCallbackUrl,
} from './connectors/teams-manifest';
export type {
  PreparedTeamsSend,
  TeamsAccessTokenProvider,
  TeamsChannelThreadResult,
  TeamsSendOutcome,
} from './connectors/teams-send';
export {
  classifyTeamsSendFailure,
  TEAMS_MESSAGE_TEXT_BUDGET,
  TeamsSendError,
} from './connectors/teams-send';
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
  buildDiscordDirectMessageMetadata,
  buildDiscordDirectMessageThreadKey,
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
export type { MarkdownChunkOptions } from './markdown-chunker';
export { chunkMarkdown, codePointLength, utf16Length } from './markdown-chunker';
export {
  gatewayFailureCode,
  isPermanentProviderRefusal,
  sanitizeGatewayProviderError,
} from './provider-error';
export { redactGatewayChannelSecrets } from './redaction';
export {
  formatGatewayFollowUpRoutingMessage,
  formatGatewayMarkdownSessionReference,
  formatGatewaySessionCreatedMessage,
  formatGatewaySystemMessage,
  formatGatewaySystemPayload,
} from './system-message';
export { safeTeamsMetadata, TEAMS_SAFE_METADATA_KEYS } from './teams-metadata';
export {
  isAllowedTeamsServiceUrl,
  isTeamsFileDownloadUrl,
  isTeamsTokenHost,
  TEAMS_SERVICE_URL_HOSTS,
} from './teams-service-url';
