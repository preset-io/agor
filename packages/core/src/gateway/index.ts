/**
 * Gateway connector layer
 *
 * Platform-specific connectors for sending/receiving messages
 * through messaging platforms (Slack, Discord, etc.)
 */

export {
  formatGatewayCommandReply,
  GATEWAY_COMMAND_AMBIGUOUS,
  GATEWAY_COMMAND_DOCS_URL,
  GATEWAY_COMMAND_HELP,
  GATEWAY_COMMAND_HINT,
  isImplicitGatewayChatCommand,
  parseGatewayChatCommand,
  supportsGatewayChatCommands,
} from './chat-commands';
export type {
  GatewayConnector,
  GatewayInboundResult,
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
  SlackInboundReactionEventType,
  SlackInboundSurfaces,
  SlackThreadHistoryMessage,
  SlackThreadHistoryRequest,
  SlackThreadHistoryResult,
} from './connectors/slack';
export {
  extractSlackInboundFiles,
  isChannelAllowedByWhitelist,
  isSlackDirectMessageId,
  isSlackFileSourceAllowed,
  isSlackInboundReactionEventType,
  isSlackInboundSurfaceAllowed,
  isSlackWriteTargetAllowed,
  markdownToMrkdwn,
  normalizeSlackReactionName,
  parseThreadId as parseSlackThreadId,
  SLACK_AGOR_MESSAGE_METADATA_EVENT_TYPES,
  SLACK_INBOUND_REACTION_EVENT_TYPES,
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
export type { NormalizedTeamsActivity, TeamsMemberIdentity } from './connectors/teams';
export {
  createTeamsAuthConfiguration,
  extractQuotedReplyText,
  fetchTeamsMemberIdentity,
  isTeamsReactionEventType,
  normalizeTeamsActivity,
  normalizeTeamsReaction,
  normalizeTeamsReactionName,
  TEAMS_REACTION_EVENT_TYPES,
  TeamsConnector,
  TeamsMemberLookupError,
  type TeamsReactionEventType,
} from './connectors/teams';
export { teamsAddressRevocationFromActivity } from './connectors/teams-address-events';
export type {
  TeamsChannelFilesRequest,
  TeamsChannelFilesResult,
} from './connectors/teams-channel-files';
export type { TeamsThreadHistoryRequest } from './connectors/teams-channel-history';
export {
  TEAMS_CHANNEL_POSTS_DEFAULT_LIMIT,
  TEAMS_HISTORY_MAX_LIMIT,
  TEAMS_THREAD_HISTORY_DEFAULT_LIMIT,
} from './connectors/teams-channel-history';
export type { TeamsTeamChannel } from './connectors/teams-graph';
export { TEAMS_MESSAGE_ID } from './connectors/teams-graph';
export type { TeamsProviderHistoryContext } from './connectors/teams-history';
export {
  buildTeamsSetupManifest,
  TEAMS_RSC_APPLICATION_PERMISSIONS,
  teamsGatewayCallbackUrl,
} from './connectors/teams-manifest';
export type {
  PreparedTeamsSend,
  TeamsChannelThreadResult,
  TeamsDirectMessageResult,
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
export { chunkMarkdown, utf16Length } from './markdown-chunker';
export {
  gatewayFailureCode,
  isPermanentProviderRefusal,
  sanitizeGatewayProviderError,
} from './provider-error';
export { GATEWAY_READABLE_MIMES } from './readable-files';
export { redactGatewayChannelSecrets } from './redaction';
export {
  formatGatewayFollowUpRoutingMessage,
  formatGatewayMarkdownSessionReference,
  formatGatewaySessionCreatedMessage,
  formatGatewaySystemMessage,
  formatGatewaySystemPayload,
} from './system-message';
export { safeTeamsMetadata } from './teams-metadata';
export {
  isAllowedTeamsServiceUrl,
  isTeamsFileDownloadUrl,
  isTeamsTokenHost,
} from './teams-service-url';
