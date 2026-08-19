/**
 * Gateway connector layer
 *
 * Platform-specific connectors for sending/receiving messages
 * through messaging platforms (Slack, Discord, etc.)
 */

export type {
  GatewayAggregatePresenceDiagnostic,
  GatewayConnector,
  GatewayHistoryCapability,
  GatewayHistoryMessage,
  InboundFile,
  InboundMessage,
  OutboundPayload,
} from './connector';
export { normalizeOutbound } from './connector';
export { getConnector, hasConnector, registerConnector } from './connector-registry';
export { DiscordConnector } from './connectors/discord';
export type {
  DiscordApplicationSettingsPatch,
  DiscordApplicationSettingsSummary,
  DiscordRecommendedApplicationSettings,
} from './connectors/discord-app-settings';
export {
  addDiscordMessageContentLimitedFlag,
  buildDiscordApplicationSettingsPatch,
  buildDiscordInstallUrl,
  buildDiscordRecommendedApplicationSettings,
  DISCORD_GATEWAY_INTENT_NAMES,
  DISCORD_GATEWAY_INTENTS,
  DISCORD_LAUNCH_PERMISSION_NAMES,
  DISCORD_LAUNCH_PERMISSIONS,
  DISCORD_LAUNCH_PERMISSIONS_DECIMAL,
  discordGuildInstallDefaultsMatch,
  hasDiscordMessageContentAccess,
  summarizeDiscordApplicationSettings,
} from './connectors/discord-app-settings';
export type { ParseDiscordGatewayConfigOptions } from './connectors/discord-config';
export {
  compareDiscordSnowflakes,
  DISCORD_ALLOWED_PARENT_CHANNEL_MAX_ENTRIES,
  DISCORD_BOT_TOKEN_MAX_BYTES,
  DISCORD_GATEWAY_CONFIG_MAX_BYTES,
  DISCORD_USER_MAP_MAX_ENTRIES,
  DiscordGatewayConfigError,
  discordSnowflakeLowerBound,
  discordSnowflakePredecessor,
  isDiscordSnowflake,
  parseDiscordGatewayConfig,
} from './connectors/discord-config';
export type { DiscordDeliveryChunk, DiscordDeliveryPlan } from './connectors/discord-delivery';
export {
  createDiscordDeliveryPlan,
  DISCORD_DELIVERY_EXECUTION_METADATA_MAX_BYTES,
  DISCORD_DELIVERY_FORMATTER_VERSION,
  DISCORD_DELIVERY_MAX_OVERFLOW_BYTES,
  DISCORD_DELIVERY_OVERFLOW_FILENAME,
  DISCORD_DELIVERY_SHA256_PATTERN,
  discordDeliveryIdentityMatches,
} from './connectors/discord-delivery';
export type { DiscordFormattedMessage } from './connectors/discord-format';
export {
  DISCORD_MESSAGE_MAX_CHARACTERS,
  DISCORD_MESSAGE_MAX_CHUNKS,
  discordAllowedMentionsNone,
  discordMessageNonce,
  discordUnicodeLength,
  discordUnicodeSlice,
  formatDiscordMarkdown,
  normalizeDiscordTables,
} from './connectors/discord-format';
export {
  buildDiscordProviderEventId,
  buildDiscordThreadId,
  discordMessageHasInvocationMention,
  discordMessageHasStructuredMention,
  isDiscordAllowedParentType,
  isDiscordSupportedThreadType,
  parseDiscordThreadId,
  stripDiscordBotMention,
} from './connectors/discord-helpers';
export {
  DISCORD_INBOUND_ATTACHMENT_MAX_COUNT,
  DISCORD_INBOUND_ATTACHMENT_MAX_MIME_BYTES,
  DISCORD_INBOUND_ATTACHMENT_MAX_NAME_BYTES,
  DISCORD_INBOUND_ATTACHMENT_MAX_URL_BYTES,
  isDiscordAttachmentCdnUrl,
  normalizeDiscordInboundAttachments,
} from './connectors/discord-inbound';
export type {
  DiscordNonceRecoveryResult,
  DiscordNonceRecoveryWindow,
} from './connectors/discord-nonce-recovery';
export {
  DISCORD_NONCE_RECOVERY_BOUNDARY_SKEW_MS,
  DISCORD_NONCE_RECOVERY_MAX_MESSAGES,
  DISCORD_NONCE_RECOVERY_MAX_PAGES,
  DiscordNonceRecoveryIncompleteError,
  discordNonceRecoveryWindowFromTimes,
  recoverDiscordMessageByNonce,
} from './connectors/discord-nonce-recovery';
export {
  discordRoutingNoticeNonceSeed,
  renderDiscordRoutingNotice,
} from './connectors/discord-notices';
export {
  buildDiscordAggregatePresence,
  DISCORD_PRESENCE_ACTIVE_COUNT_CAP,
  DISCORD_PRESENCE_MIN_SEND_INTERVAL_MS,
  DiscordAggregatePresenceController,
} from './connectors/discord-presence';
export type {
  DiscordProgressCleanupDebt,
  DiscordProgressMetadataAdvance,
  DiscordProgressMetadataState,
} from './connectors/discord-progress';
export {
  addDiscordProgressCleanupDebt,
  advanceDiscordProgressMetadata,
  DISCORD_PROGRESS_CLEANUP_DEBT_MAX_ENTRIES,
  DISCORD_PROGRESS_MAX_REVISION,
  DISCORD_PROGRESS_TOOL_NAME_MAX_BYTES,
  discordProgressNonceSeed,
  parseDiscordProgressMetadata,
  removeDiscordProgressCleanupDebt,
  sanitizeDiscordProgressToolName,
} from './connectors/discord-progress';
export type {
  DiscordDeliveryChunkRequest,
  DiscordRecoverableSendOptions,
} from './connectors/discord-provider-delivery';
export { DiscordDeliveryCoordinateError } from './connectors/discord-provider-delivery';
export type {
  DiscordThreadHistoryBounds,
  DiscordThreadHistorySnapshot,
  DiscordThreadHistorySnapshotMessage,
} from './connectors/discord-thread-history';
export {
  createDiscordThreadHistorySnapshot,
  DISCORD_THREAD_HISTORY_ACTION_TTL_MS,
  DISCORD_THREAD_HISTORY_DEFAULT_LIMIT,
  DISCORD_THREAD_HISTORY_MAX_ACTOR_BYTES,
  DISCORD_THREAD_HISTORY_MAX_LIMIT,
  DISCORD_THREAD_HISTORY_MAX_PROVIDER_PAGES,
  DISCORD_THREAD_HISTORY_MAX_TEXT_BYTES,
  DISCORD_THREAD_HISTORY_REQUEST_TIMEOUT_MS,
  DISCORD_THREAD_HISTORY_SNAPSHOT_MAX_BYTES,
  DISCORD_THREAD_HISTORY_STAGED_READ_TIMEOUT_MS,
  DISCORD_THREAD_HISTORY_STAGING_TTL_MS,
  DiscordThreadHistoryIncompleteError,
  DiscordThreadHistoryMalformedError,
  discordThreadHistorySnapshotMarkdown,
  parseDiscordThreadHistorySnapshot,
  resolveDiscordThreadHistoryBounds,
  serializeDiscordThreadHistorySnapshot,
  validateDiscordThreadHistoryAfterCursor,
} from './connectors/discord-thread-history';
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
  compareSlackHistoryCursors,
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
  GatewayListenerError,
  type GatewayListenerFailureKind,
  gatewayListenerFailure,
} from './listener-error';
export {
  formatGatewayFollowUpRoutingMessage,
  formatGatewayMarkdownSessionReference,
  formatGatewaySessionCreatedMessage,
  formatGatewaySystemMessage,
  formatGatewaySystemPayload,
} from './system-message';
