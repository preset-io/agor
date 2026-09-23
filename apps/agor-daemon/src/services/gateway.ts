/**
 * Gateway Service
 *
 * Core routing service that orchestrates message routing between
 * messaging platforms and Agor sessions. Custom service (not DrizzleService)
 * since it orchestrates across multiple repositories and services.
 */

import { randomUUID } from 'node:crypto';
import { materializeAgenticToolConfiguration } from '@agor/agentic-tools/config';
import { getBaseUrl, resolveExecutionSecurityMode } from '@agor/core/config';
import {
  boundedBackoffDelay,
  type DistributedWorkIdentity,
  initialWorkOffset,
  jitterDelay,
} from '@agor/core/coordination';
import {
  BranchRepository,
  DiscordMessageDeliveryRepository,
  GatewayChannelRepository,
  GatewayInboundEventRepository,
  type GatewayListenerDiscoveryCursor,
  GatewayListenerDiscoveryRepository,
  type GatewayListenerLease,
  GatewayOutboundMessageRepository,
  generateId,
  getCurrentTenantId,
  getHiddenTenantId,
  getMCPEgressGatewayMode,
  isDatabaseUniqueConstraintError,
  isMCPSlackConnectCardEnabled,
  isPostgresDatabase,
  MCPServerRepository,
  type MCPSlackConnectDueCursor,
  MessagesRepository,
  requireCurrentTenantId,
  runWithoutTenantDatabaseScope,
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  SessionMCPServerRepository,
  SessionRepository,
  shortId,
  TaskRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  ThreadSessionMapRepository,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { type Application, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type {
  GatewayConnector,
  GatewayContext,
  InboundFile,
  InboundMessage,
  SlackThreadHistoryRequest,
  SlackThreadHistoryResult,
} from '@agor/core/gateway';
import {
  buildDiscordLegacyThreadKey,
  buildDiscordMessageThreadKey,
  DISCORD_METADATA_KEY,
  extractDiscordStarterMessageId,
  formatGatewayContext,
  formatGatewayFollowUpRoutingMessage,
  formatGatewaySessionCreatedMessage,
  formatGatewaySystemPayload,
  gatewayFailureCode,
  gatewayListenerFailure,
  getConnector,
  hasConnector,
  isSlackWriteTargetAllowed,
  normalizeOutbound,
  normalizeSendReceipt,
  parseDiscordAuthorityMetadata,
  parseGitHubThreadId,
  parseSlackThreadId,
  type SlackAgorMessageMetadataEventType,
  sanitizeGatewayProviderError,
} from '@agor/core/gateway';
import { resolveSessionMcpServerIds } from '@agor/core/sessions';
import type {
  AgenticToolName,
  AuthenticatedParams,
  BranchPermissionLevel,
  ChannelType,
  GatewayChannel,
  GatewayOutboundMessage,
  GatewayOutboundMessageID,
  GatewayOutboundReplyAdmission,
  GatewaySource,
  MCPOAuthAttemptID,
  MCPServerID,
  MCPSlackConnectDelivery,
  MCPSlackConnectRenderedState,
  MCPSlackRecoveryNotice,
  MCPSlackRecoveryRenderedState,
  Message,
  MessageID,
  MessageSource,
  Session,
  SessionID,
  Task,
  TaskID,
  TenantID,
  ThreadSessionMap,
  User,
  UserID,
} from '@agor/core/types';
import {
  DEFAULT_DISCORD_CATCH_UP,
  GATEWAY_USER_ALIGNMENT_CONFIG_KEYS,
  hasMinimumRole,
  isDiscordSnowflake,
  isTerminalTaskStatus,
  ROLES,
  SessionStatus,
  TaskStatus,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  validateDiscordConfig,
} from '@agor/core/types';
import { assertExecutionHomeKeySatisfiesMode } from '@agor/core/unix';
import { getMcpSlackRecoveryUrl, getSessionUrl } from '@agor/core/utils/url';
import { gatewayAgenticConfigToInlineConfiguration } from '../utils/agentic-configuration-sources.js';
import { requireActiveAgenticTool } from '../utils/agentic-tool-runtime.js';
import { hasBranchPermission, sessionPromptDeniedMessage } from '../utils/branch-authorization.js';
import { isBrowserReachableUrl } from '../utils/browser-reachable-url.js';
import { gatewayInboundSessionId, gatewayInboundTaskId } from '../utils/durable-task-id.js';
import {
  buildPromptWithAttachments,
  ingestInboundAttachments,
} from '../utils/gateway-attachments.js';
import { fetchGatewayCatchUp, GatewayCatchUpError } from '../utils/gateway-catch-up.js';
import {
  classifyGatewayReadFailure,
  type GatewayReadFailureCategory,
} from '../utils/gateway-read-failure.js';
import { isMcpRuntimeRecoveryEnabled } from '../utils/mcp-runtime-hints.js';
import { issueMCPSlackRecoveryToken } from '../utils/mcp-slack-recovery-token.js';
import {
  createTenantBoundDataAccess,
  type TenantBoundDataAccess,
} from '../utils/tenant-bound-data-access.js';
import { deferWithTenantContext } from '../utils/tenant-db-scope.js';
import {
  issueMCPOAuthConnectLink,
  type MCPOAuthConnectLinkDeps,
  mutateSlackConnectDelivery,
  resealMCPOAuthConnectLink,
  resolveSlackConnectBinding,
  type SlackConnectCoordinates,
} from './mcp-oauth-connect-delivery.js';
import { isMCPOAuthGrantAuthorizedForServer } from './mcp-oauth-grant-authority.js';
import {
  mcpOAuthGrantIsConnected,
  resolveMCPOAuthGrantLiveness,
} from './mcp-oauth-grant-liveness.js';
import {
  MCP_SLACK_CONNECT_EVENT_TYPE,
  MCP_SLACK_CONNECT_SHARED_WARNING_KEY,
  mcpSlackConnectBlocks,
  mcpSlackConnectCardCopy,
  mcpSlackConnectDuplicateCardText,
  mcpSlackConnectExpiryDelay,
  mcpSlackConnectMayReissue,
  mcpSlackConnectRefusedMarkerDueAt,
  mcpSlackConnectRenderedState,
  mcpSlackConnectSharedThreadWarning,
  slackConversationIsDirectMessage,
} from './mcp-slack-connect-card.js';
import {
  acquireSlackDeliveryConnector,
  clearLostSlackRender,
  type LateSlackCardReceipt,
  lateSlackCardDisposition,
  MCP_SLACK_REPAINT_ATTEMPTS,
  type MCPSlackDeliveryFailureReason,
  type MCPSlackLane,
  recordSlackDeliveryFailure,
  retireOrphanedSlackCard,
  type SlackDeliveryStore,
  SlackDeliveryTimers,
  type SlackDeliveryWrite,
  sendSlackCard,
  slackDeliveryClaim,
  slackDeliveryClaimIsLive,
  slackDeliveryRepairAt,
  withSlackDeliveryDeadline,
} from './mcp-slack-delivery-engine.js';
import type { SessionParams } from './sessions.js';

/**
 * Inbound message data (platform → session)
 */
interface PostMessageData {
  channel_key: string;
  thread_id: string;
  text: string;
  user_name?: string;
  files?: InboundFile[];
  metadata?: Record<string, unknown>;
  /** Daemon-internal durable identities for a claimed provider occurrence. */
  idempotency_task_id?: TaskID;
  idempotency_session_id?: SessionID;
  gateway_inbound_event_id?: import('@agor/core/types').GatewayInboundEventID;
  listener_claim_token?: string;
  listener_channel_id?: import('@agor/core/types').GatewayChannelID;
}

/**
 * Inbound message response
 */
interface PostMessageResult {
  success: boolean;
  sessionId: string;
  created: boolean;
  taskId?: TaskID;
}

/** Safe, terminal authorization denial that may be shown on the gateway. */
class GatewayPromptAuthorizationError extends Forbidden {
  constructor(readonly userMessage: string) {
    super(`Gateway inbound denied: ${userMessage}`);
  }
}

/**
 * Outbound routing data (session → platform)
 */
interface RouteMessageData {
  session_id: string;
  message_id?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

interface ActiveGatewayListenerLease extends GatewayListenerLease {
  tenant_id: TenantID | string;
}

interface GatewayListenerRetryState {
  tenantId: TenantID | string;
  channel: GatewayChannel;
  lease?: GatewayListenerLease;
  attempt: number;
  timer?: NodeJS.Timeout;
  generation: number;
  lifecycleGeneration: number;
}

const GATEWAY_LISTENER_LEASE_MS = 30_000;
const GATEWAY_LISTENER_SCAN_BATCH = 25;
const GATEWAY_LISTENER_RENEW_SCAN_MAX_MS = 5_000;
const GATEWAY_EVENT_PROCESSING_LEASE_MS = 2 * 60_000;
const GATEWAY_LISTENER_STOP_TIMEOUT_MS = 5_000;
const GATEWAY_LISTENER_RETRY_BASE_MS = 5_000;
const GATEWAY_LISTENER_RETRY_MAX_MS = 5 * 60_000;
const MCP_SLACK_REPAIR_BATCH = 50;
/** Connect-lane pages one tenant visit may walk. Bounds what one page can hide. */
const MCP_SLACK_CONNECT_REPAIR_PAGES = 4;
const MCP_SLACK_REPAIR_HORIZON_MS = 24 * 60 * 60_000;
const MCP_SLACK_SWEEP_INTERVAL_MS = 30_000;
const MCP_SLACK_SWEEP_TENANT_BUDGET = 10;

/**
 * A refusal this lane decided for itself, reported in the same tally as a
 * failed read.
 *
 * Not an error and not derived from one: the lane looked at what it had and
 * declined to post. It rides the tally because the alternative — what the
 * first-card path used to do — is to return in silence, which is a real part
 * of why the 2026-09-16 incident took thirty seconds a card and no log line
 * to read.
 */
type GatewaySlackRefusalCategory = 'no_public_url';

/** Everything the MCP Slack tally can report, classified or decided. */
type McpSlackFailureCategory = GatewayReadFailureCategory | GatewaySlackRefusalCategory;

/**
 * Where in a card's repair the read failed, or the refusal was decided.
 *
 * `repair` is the whole pass throwing; `grant_liveness` is the one read this
 * lane deliberately fails CLOSED on — a card whose grant cannot be read renders
 * as not-connected, which is the right card and the wrong silence, because the
 * delivery then succeeds and the failure is never counted anywhere.
 * `binding` is the lane declining to build a link at all.
 */
type GatewayReadFailureStage = 'repair' | 'grant_liveness' | 'binding';

/**
 * The connect delivery claim this pass currently holds, if any.
 *
 * A mutable ref rather than a return value because the claim outlives the
 * frame that took it: the delivery re-renders itself three times (a binding
 * that moved, a revalidated connector, a lost repaint), and the accounting
 * has to know which claim — if any — is still outstanding when an exception
 * leaves the whole delivery.
 */
interface McpSlackConnectClaimRef {
  claimId?: string;
}

/**
 * The same ref for the recovery lane, which fences every write on `notice_id`
 * as well — a Task's notice is REPLACED in place by a later generation, so
 * "the claim" is a pair rather than an id.
 */
interface McpSlackRecoveryClaimRef {
  claimId?: string;
  noticeId?: string;
}

interface McpSlackRepairFailureTally {
  lane: MCPSlackLane;
  stage: GatewayReadFailureStage;
  category: McpSlackFailureCategory;
  count: number;
  /** First item that failed this way, for correlation. */
  entityId: string;
}

async function withGatewayTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Gateway bounded operation timed out')),
          timeoutMs
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Outbound routing response
 */
interface RouteMessageResult {
  routed: boolean;
  channelType?: string;
}

interface FlushOutboundBufferOptions {
  taskId: TaskID;
}

const GATEWAY_FINAL_REPLY_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
const GATEWAY_FAILED_TURN_REPLY =
  "I couldn't complete this request because the Agor session stopped with an error. Mention me again to retry.";
const GATEWAY_STOPPED_TURN_REPLY =
  'This request was stopped before it finished. Mention me again to continue.';

type GatewayFinalReplyState =
  | { status: 'pending' }
  | { status: 'processing'; claim_token: string; claimed_at: string }
  | { status: 'delivered'; delivered_at: string };

function gatewayFinalReplyState(metadata: Message['metadata']): GatewayFinalReplyState | undefined {
  const value = metadata?.gateway_final_reply;
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Record<string, unknown>;
  if (state.status === 'pending') return { status: 'pending' };
  if (
    state.status === 'processing' &&
    typeof state.claim_token === 'string' &&
    typeof state.claimed_at === 'string'
  ) {
    return { status: 'processing', claim_token: state.claim_token, claimed_at: state.claimed_at };
  }
  if (state.status === 'delivered' && typeof state.delivered_at === 'string') {
    return { status: 'delivered', delivered_at: state.delivered_at };
  }
  return undefined;
}

interface EmitGatewayMessageData {
  gatewayChannelId: string;
  message: string;
  target?: string;
  /** Optional Slack thread timestamp to reply into. Omit to start a new thread/DM message. */
  threadTs?: string;
  purpose?: string;
  emittedByUserId: UserID;
  /**
   * Trust contract: must be sourced from verified auth context (MCP
   * ctx.sessionId), never from tool/user input. When set, the outbound emit is
   * hard-bound to the session's branch — it is denied unless the session's
   * branch matches the channel's target branch, regardless of user role.
   */
  emittedBySessionId?: SessionID;
  emittedByTaskId?: string;
  emittedByScheduleId?: string;
  userRole?: string;
}

interface EmitGatewayMessageResult {
  success: true;
  gateway_outbound_message_id: string;
  gateway_channel_id: string;
  channel_type: ChannelType;
  platform_channel_id: string;
  platform_message_id: string;
  platform_thread_id: string;
  platform_permalink?: string | null;
}

interface SlackHistoryConnector extends GatewayConnector {
  fetchThreadHistory(req: SlackThreadHistoryRequest): Promise<SlackThreadHistoryResult>;
}

function discordInboundCursor(metadata?: Record<string, unknown>): string | undefined {
  const parsed = parseDiscordAuthorityMetadata(metadata);
  const cursor = parsed?.[DISCORD_METADATA_KEY.messageId];
  return typeof cursor === 'string' && isDiscordSnowflake(cursor) ? cursor : undefined;
}

function discordCatchUpMaxPromptBytes(config: Record<string, unknown>): number {
  const raw = config.catch_up;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_DISCORD_CATCH_UP.max_prompt_bytes;
  }
  const value = (raw as Record<string, unknown>).max_prompt_bytes;
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_DISCORD_CATCH_UP.max_prompt_bytes;
}

export type GatewayProgressState = 'queued' | 'working' | 'done' | 'failed';

export interface GatewayProgressData {
  session_id: string;
  state: GatewayProgressState;
  task_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  queue_position?: number;
  error_message?: string;
}

interface GatewayTodoItem {
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'stopped' | 'unknown';
}

interface SlackStreamState {
  threadId: string;
  ts: string;
  hasContent: boolean;
  taskId?: string;
  lastMessageId?: string;
}

/**
 * Check if a channel has the required config for its connector to listen.
 * Slack requires `app_token` (Socket Mode); GitHub requires `app_id` + `private_key` + `installation_id` (polling).
 */
function hasListeningConfig(channel: GatewayChannel): boolean {
  const config = channel.config as Record<string, unknown>;
  switch (channel.channel_type) {
    case 'slack':
      return !!config.app_token;
    case 'github':
      return !!(
        config.app_id &&
        config.private_key &&
        config.installation_id &&
        (config.watch_repos as string[] | undefined)?.length
      );
    case 'teams':
      return !!(config.app_id && config.app_password);
    case 'shortcut':
      return !!config.api_token;
    case 'discord':
      return (
        typeof channel.provider_installation_id === 'string' &&
        channel.provider_installation_id === config.application_id &&
        typeof config.bot_token === 'string' &&
        validateDiscordConfig(config, { requireBotToken: true }).ok
      );
    default:
      return false;
  }
}

function discordInboundMetadataIsAuthoritative(
  channel: GatewayChannel,
  data: PostMessageData
): boolean {
  const config = channel.config as Record<string, unknown>;
  if (channel.channel_type !== 'discord') return true;
  const metadata = parseDiscordAuthorityMetadata(data.metadata);
  if (!metadata) return false;
  const snowflake = isDiscordSnowflake;
  const guildId = config.guild_id;
  const allowedChannels = config.allowed_channel_ids;
  const authorId = metadata[DISCORD_METADATA_KEY.authorId];
  const channelId = metadata[DISCORD_METADATA_KEY.channelId];
  const messageId = metadata[DISCORD_METADATA_KEY.messageId];
  const botUserId = metadata[DISCORD_METADATA_KEY.botUserId];
  const isThread = metadata[DISCORD_METADATA_KEY.isThread];
  const parentChannelId = metadata[DISCORD_METADATA_KEY.parentChannelId];
  const roles = metadata[DISCORD_METADATA_KEY.roleIds];
  const providerThreadId = metadata[DISCORD_METADATA_KEY.threadId];
  const verifiedProviderThread = metadata[DISCORD_METADATA_KEY.thread];
  const userAllowlist = Array.isArray(config.allowed_user_ids) ? config.allowed_user_ids : [];
  const roleAllowlist = Array.isArray(config.allowed_role_ids) ? config.allowed_role_ids : [];
  if (
    !snowflake(guildId) ||
    !Array.isArray(allowedChannels) ||
    allowedChannels.length === 0 ||
    allowedChannels.some((id) => !snowflake(id)) ||
    !snowflake(metadata[DISCORD_METADATA_KEY.guildId]) ||
    metadata[DISCORD_METADATA_KEY.guildId] !== guildId ||
    !snowflake(authorId) ||
    !snowflake(botUserId) ||
    botUserId !== config.application_id ||
    authorId === botUserId ||
    typeof data.user_name !== 'string' ||
    data.user_name !== authorId ||
    !snowflake(channelId) ||
    !snowflake(messageId) ||
    !Array.isArray(roles) ||
    roles.some((role) => !snowflake(role)) ||
    userAllowlist.some((id) => !snowflake(id)) ||
    roleAllowlist.some((id) => !snowflake(id)) ||
    metadata[DISCORD_METADATA_KEY.hasMention] !== true ||
    typeof isThread !== 'boolean'
  ) {
    return false;
  }
  if (!userAllowlist.includes(authorId) && !roles.some((role) => roleAllowlist.includes(role))) {
    return false;
  }
  if (isThread) {
    if (!snowflake(parentChannelId) || !allowedChannels.includes(parentChannelId)) return false;
    if (allowedChannels.includes(channelId)) return false;
    if (providerThreadId !== undefined) {
      if (
        !snowflake(providerThreadId) ||
        providerThreadId !== channelId ||
        data.thread_id !== providerThreadId ||
        !verifiedProviderThread ||
        verifiedProviderThread.guild_id !== guildId ||
        verifiedProviderThread.parent_channel_id !== parentChannelId ||
        verifiedProviderThread.thread_channel_id !== channelId ||
        verifiedProviderThread.starter_message_id !== channelId ||
        ![10, 11].includes(metadata[DISCORD_METADATA_KEY.threadType] as number) ||
        metadata[DISCORD_METADATA_KEY.threadAccessible] !== true ||
        metadata[DISCORD_METADATA_KEY.starterMessageAccessible] !== true
      ) {
        return false;
      }
    } else if (data.thread_id !== buildDiscordLegacyThreadKey(parentChannelId, channelId)) {
      return false;
    }
  } else {
    if (!allowedChannels.includes(channelId) || parentChannelId !== undefined) return false;
    const replyTo = metadata[DISCORD_METADATA_KEY.replyToMessageId];
    if (replyTo !== undefined && !snowflake(replyTo)) return false;
    if (providerThreadId !== undefined) {
      if (
        !snowflake(providerThreadId) ||
        providerThreadId === channelId ||
        data.thread_id !== providerThreadId ||
        !verifiedProviderThread ||
        verifiedProviderThread.guild_id !== guildId ||
        verifiedProviderThread.parent_channel_id !== channelId ||
        verifiedProviderThread.thread_channel_id !== providerThreadId ||
        verifiedProviderThread.starter_message_id !== messageId ||
        ![10, 11].includes(metadata[DISCORD_METADATA_KEY.threadType] as number) ||
        metadata[DISCORD_METADATA_KEY.threadAccessible] !== true ||
        metadata[DISCORD_METADATA_KEY.starterMessageAccessible] !== true
      ) {
        return false;
      }
    } else {
      const expectedMessage = snowflake(replyTo) ? replyTo : messageId;
      if (data.thread_id !== buildDiscordMessageThreadKey(channelId, expectedMessage)) return false;
    }
  }
  return true;
}

function discordCanonicalThreadId(data: PostMessageData): string {
  const metadata = parseDiscordAuthorityMetadata(data.metadata);
  const candidate = metadata?.[DISCORD_METADATA_KEY.threadId];
  return typeof candidate === 'string' ? candidate : data.thread_id;
}

/** Legacy composite lookup retained only to adopt mappings written by DG-01. */
function discordLegacyThreadId(data: PostMessageData): string | undefined {
  const metadata = parseDiscordAuthorityMetadata(data.metadata);
  if (metadata?.[DISCORD_METADATA_KEY.isThread] === true) {
    const parent = metadata[DISCORD_METADATA_KEY.parentChannelId];
    const channel = metadata[DISCORD_METADATA_KEY.channelId];
    return typeof parent === 'string' && typeof channel === 'string'
      ? buildDiscordLegacyThreadKey(parent, channel)
      : undefined;
  }
  if (metadata?.[DISCORD_METADATA_KEY.isThread] === false) {
    const channel = metadata[DISCORD_METADATA_KEY.channelId];
    const message =
      metadata[DISCORD_METADATA_KEY.replyToMessageId] ?? metadata[DISCORD_METADATA_KEY.messageId];
    return typeof channel === 'string' && typeof message === 'string'
      ? buildDiscordMessageThreadKey(channel, message)
      : undefined;
  }
  return undefined;
}

export function tenantIdFromGatewayChannel(channel: GatewayChannel): TenantID | string | undefined {
  return getHiddenTenantId(channel);
}

function isSlackThinkingPlaceholder(text: string): boolean {
  return /^thinking\s*\.{3}$/i.test(text.trim());
}

function previewText(text: string, maxChars = 500): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function gatewayMessageText(message: Pick<Message, 'content' | 'content_preview'>): string {
  const { content } = message;
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((block) => block.type === 'text')
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
    if (text.trim()) return text;
  }
  return message.content_preview || '';
}

function quoteForPrompt(text: string, maxChars = 2000): string {
  const truncated = text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
  return truncated
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

function getSlackMessageTs(metadata?: Record<string, unknown>): string | undefined {
  return typeof metadata?.slack_message_ts === 'string' ? metadata.slack_message_ts : undefined;
}

function compareSlackTs(a: string | undefined, b: string | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb ? 0 : na < nb ? -1 : 1;
  return a.localeCompare(b);
}

function formatUtcLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const millis = /^\d+\.\d+$/.test(value) ? Number(value.split('.')[0]) * 1000 : Date.parse(value);
  if (!Number.isFinite(millis)) return value;
  return new Date(millis)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function oneLineForPrompt(text: string, maxChars = 900): string {
  const normalized = text.replace(/\s+/g, ' ').trim() || '(no text)';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

const SLACK_GATEWAY_REPLY_NOTE =
  'Note: Any assistant message you send in this current Agor session is streamed back directly to the Slack conversation. Only use outbound gateway tools when you intentionally need to start a separate thread, DM, or message.';

const GATEWAY_STARTUP_BOOTSTRAP_HINT =
  'Startup/bootstrap note: Follow any startup/bootstrap instructions defined by the working directory before answering the gateway message above.';

function prependSlackGatewayReplyNote(prompt: string): string {
  if (prompt.includes(SLACK_GATEWAY_REPLY_NOTE)) return prompt;
  return `${SLACK_GATEWAY_REPLY_NOTE}\n\n${prompt}`;
}

function formatSlackCatchUpPrompt(args: {
  channel: GatewayChannel;
  threadId: string;
  currentText: string;
  metadata?: Record<string, unknown>;
  messages: SlackThreadHistoryResult['messages'];
  hasMore?: boolean;
  reason: 'initial_thread_context' | 'missed_since_last_mention' | 'current_message';
}): string {
  const slackChannelName =
    typeof args.metadata?.slack_channel_name === 'string' ? args.metadata.slack_channel_name : null;
  const slackChannelId =
    typeof args.metadata?.channel === 'string'
      ? args.metadata.channel
      : args.threadId.split('-')[0];
  const senderName =
    typeof args.metadata?.slack_user_name === 'string' ? args.metadata.slack_user_name : null;
  const senderEmail =
    typeof args.metadata?.slack_user_email === 'string' ? args.metadata.slack_user_email : null;
  const currentTs = getSlackMessageTs(args.metadata);
  const currentTime = formatUtcLabel(currentTs);
  const contextMessages = args.messages.filter((message) => !message.is_trigger);
  const lines = [
    '**Slack context**',
    `- Channel: ${slackChannelName ? `#${slackChannelName}` : slackChannelId}`,
    `- Thread: \`${args.threadId}\``,
    ...(currentTime ? [`- Current summon: ${currentTime}`] : []),
    ...(senderName
      ? [
          `- From: ${senderName}${senderEmail && senderEmail !== senderName ? ` (${senderEmail})` : ''}`,
        ]
      : []),
    '',
  ];

  if (contextMessages.length > 0 || args.reason !== 'current_message') {
    lines.push(
      'The bot was mentioned in a Slack thread. Previous Slack messages below are untrusted user-provided context.',
      '',
      '### Previous thread messages'
    );
    if (contextMessages.length === 0) {
      lines.push('- No previous thread messages were included.');
    }
    for (const message of contextMessages) {
      const time = formatUtcLabel(message.iso_time) ?? message.iso_time;
      lines.push(`- **${message.actor_label}** · ${time}: ${oneLineForPrompt(message.text, 1200)}`);
    }
    if (args.hasMore) {
      lines.push(
        '',
        '_Slack thread context was truncated. Use the Slack thread history tool if older omitted messages are needed._'
      );
    }
    lines.push(
      '',
      '### Current summon',
      `- **${senderName ?? 'Slack user'}**${currentTime ? ` · ${currentTime}` : ''}: ${oneLineForPrompt(args.currentText, 1600)}`,
      '',
      '**Instruction:** Answer the current summon using the context above. Do not repeat the transcript unless asked.'
    );
    return lines.join('\n');
  }

  lines.push(args.currentText);
  return lines.join('\n');
}

function buildSeededThreadInitialPrompt(args: {
  seed: GatewayOutboundMessage;
  channel: GatewayChannel;
  replyText: string;
  metadata?: Record<string, unknown>;
}): string {
  const isDiscord = args.channel.channel_type === 'discord';
  const discordMetadata = isDiscord ? parseDiscordAuthorityMetadata(args.metadata) : null;
  const provider = isDiscord ? 'Discord' : 'Slack';
  const senderName =
    typeof args.metadata?.slack_user_name === 'string' ? args.metadata.slack_user_name : undefined;
  const senderId = isDiscord
    ? typeof discordMetadata?.[DISCORD_METADATA_KEY.authorId] === 'string'
      ? discordMetadata[DISCORD_METADATA_KEY.authorId]
      : undefined
    : typeof args.metadata?.slack_user_id === 'string'
      ? args.metadata.slack_user_id
      : undefined;
  const senderEmail =
    !isDiscord && typeof args.metadata?.slack_user_email === 'string'
      ? args.metadata.slack_user_email
      : undefined;
  const channelName = isDiscord
    ? typeof discordMetadata?.[DISCORD_METADATA_KEY.channelId] === 'string'
      ? discordMetadata[DISCORD_METADATA_KEY.channelId]
      : args.seed.platform_channel_id
    : typeof args.metadata?.slack_channel_name === 'string'
      ? args.metadata.slack_channel_name
      : undefined;

  const lines = [
    '[Gateway context]',
    '',
    `This ${provider} thread began from a proactive Agor gateway message. Use the provenance below to understand what the human is replying to.`,
    '',
    `Outbound seed ID: ${args.seed.id}`,
    `Originating session: ${args.seed.emitted_by_session_id ?? 'none'}`,
    `Originating task: ${args.seed.emitted_by_task_id ?? 'none'}`,
    `Originating schedule: ${args.seed.emitted_by_schedule_id ?? 'none'}`,
    `Emitted by Agor user: ${args.seed.emitted_by_user_id}`,
    `Gateway channel: ${args.channel.name} (${args.channel.id})`,
    `${provider} thread: ${args.seed.platform_thread_id}`,
    `${provider} channel: ${channelName ?? args.seed.platform_channel_id}`,
    `${provider} sender name: ${senderName ?? 'unknown'}`,
    `${provider} sender ID: ${senderId ?? 'unknown'}`,
    ...(senderEmail ? [`${provider} sender email: ${senderEmail}`] : []),
    '',
    'Original proactive Agor message:',
    quoteForPrompt(args.seed.message_text),
    '',
    `Human ${provider} reply:`,
    quoteForPrompt(args.replyText),
  ];
  return lines.join('\n');
}

/**
 * Build the initial prompt for a new GitHub-routed session.
 *
 * Provides minimal routing metadata (repo, PR/issue number, URL, commenter)
 * plus behavioral instructions for the GitHub channel. The agent needs to
 * know that only its last message will be posted as a PR/issue comment.
 *
 * Everything else — what to do, how to review, whether to fetch diffs — is
 * the responsibility of the assistant's instructions configured by the admin.
 */
function buildGitHubInitialPrompt(
  threadId: string,
  text: string,
  metadata?: Record<string, unknown>
): string {
  try {
    const { owner, repo, number } = parseGitHubThreadId(threadId);
    const url = `https://github.com/${owner}/${repo}/issues/${number}`;
    const userName = metadata?.github_user ? `@${metadata.github_user}` : 'a user';
    const commentUrl = metadata?.comment_url ?? url;

    return [
      `[GitHub] ${userName} mentioned you on ${owner}/${repo}#${number}`,
      `${commentUrl}`,
      ``,
      text,
      ``,
      `---`,
      `## GitHub Channel Behavior`,
      ``,
      `This session was triggered from a GitHub mention. Important behavior notes:`,
      ``,
      `- Your **last message** will be automatically posted as a comment on the GitHub issue/PR`,
      `- Only the final message is posted — intermediate messages are visible in the Agor UI only`,
      `- Keep your final response concise and GitHub-appropriate (markdown formatted)`,
      `- If you need to delegate work to another session, mention the session link in your response`,
      `- The comment will appear as the GitHub App bot identity, not as any human user`,
      `- Be thorough in your work, then provide a clear final summary`,
    ].join('\n');
  } catch {
    return text;
  }
}

/**
 * Build the initial prompt for a new Shortcut-triggered session.
 *
 * Mirrors buildGitHubInitialPrompt: prepends story/mention context plus the
 * channel behavior note (only the last message is posted as a threaded reply).
 */
function buildShortcutInitialPrompt(text: string, metadata?: Record<string, unknown>): string {
  try {
    const storyId = metadata?.shortcut_story_id;
    const storyName = metadata?.shortcut_story_name as string | undefined;
    const storyUrl = metadata?.shortcut_story_url as string | undefined;
    const userName =
      (metadata?.shortcut_user_name as string | undefined) ??
      (metadata?.shortcut_user as string | undefined) ??
      'a user';
    const header = storyName
      ? `[Shortcut] ${userName} mentioned you on "${storyName}"${storyId ? ` (story ${storyId})` : ''}`
      : `[Shortcut] ${userName} mentioned you${storyId ? ` on story ${storyId}` : ''}`;

    return [
      header,
      ...(storyUrl ? [String(storyUrl)] : []),
      ``,
      text,
      ``,
      `---`,
      `## Shortcut Channel Behavior`,
      ``,
      `This session was triggered from a Shortcut comment mention. Important behavior notes:`,
      ``,
      `- Your **last message** will be automatically posted as a threaded reply on the Shortcut story`,
      `- Only the final message is posted — intermediate messages are visible in the Agor UI only`,
      `- Keep your final response concise and Shortcut-appropriate (markdown is supported)`,
      `- To include a video, upload it and put the raw file URL in your message (it renders inline); reference images with ![alt](url)`,
      `- Be thorough in your work, then provide a clear final summary`,
    ].join('\n');
  } catch {
    return text;
  }
}

/**
 * Build a GatewayContext from channel + inbound message data.
 *
 * Maps platform-specific metadata fields onto the platform-agnostic
 * GatewayContext interface used by formatGatewayContext().
 */
function buildGatewayContext(channel: GatewayChannel, data: PostMessageData): GatewayContext {
  const meta = data.metadata ?? {};

  switch (channel.channel_type) {
    case 'slack': {
      const slackChannelType = meta.channel_type as string | undefined;
      const isDM = slackChannelType === 'im';
      const isMpim = slackChannelType === 'mpim';

      let channelName: string | undefined;
      let channelKind: string | undefined;

      if (isDM) {
        channelKind = 'DM';
      } else if (isMpim) {
        channelKind = 'Group DM';
        channelName = (meta.slack_channel_name as string) ?? undefined;
      } else {
        channelKind = 'Channel';
        const name = meta.slack_channel_name as string | undefined;
        channelName = name ? `#${name}` : undefined;
      }

      return {
        platform: 'slack',
        channelName,
        channelKind,
        userName: (meta.slack_user_name as string) ?? undefined,
        userEmail: (meta.slack_user_email as string) ?? undefined,
      };
    }

    case 'github': {
      const repo = meta.repo_full_name as string | undefined;
      const issueNumber = meta.issue_number as number | undefined;
      const githubUser = meta.github_user as string | undefined;
      const commentUrl = meta.comment_url as string | undefined;

      const extras: string[] = [];
      if (repo) extras.push(`Repo: ${repo}`);
      if (issueNumber) {
        extras.push(`Issue/PR: #${issueNumber}`);
      }
      if (commentUrl) extras.push(`Comment: ${commentUrl}`);

      return {
        platform: 'github',
        channelName: repo,
        userHandle: githubUser ? `@${githubUser}` : undefined,
        userEmail: (meta.github_user_email as string) ?? undefined,
        extras,
      };
    }

    case 'teams': {
      const conversationType = meta.teams_conversation_type as string | undefined;
      const isPersonal = conversationType === 'personal';
      let channelKind: string | undefined;
      if (isPersonal) {
        channelKind = 'DM';
      } else if (conversationType === 'channel') {
        channelKind = 'Channel';
      } else if (conversationType === 'groupChat') {
        channelKind = 'Group Chat';
      }
      const channelName = isPersonal
        ? undefined
        : ((meta.teams_channel_name as string) ?? (meta.teams_team_name as string) ?? undefined);
      return {
        platform: 'teams',
        channelName,
        channelKind,
        userName: (meta.teams_user_name as string) ?? undefined,
        userEmail: (meta.teams_user_email as string) ?? undefined,
      };
    }

    case 'shortcut': {
      const storyName = meta.shortcut_story_name as string | undefined;
      const storyUrl = meta.shortcut_story_url as string | undefined;
      const extras: string[] = [];
      if (meta.shortcut_story_id) extras.push(`Story: ${meta.shortcut_story_id}`);
      if (storyUrl) extras.push(`Link: ${storyUrl}`);
      return {
        platform: 'shortcut',
        channelName: storyName,
        userName: (meta.shortcut_user_name as string) ?? undefined,
        userEmail: (meta.shortcut_user_email as string) ?? undefined,
        extras,
      };
    }

    default:
      // Generic fallback for future platforms
      return {
        platform: channel.channel_type as ChannelType,
        userName: data.user_name,
      };
  }
}

/**
 * Gateway routing service
 */
export function mcpSlackRecoveryRenderedState(
  task: Task,
  notice: MCPSlackRecoveryNotice,
  now = Date.now()
): MCPSlackRecoveryRenderedState {
  const recovery = task.metadata?.mcp_recovery;
  const settledAt = task.metadata?.mcp_recovery_settled_at;
  const settledGeneration = task.metadata?.mcp_recovery_generation ?? 0;
  const exactRequestSettled = notice.recovery_request_id
    ? task.metadata?.mcp_recovery_settled_request_id === notice.recovery_request_id
    : !!settledAt && settledGeneration >= notice.recovery_generation;
  const settled =
    !!settledAt && settledGeneration >= notice.recovery_generation && exactRequestSettled;
  if (
    [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.STOPPED, TaskStatus.TIMED_OUT].includes(
      task.status as never
    )
  ) {
    return notice.oauth_succeeded_at && settled ? 'recovered' : 'expired_or_superseded';
  }
  if (notice.oauth_succeeded_at && !recovery) {
    return settled ? 'recovered' : 'sign_in_pending';
  }
  if (!notice.oauth_succeeded_at && new Date(notice.expires_at).getTime() <= now) {
    return 'expired_or_superseded';
  }
  if (notice.binding_invalidated_at) return 'expired_or_superseded';
  if (notice.oauth_superseded_at) return 'expired_or_superseded';
  if (notice.recovery_disabled_at) return 'manual_next_turn';
  if (recovery?.action === 'retry_next_turn' || recovery?.code === 'rollout_changed') {
    return 'manual_next_turn';
  }
  if (recovery && recovery.generation > notice.recovery_generation && !notice.oauth_succeeded_at) {
    return 'expired_or_superseded';
  }
  if (
    !notice.oauth_succeeded_at &&
    (!recovery ||
      recovery.mcp_server_id !== notice.mcp_server_id ||
      recovery.generation !== notice.recovery_generation ||
      recovery.request_id !== notice.recovery_request_id)
  ) {
    return 'expired_or_superseded';
  }
  if (notice.oauth_failed_at || recovery?.status === 'failed') return 'failed';
  if (notice.oauth_started_at || notice.oauth_succeeded_at) return 'sign_in_pending';
  return 'reconnect_required';
}

export function mcpSlackRecoveryExpiryDelay(
  state: MCPSlackRecoveryRenderedState,
  notice: MCPSlackRecoveryNotice,
  now = Date.now()
): number | undefined {
  if (state !== 'reconnect_required' && state !== 'sign_in_pending') return undefined;
  const expiresAt = new Date(notice.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined;
  return expiresAt - now + 1_000;
}

export function taskMayNeedMcpSlackRecoverySync(task: unknown): boolean {
  if (!task || typeof task !== 'object') return false;
  const metadata = (task as { metadata?: Task['metadata'] }).metadata;
  return !!(
    metadata?.mcp_slack_recovery_notice ||
    (metadata?.gateway_task_source?.channel_type === 'slack' &&
      metadata.mcp_recovery?.code === 'oauth_reauth_required')
  );
}

/**
 * What a recovery notice says once it turns out to be a duplicate.
 *
 * The connect lane's `mcpSlackConnectDuplicateCardText`, in this lane's words.
 * Used only where the connector cannot delete its own message: the point is to
 * take the button away and point at the row that is authoritative.
 */
/**
 * The Slack message-metadata event type stamped on a recovery card.
 *
 * Typed against the connector's allowlist rather than written as a literal:
 * the §7.1 defect was a card that posted bare because the connector stamped
 * metadata for one lane's event type only, which made `findMessageByMetadata`
 * unable to ever find it again.
 */
const MCP_SLACK_RECOVERY_EVENT_TYPE: SlackAgorMessageMetadataEventType = 'agor_mcp_recovery';

export function mcpSlackRecoveryDuplicateNoticeText(): string {
  return (
    '*MCP recovery*\nThis is a duplicate message and is no longer in use. ' +
    'See the other Agor message in this thread for the current status.'
  );
}

export function mcpSlackRecoveryMessageCopy(
  state: MCPSlackRecoveryRenderedState,
  dispatch: MCPSlackRecoveryNotice['provider_dispatch']
): { text: string; button?: string } {
  switch (state) {
    case 'reconnect_required':
      return {
        text:
          dispatch === 'ambiguous'
            ? 'MCP sign-in is required. The interrupted provider call may have started, so Agor will not replay it automatically.'
            : 'MCP sign-in is required. Agor will not replay the interrupted call automatically.',
        button: 'Reconnect MCP',
      };
    case 'sign_in_pending':
      return {
        text: 'MCP sign-in was opened and recovery is pending. You can return to Slack while Agor verifies the connection.',
      };
    case 'recovered':
      return {
        text:
          dispatch === 'ambiguous'
            ? 'MCP is reconnected for later calls. The interrupted call may have started and was not replayed. Tell the assistant what to do next.'
            : 'MCP is reconnected. The interrupted call was not replayed; explicitly ask the assistant to retry if you still want it.',
      };
    case 'manual_next_turn':
      return {
        text: 'MCP authority is current, but this provider can apply it only on the next turn. Conversation history is preserved; send a new Slack message to continue.',
      };
    case 'expired_or_superseded':
      return {
        text: 'This MCP reconnect action expired or was superseded. Send a new Slack message if recovery is still needed.',
      };
    case 'failed':
      return {
        text: 'MCP recovery could not be completed. No provider call was replayed. Try again from a new Slack turn or contact an administrator.',
      };
  }
}

export class GatewayService {
  private channelRepo: GatewayChannelRepository;
  private threadMapRepo: ThreadSessionMapRepository;
  private outboundRepo: GatewayOutboundMessageRepository;
  private branchRepo: BranchRepository;
  private sessionRepo: SessionRepository;
  private taskRepo: TaskRepository;
  private usersRepo: UsersRepository;
  private messagesRepo: MessagesRepository;
  private inboundEventRepo: GatewayInboundEventRepository;
  private deliveryRepo: DiscordMessageDeliveryRepository;

  private mcpServerRepo: MCPServerRepository;
  private userTokenRepo: UserMCPOAuthTokenRepository;
  private sessionMcpRepo: SessionMCPServerRepository;
  /**
   * The gateway's only ordinary route to tenant data.
   *
   * Everything this service does is identity-only orchestration: Socket Mode
   * listeners, repair timers, and the bounded repair sweep all run under
   * `runWithTenantContext` with no transaction. The facade is what removes the
   * "hold a raw handle and remember to open a scope" arrangement that produced
   * five separate `MissingTenantDatabaseScopeError` defects on these lanes.
   */
  private readonly data: TenantBoundDataAccess;
  /**
   * The raw handle, kept for the two things the facade deliberately cannot do:
   * explicit SYSTEM scopes for cross-tenant listener discovery, and dialect
   * inspection that must answer outside any scope. Both are narrow, named and
   * commented at their call sites. Do not reach for this to read tenant data.
   */
  private db: TenantScopeAwareDatabase;
  private app: Application;

  /** Active listeners keyed by immutable tenant + channel identity. */
  private activeListeners = new Map<string, GatewayConnector>();
  /** PostgreSQL-only durable ownership diagnostics/fences for local listeners. */
  private activeListenerLeases = new Map<string, ActiveGatewayListenerLease>();
  /** Failed starts, scoped by tenant + channel. A durable owner retains its lease while waiting. */
  private listenerRetries = new Map<string, GatewayListenerRetryState>();
  private listenerRetryGeneration = 0;
  /** Cancellation fence covering timers and provider startups already in flight. */
  private listenerLifecycleGenerations = new Map<string, number>();
  private listenerTimer: NodeJS.Timeout | null = null;
  private listenerScanRunning = false;
  private listenerStopped = false;
  private listenerDraining = false;
  private listenerDiscoveryTenantId: TenantID | string | undefined;
  private listenerDiscoveryCursor: GatewayListenerDiscoveryCursor | undefined;
  private listenerIdleRounds = 0;
  private inboundThreadQueues = new Map<string, Promise<void>>();
  private durableListenerOwnership: boolean | undefined;
  private readonly workIdentity: DistributedWorkIdentity;

  /**
   * Tenants with at least one enabled gateway channel.
   * Allows routeMessage() to skip the DB lookup entirely when the
   * gateway feature is not in use for the current tenant. A tenant-local
   * refresh must never suppress another tenant's delivery.
   */
  private activeChannelTenants = new Set<string>();

  /**
   * Slack status updates are serialized and lightly throttled so concurrent
   * tool/message hooks do not race while deleting/reposting the transient row.
   * Terminal states always bypass this throttle.
   */
  private slackProgressLastUpdate = new Map<string, number>();
  private slackProgressQueues = new Map<string, Promise<void>>();
  private slackStreamsByTask = new Map<string, SlackStreamState>();
  private slackStreamStatusRefreshLast = new Map<string, number>();
  private slackStreamedMessageIds = new Set<string>();
  private slackStreamedTaskIds = new Set<string>();
  private slackStreamTaskByMessage = new Map<string, string>();
  private mcpSlackRecoveryExpiryTimers = new SlackDeliveryTimers();
  private mcpSlackDeliveryRetryTimers = new SlackDeliveryTimers();
  private mcpSlackOAuthStartClaimTimers = new SlackDeliveryTimers();
  private mcpSlackConnectExpiryTimers = new SlackDeliveryTimers();
  private mcpSlackConnectRetryTimers = new SlackDeliveryTimers();
  private mcpSlackRepairTenants = new Set<string>();
  private mcpSlackRecoveryTenants = new Set<string>();
  private mcpSlackSweepTimer: NodeJS.Timeout | null = null;
  private mcpSlackSweepCursor = 0;
  private static SLACK_PROGRESS_MIN_UPDATE_MS = 2500;
  private static SLACK_STREAM_STATUS_REFRESH_MS = 300;
  private static SLACK_STREAMED_MESSAGE_CACHE_MAX = 500;

  constructor(db: TenantScopeAwareDatabase, app: Application) {
    // Long-lived listener orchestration carries tenant identity without
    // holding a transaction. Every repository field is therefore bound to a
    // short per-method tenant unit of work here; provider/process/network work
    // must remain outside those database scopes.
    this.data = createTenantBoundDataAccess(db);
    this.channelRepo = this.data.repository(new GatewayChannelRepository(db));
    this.threadMapRepo = this.data.repository(new ThreadSessionMapRepository(db));
    this.outboundRepo = this.data.repository(new GatewayOutboundMessageRepository(db));
    this.branchRepo = this.data.repository(new BranchRepository(db));
    this.sessionRepo = this.data.repository(new SessionRepository(db));
    this.taskRepo = this.data.repository(new TaskRepository(db));
    this.usersRepo = this.data.repository(new UsersRepository(db));
    this.messagesRepo = this.data.repository(new MessagesRepository(db));
    this.inboundEventRepo = this.data.repository(new GatewayInboundEventRepository(db));
    this.deliveryRepo = this.data.repository(new DiscordMessageDeliveryRepository(db));

    this.mcpServerRepo = this.data.repository(new MCPServerRepository(db));
    this.userTokenRepo = this.data.repository(new UserMCPOAuthTokenRepository(db));
    this.sessionMcpRepo = this.data.repository(new SessionMCPServerRepository(db));
    this.db = db;
    this.app = app;
    this.workIdentity = (
      app as unknown as { get?: (name: string) => DistributedWorkIdentity | undefined }
    ).get?.('distributedWorkIdentity') ?? {
      instanceId: 'daemon',
      bootId: `gateway-${generateId()}`,
    };
  }

  private listenerKey(tenantId: TenantID | string, channelId: string): string {
    return `${tenantId}\0${channelId}`;
  }

  /**
   * Re-enter listener tenant identity only. Repository calls inside `work`
   * open their own guarded RLS transactions through the constructor bindings;
   * external provider work deliberately does not inherit a DB transaction.
   */
  private runWithListenerTenantIdentity<T>(tenantId: TenantID | string, work: () => T): T {
    return runWithTenantContext(tenantId, work);
  }

  /**
   * Detect the database ownership model only from inside a valid database
   * scope. The tenant-aware DB proxy intentionally cannot be inspected from a
   * constructor or other unscoped lifecycle edge.
   */
  private async detectDurableListenerOwnership(): Promise<boolean> {
    if (this.durableListenerOwnership !== undefined) return this.durableListenerOwnership;
    this.durableListenerOwnership = await runWithTenantDatabaseScope(
      this.db,
      getCurrentTenantId(),
      async (scopedDb) => isPostgresDatabase(scopedDb)
    );
    return this.durableListenerOwnership;
  }

  private getActiveListener(channelId: string): GatewayConnector | undefined {
    // PostgreSQL outbound work is stateless and reloads fresh tenant-scoped
    // credentials. Never reuse a connector whose listener lease may have been
    // revoked between renewal passes. Teams is the only connector that needs
    // its process-local listener for replies, and is fail-closed in this mode.
    if (this.durableListenerOwnership) return undefined;
    const tenantId = getCurrentTenantId();
    return tenantId ? this.activeListeners.get(this.listenerKey(tenantId, channelId)) : undefined;
  }

  private currentTenantHasActiveChannels(): boolean {
    const tenantId = getCurrentTenantId();
    return !!tenantId && this.activeChannelTenants.has(tenantId);
  }

  /**
   * The SQLite fast path is process-complete because standalone listeners are
   * all local. In PostgreSQL, any daemon can execute a tenant's Task before its
   * listener discovery cursor has visited that tenant, so absence from the
   * process-local cache must never suppress durable outbound routing.
   */
  private async shouldQueryGatewayRouting(): Promise<boolean> {
    return (await this.detectDurableListenerOwnership()) || this.currentTenantHasActiveChannels();
  }

  /** Refresh the current tenant's process-local channel fast path. */
  async refreshChannelState(): Promise<void> {
    const tenantId = requireCurrentTenantId(
      'Missing tenant context while refreshing gateway channel state'
    );
    const channels = await this.channelRepo.findDisplayAll();
    if (channels.some((ch) => ch.enabled)) {
      this.activeChannelTenants.add(tenantId);
    } else {
      this.activeChannelTenants.delete(tenantId);
    }
    console.log(
      `[gateway] refreshChannelState: tenant=${tenantId} found ${channels.length} channels, ${channels.filter((ch) => ch.enabled).length} enabled`
    );
    // Bounded restart/lost-event repair. Never scan a tenant wholesale and
    // never hold a database transaction while Slack is called.
    if (channels.some((channel) => channel.enabled && channel.channel_type === 'slack')) {
      this.mcpSlackRecoveryTenants.add(tenantId);
      this.scheduleMcpSlackRecoveryRepair(tenantId);
      this.ensureMcpSlackPeriodicSweep();
    } else {
      this.mcpSlackRecoveryTenants.delete(tenantId);
    }
  }

  private scheduleMcpSlackRecoveryRepair(tenantId: string): void {
    if (this.mcpSlackRepairTenants.has(tenantId)) return;
    this.mcpSlackRepairTenants.add(tenantId);
    setTimeout(() => {
      if (this.listenerStopped) {
        this.mcpSlackRepairTenants.delete(tenantId);
        return;
      }
      void runWithTenantContext(tenantId, async () => {
        const now = new Date();
        const horizon = new Date(now.getTime() - MCP_SLACK_REPAIR_HORIZON_MS);
        // Per-item repair failures, tallied rather than logged one by one:
        // the two lanes' silent swallows are how four missing tenant scopes
        // reached a running daemon, and a page of them is not fifty events.
        const failures = new Map<string, McpSlackRepairFailureTally>();
        const page = await this.taskRepo.findMcpSlackRecoveryNoticePage({
          limit: MCP_SLACK_REPAIR_BATCH,
          now,
          horizon,
        });
        for (const task of page.tasks) {
          await this.syncMcpSlackRecoveryNotice(task.task_id, failures).catch((error) =>
            this.tallyMcpSlackRepairFailure(failures, 'recovery', task.task_id, error)
          );
        }
        // The connect lane rides the same sweep, on its own indexed due-work
        // column. One tenant visit repairs both rather than two schedules
        // racing each other for the same Slack rate limit.
        //
        // Paged, because one page is otherwise all a tenant ever sees: any
        // card the sweep cannot advance stays at the front of the ordering
        // and hides everything behind it. Rescheduling a refused first-card
        // marker is the primary fix for that; this bounds what a card the
        // reschedule does not cover can hide, without giving up the bound
        // that makes this sweep safe to run every tick.
        let cursor: MCPSlackConnectDueCursor | undefined;
        for (let pageIndex = 0; pageIndex < MCP_SLACK_CONNECT_REPAIR_PAGES; pageIndex += 1) {
          const cards = await this.messagesRepo.findMcpSlackConnectDuePage({
            limit: MCP_SLACK_REPAIR_BATCH,
            now,
            horizon,
            ...(cursor ? { after: cursor } : {}),
          });
          for (const card of cards.messages) {
            await this.deliverMcpSlackConnectCard(card.message_id as MessageID, 0, failures).catch(
              (error) =>
                this.tallyMcpSlackRepairFailure(failures, 'connect', card.message_id, error)
            );
          }
          if (cards.messages.length < MCP_SLACK_REPAIR_BATCH || !cards.cursor) break;
          cursor = cards.cursor;
        }
        this.reportMcpSlackRepairFailures(failures);
      })
        .catch((error: unknown) =>
          this.logMcpSlackOperationFailure(
            'mcp_slack_bounded_repair_failed',
            'recovery',
            { tenant_sweep: tenantId },
            error
          )
        )
        .finally(() => this.mcpSlackRepairTenants.delete(tenantId));
    }, 0).unref?.();
  }

  private ensureMcpSlackPeriodicSweep(): void {
    if (this.listenerStopped || this.mcpSlackSweepTimer) return;
    this.mcpSlackSweepTimer = setTimeout(() => {
      this.mcpSlackSweepTimer = null;
      if (this.listenerStopped) return;
      const tenants = [...this.mcpSlackRecoveryTenants].sort();
      if (tenants.length > 0) {
        const count = Math.min(MCP_SLACK_SWEEP_TENANT_BUDGET, tenants.length);
        for (let index = 0; index < count; index += 1) {
          const tenant = tenants[(this.mcpSlackSweepCursor + index) % tenants.length];
          if (tenant) this.scheduleMcpSlackRecoveryRepair(tenant);
        }
        this.mcpSlackSweepCursor = (this.mcpSlackSweepCursor + count) % tenants.length;
      }
      this.ensureMcpSlackPeriodicSweep();
    }, MCP_SLACK_SWEEP_INTERVAL_MS);
    this.mcpSlackSweepTimer.unref?.();
  }

  /**
   * Send a best-effort system message to the platform thread. Most progress
   * callers intentionally fire and forget; authorization denials await it so
   * the durable provider event is not acknowledged before the user-facing
   * explanation has been handed to the connector.
   */
  private async sendSystemMessage(
    channel: GatewayChannel,
    threadId: string,
    text: string,
    opts?: { suppressSlack?: boolean; suppressDiscord?: boolean }
  ): Promise<void> {
    // GitHub and Shortcut have their own editable ack comment (the connector's
    // "Processing" / "👀 on it" comment that becomes the final reply), so they
    // suppress all gateway system messages here. Slack keeps durable routing
    // messages (session links/errors) but suppresses transient lifecycle noise
    // like "creating session" and queued/status rows via suppressSlack.
    if (channel.channel_type === 'github' || channel.channel_type === 'shortcut') return;
    if (channel.channel_type === 'slack' && opts?.suppressSlack) return;
    if (channel.channel_type === 'discord' && opts?.suppressDiscord) return;

    if (!hasConnector(channel.channel_type as ChannelType)) return;
    try {
      // Prefer the active listener instance — webhook-based connectors (e.g. Teams)
      // store ConversationReferences in memory on the listener instance.
      // Creating a new connector via getConnector() would lose that state.
      const connector =
        this.getActiveListener(channel.id) ??
        getConnector(channel.channel_type as ChannelType, channel.config);
      await connector.sendMessage({
        threadId,
        ...formatGatewaySystemPayload(channel.channel_type as ChannelType, text),
      });
    } catch (error) {
      // Ignore — debug messages are best-effort
      console.warn('[gateway] Debug message failed:', error);
    }
  }

  /**
   * Surface a prompt denial where the external user actually asked. GitHub and
   * Shortcut normally suppress gateway system messages because their
   * processing acknowledgement is editable, so use that same comment rather
   * than leaving a permanent "working" acknowledgement behind.
   */
  private async sendPromptAuthorizationDenied(
    channel: GatewayChannel,
    data: Pick<PostMessageData, 'thread_id' | 'metadata'>,
    message: string
  ): Promise<void> {
    if (channel.channel_type !== 'github' && channel.channel_type !== 'shortcut') {
      await this.sendSystemMessage(channel, data.thread_id, message);
      return;
    }
    try {
      const connector =
        this.getActiveListener(channel.id) ??
        getConnector(channel.channel_type as ChannelType, channel.config);
      await connector.sendMessage({
        threadId: data.thread_id,
        text: `⚠️ ${message}`,
        metadata: data.metadata?.processing_comment_id
          ? { edit_comment_id: data.metadata.processing_comment_id }
          : undefined,
      });
    } catch (error) {
      console.warn('[gateway] Failed to post prompt authorization denial:', error);
    }
  }

  private recoveryEnvelopeSecret(): string | null {
    const secret = process.env.AGOR_MASTER_SECRET;
    return typeof secret === 'string' && secret.length > 0 ? secret : null;
  }

  /**
   * The recovery notice's Reconnect link, or `undefined` when none can be
   * built.
   *
   * `undefined` is the lane's existing answer for an absent
   * `AGOR_MASTER_SECRET` and for a token that has already been redeemed: the
   * card still goes out, without a button. An unbuildable base URL now joins
   * them rather than throwing, which is the same trade D2 makes on the connect
   * lane. Throwing lands above every durable write in
   * `deliverMcpSlackRecoveryNotice` — including the claim this delivery is
   * holding — so a deployment with no public URL took the notice's
   * permanently-overdue `next_repair_at` around the sweep every thirty
   * seconds and never said why.
   */
  private async mcpSlackRecoveryUrl(
    tenantId: string,
    notice: MCPSlackRecoveryNotice,
    failures?: Map<string, McpSlackRepairFailureTally>
  ): Promise<string | undefined> {
    const secret = this.recoveryEnvelopeSecret();
    if (!secret || notice.token_consumed_at) return undefined;
    const token = issueMCPSlackRecoveryToken(
      {
        type: 'mcp-slack-recovery',
        tid: tenantId,
        sub: notice.principal_user_id,
        credential_user_id: notice.credential_user_id,
        slack_user_id: notice.slack_user_id,
        slack_team_id: notice.slack_team_id,
        gateway_channel_id: notice.gateway_channel_id,
        gateway_config_generation: notice.gateway_config_generation,
        slack_channel_id: notice.slack_channel_id,
        slack_thread_id: notice.slack_thread_id,
        task_id: notice.task_id,
        session_id: notice.session_id,
        mcp_server_id: notice.mcp_server_id,
        mcp_server_config_version: notice.mcp_server_config_version,
        recovery_generation: notice.recovery_generation,
        recovery_request_id: notice.recovery_request_id,
        notice_id: notice.notice_id,
        jti: notice.token_jti,
        expiresAt: new Date(notice.expires_at),
      },
      secret,
      new Date(notice.issued_at)
    );
    const baseUrl = await getBaseUrl(this.db).catch((error: unknown) => {
      console.warn(
        `[gateway] event=mcp_slack_base_url_unresolved tenant_id=${
          getCurrentTenantId() ?? '<unknown>'
        } lane=recovery reason=${classifyGatewayReadFailure(error)}`
      );
      return '';
    });
    if (!isBrowserReachableUrl(baseUrl)) {
      // Same predicate, same reason as the connect card's `no_public_url`
      // refusal: a `#token=` deep link on `localhost` is a button that works
      // for the daemon's own machine and nobody in the Slack thread.
      this.reportMcpSlackRefusal(failures, 'recovery', notice.notice_id, 'no_public_url');
      return undefined;
    }
    const page = getMcpSlackRecoveryUrl(baseUrl);
    return `${page}#token=${encodeURIComponent(token)}`;
  }

  private mcpSlackNextActiveRepairAt(
    state: MCPSlackRecoveryRenderedState,
    notice: MCPSlackRecoveryNotice,
    now = Date.now()
  ): string | undefined {
    if (state !== 'reconnect_required' && state !== 'sign_in_pending') return undefined;
    return slackDeliveryRepairAt(mcpSlackRecoveryExpiryDelay(state, notice, now), now);
  }

  /**
   * One classified line for a failure nothing else will account for.
   *
   * The MCP Slack lanes' out-of-band triggers — the retry timers, the expiry
   * timers, the after-commit projections — all end in a `.catch` whose whole
   * job is to stop an unhandled rejection. Every one of them discarded the
   * error and printed a fixed sentence, so the incident's thirty-second loop
   * produced one indistinguishable line per pass with nothing in it but the
   * lane's name. `context/guidelines/logging.md` asks for a stable category
   * and the relevant ids; this supplies both, and still never the exception,
   * the message, the stack, or anything a provider said.
   */
  private logMcpSlackOperationFailure(
    event: string,
    lane: MCPSlackLane,
    ids: Record<string, string | undefined>,
    error: unknown
  ): void {
    console.warn(
      [
        `[gateway] event=${event}`,
        `tenant_id=${getCurrentTenantId() ?? '<unknown>'}`,
        `lane=${lane}`,
        ...Object.entries(ids).map(([key, value]) => `${key}=${value ?? '<unknown>'}`),
        `reason=${classifyGatewayReadFailure(error)}`,
      ].join(' ')
    );
  }

  private tallyMcpSlackRepairFailure(
    failures: Map<string, McpSlackRepairFailureTally>,
    lane: MCPSlackLane,
    entityId: string,
    error: unknown,
    stage: GatewayReadFailureStage = 'repair'
  ): void {
    this.tallyMcpSlackCategory(failures, lane, entityId, classifyGatewayReadFailure(error), stage);
  }

  /** One tally entry per (lane, stage, category), however many items share it. */
  private tallyMcpSlackCategory(
    failures: Map<string, McpSlackRepairFailureTally>,
    lane: MCPSlackLane,
    entityId: string,
    category: McpSlackFailureCategory,
    stage: GatewayReadFailureStage
  ): void {
    const key = `${lane}:${stage}:${category}`;
    const existing = failures.get(key);
    if (existing) existing.count += 1;
    else failures.set(key, { lane, stage, category, count: 1, entityId });
  }

  /**
   * Report a refusal this lane decided, in the same shape as a swallowed read.
   *
   * The reversible refusals return quietly on purpose — they are not errors —
   * but a FIRST card that is refused writes nothing anywhere and posts
   * nothing, so before this the only trace a blocked card left was its
   * absence. `no_public_url` in particular is a deployment-level condition
   * that silently affects every card at once, which is exactly the thing a
   * per-pass tally exists to say in one line.
   */
  private reportMcpSlackRefusal(
    failures: Map<string, McpSlackRepairFailureTally> | undefined,
    lane: MCPSlackLane,
    entityId: string,
    category: GatewaySlackRefusalCategory
  ): void {
    if (failures) {
      this.tallyMcpSlackCategory(failures, lane, entityId, category, 'binding');
      return;
    }
    const single = new Map<string, McpSlackRepairFailureTally>();
    this.tallyMcpSlackCategory(single, lane, entityId, category, 'binding');
    this.reportMcpSlackRepairFailures(single);
  }

  /**
   * Report a read this lane swallowed on purpose.
   *
   * The fail-closed answer stays — a card that cannot read its grant must not
   * claim one — but the failure stops being invisible. Inside the sweep it
   * joins that pass's tally, which is one line per (lane, stage, category)
   * however many cards a page holds; outside it (a timer, an event-driven
   * delivery) it is its own single line in the same shape.
   *
   * Nothing here is the provider's or the exception's:
   * `context/guidelines/logging.md` applies exactly as it does to the delivery
   * failure lines, and `classifyGatewayReadFailure` is the only thing that
   * looks at the error at all.
   */
  private reportSwallowedGatewayRead(
    failures: Map<string, McpSlackRepairFailureTally> | undefined,
    lane: MCPSlackLane,
    entityId: string,
    error: unknown,
    stage: GatewayReadFailureStage
  ): void {
    if (failures) {
      this.tallyMcpSlackRepairFailure(failures, lane, entityId, error, stage);
      return;
    }
    const single = new Map<string, McpSlackRepairFailureTally>();
    this.tallyMcpSlackRepairFailure(single, lane, entityId, error, stage);
    this.reportMcpSlackRepairFailures(single);
  }

  /**
   * One line per (lane, category) per sweep pass, not one per item.
   *
   * A systemic repair failure fails for every row in the page, and a page is
   * fifty. The count is the story; the first entity id is there so an
   * operator can look at one. The exception itself never appears —
   * `context/guidelines/logging.md` — and neither does anything the provider
   * said.
   */
  private reportMcpSlackRepairFailures(failures: Map<string, McpSlackRepairFailureTally>): void {
    for (const failure of failures.values()) {
      console.warn(
        [
          '[gateway] event=mcp_slack_repair_failed',
          `tenant_id=${getCurrentTenantId() ?? '<unknown>'}`,
          `lane=${failure.lane}`,
          `stage=${failure.stage}`,
          `reason=${failure.category}`,
          `count=${failure.count}`,
          `first_entity_id=${failure.entityId}`,
        ].join(' ')
      );
    }
  }

  /**
   * The recovery lane's delivery record: the notice on the Task's metadata.
   *
   * Every write is fenced on `notice_id` because a Task's notice is REPLACED
   * in place by a later recovery generation, so "the record on this task" and
   * "the record this delivery started on" are not the same question. The
   * mutated Task travels back alongside the notice: the recovery lane's
   * rendered state reads the task's own status, so a re-render needs it.
   */
  private mcpSlackRecoveryStore(
    taskId: string,
    noticeId: string
  ): SlackDeliveryStore<
    MCPSlackRecoveryNotice,
    SlackDeliveryWrite<MCPSlackRecoveryNotice> & { task: Task }
  > {
    return {
      logIds: { task_id: taskId, notice_id: noticeId },
      identifies: (current) => current?.notice_id === noticeId,
      write: (mutate) =>
        this.taskRepo.mutateMCPSlackRecoveryNotice(taskId, mutate).then((result) => ({
          changed: result.changed,
          record: result.task.metadata?.mcp_slack_recovery_notice,
          task: result.task,
        })),
    };
  }

  private async recordMcpSlackDeliveryFailure(
    taskId: string,
    noticeId: string,
    claimId: string,
    reason: MCPSlackDeliveryFailureReason
  ): Promise<void> {
    await recordSlackDeliveryFailure(this.mcpSlackRecoveryStore(taskId, noticeId), {
      lane: 'recovery',
      reason,
      claimId,
      scheduleRetry: (delay) => this.scheduleMcpSlackDeliveryRetry(taskId, noticeId, delay),
    });
  }

  /**
   * Post or edit the one Slack row that belongs to this recovery notice, and
   * account for an exception that escapes the attempt.
   *
   * The connect lane's contract, on this lane's record — see
   * {@link deliverMcpSlackConnectCard} for the argument. The one difference is
   * what the other branch can do: a notice has no mint-time marker, so when no
   * claim is held there is nothing durable to move and the rethrow into the
   * sweep's tally is the whole answer.
   */
  private async deliverMcpSlackRecoveryNotice(
    task: Task,
    attempt = 0,
    failures?: Map<string, McpSlackRepairFailureTally>
  ): Promise<void> {
    const claimRef: McpSlackRecoveryClaimRef = {};
    try {
      await this.renderMcpSlackRecoveryNotice(task, attempt, failures, claimRef);
    } catch (error) {
      if (claimRef.claimId && claimRef.noticeId) {
        await this.recordMcpSlackDeliveryFailure(
          task.task_id,
          claimRef.noticeId,
          claimRef.claimId,
          'unexpected_failure'
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * The delivery itself. Always reached through
   * {@link deliverMcpSlackRecoveryNotice}, which owns the accounting.
   */
  private async renderMcpSlackRecoveryNotice(
    task: Task,
    attempt: number,
    failures: Map<string, McpSlackRepairFailureTally> | undefined,
    claimRef: McpSlackRecoveryClaimRef
  ): Promise<void> {
    const initial = task.metadata?.mcp_slack_recovery_notice;
    if (!initial) return;
    const state = mcpSlackRecoveryRenderedState(task, initial);
    this.scheduleMcpSlackRecoveryExpiry(task.task_id, initial, state);
    if (initial.slack_message_ts && initial.rendered_state === state) {
      const nextRepairAt = this.mcpSlackNextActiveRepairAt(state, initial);
      if (initial.next_repair_at !== nextRepairAt) {
        await this.taskRepo.mutateMCPSlackRecoveryNotice(task.task_id, (current) =>
          current?.notice_id === initial.notice_id && current.rendered_state === state
            ? { ...current, next_repair_at: nextRepairAt }
            : null
        );
      }
      return;
    }
    const claimId = randomUUID();
    const now = new Date();
    const claim = slackDeliveryClaim(claimId, now.getTime());
    const claimExpiresAt = claim.expires_at;
    const claimed = await this.taskRepo.mutateMCPSlackRecoveryNotice(task.task_id, (current) => {
      if (!current || current.notice_id !== initial.notice_id) return null;
      if (current.slack_message_ts && current.rendered_state === state) return null;
      if (slackDeliveryClaimIsLive(current, now.getTime())) return null;
      return { ...current, delivery_claim: claim, next_repair_at: claimExpiresAt };
    });
    const notice = claimed.task.metadata?.mcp_slack_recovery_notice;
    if (!claimed.changed || notice?.delivery_claim?.claim_id !== claimId) {
      if (notice?.notice_id === initial.notice_id && slackDeliveryClaimIsLive(notice, Date.now())) {
        this.scheduleMcpSlackDeliveryRetry(
          task.task_id,
          notice.notice_id,
          Math.max(100, new Date(notice.delivery_claim!.expires_at).getTime() - Date.now() + 100)
        );
      }
      return;
    }
    // From here an exception leaves a claim behind, and the accounting in
    // `deliverMcpSlackRecoveryNotice` is what clears it.
    claimRef.claimId = claimId;
    claimRef.noticeId = notice.notice_id;

    let parsedThread: ReturnType<typeof parseSlackThreadId>;
    try {
      parsedThread = parseSlackThreadId(notice.slack_thread_id);
    } catch {
      parsedThread = { channel: '', thread_ts: '' };
    }
    const channel = await this.channelRepo.findById(notice.gateway_channel_id);
    if (!channel?.enabled || channel.channel_type !== 'slack') {
      claimRef.claimId = undefined;
      await this.taskRepo.mutateMCPSlackRecoveryNotice(task.task_id, (current) =>
        current?.notice_id === notice.notice_id && current.delivery_claim?.claim_id === claimId
          ? { ...current, delivery_claim: undefined, next_repair_at: undefined }
          : null
      );
      return;
    }
    if (
      parsedThread.channel !== notice.slack_channel_id ||
      !isSlackWriteTargetAllowed(channel.config, parsedThread.channel)
    ) {
      claimRef.claimId = undefined;
      await this.taskRepo.mutateMCPSlackRecoveryNotice(task.task_id, (current) =>
        current?.notice_id === notice.notice_id && current.delivery_claim?.claim_id === claimId
          ? {
              ...current,
              delivery_claim: undefined,
              binding_invalidated_at: current.binding_invalidated_at ?? new Date().toISOString(),
              next_repair_at: undefined,
            }
          : null
      );
      return;
    }
    const acquired = await acquireSlackDeliveryConnector(channel, {
      generationCurrent: channel.provider_config_generation === notice.gateway_config_generation,
      expectedTeamId: notice.slack_team_id,
      writeTargetChannel: parsedThread.channel,
      activeListener: () => this.getActiveListener(channel.id),
    });
    if (acquired.outcome === 'failed') {
      claimRef.claimId = undefined;
      await this.recordMcpSlackDeliveryFailure(
        task.task_id,
        notice.notice_id,
        claimId,
        acquired.reason
      );
      return;
    }
    if (acquired.outcome === 'app_moved') {
      claimRef.claimId = undefined;
      await this.taskRepo.mutateMCPSlackRecoveryNotice(task.task_id, (current) =>
        current?.notice_id === notice.notice_id && current.delivery_claim?.claim_id === claimId
          ? { ...current, delivery_claim: undefined, next_repair_at: undefined }
          : null
      );
      return;
    }
    const connector = acquired.connector;
    if (acquired.revalidated) {
      if (!notice.binding_invalidated_at) {
        const invalidated = await this.taskRepo.mutateMCPSlackRecoveryNotice(
          task.task_id,
          (current) =>
            current?.notice_id === notice.notice_id &&
            current.delivery_claim?.claim_id === claimId &&
            !current.binding_invalidated_at
              ? {
                  ...current,
                  delivery_claim: undefined,
                  binding_invalidated_at: new Date().toISOString(),
                  next_repair_at: new Date().toISOString(),
                }
              : null
        );
        claimRef.claimId = undefined;
        if (invalidated.changed) {
          await this.renderMcpSlackRecoveryNotice(invalidated.task, 0, failures, claimRef);
        }
        return;
      }
    }
    const copy = mcpSlackRecoveryMessageCopy(state, notice.provider_dispatch);
    const url =
      state === 'reconnect_required'
        ? await this.mcpSlackRecoveryUrl(requireCurrentTenantId(), notice, failures)
        : undefined;
    const blocks: unknown[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*MCP recovery*\n${copy.text}` },
      },
      ...(url && copy.button
        ? [
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: copy.button },
                  url,
                  // Slack requires action_id even for URL buttons. Agor does
                  // not treat this as an interactive callback or auth input.
                  action_id: 'agor_mcp_reconnect_link',
                  accessibility_label: 'Reconnect MCP in Agor',
                },
              ],
            },
          ]
        : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Return here after using Agor.' }] },
    ];
    try {
      const { receipt, reconciledMessageTs } = await sendSlackCard(connector, {
        threadId: notice.slack_thread_id,
        text: copy.text,
        blocks,
        eventType: MCP_SLACK_RECOVERY_EVENT_TYPE,
        deliveryId: notice.delivery_id,
        ...(notice.slack_message_ts ? { recordedTs: notice.slack_message_ts } : {}),
        onLateReceipt: (late) =>
          this.reconcileLateMcpSlackRecoverySend(task.task_id, notice.notice_id, state, late, {
            connector,
            threadId: notice.slack_thread_id,
          }),
      });
      const renderedAt = new Date();
      const settled = await this.taskRepo.mutateMCPSlackRecoveryNotice(task.task_id, (current) =>
        current?.notice_id === notice.notice_id && current.delivery_claim?.claim_id === claimId
          ? {
              ...current,
              slack_message_ts:
                current.slack_message_ts ?? reconciledMessageTs ?? receipt.messageId,
              delivery_claim: undefined,
              rendered_state: state,
              rendered_at: renderedAt.toISOString(),
              delivery_next_retry_at: undefined,
              next_repair_at: this.mcpSlackNextActiveRepairAt(state, current, renderedAt.getTime()),
            }
          : null
      );
      // Settled or lost, the claim is no longer this pass's to account for.
      claimRef.claimId = undefined;
      if (!settled.changed) {
        // The same lease, the same two outcomes as the connect lane. This one
        // fenced its receipt from the start and then did nothing about what it
        // had already written to Slack: a post that lost the claim left a
        // second notice with a live Reconnect button that nothing would ever
        // edit, and an edit that lost it repainted the recorded row with a
        // superseded state that `rendered_state` then made permanent.
        const owned = settled.task.metadata?.mcp_slack_recovery_notice;
        const ownedTs = owned?.notice_id === notice.notice_id ? owned.slack_message_ts : undefined;
        if (reconciledMessageTs && reconciledMessageTs === ownedTs) {
          await this.repaintLostMcpSlackRecoveryRender(
            task.task_id,
            notice.notice_id,
            reconciledMessageTs,
            state,
            attempt,
            failures,
            claimRef
          );
        } else {
          await retireOrphanedSlackCard(connector, notice.slack_thread_id, {
            lane: 'recovery',
            orphanTs: reconciledMessageTs ?? receipt.messageId,
            ownedTs,
            text: mcpSlackRecoveryDuplicateNoticeText(),
          });
        }
      }
      this.mcpSlackDeliveryRetryTimers.cancel(notice.notice_id);
    } catch {
      claimRef.claimId = undefined;
      await this.recordMcpSlackDeliveryFailure(
        task.task_id,
        notice.notice_id,
        claimId,
        'slack_write_failed'
      );
    }
  }

  /**
   * A recovery notice write that landed after its deadline had written it off.
   *
   * By then this lane has recorded `slack_write_failed` and released the claim,
   * and a later attempt may already have settled the notice — so the late
   * write is reconciled exactly like one that lost its claim. See
   * `lateSlackCardDisposition`. Detached from the pass that sent it: that pass
   * returned long ago.
   */
  private reconcileLateMcpSlackRecoverySend(
    taskId: string,
    noticeId: string,
    renderedState: MCPSlackRecoveryRenderedState,
    late: LateSlackCardReceipt,
    retire: { connector: GatewayConnector; threadId: string }
  ): void {
    const tenantId = requireCurrentTenantId();
    void runWithTenantContext(tenantId, async () => {
      const task = await this.taskRepo.findById(taskId);
      const latest = task?.metadata?.mcp_slack_recovery_notice;
      const isThisDelivery = latest?.notice_id === noticeId;
      const ownedTs = isThisDelivery ? latest?.slack_message_ts : undefined;
      const disposition = lateSlackCardDisposition(late, { isThisDelivery, ownedTs });
      if (disposition === 'repaint') {
        const cleared = await clearLostSlackRender(
          this.mcpSlackRecoveryStore(taskId, noticeId),
          late.reconciledMessageTs as string,
          renderedState
        );
        if (cleared?.changed) await this.deliverMcpSlackRecoveryNotice(cleared.task);
      } else if (disposition === 'retire') {
        await retireOrphanedSlackCard(retire.connector, retire.threadId, {
          lane: 'recovery',
          orphanTs: late.reconciledMessageTs ?? late.receipt.messageId,
          ownedTs,
          text: mcpSlackRecoveryDuplicateNoticeText(),
        });
      }
    }).catch((error: unknown) =>
      this.logMcpSlackOperationFailure(
        'mcp_slack_late_receipt_failed',
        'recovery',
        { task_id: taskId, notice_id: noticeId },
        error
      )
    );
  }

  /**
   * Re-render a recovery notice this daemon repainted but turned out not to
   * own. The connect lane's `repaintLostMcpSlackConnectRender`, on the other
   * lane's record; see that one for why clearing `rendered_state` is the fix
   * rather than an extra edit.
   */
  private async repaintLostMcpSlackRecoveryRender(
    taskId: string,
    noticeId: string,
    editedTs: string,
    renderedState: MCPSlackRecoveryRenderedState,
    attempt: number,
    failures: Map<string, McpSlackRepairFailureTally> | undefined,
    claimRef: McpSlackRecoveryClaimRef
  ): Promise<void> {
    const cleared = await clearLostSlackRender(
      this.mcpSlackRecoveryStore(taskId, noticeId),
      editedTs,
      renderedState
    );
    if (cleared?.changed && attempt < MCP_SLACK_REPAINT_ATTEMPTS) {
      await this.renderMcpSlackRecoveryNotice(cleared.task, attempt + 1, failures, claimRef);
    }
  }

  private scheduleMcpSlackDeliveryRetry(taskId: string, noticeId: string, delay = 5_000): void {
    if (this.mcpSlackDeliveryRetryTimers.has(noticeId)) return;
    const tenantId = requireCurrentTenantId();
    this.mcpSlackDeliveryRetryTimers.schedule(noticeId, delay, () => {
      void runWithTenantContext(tenantId, async () => {
        const task = await this.taskRepo.findById(taskId);
        if (task?.metadata?.mcp_slack_recovery_notice?.notice_id === noticeId) {
          await this.deliverMcpSlackRecoveryNotice(task);
        }
      }).catch((error: unknown) =>
        this.logMcpSlackOperationFailure(
          'mcp_slack_delivery_retry_failed',
          'recovery',
          { task_id: taskId, notice_id: noticeId },
          error
        )
      );
    });
  }

  private scheduleMcpSlackRecoveryExpiry(
    taskId: string,
    notice: MCPSlackRecoveryNotice,
    state: MCPSlackRecoveryRenderedState
  ): void {
    const delay = mcpSlackRecoveryExpiryDelay(state, notice);
    if (delay === undefined) {
      this.mcpSlackRecoveryExpiryTimers.cancel(notice.notice_id);
      return;
    }
    if (this.mcpSlackRecoveryExpiryTimers.has(notice.notice_id)) return;
    const tenantId = requireCurrentTenantId();
    this.mcpSlackRecoveryExpiryTimers.schedule(notice.notice_id, delay, () => {
      void runWithTenantContext(tenantId, () => this.syncMcpSlackRecoveryNotice(taskId)).catch(
        (error: unknown) =>
          this.logMcpSlackOperationFailure(
            'mcp_slack_expiry_projection_failed',
            'recovery',
            { task_id: taskId, notice_id: notice.notice_id },
            error
          )
      );
    });
  }

  private scheduleMcpSlackOAuthStartClaimRepair(
    taskId: string,
    notice: MCPSlackRecoveryNotice,
    retryDelay?: number
  ): void {
    if (
      !notice.oauth_start_claim_expires_at ||
      notice.oauth_started_at ||
      notice.oauth_failed_at ||
      this.mcpSlackOAuthStartClaimTimers.has(notice.notice_id)
    ) {
      return;
    }
    const tenantId = requireCurrentTenantId();
    const delay =
      retryDelay ??
      Math.max(0, new Date(notice.oauth_start_claim_expires_at).getTime() - Date.now() + 100);
    this.mcpSlackOAuthStartClaimTimers.schedule(notice.notice_id, delay, () => {
      void runWithTenantContext(tenantId, () => this.syncMcpSlackRecoveryNotice(taskId)).catch(
        (error: unknown) => {
          this.logMcpSlackOperationFailure(
            'mcp_slack_oauth_start_claim_repair_failed',
            'recovery',
            { task_id: taskId, notice_id: notice.notice_id },
            error
          );
          runWithTenantContext(tenantId, () =>
            this.scheduleMcpSlackOAuthStartClaimRepair(taskId, notice, 5_000)
          );
        }
      );
    });
  }

  /**
   * Read through a tenant database SCOPE from a caller that may hold only
   * tenant CONTEXT.
   *
   * Every repository field on this service is bound through `this.data`, which
   * opens a scope per call. What keeps getting missed is everything else that
   * reaches the database from here: free functions over `app_variables`
   * (`getMCPEgressGatewayMode`, `isMCPSlackConnectCardEnabled`) and shared
   * readers that build their own repositories from a raw handle
   * (`resolveMCPOAuthGrantLiveness`). None of them has anything to open a scope
   * with, and the callers that reach them — the bounded repair sweep, and the
   * Socket Mode listener creating a session — carry tenant identity and no
   * transaction.
   *
   * Against the production guard each throws `MissingTenantDatabaseScopeError`
   * into a fail-closed catch, which is why this class has now been found five
   * times and never by a test: a suite that stubs the repositories has no
   * guard to trip.
   *
   * This is now one line over `TenantBoundDataAccess`
   * (`utils/tenant-bound-data-access.ts`), which is the general form of the
   * same discipline for every `identity-only` service; the name is kept
   * because the call sites read better with it. Entering a scope that is
   * already open is a no-op, so this is also correct for the request-path
   * callers that already have one.
   */
  private async readInTenantScope<T>(read: (db: TenantScopedDatabase) => Promise<T>): Promise<T> {
    return this.data.read(read);
  }

  /** Project authoritative Task recovery into one idempotently editable Slack row. */
  async syncMcpSlackRecoveryNotice(
    taskId: string,
    /** The sweep pass's failure tally, when this notice is one of its items. */
    failures?: Map<string, McpSlackRepairFailureTally>
  ): Promise<void> {
    const { recoveryEnabled, mode } = await this.readInTenantScope(async (db) => ({
      recoveryEnabled: await isMcpRuntimeRecoveryEnabled(db),
      mode: await getMCPEgressGatewayMode(db),
    }));
    const task = await this.taskRepo.findById(taskId);
    if (!task) return;
    const recovery = task.metadata?.mcp_recovery;
    const existing = task.metadata?.mcp_slack_recovery_notice;

    if (
      existing?.oauth_start_claim_expires_at &&
      !existing.oauth_started_at &&
      !existing.oauth_failed_at
    ) {
      if (new Date(existing.oauth_start_claim_expires_at).getTime() <= Date.now()) {
        const orphaned = await this.taskRepo.mutateMCPSlackRecoveryNotice(
          task.task_id,
          (current) =>
            current?.notice_id === existing.notice_id &&
            current.oauth_attempt_id === existing.oauth_attempt_id &&
            current.oauth_start_claim_expires_at === existing.oauth_start_claim_expires_at &&
            !current.oauth_started_at &&
            !current.oauth_failed_at
              ? {
                  ...current,
                  oauth_failed_at: new Date().toISOString(),
                  next_repair_at: new Date().toISOString(),
                }
              : null
        );
        await this.deliverMcpSlackRecoveryNotice(
          orphaned.changed ? orphaned.task : task,
          0,
          failures
        );
        return;
      }
      this.scheduleMcpSlackOAuthStartClaimRepair(task.task_id, existing);
    }

    if (!recoveryEnabled) {
      if (!existing) return;
      const disabled = await this.taskRepo.mutateMCPSlackRecoveryNotice(task.task_id, (current) =>
        current?.notice_id === existing.notice_id && !current.recovery_disabled_at
          ? {
              ...current,
              recovery_disabled_at: new Date().toISOString(),
              next_repair_at: new Date().toISOString(),
            }
          : null
      );
      await this.deliverMcpSlackRecoveryNotice(
        disabled.changed ? disabled.task : task,
        0,
        failures
      );
      return;
    }

    if (
      recovery?.code === 'oauth_reauth_required' &&
      recovery.action === 'reauthenticate' &&
      recovery.status === 'action_required' &&
      recovery.mcp_server_id &&
      (mode === 'compatibility' || mode === 'enforced')
    ) {
      const source = task.metadata?.gateway_task_source;
      let sourceThread: ReturnType<typeof parseSlackThreadId> | undefined;
      try {
        sourceThread = source?.thread_id ? parseSlackThreadId(source.thread_id) : undefined;
      } catch {
        sourceThread = undefined;
      }
      const session = await this.sessionRepo.findById(task.session_id);
      const channel = source ? await this.channelRepo.findById(source.gateway_channel_id) : null;
      const mapping = session ? await this.threadMapRepo.findBySession(session.session_id) : null;
      const server = await this.mcpServerRepo.findById(recovery.mcp_server_id);
      const [principal, credentialUser] = session
        ? await Promise.all([
            this.usersRepo.findById(task.created_by),
            this.usersRepo.findById(session.created_by),
          ])
        : [null, null];
      const attached = session
        ? (await this.sessionMcpRepo.listServers(session.session_id, true)).some(
            (candidate) => candidate.mcp_server_id === recovery.mcp_server_id
          )
        : false;
      const existingBindingCurrent =
        !existing ||
        (existing.gateway_channel_id === channel?.id &&
          existing.gateway_config_generation === channel.provider_config_generation &&
          existing.mcp_server_id === server?.mcp_server_id &&
          existing.mcp_server_config_version === (server.config_version ?? 1) &&
          existing.slack_team_id === source?.slack_team_id &&
          existing.slack_channel_id === source.slack_channel_id &&
          existing.slack_thread_id === source.thread_id &&
          existing.slack_user_id === source.provider_user_id);
      const eligible =
        source?.channel_type === 'slack' &&
        !!source.slack_team_id &&
        !!source.slack_channel_id &&
        sourceThread?.channel === source.slack_channel_id &&
        source.provider_user_id !== 'unknown' &&
        !!session &&
        session.created_by === task.created_by &&
        !!principal &&
        !!credentialUser &&
        hasMinimumRole(principal.role, ROLES.MEMBER) &&
        hasMinimumRole(
          credentialUser.role,
          server?.auth?.type === 'oauth' && (server.auth.oauth_mode ?? 'per_user') === 'shared'
            ? ROLES.ADMIN
            : ROLES.MEMBER
        ) &&
        !!channel?.enabled &&
        channel.channel_type === 'slack' &&
        isSlackWriteTargetAllowed(channel.config, sourceThread.channel) &&
        mapping?.channel_id === channel.id &&
        mapping.thread_id === source.thread_id &&
        !!server?.enabled &&
        server.auth?.type === 'oauth' &&
        attached &&
        existingBindingCurrent;
      if (eligible) {
        const same =
          existing?.mcp_server_id === recovery.mcp_server_id &&
          existing.mcp_server_config_version === (server.config_version ?? 1) &&
          existing.gateway_config_generation === channel.provider_config_generation &&
          existing.recovery_generation === recovery.generation &&
          existing.recovery_request_id === recovery.request_id;
        if (!same) {
          const issued = new Date(Math.floor(Date.now() / 1_000) * 1_000);
          const expires = new Date(issued.getTime() + 10 * 60_000);
          const noticeId = randomUUID();
          const created = await this.taskRepo.mutateMCPSlackRecoveryNotice(
            task.task_id,
            (current, lockedTask) => {
              const locked = lockedTask.metadata?.mcp_recovery;
              if (
                locked?.code !== 'oauth_reauth_required' ||
                locked.status !== 'action_required' ||
                locked.mcp_server_id !== recovery.mcp_server_id ||
                locked.generation !== recovery.generation ||
                locked.request_id !== recovery.request_id
              ) {
                return null;
              }
              return {
                notice_id: noticeId,
                token_jti: randomUUID(),
                issued_at: issued.toISOString(),
                expires_at: expires.toISOString(),
                principal_user_id: task.created_by as UserID,
                credential_user_id: session.created_by as UserID,
                slack_user_id: source.provider_user_id,
                slack_team_id: source.slack_team_id!,
                gateway_channel_id: channel.id,
                gateway_config_generation: channel.provider_config_generation,
                slack_channel_id: source.slack_channel_id!,
                slack_thread_id: source.thread_id,
                session_id: session.session_id,
                task_id: task.task_id,
                mcp_server_id: recovery.mcp_server_id!,
                mcp_server_config_version: server.config_version ?? 1,
                recovery_generation: recovery.generation,
                recovery_request_id: recovery.request_id,
                provider_dispatch: recovery.provider_dispatch,
                delivery_id: current?.delivery_id ?? randomUUID(),
                next_repair_at: issued.toISOString(),
                ...(current?.slack_message_ts
                  ? { slack_message_ts: current.slack_message_ts }
                  : {}),
              };
            }
          );
          if (created.changed) await this.deliverMcpSlackRecoveryNotice(created.task, 0, failures);
          return;
        }
      } else if (
        existing?.mcp_server_id === recovery.mcp_server_id &&
        existing.recovery_generation === recovery.generation &&
        existing.recovery_request_id === recovery.request_id
      ) {
        const invalidated = await this.taskRepo.mutateMCPSlackRecoveryNotice(
          task.task_id,
          (current) =>
            current?.notice_id === existing.notice_id && !current.binding_invalidated_at
              ? {
                  ...current,
                  binding_invalidated_at: new Date().toISOString(),
                  next_repair_at: new Date().toISOString(),
                }
              : null
        );
        await this.deliverMcpSlackRecoveryNotice(
          invalidated.changed ? invalidated.task : task,
          0,
          failures
        );
        return;
      }
    }

    if (!existing) return;
    // OAuth completion may create a newer structured recovery generation. The
    // browser token is already consumed, so relink presentation to that exact
    // request without minting a second action.
    if (
      existing.oauth_succeeded_at &&
      recovery?.mcp_server_id === existing.mcp_server_id &&
      recovery.generation > existing.recovery_generation
    ) {
      const relinked = await this.taskRepo.mutateMCPSlackRecoveryNotice(
        task.task_id,
        (current, lockedTask) => {
          const locked = lockedTask.metadata?.mcp_recovery;
          return current?.notice_id === existing.notice_id &&
            current.oauth_succeeded_at &&
            locked?.mcp_server_id === current.mcp_server_id &&
            locked.generation > current.recovery_generation
            ? {
                ...current,
                recovery_generation: locked.generation,
                recovery_request_id: locked.request_id,
                next_repair_at: new Date().toISOString(),
              }
            : null;
        }
      );
      if (relinked.changed) {
        await this.deliverMcpSlackRecoveryNotice(relinked.task, 0, failures);
        return;
      }
    }
    await this.deliverMcpSlackRecoveryNotice(task, 0, failures);
  }

  syncMcpSlackRecoveryNoticeAfterCommit(taskId: string, params?: unknown): void {
    deferWithTenantContext(
      params,
      () => this.syncMcpSlackRecoveryNotice(taskId),
      (error: unknown) =>
        this.logMcpSlackOperationFailure(
          'mcp_slack_after_commit_projection_failed',
          'recovery',
          { task_id: taskId },
          error
        )
    );
  }

  // ==========================================================================
  // Agent-initiated MCP connect — the Slack face of an `oauth` widget
  //
  // Same operational discipline as the recovery notice above (delivery claim
  // CAS, bounded backoff, `next_repair_at`, config-generation re-check) bound
  // to a different record: the widget message. `WidgetResolutionStore` patches
  // that row in realtime on every lifecycle transition, so this lane has no
  // state machine of its own — the widget row already is one, and a second
  // would be a second thing to keep in step. The card's presentation lives in
  // `services/mcp-slack-connect-card.ts`.
  //
  // See `docs/internal/slack-mcp-oauth-connect-2026-09-16.md` §7.
  // ==========================================================================

  /**
   * Dependencies for the connect-link issuer.
   *
   * Every repository here is bound to the tenant unit of work, so each read
   * opens its own guarded database scope from the ambient tenant context. That
   * is what keeps this lane clear of the failure `/mcp-oauth-connect` hit: a
   * route registered outside `TENANT_OWNED_SERVICE_PATHS` has nothing upstream
   * to arm its scope, and a fail-closed catch then turns the resulting
   * `MissingTenantDatabaseScopeError` into a generic refusal that no unit test
   * against an unarmed `:memory:` database can see.
   *
   * `baseUrl` was the one field that was NOT a bound repository, and it shipped
   * the same defect a seventh time — see the call below. It is the reason
   * `getBaseUrl` no longer accepts a caller with no handle.
   */
  private async mcpSlackConnectDeps(): Promise<MCPOAuthConnectLinkDeps> {
    // `this.db`, not a bare call. In hosted mode `getBaseUrl` resolves durable
    // tenant routing, and the only sources are this handle or an ambient
    // tenant database SCOPE. Every entry into `deliverMcpSlackConnectCard`
    // carries tenant CONTEXT and nothing else — `deferWithTenantContext` has
    // exited the request's scope by the time it runs, the repair sweep and the
    // expiry timers use `runWithTenantContext`, and both `register-services.ts`
    // callers sit on `identity-only` routes. Omitting it threw
    // "Tenant public links require a tenant database" on this line, above the
    // refusal classifier and the claim, so the lane reported `unexpected` and
    // retried for thirty seconds without ever reaching Slack.
    //
    // Tolerated, not thrown — the template is one line below. `masterSecret`
    // has always answered `''` for an absent secret and let
    // `resolveSlackConnectBinding` classify it as `no_secret`, and an
    // unbuildable base URL is the same KIND of fact: a deployment-level
    // condition an administrator can fix, not an exception. Throwing it here
    // lands above the refusal classifier, the marker reschedule and the claim,
    // which is precisely the shape D1 exists to stop. `''` and a value no
    // browser could open both become the `no_public_url` refusal.
    const baseUrl = await getBaseUrl(this.db).catch((error: unknown) => {
      // The one place the exception is looked at, and only for its Agor-owned
      // category. The refusal itself is reported by the delivery, once per
      // pass, because that is where the widget id is.
      console.warn(
        `[gateway] event=mcp_slack_base_url_unresolved tenant_id=${
          getCurrentTenantId() ?? '<unknown>'
        } lane=connect reason=${classifyGatewayReadFailure(error)}`
      );
      return '';
    });
    return {
      repositories: {
        sessions: this.sessionRepo,
        users: this.usersRepo,
        channels: this.channelRepo,
        servers: this.mcpServerRepo,
        threadMap: this.threadMapRepo,
      },
      messages: this.messagesRepo,
      tasks: { findById: (id: string) => this.taskRepo.findById(id) },
      masterSecret: this.recoveryEnvelopeSecret() ?? '',
      baseUrl,
    };
  }

  private mcpSlackConnectNextActiveRepairAt(
    state: MCPSlackConnectRenderedState,
    delivery: MCPSlackConnectDelivery | undefined,
    now = Date.now()
  ): string | undefined {
    if (
      state !== 'connect_required' &&
      state !== 'sign_in_pending' &&
      state !== 'finish_required'
    ) {
      return undefined;
    }
    return slackDeliveryRepairAt(mcpSlackConnectExpiryDelay(state, delivery, now), now);
  }

  /**
   * The connect lane's delivery record: `slack_connect` on the widget
   * message's own metadata, under the same row lock the widget lifecycle uses.
   *
   * No identity fence beyond existence, and deliberately so: a widget has
   * exactly one delivery record for as long as it exists, and a re-issue
   * advances that record's generation rather than replacing the record. Where
   * the generation matters — the settlement CAS — the lane fences on it
   * explicitly.
   */
  private mcpSlackConnectStore(widgetId: MessageID): SlackDeliveryStore<MCPSlackConnectDelivery> {
    return {
      logIds: { widget_id: widgetId },
      identifies: (current) => !!current,
      write: (mutate) =>
        mutateSlackConnectDelivery(this.messagesRepo, widgetId, mutate).then((result) => ({
          changed: result.changed,
          record: result.delivery,
        })),
    };
  }

  private async recordMcpSlackConnectDeliveryFailure(
    widgetId: MessageID,
    claimId: string,
    reason: MCPSlackDeliveryFailureReason
  ): Promise<void> {
    await recordSlackDeliveryFailure(this.mcpSlackConnectStore(widgetId), {
      lane: 'connect',
      reason,
      claimId,
      scheduleRetry: (delay) => this.scheduleMcpSlackConnectRetry(widgetId, delay),
    });
  }

  private async releaseMcpSlackConnectClaim(
    widgetId: MessageID,
    claimId: string,
    repairNow = false
  ): Promise<void> {
    await mutateSlackConnectDelivery(this.messagesRepo, widgetId, (current) =>
      current?.delivery_claim?.claim_id === claimId
        ? {
            ...current,
            delivery_claim: undefined,
            next_repair_at: repairNow ? new Date().toISOString() : undefined,
          }
        : null
    ).catch(() => undefined);
  }

  /**
   * Retire a card whose binding moved, once and durably.
   *
   * Terminal on purpose, matching the recovery lane. Switching
   * `align_slack_users` off, reconfiguring a channel, and demoting a user are
   * all deliberate administrative acts; a card that silently became clickable
   * again when one was reverted would be a surprising thing to find in a
   * thread weeks later. Asking again mints a fresh widget, which re-asks every
   * question from scratch.
   */
  private async invalidateMcpSlackConnectBinding(widgetId: MessageID): Promise<boolean> {
    const invalidated = await mutateSlackConnectDelivery(this.messagesRepo, widgetId, (current) =>
      current && !current.binding_invalidated_at
        ? {
            ...current,
            delivery_claim: undefined,
            binding_invalidated_at: new Date().toISOString(),
            next_repair_at: new Date().toISOString(),
          }
        : null
    ).catch(() => undefined);
    return !!invalidated?.changed;
  }

  /**
   * Drop the mint-time "owes a card" marker, once the lane knows it will never
   * post one.
   *
   * Writes through the same row lock every other widget-metadata mutation
   * uses, and clears `slack_connect_due_at` only while no delivery record
   * exists — once one does, that record owns the indexed due column outright
   * and this field is already inert.
   */
  private async retireMcpSlackConnectDueMarker(widgetId: MessageID): Promise<void> {
    await this.messagesRepo
      .mutateMetadataLocked(widgetId, (metadata) => {
        const widget = metadata?.widget;
        if (!widget?.slack_connect_due_at || widget.slack_connect) return null;
        const { slack_connect_due_at: _dueAt, ...rest } = widget;
        return { ...metadata, widget: rest };
      })
      .catch(() => undefined);
  }

  /**
   * Move a refused first-card marker off the front of the sweep queue.
   *
   * Same row lock and same inertness rule as `retireMcpSlackConnectDueMarker`:
   * once a delivery record exists it owns the indexed due column outright and
   * this field decides nothing. The rule itself is
   * `mcpSlackConnectRefusedMarkerDueAt`, which keeps the marker's eligibility
   * window anchored to the mint rather than to the last refusal, so a card
   * nobody ever unblocks still ages out of the sweep exactly when it used to.
   */
  private async rescheduleMcpSlackConnectDueMarker(widgetId: MessageID): Promise<void> {
    await this.messagesRepo
      .mutateMetadataLocked(widgetId, (metadata) => {
        const widget = metadata?.widget;
        if (!widget?.slack_connect_due_at || widget.slack_connect) return null;
        const dueAt = mcpSlackConnectRefusedMarkerDueAt(widget);
        if (!dueAt || dueAt === widget.slack_connect_due_at) return null;
        return { ...metadata, widget: { ...widget, slack_connect_due_at: dueAt } };
      })
      .catch(() => undefined);
  }

  /**
   * Announce, once per (session, conversation), that this is not a DM.
   *
   * §4.8 allows channels rather than restricting the lane to DMs: credentials
   * belong to the prompt actor in both egress modes (D2), so there is no
   * credential-borrowing path to close. What a channel does change is who can
   * read what the connected account returns. The claim is a row-locked
   * compare-and-set rather than a read-then-write so two daemons projecting
   * the same thread cannot both decide they are first.
   *
   * Best effort by design: a thread that could not be warned still gets its
   * card. Failing the delivery instead would trade a missing sentence for a
   * missing button.
   */
  private async postMcpSlackSharedThreadWarning(
    connector: GatewayConnector,
    slack: SlackConnectCoordinates,
    sessionId: string
  ): Promise<void> {
    if (slackConversationIsDirectMessage(slack.channelId, slack.conversationType)) return;
    try {
      const mapping = await this.threadMapRepo.findBySession(sessionId);
      if (!mapping || mapping.thread_id !== slack.threadId) return;
      const claimed = await this.threadMapRepo.claimMetadataFlag(
        mapping.id,
        MCP_SLACK_CONNECT_SHARED_WARNING_KEY,
        new Date().toISOString()
      );
      if (!claimed) return;
      // Bounded: this runs INSIDE the card delivery's 30s claim, one call
      // before the card itself. An unanswered notice used to hold the whole
      // delivery — and then the card, which is the part that matters, missed
      // its own lease.
      await withSlackDeliveryDeadline(
        connector.sendMessage({
          threadId: slack.threadId,
          text: mcpSlackConnectSharedThreadWarning(),
        })
      );
    } catch {
      console.warn('[gateway] MCP connect shared-thread notice failed');
    }
  }

  /**
   * Post or edit the one Slack row that belongs to this widget, and account
   * for an exception that escapes the attempt.
   *
   * Every classified refusal below writes something durable — a marker
   * reschedule, a released claim, a recorded delivery failure — and an
   * UNCLASSIFIED throw wrote nothing at all. `recordSlackDeliveryFailure`
   * cannot see one: it needs a delivery record AND a live claim it owns, and
   * the whole prologue (the kill-switch read, the deps, the binding, the
   * re-seal, the channel read, the mint) runs above both. On 2026-09-16 there
   * was no delivery record to write to even in principle, and the throw also
   * landed above {@link rescheduleMcpSlackConnectDueMarker} — so
   * `slack_connect_due_at` kept its permanently-overdue mint timestamp, the
   * sweep re-selected the card every thirty seconds for the full 24-hour
   * horizon, and 2880 attempts produced no card, no accounting and one
   * `reason=unexpected`.
   *
   * So the exception is routed into whichever durable trigger the widget
   * actually has:
   *
   * - **This pass holds the claim** → account it as a delivery attempt
   *   (`unexpected_failure`). That clears the claim this pass leaked, counts
   *   the attempt, applies the backoff ladder, and strands the card through
   *   the disposition every other failure uses.
   * - **Otherwise** → reschedule the first-card marker, which self-guards to
   *   the case where it is the only trigger there is (no delivery record).
   *   30s → 5 min, still anchored to `requested_at` and still aged out at
   *   `requested_at + 24h`.
   *
   * Then it is RETHROWN, so the sweep's per-pass tally still counts the pass
   * and names its category.
   *
   * The trade, stated once: where a delivery record exists, an unclassified
   * throw now consumes the ladder, so a genuinely transient fault can strand
   * a card that previously would have retried past it. That is preferred to
   * the alternative — a leaked claim plus an unbounded retry — and it is why
   * §7.2's argument against an attempt counter on the MARKER still holds for
   * the other branch: a refused visit costs one binding read and makes no
   * Slack call, which is exactly true of a throw in the prologue.
   *
   * Idempotent by construction: one durable `delivery_claim` at a time, one
   * `slack_message_ts` reconciled from Slack's own message metadata when a
   * crash lost it, and a no-op when the state already rendered is the state
   * that would render now.
   */
  private async deliverMcpSlackConnectCard(
    widgetId: MessageID,
    attempt = 0,
    /**
     * The sweep pass's failure tally, when this delivery is one of its items.
     *
     * Only for reads this delivery swallows on purpose: a throw still leaves
     * through the caller's `.catch`. Absent for a timer or an event-driven
     * delivery, which report on their own.
     */
    failures?: Map<string, McpSlackRepairFailureTally>
  ): Promise<void> {
    // One ref for the whole delivery, re-entrant calls included, because a
    // claim is held by the DELIVERY and not by a stack frame: the three
    // internal re-renders below hand it down rather than wrapping themselves,
    // so the ladder is consumed once per pass however many times the card
    // re-rendered inside it.
    const claimRef: McpSlackConnectClaimRef = {};
    try {
      await this.renderMcpSlackConnectCard(widgetId, attempt, failures, claimRef);
    } catch (error) {
      if (claimRef.claimId) {
        await this.recordMcpSlackConnectDeliveryFailure(
          widgetId,
          claimRef.claimId,
          'unexpected_failure'
        ).catch(() => undefined);
      } else {
        await this.rescheduleMcpSlackConnectDueMarker(widgetId);
      }
      throw error;
    }
  }

  /**
   * The delivery itself. Always reached through
   * {@link deliverMcpSlackConnectCard}, which owns the accounting.
   */
  private async renderMcpSlackConnectCard(
    widgetId: MessageID,
    attempt: number,
    failures: Map<string, McpSlackRepairFailureTally> | undefined,
    claimRef: McpSlackConnectClaimRef
  ): Promise<void> {
    // Operator kill switch, checked before anything is read or posted. Off
    // stops the PROJECTION only: the canvas widget still renders a live
    // Connect button and `agor_widgets_request_oauth` still hands the agent a
    // `session_url` to relay, which is what makes turning the card off a
    // degradation rather than a removal. A card already in a thread simply
    // stops being repainted, and its link stops being redeemable
    // (`loadMCPOAuthConnectBinding`) — matching the recovery lane, which
    // refuses at both ends on `isMcpRuntimeRecoveryEnabled`.
    if (!(await this.readInTenantScope(isMCPSlackConnectCardEnabled))) return;
    const deps = await this.mcpSlackConnectDeps();
    const binding = await resolveSlackConnectBinding(deps, widgetId);
    const widget = binding.widget;
    const slack = binding.slack;
    const delivery = widget?.slack_connect;
    // A mint-time marker (`slack_connect_due_at`) puts a widget on this sweep
    // before any delivery record exists. Retire it on the first look at a
    // widget this lane can never post for, so a Discord/GitHub/Teams mint —
    // or a card that resolved before it was ever issued — costs one visit
    // rather than a day of them. Only the PERMANENT refusals qualify:
    // `no_secret`, `no_public_url`, `unaligned` and `authority_moved` can all
    // be undone by an administrator, and dropping the marker for those would
    // take away the durable trigger for a card that becomes postable later.
    if (
      !delivery &&
      widget?.slack_connect_due_at &&
      !binding.ok &&
      (binding.reason === 'not_slack' || binding.reason === 'not_connectable')
    ) {
      await this.retireMcpSlackConnectDueMarker(widgetId);
    }
    // A widget that was never Slack-delivered — the whole canvas case, and
    // every Discord/GitHub/Teams session — has no row here and must not
    // acquire one. B3's session deep link remains their answer.
    if (!widget || !slack) return;
    // Say the deployment-level refusal out loud, once per pass. It is not this
    // widget's fault and it is not an error, so it returns quietly below —
    // but it is the same condition for every card at once, and a first-card
    // refusal that returned in SILENCE is a real part of why the incident
    // took thirty seconds a card and no log line to read.
    if (!binding.ok && binding.reason === 'no_public_url') {
      this.reportMcpSlackRefusal(failures, 'connect', widgetId, 'no_public_url');
    }
    if (!delivery && (!binding.ok || !this.recoveryEnvelopeSecret())) {
      // Keep the trigger, give up the queue position. The reversible refusals
      // are why the marker survives the block above; leaving it at its
      // original, permanently overdue timestamp is what let fifty of them sit
      // at the front of every sweep page and starve the healthy cards behind
      // them of a first delivery and of every repair.
      await this.rescheduleMcpSlackConnectDueMarker(widgetId);
      return;
    }

    const now = Date.now();
    // Is the credential already on file? The card has to know, because the
    // provider callback is the only one of this lane's three milestones the
    // browser completes on its own: a sign-in whose page went away afterwards
    // leaves a real grant behind an unresolved widget, and a card that only
    // reads the delivery record renders that as a sign-in still in flight,
    // forever, with nothing to press. Read through the one liveness function
    // and the one verdict (D4/D4.1), for the credential user the widget was
    // minted for, so the card cannot offer a finish `/oauth-resolve` would
    // then refuse — nor withhold one it would accept, which is what keying
    // this on `live` alone did to the user who came back an hour later.
    //
    // Only asked while the widget is unresolved — a resolved card's state is
    // decided by the widget row alone — so a connected thread costs no read.
    //
    // Fails CLOSED, and says so out loud. A read that throws here — a missing
    // tenant scope, a database that is not answering — is indistinguishable in
    // the rendered card from a grant that genuinely is not there: the delivery
    // then SUCCEEDS, so the sweep's per-item `.catch` never sees it and the
    // failure is counted nowhere. That silence is how four of six tenant-scope
    // defects reached a running daemon (§7.1.6), so the verdict stays `false`
    // and the failure is reported.
    const grantConnected =
      binding.ok && (widget.status === 'pending' || widget.status === 'resolving')
        ? await this.readInTenantScope((db) =>
            resolveMCPOAuthGrantLiveness(
              db,
              binding.params.mcpServerId as MCPServerID,
              binding.task.created_by as UserID
            )
          )
            .then(mcpOAuthGrantIsConnected)
            .catch((error: unknown) => {
              this.reportSwallowedGatewayRead(
                failures,
                'connect',
                widgetId,
                error,
                'grant_liveness'
              );
              return false;
            })
        : false;
    // A re-issue offers a fresh SIGN-IN link, which is exactly what a landed
    // grant makes pointless — and, since `finish_required` outranks the state
    // a re-issue produces, leaving it set would defeat the no-op shortcut and
    // re-render the card on every repair tick.
    const willReissue =
      binding.ok && !grantConnected && mcpSlackConnectMayReissue(widget, delivery, now);
    let state = mcpSlackConnectRenderedState(
      {
        widget,
        delivery,
        willReissue,
        grantConnected,
        ...(binding.ok ? {} : { refusal: binding.reason }),
      },
      now
    );

    // Re-seal HERE, above the steady-state shortcut, because whether a finish
    // link can be produced at all is part of which state this card is in —
    // `finish_required` means "there is a button to offer" and
    // `finish_stalled` means "there is not". Deciding it later would leave the
    // shortcut, the claim and the expiry timer all reasoning about a state the
    // card then could not render, and would re-render a settled
    // `finish_stalled` card on every tick.
    //
    // Unlike `issueMCPOAuthConnectLink` below — which is deliberately left
    // until a post is certain, because minting starts a ten-minute clock —
    // this writes nothing and starts nothing. It re-derives a link from a
    // record that already exists, so running it on a tick that turns out to
    // be a no-op costs one seal and changes nothing.
    let finishUrl: string | undefined;
    if (state === 'finish_required' && delivery) {
      // Re-seal, never re-issue. The sign-in already happened, the one-use
      // token already did its job, and a re-issue would clear the
      // `oauth_succeeded_at` that is the record of it.
      finishUrl = binding.ok
        ? (resealMCPOAuthConnectLink(deps, binding, requireCurrentTenantId(), new Date()) ??
          undefined)
        : undefined;
      if (!finishUrl) state = 'finish_stalled';
    }
    this.scheduleMcpSlackConnectExpiry(widgetId, delivery, state);

    // The binding moved under a card that is already in the thread. Record it
    // once, so the card's terminal state stops depending on a read that could
    // flap, then render from the recorded fact.
    if (state === 'unavailable' && delivery && !delivery.binding_invalidated_at) {
      if (await this.invalidateMcpSlackConnectBinding(widgetId)) {
        await this.renderMcpSlackConnectCard(widgetId, 0, failures, claimRef);
        return;
      }
    }

    if (delivery?.slack_message_ts && delivery.rendered_state === state && !willReissue) {
      const nextRepairAt = this.mcpSlackConnectNextActiveRepairAt(state, delivery, now);
      if (delivery.next_repair_at !== nextRepairAt) {
        await mutateSlackConnectDelivery(this.messagesRepo, widgetId, (current) =>
          current?.delivery_id === delivery.delivery_id && current.rendered_state === state
            ? { ...current, next_repair_at: nextRepairAt }
            : null
        );
      }
      return;
    }

    const claimId = randomUUID();
    const claim = slackDeliveryClaim(claimId, now);
    const claimExpiresAt = claim.expires_at;
    let current = delivery;
    if (delivery) {
      const result = await mutateSlackConnectDelivery(this.messagesRepo, widgetId, (latest) => {
        if (!latest || latest.delivery_id !== delivery.delivery_id) return null;
        if (latest.slack_message_ts && latest.rendered_state === state && !willReissue) return null;
        if (slackDeliveryClaimIsLive(latest, now)) return null;
        return { ...latest, delivery_claim: claim, next_repair_at: claimExpiresAt };
      });
      if (!result.changed || result.delivery?.delivery_claim?.claim_id !== claimId) {
        // Another daemon owns this render. Come back once its lease lapses, so
        // a claimant that died mid-delivery does not strand the card.
        const live = result.delivery?.delivery_claim;
        if (slackDeliveryClaimIsLive(result.delivery, Date.now())) {
          this.scheduleMcpSlackConnectRetry(
            widgetId,
            Math.max(100, new Date(live!.expires_at).getTime() - Date.now() + 100)
          );
        }
        return;
      }
      // From here an exception leaves a claim behind, and the accounting in
      // `deliverMcpSlackConnectCard` is what clears it.
      claimRef.claimId = claimId;
      current = result.delivery;
    }

    // Mint the link only when one is about to be posted: a card in a steady
    // state returned above, so the ten-minute clock starts when the button
    // appears rather than on every repair tick. On the first card the mint IS
    // the claim — there is no record to claim beforehand, and two daemons
    // minting concurrently would otherwise each post one.
    let url: string | undefined = finishUrl;
    if (state === 'connect_required' || (state === 'finish_required' && !delivery)) {
      if (!binding.ok) return;
      const issued = await issueMCPOAuthConnectLink(deps, {
        tenantId: requireCurrentTenantId(),
        widgetId,
        binding,
        claim: { claimId, expiresAt: claimExpiresAt },
      });
      if (!issued) {
        // The widget resolved under the claim, or another daemon holds it.
        claimRef.claimId = undefined;
        if (current) await this.releaseMcpSlackConnectClaim(widgetId, claimId, true);
        return;
      }
      url = issued.url;
      current = issued.delivery;
      // On a first card the MINT is the claim, so this is where the ref starts
      // naming one.
      claimRef.claimId = claimId;
    }
    if (!current) return;
    const fence = {
      deliveryId: current.delivery_id,
      generation: current.delivery_generation,
    };

    const channel = await this.channelRepo.findById(slack.gatewayChannelId);
    if (!channel?.enabled || channel.channel_type !== 'slack') {
      claimRef.claimId = undefined;
      await this.releaseMcpSlackConnectClaim(widgetId, claimId);
      return;
    }
    let parsedThread: ReturnType<typeof parseSlackThreadId>;
    try {
      parsedThread = parseSlackThreadId(slack.threadId);
    } catch {
      parsedThread = { channel: '', thread_ts: '' };
    }
    if (
      parsedThread.channel !== slack.channelId ||
      !isSlackWriteTargetAllowed(channel.config, parsedThread.channel)
    ) {
      claimRef.claimId = undefined;
      await this.invalidateMcpSlackConnectBinding(widgetId);
      return;
    }
    const acquired = await acquireSlackDeliveryConnector(channel, {
      // An absent sealed generation predates the field and is treated as
      // current; the recovery lane's record always carries one, which is why
      // this predicate belongs to the lane rather than to the engine.
      generationCurrent:
        current.gateway_config_generation === undefined ||
        current.gateway_config_generation === channel.provider_config_generation,
      expectedTeamId: slack.teamId,
      writeTargetChannel: parsedThread.channel,
      activeListener: () => this.getActiveListener(channel.id),
    });
    if (acquired.outcome === 'failed') {
      claimRef.claimId = undefined;
      await this.recordMcpSlackConnectDeliveryFailure(widgetId, claimId, acquired.reason);
      return;
    }
    if (acquired.outcome === 'app_moved') {
      claimRef.claimId = undefined;
      await this.releaseMcpSlackConnectClaim(widgetId, claimId);
      return;
    }
    const connector = acquired.connector;
    if (acquired.revalidated) {
      // Same app, still allowed to write here — but the configuration this
      // link was sealed against has changed, and the sealed token pins the
      // generation redemption compares. Only a card that still offers that
      // link has anything to withhold: retire it and re-render as the refusal.
      // A card with no button carries nothing stale, so it goes out through
      // the freshly loaded connector rather than being stranded forever — by
      // then `binding_invalidated_at` is usually already set, and refusing to
      // render would leave the thread showing its last live state permanently.
      if (state === 'connect_required') {
        claimRef.claimId = undefined;
        if (await this.invalidateMcpSlackConnectBinding(widgetId)) {
          await this.renderMcpSlackConnectCard(widgetId, 0, failures, claimRef);
        } else {
          await this.releaseMcpSlackConnectClaim(widgetId, claimId);
        }
        return;
      }
    }

    const copy = mcpSlackConnectCardCopy(state, {
      serverName: binding.params?.serverName ?? 'this MCP server',
      reason: binding.params?.reason ?? '',
      oauthMode: binding.params?.oauthMode ?? 'per_user',
      ...(binding.ok ? {} : { refusal: binding.reason }),
    });
    const blocks = mcpSlackConnectBlocks(copy, url);
    try {
      // Once, before the first card lands in the thread — not on every edit.
      if (!current.slack_message_ts && binding.message) {
        await this.postMcpSlackSharedThreadWarning(connector, slack, binding.message.session_id);
      }
      const { receipt, reconciledMessageTs } = await sendSlackCard(connector, {
        threadId: slack.threadId,
        text: copy.text,
        blocks,
        eventType: MCP_SLACK_CONNECT_EVENT_TYPE,
        deliveryId: current.delivery_id,
        ...(current.slack_message_ts ? { recordedTs: current.slack_message_ts } : {}),
        onLateReceipt: (late) =>
          this.reconcileLateMcpSlackConnectSend(widgetId, fence, state, late, {
            connector,
            threadId: slack.threadId,
            text: mcpSlackConnectDuplicateCardText(binding.params?.serverName ?? 'this MCP server'),
          }),
      });
      const renderedAt = new Date();
      const settled = await mutateSlackConnectDelivery(this.messagesRepo, widgetId, (latest) => {
        if (!latest || latest.delivery_id !== fence.deliveryId) return null;
        if (latest.delivery_generation !== fence.generation) return null;
        // Still OURS, not merely unclaimed. The claim is a 30s lease, so a
        // post that outlives it can land after another claimant took the
        // expired claim, posted the row that counts, and released it — at
        // which point an absent claim reads as consent to record a receipt
        // that belongs to somebody else's message.
        if (latest.delivery_claim?.claim_id !== claimId) return null;
        return {
          ...latest,
          slack_message_ts: latest.slack_message_ts ?? reconciledMessageTs ?? receipt.messageId,
          delivery_claim: undefined,
          rendered_state: state,
          rendered_at: renderedAt.toISOString(),
          delivery_attempt_count: 0,
          delivery_next_retry_at: undefined,
          next_repair_at: this.mcpSlackConnectNextActiveRepairAt(
            state,
            latest,
            renderedAt.getTime()
          ),
        };
      });
      // Settled or lost, the claim is no longer this pass's to account for:
      // a settlement cleared it, and anything else means another claimant
      // holds it.
      claimRef.claimId = undefined;
      if (!settled.changed) {
        // A lost claim has to reconcile whatever this delivery actually did,
        // and that is two different things. A fresh POST left a second Slack
        // row nothing durable names, so it is retired. An EDIT reused the row
        // the record already names and repainted it with a state this daemon
        // no longer owns — nothing is orphaned, but the thread now shows the
        // wrong card and `rendered_state` says otherwise, so every later
        // render (including an explicit repair) skips it as a no-op.
        const ownedTs = settled.delivery?.slack_message_ts;
        if (reconciledMessageTs && reconciledMessageTs === ownedTs) {
          await this.repaintLostMcpSlackConnectRender(
            widgetId,
            reconciledMessageTs,
            state,
            attempt,
            failures,
            claimRef
          );
        } else {
          await retireOrphanedSlackCard(connector, slack.threadId, {
            lane: 'connect',
            orphanTs: reconciledMessageTs ?? receipt.messageId,
            ownedTs,
            text: mcpSlackConnectDuplicateCardText(binding.params?.serverName ?? 'this MCP server'),
          });
        }
      }
      this.mcpSlackConnectRetryTimers.cancel(widgetId);
    } catch {
      claimRef.claimId = undefined;
      await this.recordMcpSlackConnectDeliveryFailure(widgetId, claimId, 'slack_write_failed');
    }
  }

  /**
   * A connect card write that landed after its deadline had written it off.
   *
   * The connect lane's counterpart of `reconcileLateMcpSlackRecoverySend`, and
   * for the same reason: a timed-out write is one whose claim was released,
   * so a later attempt may already have settled the card to a newer state —
   * and a terminal state schedules no repair, so without this the thread would
   * keep whatever the late write painted. Fenced on the delivery this pass was
   * sending for, like settlement.
   */
  private reconcileLateMcpSlackConnectSend(
    widgetId: MessageID,
    fence: { deliveryId: string; generation: number | undefined },
    renderedState: MCPSlackConnectRenderedState,
    late: LateSlackCardReceipt,
    retire: { connector: GatewayConnector; threadId: string; text: string }
  ): void {
    const tenantId = requireCurrentTenantId();
    void runWithTenantContext(tenantId, async () => {
      const latest = (await this.messagesRepo.findById(widgetId))?.metadata?.widget?.slack_connect;
      const isThisDelivery =
        latest?.delivery_id === fence.deliveryId && latest.delivery_generation === fence.generation;
      const ownedTs = isThisDelivery ? latest?.slack_message_ts : undefined;
      const disposition = lateSlackCardDisposition(late, { isThisDelivery, ownedTs });
      if (disposition === 'repaint') {
        const cleared = await clearLostSlackRender(
          this.mcpSlackConnectStore(widgetId),
          late.reconciledMessageTs as string,
          renderedState
        );
        if (cleared?.changed) await this.deliverMcpSlackConnectCard(widgetId);
      } else if (disposition === 'retire') {
        await retireOrphanedSlackCard(retire.connector, retire.threadId, {
          lane: 'connect',
          orphanTs: late.reconciledMessageTs ?? late.receipt.messageId,
          ownedTs,
          text: retire.text,
        });
      }
    }).catch((error: unknown) =>
      this.logMcpSlackOperationFailure(
        'mcp_slack_late_receipt_failed',
        'connect',
        { widget_id: widgetId },
        error
      )
    );
  }

  /**
   * Re-render a card this daemon repainted but turned out not to own.
   *
   * The counterpart of `retireOrphanedSlackCard`, for the other
   * thing a lost claim can leave behind. A delivery that EDITED the recorded
   * row orphans nothing — it wrote over the one card the widget has — but it
   * wrote a state a second claimant had already superseded. The record then
   * disagrees with the thread, and because `rendered_state` is exactly what
   * every later render compares against, the disagreement is self-sealing:
   * the no-op shortcut, the claim CAS, and an explicit repair all skip a card
   * whose recorded state already matches the state that would render now.
   *
   * So the fix is to stop the record from claiming a render that was undone.
   * Clearing `rendered_state` costs one extra edit and makes the next render —
   * this one, immediately, or the sweep after a crash — repaint the card from
   * the widget row, which is the authority. Fenced on the recorded `ts` so it
   * can only ever unwind the message this delivery actually wrote to, and a
   * no-op when the winner rendered the same state this one did.
   */
  private async repaintLostMcpSlackConnectRender(
    widgetId: MessageID,
    editedTs: string,
    renderedState: MCPSlackConnectRenderedState,
    attempt: number,
    failures: Map<string, McpSlackRepairFailureTally> | undefined,
    claimRef: McpSlackConnectClaimRef
  ): Promise<void> {
    const cleared = await clearLostSlackRender(
      this.mcpSlackConnectStore(widgetId),
      editedTs,
      renderedState
    );
    // Bounded in process: losing the claim again means a third daemon is
    // still writing this row, and `next_repair_at` above already hands the
    // card to the sweep. Repainting in a loop would just race it harder.
    if (cleared?.changed && attempt < MCP_SLACK_REPAINT_ATTEMPTS) {
      await this.renderMcpSlackConnectCard(widgetId, attempt + 1, failures, claimRef);
    }
  }

  private scheduleMcpSlackConnectRetry(widgetId: MessageID, delay = 5_000): void {
    if (this.mcpSlackConnectRetryTimers.has(widgetId)) return;
    const tenantId = requireCurrentTenantId();
    this.mcpSlackConnectRetryTimers.schedule(widgetId, delay, () => {
      void runWithTenantContext(tenantId, () => this.deliverMcpSlackConnectCard(widgetId)).catch(
        (error: unknown) =>
          this.logMcpSlackOperationFailure(
            'mcp_slack_delivery_retry_failed',
            'connect',
            { widget_id: widgetId },
            error
          )
      );
    });
  }

  /**
   * Wake this card when its own link expires.
   *
   * Only the two live states age, and only on the connect token's clock — the
   * one clock D7 chose to keep. Every other state is terminal and must not
   * hold a timer open.
   */
  private scheduleMcpSlackConnectExpiry(
    widgetId: MessageID,
    delivery: MCPSlackConnectDelivery | undefined,
    state: MCPSlackConnectRenderedState
  ): void {
    const delay = mcpSlackConnectExpiryDelay(state, delivery);
    if (delay === undefined) {
      this.mcpSlackConnectExpiryTimers.cancel(widgetId);
      return;
    }
    if (this.mcpSlackConnectExpiryTimers.has(widgetId)) return;
    const tenantId = requireCurrentTenantId();
    this.mcpSlackConnectExpiryTimers.schedule(widgetId, delay, () => {
      void runWithTenantContext(tenantId, () => this.deliverMcpSlackConnectCard(widgetId)).catch(
        (error: unknown) =>
          this.logMcpSlackOperationFailure(
            'mcp_slack_expiry_projection_failed',
            'connect',
            { widget_id: widgetId },
            error
          )
      );
    });
  }

  /** Project one `oauth` widget's durable state into its Slack row. */
  async syncMcpSlackConnectCard(widgetId: MessageID): Promise<void> {
    await this.deliverMcpSlackConnectCard(widgetId);
  }

  /**
   * Project after the caller's transaction commits.
   *
   * Every trigger is post-commit for the same reason the recovery lane's is:
   * Slack must never be told about a widget transition that has not landed,
   * and a provider call must never be made while a database transaction is
   * open.
   */
  syncMcpSlackConnectCardAfterCommit(widgetId: MessageID, params?: unknown): void {
    deferWithTenantContext(
      params,
      () => this.syncMcpSlackConnectCard(widgetId),
      // `deferWithTenantContext` has always PASSED the error here and this
      // callback has always ignored it, so the incident's after-commit
      // projection failures were one fixed sentence apiece.
      (error: unknown) =>
        this.logMcpSlackOperationFailure(
          'mcp_slack_after_commit_projection_failed',
          'connect',
          { widget_id: widgetId },
          error
        )
    );
  }

  async markMcpSlackOAuthResult(input: {
    taskId: string;
    noticeId: string;
    attemptId: MCPOAuthAttemptID;
    success: boolean;
  }): Promise<void> {
    let authorityCurrent = !input.success;
    if (input.success) {
      const task = await this.taskRepo.findById(input.taskId);
      const notice = task?.metadata?.mcp_slack_recovery_notice;
      const recovery = task?.metadata?.mcp_recovery;
      if (task && notice?.notice_id === input.noticeId && recovery) {
        const [session, channel, mapping, server, principal, credentialUser, mode] =
          await Promise.all([
            this.sessionRepo.findById(task.session_id),
            this.channelRepo.findById(notice.gateway_channel_id),
            this.threadMapRepo.findBySession(task.session_id),
            this.mcpServerRepo.findById(notice.mcp_server_id),
            this.usersRepo.findById(notice.principal_user_id),
            this.usersRepo.findById(notice.credential_user_id),
            this.readInTenantScope(getMCPEgressGatewayMode),
          ]);
        const attached = (await this.sessionMcpRepo.listServers(task.session_id, true)).some(
          (candidate) => candidate.mcp_server_id === notice.mcp_server_id
        );
        const grantUserId =
          server?.auth?.type === 'oauth' && (server.auth.oauth_mode ?? 'per_user') === 'shared'
            ? null
            : notice.credential_user_id;
        const grant = server
          ? await this.userTokenRepo.getToken(grantUserId as UserID | null, notice.mcp_server_id)
          : null;
        let parsedThread: ReturnType<typeof parseSlackThreadId> | undefined;
        try {
          parsedThread = parseSlackThreadId(notice.slack_thread_id);
        } catch {
          parsedThread = undefined;
        }
        authorityCurrent = !!(
          session &&
          session.session_id === notice.session_id &&
          session.created_by === notice.credential_user_id &&
          task.created_by === notice.principal_user_id &&
          [TaskStatus.RUNNING, TaskStatus.AWAITING_PERMISSION, TaskStatus.AWAITING_INPUT].includes(
            task.status as never
          ) &&
          recovery.code === 'oauth_reauth_required' &&
          recovery.status === 'action_required' &&
          recovery.mcp_server_id === notice.mcp_server_id &&
          recovery.generation === notice.recovery_generation &&
          recovery.request_id === notice.recovery_request_id &&
          channel?.enabled &&
          channel.channel_type === 'slack' &&
          channel.provider_config_generation === notice.gateway_config_generation &&
          parsedThread?.channel === notice.slack_channel_id &&
          isSlackWriteTargetAllowed(channel.config, parsedThread.channel) &&
          mapping?.channel_id === channel.id &&
          mapping.thread_id === notice.slack_thread_id &&
          server?.enabled &&
          server.auth?.type === 'oauth' &&
          (server.config_version ?? 1) === notice.mcp_server_config_version &&
          attached &&
          principal &&
          credentialUser &&
          hasMinimumRole(principal.role, ROLES.MEMBER) &&
          hasMinimumRole(
            credentialUser.role,
            (server.auth.oauth_mode ?? 'per_user') === 'shared' ? ROLES.ADMIN : ROLES.MEMBER
          ) &&
          grant &&
          (await isMCPOAuthGrantAuthorizedForServer(this.db, server, grant)) &&
          (mode === 'compatibility' || mode === 'enforced')
        );
      }
    }
    const resultAt = new Date().toISOString();
    const changed = await this.taskRepo.mutateMCPSlackRecoveryNotice(input.taskId, (current) =>
      current?.notice_id === input.noticeId && current.oauth_attempt_id === input.attemptId
        ? {
            ...current,
            ...(input.success && authorityCurrent
              ? { oauth_succeeded_at: resultAt }
              : input.success
                ? { oauth_superseded_at: resultAt }
                : { oauth_failed_at: resultAt }),
            next_repair_at: resultAt,
          }
        : null
    );
    if (changed.changed) await this.deliverMcpSlackRecoveryNotice(changed.task);
  }

  /**
   * Resolve an aligned Agor user from an external platform identity.
   *
   * Two-tier lookup shared by the GitHub and Shortcut alignment branches:
   *   1. `user_map[externalId]` → Agor email (explicit operator mapping)
   *   2. the platform-provided email
   * Returns the matched user row, or null when neither resolves. Callers own
   * the platform-specific rejection — there is never a fallback to the channel
   * owner (that would be a privilege-escalation path).
   */
  private async resolveAlignedUser(opts: {
    platform: string;
    externalId: string | undefined;
    email: unknown;
    userMap: Record<string, string> | undefined;
  }): Promise<Awaited<ReturnType<UsersRepository['findByEmailForAlignment']>>> {
    const { platform, externalId, email, userMap } = opts;

    // Tier 1: explicit user_map (externalId → Agor email).
    const mappedEmail =
      externalId && userMap?.[externalId] ? userMap[externalId].toLowerCase().trim() : null;
    if (mappedEmail) {
      const matched = await this.usersRepo.findByEmailForAlignment(mappedEmail);
      if (matched) {
        console.log(
          `[gateway] ${platform} user alignment succeeded: source=user_map agor_user=${shortId(matched.user_id)}`
        );
        return matched;
      }
      console.warn(
        `[gateway] ${platform} user alignment failed: source=user_map result=agor_user_not_found`
      );
    }

    // Tier 2: platform-provided email → Agor user email match.
    const normalizedEmail = typeof email === 'string' ? email.toLowerCase().trim() || null : null;
    if (normalizedEmail) {
      const matched = await this.usersRepo.findByEmailForAlignment(normalizedEmail);
      if (matched) {
        console.log(
          `[gateway] ${platform} user alignment succeeded: source=email agor_user=${shortId(matched.user_id)}`
        );
        return matched;
      }
    }

    return null;
  }

  private truncateSlackInline(value: string, maxChars = 70): string {
    const singleLine = value.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= maxChars) return singleLine;
    return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  private formatSlackLoadingMessage(text: string): string {
    // Slack validates loading_messages entries as strictly < 51 chars.
    return this.truncateSlackInline(text, 50);
  }

  private makeSlackThreadIdForMessage(rootThreadId: string, messageTs: string): string | null {
    const lastHyphen = rootThreadId.lastIndexOf('-');
    if (lastHyphen === -1) return null;
    const channelId = rootThreadId.slice(0, lastHyphen);
    if (!channelId || !messageTs) return null;
    return `${channelId}-${messageTs}`;
  }

  /**
   * Can `assistant.threads.setStatus` apply to this thread at all?
   *
   * Slack's assistant-thread APIs are a property of the assistant container —
   * the app's own DM surface. A public channel, a private channel or an MPIM
   * has no assistant thread to set a status on, so the call is not "a status
   * update that happened to fail": it is a request Slack was never going to
   * accept, made on every progress tick of every channel conversation.
   *
   * Deliberately the SAME predicate that keeps streaming out of channel-like
   * surfaces, rather than a second one beside it. Both questions are "is this
   * the app's DM surface", and two spellings of that would drift.
   */
  private slackThreadSupportsAssistantStatus(threadId: string): boolean {
    return !this.isSlackChannelLikeThreadId(threadId);
  }

  /**
   * Account for a refused assistant-status write.
   *
   * It stays non-fatal — a status is cosmetic and must never take a turn down
   * with it — but it stops being anonymous. A bare `catch` hid the one thing
   * worth knowing: whether Slack refused because the method does not apply
   * here (now guarded above) or because the workspace is rate limiting us,
   * which the connector's retry ladder will have spent real time on first.
   */
  private warnSlackAssistantStatusFailed(threadId: string, error: unknown): void {
    console.warn(
      `[gateway] event=slack_assistant_status_failed thread=${shortId(threadId)} ` +
        `code=${gatewayFailureCode(error)} detail=${sanitizeGatewayProviderError(error, 120)}`
    );
  }

  private isSlackChannelLikeThreadId(threadId: string): boolean {
    const lastHyphen = threadId.lastIndexOf('-');
    if (lastHyphen === -1) return false;
    const channelId = threadId.slice(0, lastHyphen);
    // Slack DMs use D-prefixed channel IDs. Public channels, private channels,
    // and multi-person DMs are channel-like surfaces where streaming has proven
    // easier to leak into the main channel than regular threaded chat.postMessage.
    return !!channelId && !channelId.startsWith('D');
  }

  private async addSlackThreadAlias(
    mapping: ThreadSessionMap,
    messageTs: string,
    reason: string
  ): Promise<void> {
    const aliasThreadId = this.makeSlackThreadIdForMessage(mapping.thread_id, messageTs);
    if (!aliasThreadId || aliasThreadId === mapping.thread_id) return;

    // Merge against fresh metadata so alias writes do not clobber platform
    // context/active-thread fields written by the inbound path moments earlier.
    const freshMapping = await this.threadMapRepo.findById(mapping.id);
    const metadata = (((freshMapping ?? mapping).metadata as Record<string, unknown>) ??
      {}) as Record<string, unknown>;
    const aliases = Array.isArray(metadata.slack_thread_aliases)
      ? metadata.slack_thread_aliases.filter((alias): alias is string => typeof alias === 'string')
      : [];
    if (aliases.includes(aliasThreadId)) return;

    await this.threadMapRepo.updateMetadata(mapping.id, {
      ...metadata,
      slack_thread_aliases: [...aliases, aliasThreadId].slice(-50),
      slack_thread_alias_last_reason: reason,
    });
  }

  /** Store provider-neutral reply aliases without disturbing legacy Slack metadata. */
  private async addGatewayReplyAliases(
    mapping: ThreadSessionMap,
    aliasesToAdd: string[]
  ): Promise<void> {
    const aliases = aliasesToAdd.filter((alias) => typeof alias === 'string' && alias.length > 0);
    if (aliases.length === 0) return;
    await this.threadMapRepo.mergeGatewayReplyAliases(mapping.id, aliases);
  }

  /**
   * The first reply to a proactive seed has a distinct durable delivery phase.
   * Keep that phase on the canonical mapping until prompt admission crosses its
   * own durable fence; later replies to the seed's response aliases must remain
   * ordinary follow-ups.
   */
  private isSeedInitialPromptPending(
    mapping: ThreadSessionMap,
    eventId?: import('@agor/core/types').GatewayInboundEventID
  ): boolean {
    const metadata = ((mapping.metadata as Record<string, unknown> | null) ?? {}) as Record<
      string,
      unknown
    >;
    if (metadata.outbound_seed_initial_prompt_pending !== true) return false;
    const initialEventId = metadata.outbound_seed_initial_event_id;
    return (
      (initialEventId === undefined && eventId === undefined) ||
      (typeof initialEventId === 'string' &&
        initialEventId.length > 0 &&
        typeof eventId === 'string' &&
        eventId.length > 0 &&
        initialEventId === eventId)
    );
  }

  private async markSeedInitialPromptAdmitted(
    mapping: ThreadSessionMap,
    eventId: import('@agor/core/types').GatewayInboundEventID | undefined,
    taskId: TaskID
  ): Promise<void> {
    await this.threadMapRepo.completeSeedInitialPrompt(mapping.id, eventId, taskId);
  }

  private getActiveSlackThreadId(mapping: ThreadSessionMap): string {
    const metadata = ((mapping.metadata as Record<string, unknown>) ?? {}) as Record<
      string,
      unknown
    >;
    return typeof metadata.slack_active_thread_id === 'string'
      ? metadata.slack_active_thread_id
      : mapping.thread_id;
  }

  private pickSlackRoutingMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(typeof metadata.slack_active_thread_id === 'string'
        ? { slack_active_thread_id: metadata.slack_active_thread_id }
        : {}),
      ...(Array.isArray(metadata.slack_thread_aliases)
        ? { slack_thread_aliases: metadata.slack_thread_aliases }
        : {}),
      ...(typeof metadata.slack_thread_alias_last_reason === 'string'
        ? { slack_thread_alias_last_reason: metadata.slack_thread_alias_last_reason }
        : {}),
    };
  }

  private async findGatewayReplyAliasMapping(
    channelId: string | undefined,
    threadId: string
  ): Promise<ThreadSessionMap | null> {
    const mappings = channelId
      ? await this.threadMapRepo.findByChannel(channelId, 'active')
      : (await this.threadMapRepo.findAll()).filter((mapping) => mapping.status === 'active');
    return (
      mappings.find((mapping) => {
        const metadata = ((mapping.metadata as Record<string, unknown>) ?? {}) as Record<
          string,
          unknown
        >;
        const genericAliases = Array.isArray(metadata.gateway_reply_aliases)
          ? metadata.gateway_reply_aliases
          : [];
        const legacySlackAliases = Array.isArray(metadata.slack_thread_aliases)
          ? metadata.slack_thread_aliases
          : [];
        return [...genericAliases, ...legacySlackAliases].includes(threadId);
      }) ?? null
    );
  }

  private parseGatewayTodos(raw: unknown): GatewayTodoItem[] {
    const candidate =
      typeof raw === 'string'
        ? (() => {
            try {
              return JSON.parse(raw);
            } catch {
              return null;
            }
          })()
        : raw;

    if (!Array.isArray(candidate)) return [];

    return candidate
      .map((item): GatewayTodoItem | null => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        const content =
          typeof record.content === 'string'
            ? record.content
            : typeof record.activeForm === 'string'
              ? record.activeForm
              : null;
        if (!content) return null;
        const status = record.status;
        if (
          status !== 'pending' &&
          status !== 'in_progress' &&
          status !== 'completed' &&
          status !== 'stopped' &&
          status !== 'unknown'
        ) {
          return { content, status: 'pending' };
        }
        return {
          content,
          ...(typeof record.activeForm === 'string' ? { activeForm: record.activeForm } : {}),
          status,
        };
      })
      .filter((item): item is GatewayTodoItem => item !== null);
  }

  private formatSlackToolSummary(toolName?: string, input?: Record<string, unknown>): string {
    if (!toolName) return 'Waiting for the agent...';

    const str = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim().length > 0 ? value : undefined;
    const preview = (value: unknown, maxChars = 70): string | undefined => {
      const text = str(value);
      return text ? this.truncateSlackInline(text, maxChars) : undefined;
    };
    const withPreview = (value?: string): string =>
      value ? `\`${toolName}\` ${value}` : `\`${toolName}\``;

    if (toolName === 'TodoWrite') {
      const todos = this.parseGatewayTodos(input?.todos);
      if (todos.length > 0) {
        const completed = todos.filter((todo) => todo.status === 'completed').length;
        const inProgress = todos.filter((todo) => todo.status === 'in_progress').length;
        const parts = [`${completed}/${todos.length} done`];
        if (inProgress > 0) parts.push(`${inProgress} in progress`);
        return withPreview(parts.join(', '));
      }
    }

    switch (toolName) {
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'NotebookEdit':
        return withPreview(preview(input?.file_path));
      case 'Bash':
      case 'exec_command':
        return withPreview(preview(input?.description) ?? preview(input?.command));
      case 'Grep':
      case 'Glob':
        return withPreview(preview(input?.pattern));
      case 'ToolSearch':
      case 'WebSearch':
      case 'web_search':
        return withPreview(preview(input?.query));
      case 'WebFetch':
        return withPreview(preview(input?.url));
      case 'Agent':
        return withPreview(preview(input?.description));
      case 'Skill':
      case 'SlashCommand':
        return withPreview(preview(input?.skill) ?? preview(input?.name));
      case 'Task':
        return withPreview(preview(str(input?.prompt)?.split('\n')[0], 100));
      case 'edit_files': {
        const changes = input?.changes;
        if (Array.isArray(changes) && changes.length > 0) {
          if (changes.length === 1) {
            const change = changes[0] as Record<string, unknown>;
            const kind = str(change.kind) ?? 'update';
            const path = str(change.path) ?? '';
            return withPreview(this.truncateSlackInline(`${kind} ${path}`.trim(), 70));
          }
          return withPreview(`${changes.length} files`);
        }
        break;
      }
    }

    return `\`${toolName}\``;
  }

  private buildSlackAssistantStatus(
    data: GatewayProgressData,
    existingMetadata: Record<string, unknown>
  ): string {
    if (data.state === 'done') return '';
    if (data.state === 'failed') return 'ran into an error.';
    if (data.state === 'queued') {
      const position =
        typeof data.queue_position === 'number' ? ` at position ${data.queue_position}` : '';
      return `is queued${position}.`;
    }

    const latestToolName =
      data.tool_name ??
      (typeof existingMetadata.slack_status_tool_name === 'string'
        ? existingMetadata.slack_status_tool_name
        : undefined);
    return latestToolName
      ? `is using ${this.truncateSlackInline(latestToolName, 40)}.`
      : 'is working on your request.';
  }

  private buildSlackAssistantLoadingMessage(
    data: GatewayProgressData,
    existingMetadata: Record<string, unknown>
  ): string | undefined {
    if (data.state === 'done') return undefined;
    if (data.state === 'failed') return this.formatSlackLoadingMessage('Agor ran into an error.');
    if (data.state === 'queued') return this.formatSlackLoadingMessage('Queued in Agor…');

    const latestToolSummary =
      data.tool_name || data.tool_input
        ? this.formatSlackToolSummary(data.tool_name, data.tool_input)
        : typeof existingMetadata.slack_status_tool_summary === 'string'
          ? existingMetadata.slack_status_tool_summary
          : undefined;

    if (latestToolSummary) {
      return this.formatSlackLoadingMessage(`Using ${latestToolSummary.replace(/`/g, '')}…`);
    }

    const latestToolName =
      data.tool_name ??
      (typeof existingMetadata.slack_status_tool_name === 'string'
        ? existingMetadata.slack_status_tool_name
        : undefined);

    if (latestToolName) {
      return this.formatSlackLoadingMessage(`Using ${latestToolName}…`);
    }

    return this.formatSlackLoadingMessage('Working in Agor…');
  }

  private stripSlackProgressMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    const {
      slack_status_message_ts: _statusTs,
      slack_status_started_at: _startedAt,
      slack_status_tool_name: _toolName,
      slack_status_tool_summary: _toolSummary,
      slack_status_todos: _todos,
      slack_status_state: _state,
      slack_status_task_id: _taskId,
      ...rest
    } = metadata;
    return rest;
  }

  private stripSlackProgressMessageMetadata(
    metadata: Record<string, unknown>
  ): Record<string, unknown> {
    const { slack_status_message_ts: _statusTs, ...rest } = metadata;
    return rest;
  }

  private async refreshSlackAssistantStatusAfterStreamStart(
    threadId: string,
    connector: GatewayConnector,
    sessionId: string,
    taskId: string | undefined,
    metadata: Record<string, unknown>
  ): Promise<void> {
    if (!connector.setThreadStatus) return;
    if (!this.slackThreadSupportsAssistantStatus(threadId)) return;
    const progress: GatewayProgressData = {
      session_id: sessionId,
      state: 'working',
      ...(taskId ? { task_id: taskId } : {}),
    };
    const loadingMessage =
      this.buildSlackAssistantLoadingMessage(progress, metadata) ??
      this.formatSlackLoadingMessage('Writing response…');
    await connector.setThreadStatus({
      threadId,
      status: this.buildSlackAssistantStatus(progress, metadata),
      loadingMessages: [loadingMessage],
      iconEmoji: ':hourglass_flowing_sand:',
    });
    if (taskId) {
      this.slackStreamStatusRefreshLast.set(taskId, Date.now());
    }
  }

  private async refreshSlackAssistantStatusAfterStreamAppend(
    threadId: string,
    connector: GatewayConnector,
    sessionId: string,
    taskId: string | undefined,
    metadata: Record<string, unknown>
  ): Promise<void> {
    if (!taskId) return;
    const now = Date.now();
    const lastRefresh = this.slackStreamStatusRefreshLast.get(taskId) ?? 0;
    if (now - lastRefresh < GatewayService.SLACK_STREAM_STATUS_REFRESH_MS) return;
    this.slackStreamStatusRefreshLast.set(taskId, now);
    await this.refreshSlackAssistantStatusAfterStreamStart(
      threadId,
      connector,
      sessionId,
      taskId,
      metadata
    );
  }

  /**
   * Update Slack's native assistant status/stream chrome for a gateway thread.
   *
   * We expose a short, Slack-safe tool summary and TodoWrite plan state, never
   * raw JSON args/results. Raw tool inputs are already persisted in Agor's
   * transcript; Slack receives only a compact truncated preview.
   */
  async updateProgress(data: GatewayProgressData): Promise<void> {
    const previous = this.slackProgressQueues.get(data.session_id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.updateProgressNow(data));
    this.slackProgressQueues.set(data.session_id, next);

    try {
      await next;
    } finally {
      if (this.slackProgressQueues.get(data.session_id) === next) {
        this.slackProgressQueues.delete(data.session_id);
      }
    }
  }

  /**
   * Schedule Slack assistant progress/status updates after the current
   * tenant-scoped database work commits, then update inside a fresh tenant
   * scope. Presence/status updates are often emitted from hooks and streaming
   * routes whose enclosing transaction is about to close.
   */
  updateProgressAfterCommit(data: GatewayProgressData, params?: unknown): void {
    deferWithTenantContext(
      params,
      async () => {
        await this.updateProgress(data);
      },
      () => {
        console.warn('[gateway] Failed to update Slack progress after commit');
      }
    );
  }

  wasMessageStreamedToSlack(messageId: string): boolean {
    return this.slackStreamedMessageIds.has(messageId);
  }

  wasTaskStreamedToSlack(taskId?: string): boolean {
    return !!taskId && this.slackStreamedTaskIds.has(taskId);
  }

  private markMessageStreamedToSlack(messageId: string): void {
    this.slackStreamedMessageIds.add(messageId);
    if (this.slackStreamedMessageIds.size > GatewayService.SLACK_STREAMED_MESSAGE_CACHE_MAX) {
      const oldest = this.slackStreamedMessageIds.values().next().value;
      if (oldest) this.slackStreamedMessageIds.delete(oldest);
    }
  }

  private markTaskStreamedToSlack(taskId?: string): void {
    if (!taskId) return;
    this.slackStreamedTaskIds.add(taskId);
    if (this.slackStreamedTaskIds.size > GatewayService.SLACK_STREAMED_MESSAGE_CACHE_MAX) {
      const oldest = this.slackStreamedTaskIds.values().next().value;
      if (oldest) this.slackStreamedTaskIds.delete(oldest);
    }
  }

  private async stopSlackTaskStream(
    taskId: string | undefined,
    connector: GatewayConnector
  ): Promise<void> {
    if (!taskId) return;
    const stream = this.slackStreamsByTask.get(taskId);
    if (!stream) return;
    if (!stream.hasContent && connector.deleteMessage) {
      await connector.deleteMessage({
        threadId: stream.threadId,
        messageId: stream.ts,
      });
      this.slackStreamsByTask.delete(taskId);
      this.slackStreamStatusRefreshLast.delete(taskId);
      return;
    }

    const streamConnector = connector as GatewayConnector & {
      stopStream?: (req: { threadId: string; ts: string; text?: string }) => Promise<void>;
    };
    if (!streamConnector.stopStream) return;
    await streamConnector.stopStream({
      threadId: stream.threadId,
      ts: stream.ts,
    });
    this.slackStreamsByTask.delete(taskId);
    this.slackStreamStatusRefreshLast.delete(taskId);
  }

  private async updateProgressNow(data: GatewayProgressData): Promise<void> {
    if (!(await this.shouldQueryGatewayRouting())) return;

    const mapping = await this.threadMapRepo.findBySession(data.session_id);
    if (!mapping) return;

    const channel = await this.channelRepo.findById(mapping.channel_id);
    if (!channel?.enabled || channel.channel_type !== 'slack') return;

    const now = Date.now();
    const isTerminal = data.state === 'done' || data.state === 'failed';
    const metadata = ((mapping.metadata as Record<string, unknown>) ?? {}) as Record<
      string,
      unknown
    >;
    const isNewTask =
      typeof data.task_id === 'string' && data.task_id !== metadata.slack_status_task_id;
    const isRestartingAfterTerminal =
      (data.state === 'queued' || data.state === 'working') &&
      (metadata.slack_status_state === 'done' || metadata.slack_status_state === 'failed');
    const lastUpdate = this.slackProgressLastUpdate.get(data.session_id) ?? 0;
    if (
      !isTerminal &&
      !data.tool_name &&
      !isNewTask &&
      !isRestartingAfterTerminal &&
      now - lastUpdate < GatewayService.SLACK_PROGRESS_MIN_UPDATE_MS
    ) {
      return;
    }
    this.slackProgressLastUpdate.set(data.session_id, now);

    const statusStartedAt =
      isNewTask || isRestartingAfterTerminal
        ? new Date(now).toISOString()
        : typeof metadata.slack_status_started_at === 'string'
          ? metadata.slack_status_started_at
          : new Date(now).toISOString();
    // Keep TodoWrite parsing for compact status text. Slack task_update/plan
    // rendering is intentionally deferred until a follow-up PR verifies it.
    const toolTodos =
      data.tool_name === 'TodoWrite' ? this.parseGatewayTodos(data.tool_input?.todos) : [];
    const toolSummary =
      data.tool_name || data.tool_input
        ? this.formatSlackToolSummary(data.tool_name, data.tool_input)
        : undefined;
    const baseMetadata =
      isNewTask || isRestartingAfterTerminal ? this.stripSlackProgressMetadata(metadata) : metadata;
    const metadataWithStart = {
      ...baseMetadata,
      slack_status_started_at: statusStartedAt,
      slack_status_state: data.state,
      ...(data.task_id ? { slack_status_task_id: data.task_id } : {}),
      ...(data.tool_name ? { slack_status_tool_name: data.tool_name } : {}),
      ...(toolSummary ? { slack_status_tool_summary: toolSummary } : {}),
      ...(toolTodos.length > 0 ? { slack_status_todos: toolTodos } : {}),
    };

    const connector =
      this.getActiveListener(channel.id) ??
      getConnector(channel.channel_type as ChannelType, channel.config);
    const activeTaskId =
      typeof metadata.slack_status_task_id === 'string' ? metadata.slack_status_task_id : undefined;

    try {
      if (isTerminal) {
        try {
          await this.stopSlackTaskStream(activeTaskId, connector);
        } catch (_error) {
          console.warn('[gateway] Failed to stop Slack task stream');
        }
      }

      const freshMapping = await this.threadMapRepo.findById(mapping.id);
      const freshMetadata = ((freshMapping?.metadata as Record<string, unknown>) ?? {}) as Record<
        string,
        unknown
      >;
      const metadataForWrite = {
        ...(isTerminal
          ? this.stripSlackProgressMetadata(metadataWithStart)
          : this.stripSlackProgressMessageMetadata(metadataWithStart)),
        ...this.pickSlackRoutingMetadata(freshMetadata),
      };
      const slackThreadId =
        typeof metadataForWrite.slack_active_thread_id === 'string'
          ? metadataForWrite.slack_active_thread_id
          : mapping.thread_id;

      await this.threadMapRepo.updateMetadata(mapping.id, metadataForWrite);

      if (!connector.setThreadStatus) return;
      // `assistant.threads.setStatus` belongs to the app's DM surface. This
      // fired on EVERY progress tick of every channel conversation, where
      // Slack was never going to accept it — and each refusal was then
      // entitled to the WebClient's own retry ladder before landing in a bare
      // `catch`. The work was invisible and the refusal was silent.
      if (!this.slackThreadSupportsAssistantStatus(slackThreadId)) return;

      try {
        const loadingMessage = this.buildSlackAssistantLoadingMessage(data, metadataWithStart);
        await connector.setThreadStatus({
          threadId: slackThreadId,
          status: this.buildSlackAssistantStatus(data, metadataWithStart),
          loadingMessages: loadingMessage ? [loadingMessage] : undefined,
          iconEmoji: ':hourglass_flowing_sand:',
        });
      } catch (error) {
        this.warnSlackAssistantStatusFailed(slackThreadId, error);
      }
    } catch (_error) {
      console.warn('[gateway] Failed to update Slack progress status');
    }
  }

  async handleMessageStreamingEvent(
    event: 'streaming:start' | 'streaming:chunk' | 'streaming:end' | 'streaming:error',
    data: Record<string, unknown>
  ): Promise<void> {
    if (!(await this.shouldQueryGatewayRouting())) return;

    const sessionId = typeof data.session_id === 'string' ? data.session_id : undefined;
    const messageId = typeof data.message_id === 'string' ? data.message_id : undefined;
    const taskId = typeof data.task_id === 'string' ? data.task_id : undefined;
    if (!sessionId || !messageId) return;

    if (event === 'streaming:start') {
      if (taskId) {
        this.slackStreamTaskByMessage.set(messageId, taskId);
      }
      return;
    }

    const taskKey = taskId ?? this.slackStreamTaskByMessage.get(messageId) ?? messageId;

    const mapping = await this.threadMapRepo.findBySession(sessionId);
    if (!mapping) return;

    const channel = await this.channelRepo.findById(mapping.channel_id);
    if (!channel?.enabled || channel.channel_type !== 'slack') return;

    const connector =
      this.getActiveListener(channel.id) ??
      getConnector(channel.channel_type as ChannelType, channel.config);

    const streamConnector = connector as GatewayConnector & {
      startStream?: (req: {
        threadId: string;
        text?: string;
        recipientUserId?: string;
        recipientTeamId?: string;
      }) => Promise<string>;
      appendStream?: (req: { threadId: string; ts: string; text: string }) => Promise<void>;
      stopStream?: (req: { threadId: string; ts: string; text?: string }) => Promise<void>;
    };

    if (!streamConnector.startStream || !streamConnector.appendStream) {
      return;
    }

    try {
      const metadata = ((mapping.metadata as Record<string, unknown>) ?? {}) as Record<
        string,
        unknown
      >;
      const slackThreadId = this.getActiveSlackThreadId(mapping);
      if (this.isSlackChannelLikeThreadId(slackThreadId)) {
        // Do not stream assistant text into Slack channel-like surfaces. The
        // final assistant message will still be routed through routeMessage(),
        // whose Slack chat.postMessage path explicitly sets thread_ts.
        return;
      }
      const recipientUserId =
        typeof metadata.slack_user_id === 'string' ? metadata.slack_user_id : undefined;
      const recipientTeamId =
        typeof metadata.slack_team_id === 'string' ? metadata.slack_team_id : undefined;

      if (event === 'streaming:chunk') {
        const chunk = typeof data.chunk === 'string' ? data.chunk : '';
        if (!chunk) return;
        if (isSlackThinkingPlaceholder(chunk)) {
          return;
        }

        const existing = this.slackStreamsByTask.get(taskKey);
        if (!existing) {
          const ts = await streamConnector.startStream({
            threadId: slackThreadId,
            text: chunk,
            recipientUserId,
            recipientTeamId,
          });
          this.slackStreamsByTask.set(taskKey, {
            threadId: slackThreadId,
            ts,
            hasContent: true,
            taskId: taskKey,
            lastMessageId: messageId,
          });
          await this.addSlackThreadAlias(mapping, ts, 'stream');
          try {
            await this.refreshSlackAssistantStatusAfterStreamStart(
              slackThreadId,
              connector,
              sessionId,
              taskKey,
              metadata
            );
          } catch (error) {
            this.warnSlackAssistantStatusFailed(slackThreadId, error);
          }
          this.markMessageStreamedToSlack(messageId);
          this.markTaskStreamedToSlack(taskKey);
          return;
        }

        const text =
          existing.hasContent && existing.lastMessageId && existing.lastMessageId !== messageId
            ? `\n\n${chunk}`
            : chunk;
        await streamConnector.appendStream({
          threadId: existing.threadId,
          ts: existing.ts,
          text,
        });
        try {
          await this.refreshSlackAssistantStatusAfterStreamAppend(
            existing.threadId,
            connector,
            sessionId,
            taskKey,
            metadata
          );
        } catch (error) {
          this.warnSlackAssistantStatusFailed(existing.threadId, error);
        }
        existing.hasContent = true;
        existing.lastMessageId = messageId;
        this.markMessageStreamedToSlack(messageId);
        this.markTaskStreamedToSlack(taskKey);
        return;
      }

      if (event === 'streaming:end') {
        const existing = this.slackStreamsByTask.get(taskKey);
        if (existing?.hasContent) {
          this.markMessageStreamedToSlack(messageId);
          this.markTaskStreamedToSlack(taskKey);
        }
        this.slackStreamTaskByMessage.delete(messageId);
        return;
      }

      if (event === 'streaming:error') {
        this.slackStreamTaskByMessage.delete(messageId);
      }
    } catch (_error) {
      this.slackStreamsByTask.delete(taskKey);
      this.slackStreamTaskByMessage.delete(messageId);
      console.warn('[gateway] Failed to mirror message stream to Slack');
    }
  }

  /**
   * Session-context emits are hard-bound to the session's branch, with no
   * admin-role bypass — agent sessions run as admin users, so a role bypass
   * would let any session impersonate another assistant's channel. The error
   * deliberately never echoes the channel's target branch, so a denied emit
   * cannot be used to enumerate which branch a foreign channel serves.
   */
  private async ensureSessionBranchBoundToChannel(
    channel: GatewayChannel,
    sessionId: SessionID
  ): Promise<void> {
    const session = await this.sessionRepo.findById(sessionId);
    if (!session) {
      throw new Error('Gateway outbound denied: emitting session not found');
    }
    if (session.branch_id !== channel.target_branch_id) {
      throw new Error(
        `Gateway outbound denied: session ${shortId(sessionId)} runs on branch ${shortId(session.branch_id)}, but this channel targets a different branch. Sessions can emit only through gateway channels whose target branch matches their own. Call agor_gateway_outbound_targets_list to see usable channels.`
      );
    }
  }

  private async ensureCanEmitFromChannel(
    channel: GatewayChannel,
    userId: UserID,
    userRole?: string
  ): Promise<void> {
    if (hasMinimumRole(userRole, ROLES.ADMIN)) return;

    const branch = await this.branchRepo.findById(channel.target_branch_id);
    if (!branch) {
      throw new Error(`Branch not found for gateway channel ${shortId(channel.id)}`);
    }

    const isOwner = await this.branchRepo.isOwner(branch.branch_id, userId);
    const effectivePermission = await this.branchRepo.resolveUserPermission(branch, userId);
    const canEmit = hasBranchPermission(
      branch,
      userId,
      isOwner,
      'all' as BranchPermissionLevel,
      userRole,
      true,
      effectivePermission
    );

    if (!canEmit) {
      throw new Error(
        'Insufficient branch permission: gateway outbound emits require branch all permission or admin access'
      );
    }
  }

  /**
   * Gateway calls the Session and Prompt services internally, so their
   * provider-only RBAC hooks do not run. Keep inbound admission on the same
   * normalized branch policy as browser, REST, MCP, and scheduler callers.
   */
  private async requireInboundSessionCreateAccess(
    channel: GatewayChannel,
    userId: UserID
  ): Promise<void> {
    const branch = await this.branchRepo.findById(channel.target_branch_id);
    if (!branch) {
      throw new Forbidden('Gateway inbound denied: target branch is unavailable');
    }
    const access = await this.branchRepo.resolveUserAccess(branch, userId);
    if (!['session', 'prompt', 'all'].includes(access.can)) {
      throw new Forbidden(
        'Gateway inbound denied: Collaborator access is required to create a session'
      );
    }
  }

  /**
   * Resolve the target Session again immediately before prompt admission.
   * This both binds a durable thread mapping to its configured branch and
   * applies the Session's immutable sharing boundary: branch Sessions require
   * Collaborator access and both sharing switches, while execution-home
   * Sessions are never shareable.
   */
  private async requireInboundPromptAuthority(
    channel: GatewayChannel,
    sessionId: SessionID,
    userId: UserID
  ): Promise<Session> {
    const session = await this.sessionRepo.findById(sessionId);
    if (!session || session.branch_id !== channel.target_branch_id) {
      throw new GatewayPromptAuthorizationError(
        "This gateway thread's Agor session is no longer available."
      );
    }
    const authority = await this.branchRepo.resolveSessionPromptAuthority(
      channel.target_branch_id,
      userId,
      session.created_by as UserID,
      session.sdk_home_scope
    );
    if (!authority.allowed) {
      throw new GatewayPromptAuthorizationError(sessionPromptDeniedMessage(authority));
    }
    return session;
  }

  async emitMessage(data: EmitGatewayMessageData): Promise<EmitGatewayMessageResult> {
    const channel = await this.channelRepo.findById(data.gatewayChannelId);
    if (!channel) throw new Error('Gateway channel not found');
    if (!channel.enabled) throw new Error('Gateway channel is disabled');
    if (channel.channel_type !== 'slack' && channel.channel_type !== 'discord') {
      throw new Error('Gateway outbound beta supports Slack and Discord channels');
    }

    const config = channel.config as Record<string, unknown>;
    if (config.outbound_enabled !== true) {
      throw new Error('Gateway outbound is disabled for this channel');
    }

    if (data.emittedBySessionId) {
      await this.ensureSessionBranchBoundToChannel(channel, data.emittedBySessionId);
    }
    await this.ensureCanEmitFromChannel(channel, data.emittedByUserId, data.userRole);

    const target =
      data.target ??
      (typeof config.default_outbound_target === 'string'
        ? config.default_outbound_target
        : undefined);
    if (!target) throw new Error('No usable default outbound target configured');
    if (channel.channel_type === 'discord' && data.threadTs) {
      throw new Error('Discord proactive outbound requires a fresh channel:<snowflake> seed');
    }

    const connector = getConnector(channel.channel_type as ChannelType, channel.config);
    if (typeof connector.sendDirectMessage !== 'function') {
      throw new Error(`${channel.channel_type} connector does not support direct outbound sends`);
    }

    const { text, blocks } = normalizeOutbound(
      connector.formatMessage ? connector.formatMessage(data.message) : data.message
    );

    let sent: ReturnType<typeof normalizeSendReceipt>;
    try {
      sent = normalizeSendReceipt(
        await connector.sendDirectMessage({
          target,
          text,
          blocks,
          ...(data.threadTs ? { threadId: data.threadTs } : {}),
          metadata: {
            ...(data.purpose ? { purpose: data.purpose } : {}),
            target,
          },
        })
      );
    } catch (error) {
      const failure = gatewayFailureCode(error);
      throw new Error(
        `${channel.channel_type === 'slack' ? 'Slack' : 'Discord'} API failure: ${failure}`
      );
    }

    const resolvedChannelId = sent.metadata?.resolved_channel_id;
    const platformChannelId =
      sent.platformChannelId ??
      (typeof resolvedChannelId === 'string' ? resolvedChannelId : undefined);
    const platformThreadId = sent.platformThreadId ?? sent.threadId;
    if (!platformChannelId || !platformThreadId) {
      throw new Error(`${channel.channel_type} connector returned an incomplete outbound receipt`);
    }

    const row = await this.outboundRepo.create({
      gateway_channel_id: channel.id,
      channel_type: channel.channel_type,
      platform_channel_id: platformChannelId,
      platform_message_id: sent.messageId,
      platform_thread_id: platformThreadId,
      platform_permalink: sent.permalink ?? null,
      target_branch_id: channel.target_branch_id,
      emitted_by_user_id: data.emittedByUserId,
      emitted_by_session_id: data.emittedBySessionId ?? null,
      emitted_by_task_id:
        (data.emittedByTaskId as GatewayOutboundMessage['emitted_by_task_id']) ?? null,
      emitted_by_schedule_id:
        (data.emittedByScheduleId as GatewayOutboundMessage['emitted_by_schedule_id']) ?? null,
      message_text: data.message,
      message_preview: previewText(data.message),
      metadata: {
        target,
        ...(data.purpose ? { purpose: data.purpose } : {}),
        ...(sent.metadata ? { provider_target: sent.metadata } : {}),
        ...(sent.replyAliases?.length ? { provider_reply_aliases: sent.replyAliases } : {}),
      },
    });

    await this.channelRepo.updateLastMessage(channel.id);
    console.log(
      `[gateway] Proactive ${channel.channel_type} outbound ${shortId(row.id)} sent via ${shortId(channel.id)}`
    );

    return {
      success: true,
      gateway_outbound_message_id: row.id,
      gateway_channel_id: channel.id,
      channel_type: channel.channel_type,
      platform_channel_id: platformChannelId,
      platform_message_id: sent.messageId,
      platform_thread_id: platformThreadId,
      ...(sent.permalink ? { platform_permalink: sent.permalink } : {}),
    };
  }

  /**
   * A session link for a platform user, or nothing.
   *
   * Both branches now ask the one `isBrowserReachableUrl` predicate rather
   * than the `0.0.0.0` half-check they each carried. This is the third caller
   * of it, and the reason it exists: the check here and the one in
   * `gatewaySessionConnectUrl` were copies, and the Slack connect card had
   * neither, so `http://localhost:3030` — what a deployment that never
   * configured a public URL falls back to — passed every one of them and got
   * pasted into a conversation.
   */
  private async fetchExistingSessionUrlForGatewayUser(
    sessionId: SessionID,
    user?: User
  ): Promise<string | null> {
    try {
      const baseUrl = await getBaseUrl(this.db);
      if (!baseUrl) return null;
      const sessionUrl = getSessionUrl(sessionId, baseUrl);
      return isBrowserReachableUrl(sessionUrl) ? sessionUrl : null;
    } catch (error) {
      console.warn(
        `[gateway] event=gateway_session_link_unresolved tenant_id=${
          getCurrentTenantId() ?? '<unknown>'
        } session_id=${sessionId} reason=${classifyGatewayReadFailure(error)}`
      );
    }

    if (!user) return null;

    try {
      const sessionsService = this.app.service('sessions') as {
        get: (id: string, params?: { user: User }) => Promise<Session & { url?: string | null }>;
      };
      const sessionWithUrl = await sessionsService.get(sessionId, { user });
      const sessionUrl = sessionWithUrl.url || null;
      return isBrowserReachableUrl(sessionUrl) ? sessionUrl : null;
    } catch (error) {
      console.warn(
        `[gateway] event=gateway_session_link_unresolved tenant_id=${
          getCurrentTenantId() ?? '<unknown>'
        } session_id=${sessionId} reason=${classifyGatewayReadFailure(error)}`
      );
      return null;
    }
  }

  private async formatTerminalGatewayReply(text: string, sessionId: SessionID): Promise<string> {
    const sessionUrl = await this.fetchExistingSessionUrlForGatewayUser(sessionId);
    const sessionReference = sessionUrl
      ? `[View session](${sessionUrl})`
      : `Session: \`${shortId(sessionId)}\``;
    return `${text}\n\n${sessionReference}`;
  }

  /**
   * Inbound routing: platform → session
   *
   * Authenticates via channel_key, looks up or creates a session
   * for the given thread, and sends the prompt to the session.
   */
  async create(data: PostMessageData): Promise<PostMessageResult> {
    const durableListenerOwnership = await this.detectDurableListenerOwnership();
    // 1. Authenticate via channel_key
    const channel = await this.channelRepo.findByKey(data.channel_key);
    if (!channel) {
      throw new Error('Invalid channel_key');
    }

    if (!channel.enabled) {
      throw new Error('Channel is disabled');
    }
    if (durableListenerOwnership && !data.gateway_inbound_event_id) {
      throw new Error(
        'Direct gateway inbound delivery is unsupported on PostgreSQL without a provider event identity'
      );
    }
    if (
      data.listener_claim_token &&
      (data.listener_channel_id !== channel.id ||
        !(await this.channelRepo.listenerClaimIsCurrent(channel.id, data.listener_claim_token)))
    ) {
      throw new Error('Gateway listener ownership lost before inbound routing');
    }

    // Connector metadata is untrusted at this service boundary. Reloaded
    // Discord configuration and the canonical provider identifiers must agree
    // before any mapping, seed, session, or prompt lookup can occur.
    if (!discordInboundMetadataIsAuthoritative(channel, data)) {
      console.debug('[gateway] IGNORED: Discord inbound metadata failed authorization checks');
      return { success: false, sessionId: '', created: false };
    }
    const discordMetadata =
      channel.channel_type === 'discord' ? parseDiscordAuthorityMetadata(data.metadata) : null;

    // 2. Look up existing thread mapping. New Discord admissions use the raw
    // provider thread Snowflake; a legacy composite is consulted only to
    // adopt mappings written before DG-02.
    const canonicalThreadId =
      channel.channel_type === 'discord' ? discordCanonicalThreadId(data) : data.thread_id;
    const legacyDiscordThread =
      channel.channel_type === 'discord' ? discordLegacyThreadId(data) : undefined;
    let existingMapping = await this.threadMapRepo.findByChannelAndThread(
      channel.id,
      canonicalThreadId
    );
    if (!existingMapping && legacyDiscordThread && legacyDiscordThread !== canonicalThreadId) {
      existingMapping = await this.threadMapRepo.findByChannelAndThread(
        channel.id,
        legacyDiscordThread
      );
    }
    if (
      !existingMapping &&
      (channel.channel_type === 'slack' || channel.channel_type === 'discord')
    ) {
      existingMapping = await this.findGatewayReplyAliasMapping(channel.id, canonicalThreadId);
      if (!existingMapping && legacyDiscordThread && legacyDiscordThread !== canonicalThreadId) {
        existingMapping = await this.findGatewayReplyAliasMapping(channel.id, legacyDiscordThread);
      }
      if (existingMapping) {
        console.log(
          `[gateway] Found ${channel.channel_type} reply alias: ${data.thread_id} → ${existingMapping.thread_id}`
        );
      }
    }
    if (existingMapping && channel.channel_type === 'slack') {
      console.log(
        `[gateway] Slack inbound thread ${data.thread_id} → session ${shortId(existingMapping.session_id)} (root ${existingMapping.thread_id})`
      );
    }
    let recoveringInitialDelivery = false;
    let outboundSeed: GatewayOutboundMessage | null = null;
    let outboundAdmission: GatewayOutboundReplyAdmission | null = null;

    // A process can die after the stable Task is admitted but before the
    // provider occurrence is completed. Reconcile that durable fact before
    // rebuilding a prompt: the first delivery may have created the mapping and
    // therefore formatted an "initial" prompt, while a retry observes an
    // existing mapping and would otherwise produce a different prompt string.
    if (
      durableListenerOwnership &&
      data.gateway_inbound_event_id &&
      data.idempotency_task_id &&
      existingMapping
    ) {
      const priorTask = await this.taskRepo.findById(data.idempotency_task_id);
      if (priorTask) {
        const priorSession = await this.sessionRepo.findById(existingMapping.session_id);
        const gatewaySource = priorSession?.custom_context?.gateway_source as
          | Record<string, unknown>
          | undefined;
        if (
          priorTask.session_id !== existingMapping.session_id ||
          priorTask.metadata?.gateway_inbound_event_id !== data.gateway_inbound_event_id ||
          !priorSession ||
          priorSession.branch_id !== channel.target_branch_id ||
          gatewaySource?.channel_id !== channel.id
        ) {
          throw new Error('Gateway provider event Task identity is already in use');
        }
        const mappingMetadata = (existingMapping.metadata as Record<string, unknown> | null) ?? {};
        const ordinaryDiscordCatchUp =
          channel.channel_type === 'discord' &&
          typeof mappingMetadata.outbound_seed_id !== 'string';
        const liveDiscordCursor = ordinaryDiscordCatchUp
          ? discordInboundCursor(data.metadata)
          : undefined;
        if (liveDiscordCursor) {
          // The stable Task is the admission fence. A retry after a process
          // crash repairs only the cursor; it never fetches history or creates
          // another prompt.
          await this.threadMapRepo.advanceDiscordLastAdmittedMessageId(
            existingMapping.id,
            liveDiscordCursor
          );
        }
        await this.markSeedInitialPromptAdmitted(
          existingMapping,
          data.gateway_inbound_event_id,
          priorTask.task_id as TaskID
        );
        return {
          success: true,
          sessionId: existingMapping.session_id,
          created: false,
          taskId: priorTask.task_id,
        };
      }
      recoveringInitialDelivery = existingMapping.session_id === data.idempotency_session_id;
    }

    // 3. Cross-channel ownership check.
    // Slack and Discord support multiple distinct bots in the same human thread;
    // their channel-scoped mappings are independent. Other providers retain
    // global platform-thread ownership.
    if (
      !existingMapping &&
      channel.channel_type !== 'slack' &&
      channel.channel_type !== 'discord'
    ) {
      const exactThreadMapping = await this.threadMapRepo.findByThread(data.thread_id);
      const otherChannelMapping =
        exactThreadMapping && exactThreadMapping.channel_id !== channel.id
          ? exactThreadMapping
          : null;
      if (otherChannelMapping) {
        console.log(
          `[gateway] IGNORED: Thread ${data.thread_id} owned by channel ${shortId(otherChannelMapping.channel_id)}, not ours (${shortId(channel.id)}). Silently dropping.`
        );
        return {
          success: false,
          sessionId: '',
          created: false,
        };
      }
    }

    // Defense in depth: the Slack connector is supposed to enforce this before
    // calling the gateway, but keep the gateway invariant explicit too. In
    // Slack channel-like surfaces, every prompt must be an explicit bot mention.
    if (channel.channel_type === 'slack') {
      const slackConversationType =
        typeof data.metadata?.channel_type === 'string' ? data.metadata.channel_type : undefined;
      const isSlackDm = slackConversationType === 'im';
      const hasExplicitMention = data.metadata?.slack_has_mention === true;
      if (!isSlackDm && !hasExplicitMention) {
        console.debug(
          `[gateway] IGNORED: Slack channel-like message without explicit mention: channel=${shortId(channel.id)}, thread=${data.thread_id}`
        );
        return {
          success: false,
          sessionId: '',
          created: false,
        };
      }
    }

    if (
      channel.channel_type === 'discord' &&
      discordMetadata?.[DISCORD_METADATA_KEY.hasMention] !== true
    ) {
      console.debug(
        `[gateway] IGNORED: Discord message without explicit mention: channel=${shortId(channel.id)}, thread=${data.thread_id}`
      );
      return { success: false, sessionId: '', created: false };
    }

    // 4. Reject unmapped thread replies that came through without mention.
    // Slack channel-like conversations now require explicit mentions for every
    // prompt. This legacy verification flag is kept for webhook-style connectors
    // that may still allow mapped thread replies without a new mention.
    // IMPORTANT: Silently drop — do NOT send a debug message. These are normal messages
    // in threads that have nothing to do with Agor. Sending a visible rejection would
    // cause the bot to spam every active thread in the channel.
    if (!existingMapping && !outboundSeed && data.metadata?.requires_mapping_verification) {
      // Use debug level — this fires for every non-Agor thread reply in monitored
      // channels and would create excessive log noise at info level.
      console.debug(
        `[gateway] IGNORED: Thread reply without mention in unmapped thread: channel=${shortId(channel.id)}, thread=${data.thread_id}`
      );
      return {
        success: false,
        sessionId: '',
        created: false,
      };
    }

    // 5. Resolve effective user (platform user alignment or channel owner fallback)
    //
    // Alignment flags are checked FIRST: when alignment is active, the channel
    // owner ("run as") is NOT used — user is resolved entirely via alignment
    // (or rejected). This prevents privilege escalation where any org member
    // with @mention access would inherit the channel owner's permissions.
    const usersService = this.app.service('users') as {
      get: (id: string) => Promise<User>;
    };
    const channelConfig = channel.config as Record<string, unknown>;
    //
    // Flag names come from GATEWAY_USER_ALIGNMENT_CONFIG_KEYS so that the
    // fail-closed identity guard (`utils/gateway-prompt-identity.ts`) and this
    // fallback read the same declaration. A platform added here without an
    // entry there would be reported as having a real per-user sender when it
    // does not.
    const alignSlackUsers =
      channelConfig[GATEWAY_USER_ALIGNMENT_CONFIG_KEYS.slack] === true ||
      data.metadata?.[GATEWAY_USER_ALIGNMENT_CONFIG_KEYS.slack] === true;
    const alignGitHubUsers =
      channelConfig[GATEWAY_USER_ALIGNMENT_CONFIG_KEYS.github] === true ||
      data.metadata?.[GATEWAY_USER_ALIGNMENT_CONFIG_KEYS.github] === true;
    const alignShortcutUsers =
      channelConfig[GATEWAY_USER_ALIGNMENT_CONFIG_KEYS.shortcut] === true ||
      data.metadata?.[GATEWAY_USER_ALIGNMENT_CONFIG_KEYS.shortcut] === true;
    const alignDiscordUsers =
      channel.channel_type === 'discord' &&
      channelConfig[GATEWAY_USER_ALIGNMENT_CONFIG_KEYS.discord] === true;

    // Only fetch and use channel owner when NO alignment is active.
    // When alignment is ON, agor_user_id may be empty (the "Post messages as"
    // field is hidden in the UI), so we must not fetch it unconditionally.
    let user: User = null as unknown as User;
    if (!alignSlackUsers && !alignGitHubUsers && !alignShortcutUsers && !alignDiscordUsers) {
      if (!channel.agor_user_id) {
        const errMsg =
          'Channel configuration error: no "Post messages as" user set. An admin needs to edit the channel and select a user, or enable user alignment.';
        console.error(
          `[gateway] Channel "${channel.name}" has no agor_user_id and alignment is OFF. Cannot process message.`
        );
        this.sendSystemMessage(channel, data.thread_id, errMsg);
        // For GitHub: edit the Processing comment with the error
        if (channel.channel_type === 'github' && data.metadata?.processing_comment_id) {
          try {
            const connector = getConnector(channel.channel_type as ChannelType, channel.config);
            await connector.sendMessage({
              threadId: data.thread_id,
              text: `⚠️ ${errMsg}`,
              metadata: { edit_comment_id: data.metadata.processing_comment_id },
            });
          } catch (_err) {
            console.warn('[gateway] Failed to post config error comment');
          }
        }
        return {
          success: false,
          sessionId: '',
          created: false,
        };
      }
      user = await usersService.get(channel.agor_user_id);
    }

    // --- Discord user alignment ---
    // Discord does not expose an email to the bot.  The explicit user_map is
    // therefore the only aligned identity source; absence is a rejection, not
    // permission to borrow the channel owner's execution context.
    if (alignDiscordUsers && !alignSlackUsers && !alignGitHubUsers && !alignShortcutUsers) {
      const matchedUser = await this.resolveAlignedUser({
        platform: 'Discord',
        externalId: discordMetadata?.[DISCORD_METADATA_KEY.authorId],
        email: undefined,
        userMap: channelConfig.user_map as Record<string, string> | undefined,
      });
      if (matchedUser) {
        user = await usersService.get(matchedUser.user_id);
      } else {
        console.log('[gateway] Discord user alignment failed: result=agor_user_not_found');
        return { success: false, sessionId: '', created: false };
      }
    }

    // --- Slack user alignment ---
    if (alignSlackUsers) {
      if (data.metadata?.slack_user_email && typeof data.metadata.slack_user_email === 'string') {
        const email = data.metadata.slack_user_email.toLowerCase().trim();
        const matchedUser = await this.usersRepo.findByEmailForAlignment(email);

        if (matchedUser) {
          console.log(
            `[gateway] Slack user alignment succeeded: agor_user=${shortId(matchedUser.user_id)}`
          );
          user = await usersService.get(matchedUser.user_id);
        } else {
          console.log('[gateway] Slack user alignment failed: result=agor_user_not_found');
          this.sendSystemMessage(
            channel,
            data.thread_id,
            `User ${email} doesn't have an Agor account. Ask an admin to create an account with this email, or disable user alignment.`
          );
          return {
            success: false,
            sessionId: '',
            created: false,
          };
        }
      } else {
        // Alignment is enabled but email couldn't be resolved (missing
        // users:read.email scope, Slack API error, or no email on profile).
        // Reject instead of silently falling back to channel owner.
        console.log('[gateway] Slack user alignment failed: result=identity_email_unavailable');
        this.sendSystemMessage(
          channel,
          data.thread_id,
          "Couldn't resolve your Slack identity. The bot may be missing the `users:read.email` scope, or your Slack profile has no email. Ask an admin to check the bot's scopes."
        );
        return {
          success: false,
          sessionId: '',
          created: false,
        };
      }
    }

    // --- GitHub user alignment ---
    // 3-tier resolution: user_map → GitHub email → reject.
    // Never falls back to channel owner — unmapped users are rejected.
    if (alignGitHubUsers && !alignSlackUsers) {
      const githubLogin = data.metadata?.github_user as string | undefined;
      // Read user_map from fresh channel.config (NOT connector metadata, which
      // can be stale since the connector holds config from construction time).
      const matchedUser = await this.resolveAlignedUser({
        platform: 'GitHub',
        externalId: githubLogin,
        email: data.metadata?.github_user_email,
        userMap: channelConfig.user_map as Record<string, string> | undefined,
      });

      if (matchedUser) {
        user = await usersService.get(matchedUser.user_id);
      } else {
        // Reject — no silent fallback to channel owner.
        console.log('[gateway] GitHub user alignment failed: result=agor_user_not_found');
        // Edit the Processing comment with rejection message (if we have one)
        if (data.metadata?.processing_comment_id) {
          try {
            const connector = getConnector(channel.channel_type as ChannelType, channel.config);
            await connector.sendMessage({
              threadId: data.thread_id,
              text: `⚠️ @${githubLogin ?? 'unknown'} — your GitHub account isn't linked to an Agor user. Ask an admin to add a \`user_map\` entry for your GitHub login, or set a public email on your GitHub profile that matches your Agor account.`,
              metadata: { edit_comment_id: data.metadata.processing_comment_id },
            });
          } catch (err) {
            console.warn('[gateway] Failed to post rejection comment:', err);
          }
        }
        return {
          success: false,
          sessionId: '',
          created: false,
        };
      }
    }

    // --- Shortcut user alignment ---
    // 3-tier resolution: user_map → Shortcut member email → reject.
    // Never falls back to channel owner — unmapped users are rejected.
    if (alignShortcutUsers && !alignSlackUsers && !alignGitHubUsers) {
      const shortcutMemberId = data.metadata?.shortcut_user as string | undefined;
      const matchedUser = await this.resolveAlignedUser({
        platform: 'Shortcut',
        externalId: shortcutMemberId,
        email: data.metadata?.shortcut_user_email,
        userMap: channelConfig.user_map as Record<string, string> | undefined,
      });

      if (matchedUser) {
        user = await usersService.get(matchedUser.user_id);
      } else {
        // Reject — no silent fallback to channel owner. Deliver the rejection by
        // editing the "👀 on it" ack (or a fresh comment if the ack is absent).
        console.log('[gateway] Shortcut user alignment failed: result=agor_user_not_found');
        try {
          const connector = getConnector(channel.channel_type as ChannelType, channel.config);
          await connector.sendMessage({
            threadId: data.thread_id,
            text: "⚠️ Your Shortcut account isn't linked to an Agor user. Ask an admin to add a user_map entry for your Shortcut member id, or set your Agor account email to match your Shortcut email.",
            metadata: data.metadata?.processing_comment_id
              ? { edit_comment_id: data.metadata.processing_comment_id }
              : undefined,
          });
        } catch (err) {
          console.warn('[gateway] Failed to post Shortcut rejection comment:', err);
        }
        return {
          success: false,
          sessionId: '',
          created: false,
        };
      }
    }

    let sessionId: SessionID;
    let created = recoveringInitialDelivery;
    let admittedTaskId: TaskID | undefined;
    let mcpAuthWarning: string | undefined;
    let mappingForCursor: ThreadSessionMap | null = existingMapping ?? null;

    // Authorize before resolving configuration or mutating an existing
    // Session. Re-check at the actual Session/Task admission boundaries below
    // so a revoked aligned user cannot keep using a durable platform thread.
    if (existingMapping) {
      try {
        await this.requireInboundPromptAuthority(channel, existingMapping.session_id, user.user_id);
      } catch (error) {
        if (!(error instanceof GatewayPromptAuthorizationError)) throw error;
        await this.sendPromptAuthorizationDenied(channel, data, error.userMessage);
        return { success: false, sessionId: '', created: false };
      }
    } else {
      await this.requireInboundSessionCreateAccess(channel, user.user_id);
    }

    // Resolve agentic config: channel config > user defaults > system defaults.
    // Channel-level agentic_config maps to the helper's `overrides` (it's the
    // gateway's analogue of an MCP tool's explicit args). Codex sub-config is
    // first-class on `GatewayAgenticConfig`, so thread it through the helper —
    // otherwise the executor's per-tool
    // settings (which Codex reads from `permission_config.codex`, not `mode`)
    // get silently dropped.
    const agenticConfig = channel.agentic_config;
    const agenticTool: AgenticToolName = requireActiveAgenticTool(
      agenticConfig?.agent ?? 'claude-code'
    );
    // HTTP-originated requests carry an ambient tenant DB scope; socket-mode
    // listener messages only carry tenant identity (runWithTenantContext).
    // Open a short tenant unit of work from that identity — same pattern as
    // bindRepositoryToTenantUnitOfWork — instead of assuming an ambient scope
    // or falling back to the unscoped base connection.
    const materializedAgenticConfig = await runWithTenantDatabaseScope(
      this.db,
      getCurrentTenantId(),
      (tenantDb) =>
        materializeAgenticToolConfiguration(tenantDb, {
          tool: agenticTool,
          source: agenticConfig
            ? agenticConfig.presetId
              ? { reference: agenticConfig.presetId }
              : { configuration: gatewayAgenticConfigToInlineConfiguration(agenticConfig) }
            : { reference: USER_DEFAULT_AGENTIC_CONFIGURATION },
          executionOwnerId: user.user_id,
          executionOwner: user,
        })
    );
    const { permission_config: gatewayPermissionConfig, model_config: gatewayModelConfig } =
      materializedAgenticConfig;
    const resolvedPresetId = materializedAgenticConfig.agentic_tool_preset_id ?? undefined;
    const gatewayMcpServerIds = resolveSessionMcpServerIds({
      explicit: channel.mcp_server_ids,
      user,
    });
    const permissionMode = gatewayPermissionConfig.mode;

    // Seed admission is the one durable mutation that must happen before
    // creating a session. It also replaces the old lookup-then-late-claim
    // sequence, so competing provider aliases receive one stable ID.
    //
    // Seed admission only decides which Session a thread that has none yet
    // belongs to. A thread that already carries a canonical mapping the seed
    // did not create is not a seed reply: a proactive outbound message can be
    // sent into a thread that is already routed to a Session, and the mapping
    // stays that thread's owner. Skip admission entirely for those threads so
    // no seed is reserved or consumed for a thread it does not own, and the
    // message continues down the ordinary follow-up path below.
    const existingMappingSeedId = (existingMapping?.metadata as Record<string, unknown> | null)
      ?.outbound_seed_id;
    const threadOwnedByUnseededMapping =
      !!existingMapping && typeof existingMappingSeedId !== 'string';
    if (
      (channel.channel_type === 'slack' || channel.channel_type === 'discord') &&
      !threadOwnedByUnseededMapping
    ) {
      outboundAdmission = await this.outboundRepo.admitReplySession(channel.id, data.thread_id);
      if (outboundAdmission) {
        outboundSeed = outboundAdmission.message;
        console.log(
          `[gateway] ${channel.channel_type} inbound thread ${data.thread_id} is replying to outbound seed ${shortId(outboundSeed.id)}`
        );
        if (!existingMapping && !outboundAdmission.admitted) {
          const admittedMapping =
            (await this.threadMapRepo.findByChannelAndThread(
              channel.id,
              outboundSeed.platform_thread_id
            )) ?? (await this.findGatewayReplyAliasMapping(channel.id, data.thread_id));
          if (admittedMapping) {
            existingMapping = admittedMapping;
          } else if (outboundSeed.consumed_at) {
            throw new Error('Gateway outbound seed is consumed without a canonical mapping');
          }
        }

        if (existingMapping) {
          const mappingMetadata =
            (existingMapping.metadata as Record<string, unknown> | null) ?? {};
          if (
            mappingMetadata.outbound_seed_id !== outboundSeed.id ||
            existingMapping.session_id !== outboundAdmission.sessionId
          ) {
            throw new Error('Gateway outbound seed admission does not match canonical mapping');
          }
          // A crash can leave the canonical mapping committed after seed
          // completion but before prompt admission. The mapping's durable
          // pending marker distinguishes that first delivery from later
          // replies to any of the seed's response aliases.
          if (this.isSeedInitialPromptPending(existingMapping, data.gateway_inbound_event_id)) {
            recoveringInitialDelivery = true;
            created = true;
          }
        }
      }
    }

    // Discord's connector uses a referenced message as an alias candidate for
    // top-level replies. If that candidate is neither an existing Agor alias
    // nor a proactive seed, it is just another human message: canonicalize the
    // new conversation to the current inbound message so two mentions replying
    // to the same unrelated human message do not share a session.
    if (
      channel.channel_type === 'discord' &&
      !existingMapping &&
      !outboundAdmission &&
      (() => {
        const discordMetadata = parseDiscordAuthorityMetadata(data.metadata);
        return (
          discordMetadata?.[DISCORD_METADATA_KEY.threadId] === undefined &&
          discordMetadata?.[DISCORD_METADATA_KEY.isThread] === false &&
          typeof discordMetadata?.[DISCORD_METADATA_KEY.channelId] === 'string' &&
          typeof discordMetadata?.[DISCORD_METADATA_KEY.messageId] === 'string'
        );
      })()
    ) {
      const discordMetadata = parseDiscordAuthorityMetadata(data.metadata);
      if (!discordMetadata) throw new Error('Malformed Discord authority metadata');
      data = {
        ...data,
        thread_id: buildDiscordMessageThreadKey(
          discordMetadata[DISCORD_METADATA_KEY.channelId] as string,
          discordMetadata[DISCORD_METADATA_KEY.messageId] as string
        ),
      };
    }

    if (existingMapping) {
      // Existing thread → existing session
      sessionId = existingMapping.session_id;
      if (resolvedPresetId) {
        await this.app.service('sessions').patch(sessionId, {
          agentic_tool_preset_id: resolvedPresetId,
        });
      } else if (agenticConfig) {
        await this.app.service('sessions').patch(sessionId, {
          agentic_tool_preset_id: null,
          model_config: gatewayModelConfig,
          permission_config: gatewayPermissionConfig,
        });
      }

      // Touch timestamps
      await this.threadMapRepo.updateLastMessage(existingMapping.id);

      // Update mapping metadata with fresh platform context. For GitHub, each
      // follow-up @mention creates a new "Processing..." comment and the flush
      // needs the latest comment ID. For Slack streaming, chat.startStream
      // requires the recipient user/team IDs for channel threads.
      const existingMetadata = ((existingMapping.metadata as Record<string, unknown>) ?? {}) as
        | Record<string, unknown>
        | undefined;
      const mergedMetadata = {
        ...existingMetadata,
        ...(data.metadata?.processing_comment_id
          ? { processing_comment_id: data.metadata.processing_comment_id }
          : {}),
        ...(typeof data.metadata?.slack_user_id === 'string'
          ? { slack_user_id: data.metadata.slack_user_id }
          : {}),
        ...(typeof data.metadata?.slack_team_id === 'string'
          ? { slack_team_id: data.metadata.slack_team_id }
          : {}),
        ...(typeof data.metadata?.slack_bot_user_id === 'string'
          ? { slack_bot_user_id: data.metadata.slack_bot_user_id }
          : {}),
        ...(typeof data.metadata?.slack_thread_ts === 'string'
          ? { slack_root_ts: data.metadata.slack_thread_ts }
          : {}),
        ...(typeof data.metadata?.channel === 'string'
          ? { slack_channel_id: data.metadata.channel }
          : {}),
        ...(channel.channel_type === 'slack' ? { slack_active_thread_id: data.thread_id } : {}),
      };
      await this.threadMapRepo.updateMetadata(existingMapping.id, mergedMetadata);
      mappingForCursor = { ...existingMapping, metadata: mergedMetadata };
      if (channel.channel_type === 'slack') {
        console.log(
          `[gateway] Slack active outbound thread for session ${shortId(sessionId)} set to ${data.thread_id}`
        );
      }

      if (outboundSeed) {
        await this.addGatewayReplyAliases(mappingForCursor, [
          outboundSeed.platform_thread_id,
          data.thread_id,
          ...(Array.isArray(outboundSeed.metadata?.provider_reply_aliases)
            ? outboundSeed.metadata.provider_reply_aliases.filter(
                (alias): alias is string => typeof alias === 'string'
              )
            : []),
        ]);
        if (outboundAdmission) {
          await this.outboundRepo.completeReplyAdmission(
            outboundSeed.id as GatewayOutboundMessageID,
            outboundAdmission.sessionId
          );
        }
      }

      const sessionUrl = await this.fetchExistingSessionUrlForGatewayUser(sessionId, user);
      if (sessionUrl && channel.channel_type !== 'slack') {
        this.sendSystemMessage(
          channel,
          data.thread_id,
          formatGatewayFollowUpRoutingMessage(sessionId, sessionUrl)
        );
      }
    } else {
      // New thread → create session via FeathersJS service
      const sessionsService = this.app.service('sessions') as unknown as {
        create: (data: Partial<Session>, params?: SessionParams) => Promise<Session>;
        get: (id: SessionID, params?: Record<string, unknown>) => Promise<Session>;
        setMCPServers: (sessionId: SessionID, serverIds: string[], label: string) => Promise<void>;
      };

      this.sendSystemMessage(
        channel,
        data.thread_id,
        `Creating new ${agenticTool} session (${permissionMode} mode)...`,
        { suppressSlack: true, suppressDiscord: true }
      );

      // Build custom_context with gateway metadata + platform-specific fields
      const gatewaySource: GatewaySource & Record<string, unknown> = {
        channel_id: channel.id,
        channel_name: channel.name,
        channel_type: channel.channel_type,
        thread_id: data.thread_id,
      };

      if (outboundSeed) {
        gatewaySource.outbound_seed_id = outboundSeed.id;
        gatewaySource.outbound_seed_thread_id = outboundSeed.platform_thread_id;
        gatewaySource.proactive_seed = true;
      }

      const mappingThreadId = outboundSeed?.platform_thread_id ?? data.thread_id;
      const providerReplyAliases = outboundSeed?.metadata?.provider_reply_aliases;
      const outboundReplyAliases = outboundSeed
        ? [
            outboundSeed.platform_thread_id,
            data.thread_id,
            ...(Array.isArray(providerReplyAliases)
              ? providerReplyAliases.filter((alias): alias is string => typeof alias === 'string')
              : []),
          ]
        : [];

      // Add Slack-specific metadata for richer context
      if (channel.channel_type === 'slack') {
        if (typeof data.metadata?.slack_team_id === 'string') {
          gatewaySource.slack_team_id = data.metadata.slack_team_id;
        }
        if (typeof data.metadata?.channel === 'string') {
          gatewaySource.slack_channel_id = data.metadata.channel;
        }
        if (typeof data.metadata?.slack_channel_name === 'string') {
          gatewaySource.slack_channel_name = data.metadata.slack_channel_name;
        }
        if (typeof data.metadata?.slack_thread_ts === 'string') {
          gatewaySource.slack_root_ts = data.metadata.slack_thread_ts;
        }
        if (typeof data.metadata?.slack_message_ts === 'string') {
          gatewaySource.slack_trigger_ts = data.metadata.slack_message_ts;
        }
      }

      // Add GitHub-specific metadata for richer context
      if (channel.channel_type === 'github') {
        try {
          const parsed = parseGitHubThreadId(data.thread_id);
          gatewaySource.github_repo = `${parsed.owner}/${parsed.repo}`;
          gatewaySource.github_issue_number = parsed.number;
          gatewaySource.github_thread_id = data.thread_id;
        } catch {
          // Non-fatal — thread ID might not match expected format
        }
        // Flag for downstream consumers: only the last message is posted to GitHub
        gatewaySource.last_message_only = true;
      }

      // Add Shortcut-specific metadata for richer context
      if (channel.channel_type === 'shortcut') {
        if (typeof data.metadata?.shortcut_story_id !== 'undefined') {
          gatewaySource.shortcut_story_id = data.metadata.shortcut_story_id;
        }
        if (typeof data.metadata?.shortcut_story_name === 'string') {
          gatewaySource.shortcut_story_name = data.metadata.shortcut_story_name;
        }
        if (typeof data.metadata?.shortcut_story_url === 'string') {
          gatewaySource.shortcut_story_url = data.metadata.shortcut_story_url;
        }
        gatewaySource.shortcut_thread_id = data.thread_id;
        // Flag for downstream consumers: only the last message is posted to Shortcut
        gatewaySource.last_message_only = true;
      }

      // In delegated mode, refuse to create a gateway session for a user
      // without a unix_username — it would fail at prompt time (or silently
      // share an identity in hosted deployments).
      assertExecutionHomeKeySatisfiesMode(
        user.unix_username,
        resolveExecutionSecurityMode().unixUserMode,
        `gateway user ${user.user_id}`
      );

      const sessionInput: Partial<Session> = {
        ...(outboundAdmission?.sessionId
          ? { session_id: outboundAdmission.sessionId }
          : data.idempotency_session_id
            ? { session_id: data.idempotency_session_id }
            : {}),
        title: data.text.substring(0, 100),
        description: data.text,
        branch_id: channel.target_branch_id,
        created_by: user.user_id,
        // Stamp session with creator's immutable execution-home key.
        // Normally set by the setSessionUnixUsername hook, but that hook skips
        // internal calls (no provider). Gateway sessions are internal, so we
        // must set it explicitly. When user alignment is active, this uses the
        // aligned user's unix_username; otherwise the channel owner's.
        unix_username: user.unix_username ?? null,
        status: SessionStatus.IDLE,
        agentic_tool: agenticTool,
        agentic_tool_preset_id: resolvedPresetId,
        permission_config: gatewayPermissionConfig,
        model_config: gatewayModelConfig,
        tasks: [],
        // Denormalized gateway metadata (immutable snapshot at creation time)
        // Avoids N+1 lookups when rendering board cards
        custom_context: {
          gateway_source: gatewaySource,
        },
      };
      let session: Session;
      if (
        data.listener_claim_token &&
        !(await this.channelRepo.listenerClaimIsCurrent(channel.id, data.listener_claim_token))
      ) {
        throw new Error('Gateway listener ownership lost before Session admission');
      }
      await this.requireInboundSessionCreateAccess(channel, user.user_id);
      try {
        session = await sessionsService.create(sessionInput, { _agenticConfigResolved: true });
      } catch (error) {
        const stableSessionId = outboundAdmission?.sessionId ?? data.idempotency_session_id;
        if (!stableSessionId || !isDatabaseUniqueConstraintError(error)) {
          throw error;
        }
        // A crash or a competing provider alias can leave the stable Session
        // committed before the provider occurrence is completed. Reuse it
        // only when its immutable security identity matches this channel;
        // never adopt an arbitrary collision.
        let prior: Session;
        try {
          prior = await sessionsService.get(stableSessionId, { user });
        } catch {
          throw error;
        }
        const priorGatewaySourceValue = prior?.custom_context?.gateway_source;
        const priorGatewaySource =
          typeof priorGatewaySourceValue === 'object' &&
          priorGatewaySourceValue !== null &&
          !Array.isArray(priorGatewaySourceValue)
            ? (priorGatewaySourceValue as unknown as GatewaySource & Record<string, unknown>)
            : null;
        const currentTenantId = getCurrentTenantId();
        const priorSeedId = priorGatewaySource?.outbound_seed_id;
        const collisionMatchesIdentity =
          typeof currentTenantId === 'string' &&
          getHiddenTenantId(prior) === currentTenantId &&
          prior?.session_id === stableSessionId &&
          prior.branch_id === channel.target_branch_id &&
          prior.created_by === user.user_id &&
          priorGatewaySource?.channel_id === channel.id &&
          priorGatewaySource?.channel_type === channel.channel_type &&
          (outboundAdmission
            ? priorSeedId === outboundSeed?.id &&
              priorGatewaySource?.outbound_seed_thread_id === outboundSeed?.platform_thread_id
            : priorSeedId === undefined && priorGatewaySource?.thread_id === data.thread_id);
        if (!collisionMatchesIdentity) {
          throw error;
        }
        session = prior;
      }

      sessionId = session.session_id;
      created = true;

      // Attach the channel selection, falling back to the stable owner's defaults.
      if (gatewayMcpServerIds.length > 0) {
        await sessionsService.setMCPServers(
          session.session_id as SessionID,
          gatewayMcpServerIds,
          'gateway'
        );

        // Check which MCP servers are not authenticated for this user.
        //
        // `mcpOAuthGrantIsConnected`, the one verdict — not a second copy of
        // the rule, and no longer a widening this surface holds alone. It
        // counts `refreshable` because a grant whose access token has expired
        // but whose refresh token the inject hook will spend JIT, before the
        // executor ever sees it, is a working connection; telling a Slack
        // thread otherwise is a false alarm on a prompt nobody can act on.
        //
        // Read inside a tenant database scope: this listener holds tenant
        // identity and no transaction, and `resolveMCPOAuthGrantLiveness`
        // builds its own repositories from the raw handle rather than using
        // the bound ones. Without the scope its first server read throws
        // straight into the catch below, and the thread silently stops being
        // told that a server it selected is unavailable.
        const unauthedMcpNames: string[] = [];
        for (const serverId of gatewayMcpServerIds) {
          try {
            const server = await this.mcpServerRepo.findById(serverId);
            if (server?.auth?.type === 'oauth') {
              const liveness = await this.readInTenantScope((db) =>
                resolveMCPOAuthGrantLiveness(db, serverId as MCPServerID, user.user_id as UserID)
              );
              if (!mcpOAuthGrantIsConnected(liveness)) {
                unauthedMcpNames.push(server.display_name || server.name);
              }
            }
          } catch (error) {
            // Non-fatal — the warning is an optimisation on the prompt, never
            // a gate. Logged rather than swallowed: the last two defects in
            // this lane were invisible precisely because a read that could
            // not run left nothing behind.
            console.warn(
              `[gateway] event=mcp_auth_warning_check_failed tenant_id=${
                getCurrentTenantId() ?? '<unknown>'
              } mcp_server_id=${serverId} reason=${classifyGatewayReadFailure(error)}`
            );
          }
        }

        // Track unauthed MCP names so the warning can be prepended to the initial prompt
        if (unauthedMcpNames.length > 0) {
          mcpAuthWarning = `[System notice: The following MCP servers are not authenticated for this user and will be unavailable: ${unauthedMcpNames.join(', ')}. The agent will not have access to these tools.]`;
          console.log(`[gateway] MCP auth warning for: ${unauthedMcpNames.join(', ')}`);
        }
      }

      // Create thread → session mapping
      const initialMappingMetadata =
        channel.channel_type === 'slack'
          ? {
              ...(data.metadata ?? {}),
              slack_active_thread_id: data.thread_id,
              ...(typeof data.metadata?.slack_thread_ts === 'string'
                ? { slack_root_ts: data.metadata.slack_thread_ts }
                : {}),
              ...(typeof data.metadata?.channel === 'string'
                ? { slack_channel_id: data.metadata.channel }
                : {}),
              ...(outboundSeed ? { outbound_seed_id: outboundSeed.id } : {}),
              ...(outboundSeed
                ? {
                    outbound_seed_initial_prompt_pending: true,
                    ...(data.gateway_inbound_event_id
                      ? { outbound_seed_initial_event_id: data.gateway_inbound_event_id }
                      : {}),
                  }
                : {}),
              ...(outboundReplyAliases.length > 0
                ? { gateway_reply_aliases: [...new Set(outboundReplyAliases)] }
                : {}),
            }
          : {
              ...(data.metadata ?? {}),
              ...(outboundSeed ? { outbound_seed_id: outboundSeed.id } : {}),
              ...(outboundSeed
                ? {
                    outbound_seed_initial_prompt_pending: true,
                    ...(data.gateway_inbound_event_id
                      ? { outbound_seed_initial_event_id: data.gateway_inbound_event_id }
                      : {}),
                  }
                : {}),
              ...(outboundReplyAliases.length > 0
                ? { gateway_reply_aliases: [...new Set(outboundReplyAliases)] }
                : {}),
            };
      try {
        mappingForCursor = await this.threadMapRepo.create({
          channel_id: channel.id,
          thread_id: mappingThreadId,
          session_id: session.session_id,
          branch_id: channel.target_branch_id,
          status: 'active',
          metadata: initialMappingMetadata,
        });
      } catch (error) {
        // Different provider events can arrive concurrently on the same new
        // thread. The database unique key elects the mapping; a loser reloads
        // and routes its stable Task to the winner instead of creating a
        // second externally-visible thread association.
        const winner = await this.threadMapRepo.findByChannelAndThread(channel.id, mappingThreadId);
        if (!winner) throw error;
        mappingForCursor = winner;
        sessionId = winner.session_id;
        created = false;
      }

      if (
        outboundAdmission &&
        mappingForCursor &&
        this.isSeedInitialPromptPending(mappingForCursor, data.gateway_inbound_event_id)
      ) {
        recoveringInitialDelivery = true;
        created = true;
      }

      if (outboundAdmission && mappingForCursor) {
        await this.addGatewayReplyAliases(mappingForCursor, outboundReplyAliases);
        await this.outboundRepo.completeReplyAdmission(
          outboundSeed!.id as GatewayOutboundMessageID,
          sessionId
        );
      }

      const sessionUrl = await this.fetchExistingSessionUrlForGatewayUser(sessionId, user);

      if (sessionUrl || channel.channel_type === 'slack') {
        this.sendSystemMessage(
          channel,
          data.thread_id,
          formatGatewaySessionCreatedMessage(sessionId, sessionUrl)
        );
      }

      // GitHub/Shortcut: fold the session link into the connector's editable ack
      // comment (the "Processing..." / "👀 on it" comment) now the session exists.
      // The processing_comment_id was stored in inbound metadata by the connector.
      if (
        data.metadata?.processing_comment_id &&
        (channel.channel_type === 'github' || channel.channel_type === 'shortcut')
      ) {
        const ackText =
          channel.channel_type === 'github'
            ? sessionUrl
              ? `⏳ Processing... [View session](${sessionUrl})`
              : `⏳ Processing in session \`${shortId(sessionId)}\`...`
            : sessionUrl
              ? `👀 On it — [view session](${sessionUrl})`
              : `👀 On it (session \`${shortId(sessionId)}\`)`;
        try {
          const connector = getConnector(channel.channel_type as ChannelType, channel.config);
          await connector.sendMessage({
            threadId: data.thread_id,
            text: ackText,
            metadata: { edit_comment_id: data.metadata.processing_comment_id },
          });
        } catch (err) {
          console.warn(
            `[gateway] Failed to update ${channel.channel_type} ack with session URL:`,
            err
          );
        }
      }
    }

    // Touch channel last_message_at
    await this.channelRepo.updateLastMessage(channel.id);

    // 4. Send prompt via /sessions/:id/prompt — it handles queue-vs-execute internally
    //    (auto-queues when session is busy or has queued items, executes when idle)
    const routingMode = recoveringInitialDelivery
      ? 'recovering_initial'
      : created
        ? 'new_session'
        : 'existing_session';
    try {
      const promptService = this.app.service('/sessions/:id/prompt') as {
        create: (
          data: {
            prompt: string;
            permissionMode?: string;
            messageSource?: MessageSource;
            metadata?: {
              gateway_inbound_event_id?: import('@agor/core/types').GatewayInboundEventID;
              gateway_reply_metadata?: Record<string, unknown>;
              gateway_task_source?: import('@agor/core/types').TaskMetadata['gateway_task_source'];
            };
            idempotencyTaskId?: TaskID;
          },
          params: Record<string, unknown>
        ) => Promise<Task>;
      };

      // For Slack mentions, include catch-up thread context. The connector now
      // requires explicit mentions for channel-like Slack conversations, so each
      // delivered prompt advances the last-delivered cursor. Non-mention replies
      // are picked up here the next time the bot is summoned.
      let promptText = data.text;
      let slackCursorTsToWrite: string | undefined;
      let discordCursorToWrite: string | undefined;
      if (channel.channel_type === 'discord' && !outboundSeed) {
        const connector =
          this.getActiveListener(channel.id) ??
          getConnector(channel.channel_type as ChannelType, channel.config);
        const liveCursor = discordInboundCursor(data.metadata);
        if (!liveCursor) {
          throw new GatewayCatchUpError('malformed', 'Discord mention had no canonical message ID');
        }
        const mappingMetadata = mappingForCursor?.metadata ?? data.metadata ?? {};
        if (!parseDiscordAuthorityMetadata(mappingMetadata)) {
          throw new GatewayCatchUpError(
            'malformed',
            'Stored Discord authority metadata was malformed'
          );
        }
        const discordMetadata = parseDiscordAuthorityMetadata(data.metadata);
        if (connector?.fetchProviderHistory) {
          const afterCursor =
            mappingForCursor?.discord_last_admitted_message_id ??
            extractDiscordStarterMessageId(mappingMetadata);
          if (!afterCursor) {
            throw new GatewayCatchUpError(
              'incomplete',
              'Discord history bootstrap lacked a verified public-thread starter'
            );
          }
          const discordChannelId = discordMetadata?.[DISCORD_METADATA_KEY.channelId];
          const catchUp = await fetchGatewayCatchUp({
            connector,
            request: {
              // Discord keeps a top-level summon's starter message in the
              // parent channel even after it creates a public thread. Read
              // that first live boundary from the channel where Discord
              // actually stored it; later thread mentions are read from the
              // canonical provider thread as usual.
              threadId:
                discordMetadata?.[DISCORD_METADATA_KEY.isThread] === false &&
                discordChannelId !== undefined
                  ? discordChannelId
                  : (mappingForCursor?.thread_id ?? data.thread_id),
              afterProviderCursor: afterCursor,
              throughProviderCursor: liveCursor,
              triggerProviderCursor: liveCursor,
            },
            provider: 'Discord',
            currentText: data.text,
            maxPromptBytes: discordCatchUpMaxPromptBytes(channel.config),
          });
          promptText = catchUp.prompt;
          discordCursorToWrite = catchUp.cursor;
        } else if (durableListenerOwnership) {
          throw new GatewayCatchUpError('unsupported', 'Discord history is unavailable');
        }
      }
      if (channel.channel_type === 'slack' && !outboundSeed) {
        const currentTs = getSlackMessageTs(data.metadata);
        const mappingMetadata = ((mappingForCursor?.metadata as Record<string, unknown>) ?? {}) as
          | Record<string, unknown>
          | undefined;
        const lastDeliveredTs =
          typeof mappingMetadata?.slack_last_delivered_ts === 'string'
            ? mappingMetadata.slack_last_delivered_ts
            : undefined;
        const connector =
          this.getActiveListener(channel.id) ??
          getConnector(channel.channel_type as ChannelType, channel.config);
        const historyConnector = connector as Partial<SlackHistoryConnector>;
        if (currentTs && typeof historyConnector.fetchThreadHistory === 'function') {
          try {
            const slackHistoryThreadId = mappingForCursor?.thread_id ?? data.thread_id;
            const history = await historyConnector.fetchThreadHistory({
              threadId: slackHistoryThreadId,
              ...(created || !lastDeliveredTs ? {} : { oldestTs: lastDeliveredTs }),
              latestTs: currentTs,
              inclusive: true,
              limit: 200,
              includeBotMessages: false,
              triggerTs: currentTs,
            });
            const filteredMessages = lastDeliveredTs
              ? history.messages.filter(
                  (message) => compareSlackTs(message.ts, lastDeliveredTs) > 0
                )
              : history.messages;
            promptText = formatSlackCatchUpPrompt({
              channel,
              threadId: slackHistoryThreadId,
              currentText: data.text,
              metadata: data.metadata,
              messages: filteredMessages.length > 0 ? filteredMessages : history.messages,
              hasMore: history.has_more,
              reason: created
                ? 'initial_thread_context'
                : lastDeliveredTs
                  ? 'missed_since_last_mention'
                  : 'current_message',
            });
            slackCursorTsToWrite = currentTs;
          } catch (_error) {
            console.warn('[gateway] Failed to fetch Slack thread catch-up context');
          }
        } else if (currentTs) {
          slackCursorTsToWrite = currentTs;
        }
      }

      // For new GitHub sessions, wrap the prompt with repository/PR context
      // so the agent knows where it's operating. Follow-up messages (existing
      // mapping) are sent as-is since the session already has context.
      if (created && outboundSeed) {
        promptText = buildSeededThreadInitialPrompt({
          seed: outboundSeed,
          channel,
          replyText: data.text,
          metadata: data.metadata,
        });
      } else if (created && channel.channel_type === 'github') {
        promptText = buildGitHubInitialPrompt(data.thread_id, data.text, data.metadata);
      } else if (created && channel.channel_type === 'shortcut') {
        promptText = buildShortcutInitialPrompt(data.text, data.metadata);
      }

      // Download Slack image and text attachments server-side and fold their
      // opaque handles into the prompt for executor-owned materialization. Gated on the
      // channel's ingest_files flag — channels without the files:read scope
      // never attempt downloads. Any failure degrades to a short note; the
      // prompt is always delivered.
      if (
        channel.channel_type === 'slack' &&
        channelConfig.ingest_files === true &&
        data.files &&
        data.files.length > 0
      ) {
        const botToken =
          typeof channelConfig.bot_token === 'string' ? channelConfig.bot_token : undefined;
        let failedAttachments = 0;
        if (botToken) {
          const ingestion = await ingestInboundAttachments({
            files: data.files,
            botToken,
            tenantId: requireCurrentTenantId() as TenantID,
            sessionId,
            branchId: channel.target_branch_id,
            createdBy: channel.agor_user_id ?? user.user_id,
          });
          const stagedUploads = ingestion.uploads;
          const { failed } = ingestion;
          failedAttachments = failed;
          if (stagedUploads.length > 0) {
            promptText = buildPromptWithAttachments(promptText, stagedUploads);
            console.log(
              `[gateway] Ingested ${stagedUploads.length} Slack attachment(s) for session ${shortId(sessionId)}`
            );
          }
        } else {
          failedAttachments = data.files.length;
          console.warn(
            `[gateway] Cannot ingest Slack attachments for channel ${shortId(channel.id)}: no bot_token in config`
          );
        }
        if (failedAttachments > 0) {
          promptText = `${promptText}\n\n(an attachment could not be fetched)`;
        }
      }

      // Prepend gateway context block so the agent knows the message source.
      // Applied to ALL messages (initial + follow-up) since each message may
      // come from a different user in a shared channel.
      // Skip for initial GitHub messages — buildGitHubInitialPrompt() already
      // includes repo/issue/user context and adding both would be redundant.
      const skipContext =
        channel.channel_type === 'slack' ||
        (created &&
          (channel.channel_type === 'github' ||
            channel.channel_type === 'shortcut' ||
            !!outboundSeed));
      if (!skipContext) {
        const gatewayCtx = buildGatewayContext(channel, data);
        const contextPrefix = formatGatewayContext(gatewayCtx);
        if (contextPrefix) {
          promptText = contextPrefix + promptText;
        }
      }

      if (channel.channel_type === 'slack') {
        promptText = prependSlackGatewayReplyNote(promptText);
      }

      // Prepend MCP auth warning to the initial prompt so the agent is aware
      if (created && mcpAuthWarning) {
        promptText = `${mcpAuthWarning}\n\n${promptText}`;
      }

      // Internal call: pass user, omit provider to bypass auth hooks
      // Mark message source as 'gateway' so it won't be echoed back to the platform
      const tenantId = getCurrentTenantId();
      if (
        data.listener_claim_token &&
        !(await this.channelRepo.listenerClaimIsCurrent(channel.id, data.listener_claim_token))
      ) {
        throw new Error('Gateway listener ownership lost before Task admission');
      }

      // Best-effort nudge for initial gateway delivery. Keep this after all
      // other transformations so the hint remains the final prompt block.
      if (created) {
        promptText = `${promptText}\n\n${GATEWAY_STARTUP_BOOTSTRAP_HINT}`;
      }

      await this.requireInboundPromptAuthority(channel, sessionId, user.user_id);

      const gatewayTaskMetadata = {
        ...(data.gateway_inbound_event_id
          ? { gateway_inbound_event_id: data.gateway_inbound_event_id }
          : {}),
        ...(typeof data.metadata?.processing_comment_id === 'number'
          ? {
              gateway_reply_metadata: {
                processing_comment_id: data.metadata.processing_comment_id,
              },
            }
          : {}),
      };

      const task = await promptService.create(
        {
          prompt: promptText,
          permissionMode,
          messageSource: 'gateway',
          metadata: {
            ...gatewayTaskMetadata,
            gateway_task_source: {
              gateway_channel_id: channel.id,
              channel_type: channel.channel_type as ChannelType,
              thread_id: data.thread_id,
              provider_user_id: data.user_name ?? 'unknown',
              ...(typeof data.metadata?.slack_message_ts === 'string'
                ? { provider_message_id: data.metadata.slack_message_ts }
                : {}),
              ...(typeof data.metadata?.slack_team_id === 'string'
                ? { slack_team_id: data.metadata.slack_team_id }
                : {}),
              ...(typeof data.metadata?.channel === 'string'
                ? { slack_channel_id: data.metadata.channel }
                : {}),
              // Only meaningful for Slack, and only available here: a later
              // projection into this thread (the MCP connect card) needs to
              // know whether it is speaking into a DM or a room other people
              // read, and nothing else persists the conversation kind.
              ...(channel.channel_type === 'slack' &&
              typeof data.metadata?.channel_type === 'string'
                ? { slack_conversation_type: data.metadata.channel_type }
                : {}),
            },
          },
          ...(data.idempotency_task_id ? { idempotencyTaskId: data.idempotency_task_id } : {}),
        },
        {
          route: { id: sessionId },
          user,
          ...(tenantId ? { tenant: { tenant_id: tenantId, source: 'explicit' as const } } : {}),
        }
      );
      admittedTaskId = task.task_id as TaskID;
      if (mappingForCursor) {
        await this.markSeedInitialPromptAdmitted(
          mappingForCursor,
          data.gateway_inbound_event_id,
          admittedTaskId
        );
      }

      // Task admission is the durable happens-before edge for Discord
      // catch-up. A failure here leaves the provider event retryable; the
      // stable Task reconciliation above advances the cursor without a second
      // prompt.
      if (channel.channel_type === 'discord' && discordCursorToWrite && mappingForCursor) {
        await this.threadMapRepo.advanceDiscordLastAdmittedMessageId(
          mappingForCursor.id,
          discordCursorToWrite
        );
      }

      if (channel.channel_type === 'slack' && slackCursorTsToWrite && mappingForCursor) {
        const latestMapping = await this.threadMapRepo.findById(mappingForCursor.id);
        const latestMetadata = ((latestMapping?.metadata as Record<string, unknown>) ??
          {}) as Record<string, unknown>;
        const previousDelivered =
          typeof latestMetadata.slack_last_delivered_ts === 'string'
            ? latestMetadata.slack_last_delivered_ts
            : undefined;
        if (compareSlackTs(slackCursorTsToWrite, previousDelivered) >= 0) {
          await this.threadMapRepo.updateMetadata(mappingForCursor.id, {
            ...latestMetadata,
            slack_last_delivered_ts: slackCursorTsToWrite,
            slack_last_summon_ts: slackCursorTsToWrite,
          });
        }
      }

      if (task.status === 'queued') {
        console.log(
          `[gateway] Message queued for session ${shortId(sessionId)} ` +
            `route=${routingMode} at position ${task.queue_position}`
        );
        this.sendSystemMessage(
          channel,
          data.thread_id,
          `Session is busy, message queued at position ${task.queue_position}`,
          { suppressSlack: true, suppressDiscord: true }
        );
        this.updateProgressAfterCommit({
          session_id: sessionId,
          state: 'queued',
          task_id: task.task_id,
          queue_position: task.queue_position,
        });
      } else {
        console.log(
          `[gateway] Prompt sent to session ${shortId(sessionId)} ` +
            `route=${routingMode} via /sessions/:id/prompt`
        );
        this.updateProgressAfterCommit({
          session_id: sessionId,
          state: 'working',
          task_id: task.task_id,
        });
      }
    } catch (error) {
      if (error instanceof GatewayPromptAuthorizationError) {
        await this.sendPromptAuthorizationDenied(channel, data, error.userMessage);
        this.updateProgressAfterCommit({
          session_id: sessionId,
          state: 'failed',
          error_message: 'prompt_not_authorized',
        });
        // Authorization is a terminal outcome for this provider occurrence,
        // not a transient delivery failure. Retrying cannot make the already
        // denied event safe to admit and would spam the same visible message.
        return { success: false, sessionId: '', created: false };
      }
      const safeError = gatewayFailureCode(error);
      console.error(
        `[gateway] Failed to send prompt to session: channel_id=${channel.id} code=${safeError}`
      );
      this.sendSystemMessage(channel, data.thread_id, `Error sending prompt: ${safeError}`);
      this.updateProgressAfterCommit({
        session_id: sessionId,
        state: 'failed',
        error_message: safeError,
      });
      // Durable listener recovery must retry/reconcile the same stable Task;
      // swallowing this error would mark the provider event completed even
      // though prompt admission never crossed its database fence.
      if (data.gateway_inbound_event_id) throw error;
    }

    return {
      success: true,
      sessionId,
      created,
      ...(admittedTaskId ? { taskId: admittedTaskId } : {}),
    };
  }

  /**
   * Outbound routing: session → platform
   *
   * Looks up session in thread_session_map. If no mapping exists,
   * returns a cheap no-op. Uses platform connectors to send messages.
   */
  async routeMessage(
    data: RouteMessageData,
    params?: AuthenticatedParams
  ): Promise<RouteMessageResult> {
    let transportedSession: Session | null | undefined;
    // Direct service calls are daemon-internal. Every transported invocation
    // must carry trusted auth and prove authority over the session's branch
    // before even consulting a mapping or constructing a provider connector.
    if (params?.provider) {
      const user = params.user;
      if (!user) throw new NotAuthenticated('Authentication required');
      const userId = user.user_id as UserID;
      transportedSession = await this.sessionRepo.findById(data.session_id as SessionID);
      if (!transportedSession) throw new Forbidden('Gateway outbound access denied');
      const branch = await this.branchRepo.findById(transportedSession.branch_id);
      if (!branch) throw new Forbidden('Gateway outbound access denied');
      const isOwner = await this.branchRepo.isOwner(branch.branch_id, userId);
      const effectivePermission = await this.branchRepo.resolveUserPermission(branch, userId);
      if (
        !hasBranchPermission(
          branch,
          userId,
          isOwner,
          'all' as BranchPermissionLevel,
          user.role,
          this.app.get('config').execution?.allow_superadmin === true,
          effectivePermission
        )
      ) {
        throw new Forbidden('Gateway outbound access denied');
      }
    }

    // Mapped Discord assistant Messages now have a durable intent inserted in
    // the Message transaction. The independent delivery worker owns those
    // rows; never send them through the legacy after-hook path as well.
    if (data.message_id && (await this.deliveryRepo.findByMessageId(data.message_id))) {
      return { routed: true, channelType: 'discord' };
    }

    // Fast path: skip DB lookup entirely when no channels are configured
    if (!(await this.shouldQueryGatewayRouting())) {
      return { routed: false };
    }

    // Look up session in thread_session_map
    const mapping = await this.threadMapRepo.findBySession(data.session_id);

    if (!mapping) {
      // No mapping → cheap no-op (session is not gateway-connected)
      return { routed: false };
    }

    console.log(
      `[gateway] Found mapping: channel=${shortId(mapping.channel_id)}, thread=${mapping.thread_id}`
    );

    const channel = await this.channelRepo.findById(mapping.channel_id);

    if (!channel?.enabled) {
      return { routed: false };
    }

    if (params?.provider) {
      if (!transportedSession || transportedSession.branch_id !== channel.target_branch_id) {
        throw new Forbidden('Gateway outbound access denied');
      }
    }

    // Check if we have a connector for this channel type
    if (!hasConnector(channel.channel_type as ChannelType)) {
      console.warn(`[gateway] No connector for channel type: ${channel.channel_type}`);
      return { routed: false };
    }

    // Touch timestamps
    await this.threadMapRepo.updateLastMessage(mapping.id);
    await this.channelRepo.updateLastMessage(channel.id);

    // GitHub and Shortcut replies are resolved from durable, task-scoped
    // messages when the session turn ends. Do not stream intermediate output.
    if (channel.channel_type === 'github' || channel.channel_type === 'shortcut') {
      console.log(
        `[gateway] Deferred ${channel.channel_type} message for session ${shortId(data.session_id)} (${data.message.length} chars)`
      );
      return { routed: true, channelType: channel.channel_type };
    }

    // Non-GitHub channels (e.g. Slack, Teams): send immediately
    try {
      // Prefer the active listener instance — webhook-based connectors (e.g. Teams)
      // store ConversationReferences in memory on the listener instance.
      const connector =
        this.getActiveListener(channel.id) ??
        getConnector(channel.channel_type as ChannelType, channel.config);

      const systemMeta = data.metadata?.system as Record<string, unknown> | undefined;
      const systemPrefixMatch = /^\s*\[system\]\s*/i.exec(data.message);
      const shouldRenderAsSystem =
        channel.channel_type === 'slack' &&
        (systemMeta?.render_hint === 'context' || !!systemPrefixMatch);
      const payload = shouldRenderAsSystem
        ? formatGatewaySystemPayload('slack', data.message.replace(/^\s*\[system\]\s*/i, '').trim())
        : normalizeOutbound(
            connector.formatMessage ? connector.formatMessage(data.message) : data.message
          );
      const { text, blocks } = payload;
      const threadId =
        channel.channel_type === 'slack' ? this.getActiveSlackThreadId(mapping) : mapping.thread_id;

      const sent = await connector.sendMessage({
        threadId,
        text,
        blocks,
        metadata: data.metadata,
      });
      const receipt = normalizeSendReceipt(sent);
      if (channel.channel_type === 'slack') {
        if (typeof sent === 'string') {
          await this.addSlackThreadAlias(mapping, sent, 'message');
        }
      }
      // Discord's canonical public-thread mapping is already the routing
      // identity. Only preserve aliases for providers/legacy paths that still
      // need them; ordinary Discord final responses must not grow metadata.
      if (channel.channel_type !== 'discord' && receipt.replyAliases?.length) {
        await this.addGatewayReplyAliases(mapping, receipt.replyAliases ?? []);
      }

      console.log(`[gateway] Routed message to ${channel.channel_type} thread ${threadId}`);
    } catch (error) {
      const failure = gatewayFailureCode(error);
      console.error(
        `[gateway] Failed to route message: channel_id=${channel.id} provider=${channel.channel_type} code=${failure}`
      );
      return { routed: false, channelType: channel.channel_type };
    }

    return {
      routed: true,
      channelType: channel.channel_type,
    };
  }

  /**
   * Schedule outbound routing after the current tenant-scoped database work
   * commits, then route inside a fresh tenant scope. Message after-hooks fire
   * while the newly-created row may still be transactional; routing immediately
   * can inherit a stale transaction object or query before the session/message
   * graph is visible on a new scoped connection.
   */
  routeMessageAfterCommit(data: RouteMessageData, params?: unknown): void {
    deferWithTenantContext(
      params,
      async () => {
        await this.routeMessage(data);
      },
      () => {
        console.warn('[gateway] Failed to route message after commit');
      }
    );
  }

  /** Deliver one task's terminal reply by editing its exact provider acknowledgement. */
  async flushOutboundBuffer(sessionId: string, options: FlushOutboundBufferOptions): Promise<void> {
    const mapping = await this.threadMapRepo.findBySession(sessionId);
    if (!mapping) return;

    const channel = await this.channelRepo.findById(mapping.channel_id);
    if (
      !channel?.enabled ||
      (channel.channel_type !== 'github' && channel.channel_type !== 'shortcut')
    ) {
      return;
    }

    const taskId = options.taskId;
    const terminalTask = await this.taskRepo.findById(taskId);
    if (
      !terminalTask ||
      terminalTask.session_id !== sessionId ||
      !isTerminalTaskStatus(terminalTask.status)
    ) {
      return;
    }
    const processingCommentId =
      terminalTask.metadata?.gateway_reply_metadata?.processing_comment_id;
    if (typeof processingCommentId !== 'number') {
      console.warn(
        `[gateway] Task ${shortId(taskId)} has no provider acknowledgement; final reply was not sent`
      );
      return;
    }

    const mappingMetadata = ((mapping.metadata as Record<string, unknown>) ?? {}) as Record<
      string,
      unknown
    >;

    const messages = await this.messagesRepo.findByTaskId(taskId);
    const latestAssistant = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant' && gatewayMessageText(message));
    const claimMessage = latestAssistant ?? messages.at(-1);
    if (!claimMessage) return;

    let finalMessage = latestAssistant ? gatewayMessageText(latestAssistant) : undefined;
    if (terminalTask.status === TaskStatus.FAILED || terminalTask.status === TaskStatus.TIMED_OUT) {
      finalMessage = await this.formatTerminalGatewayReply(
        GATEWAY_FAILED_TURN_REPLY,
        sessionId as SessionID
      );
    } else if (terminalTask.status === TaskStatus.STOPPED) {
      finalMessage = await this.formatTerminalGatewayReply(
        GATEWAY_STOPPED_TURN_REPLY,
        sessionId as SessionID
      );
    }
    if (!finalMessage) return;

    if (
      mappingMetadata.gateway_last_flushed_task_id === taskId ||
      mappingMetadata.gateway_last_flushed_message_id === claimMessage.message_id
    ) {
      return;
    }

    // Reuse the existing Message metadata row-lock primitive. This is the
    // same short claim/finish pattern used by widget resolution and avoids a
    // new delivery table or Task-repository state machine.
    const claimToken = generateId();
    const claim = await this.messagesRepo.mutateMetadataLocked(
      claimMessage.message_id,
      (metadata) => {
        const claimedAt = new Date();
        const state = gatewayFinalReplyState(metadata);
        if (state?.status === 'delivered') return null;
        if (state?.status === 'processing') {
          const claimAgeMs = claimedAt.getTime() - Date.parse(state.claimed_at);
          if (Number.isFinite(claimAgeMs) && claimAgeMs < GATEWAY_FINAL_REPLY_CLAIM_TIMEOUT_MS) {
            return null;
          }
        }
        return {
          ...(metadata ?? {}),
          gateway_final_reply: {
            status: 'processing',
            claim_token: claimToken,
            claimed_at: claimedAt.toISOString(),
          },
        };
      }
    );
    if (!claim.changed) return;

    try {
      const connector = getConnector(channel.channel_type as ChannelType, channel.config);
      const { text, blocks } = normalizeOutbound(
        connector.formatMessage ? connector.formatMessage(finalMessage) : finalMessage
      );
      await connector.sendMessage({
        threadId: mapping.thread_id,
        text,
        blocks,
        metadata: { edit_comment_id: processingCommentId },
      });

      const completed = await this.messagesRepo.mutateMetadataLocked(
        claimMessage.message_id,
        (metadata) => {
          const state = gatewayFinalReplyState(metadata);
          if (state?.status !== 'processing' || state.claim_token !== claimToken) return null;
          return {
            ...(metadata ?? {}),
            gateway_final_reply: {
              status: 'delivered',
              delivered_at: new Date().toISOString(),
            },
          };
        }
      );
      if (!completed.changed) throw new Error('Gateway final reply claim was lost');

      try {
        await this.threadMapRepo.mergeMetadata(mapping.id, {
          gateway_last_flushed_message_id: claimMessage.message_id,
          gateway_last_flushed_task_id: taskId,
        });
      } catch (_error) {
        console.warn('[gateway] Failed to update legacy final reply markers');
      }

      console.log(
        `[gateway] Flushed ${channel.channel_type} final reply for session ${shortId(sessionId)} → ${mapping.thread_id} (${finalMessage.length} chars)`
      );
    } catch (error) {
      try {
        await this.messagesRepo.mutateMetadataLocked(claimMessage.message_id, (metadata) => {
          const state = gatewayFinalReplyState(metadata);
          if (state?.status !== 'processing' || state.claim_token !== claimToken) return null;
          return { ...(metadata ?? {}), gateway_final_reply: { status: 'pending' } };
        });
      } catch (_releaseError) {
        console.warn('[gateway] Failed to release final reply claim');
      }
      console.error(
        `[gateway] Failed to flush ${channel.channel_type} final reply for session ${shortId(sessionId)}:`,
        error
      );
    }
  }

  private scheduleListenerScan(delayMs: number): void {
    if (this.listenerStopped || this.listenerDraining) return;
    this.listenerTimer = setTimeout(() => {
      this.listenerTimer = null;
      void this.runListenerScanLoop();
    }, delayMs);
    this.listenerTimer.unref?.();
  }

  private async startListenerWorker(): Promise<void> {
    if (this.listenerTimer || this.listenerScanRunning) return;
    this.listenerStopped = false;
    this.listenerDraining = false;
    console.log(
      `[distributed-work.gateway-listener] event="loop_started" instance_id=${JSON.stringify(this.workIdentity.instanceId)} boot_id=${JSON.stringify(this.workIdentity.bootId)} scan_batch_size=${GATEWAY_LISTENER_SCAN_BATCH}`
    );
    // Preserve prompt startup while spreading each daemon's next contention
    // pass over the renewal window.
    await this.runListenerScanLoop(false);
    this.scheduleListenerScan(initialWorkOffset(GATEWAY_LISTENER_RENEW_SCAN_MAX_MS, Math.random()));
  }

  private async runListenerScanLoop(scheduleNext = true): Promise<void> {
    if (this.listenerScanRunning || this.listenerStopped) return;
    this.listenerScanRunning = true;
    let found = 0;
    try {
      found = await this.reconcileListenersOnce();
      this.listenerIdleRounds = found === 0 ? this.listenerIdleRounds + 1 : 0;
    } catch {
      this.listenerIdleRounds += 1;
      console.warn(
        `[distributed-work.gateway-listener] event=scan_failed instance_id=${JSON.stringify(this.workIdentity.instanceId)} boot_id=${JSON.stringify(this.workIdentity.bootId)} code=database_unavailable`
      );
    } finally {
      this.listenerScanRunning = false;
    }
    if (!scheduleNext) return;
    const delay =
      found >= GATEWAY_LISTENER_SCAN_BATCH
        ? jitterDelay(150, 2 / 3, Math.random())
        : boundedBackoffDelay(
            this.listenerIdleRounds,
            {
              baseDelayMs: 1_000,
              maxDelayMs: GATEWAY_LISTENER_RENEW_SCAN_MAX_MS,
              jitterRatio: 0.2,
            },
            Math.random()
          );
    this.scheduleListenerScan(delay);
  }

  /** One bounded all-daemon renewal/discovery pass; database claims elect owners. */
  private async reconcileListenersOnce(): Promise<number> {
    // Renew before discovery so a full candidate page cannot starve local
    // owners. An expired/revoked token is removed immediately and never
    // released: its provider transport gets a bounded stop while the new owner
    // may already contend safely behind the database fence.
    for (const [key, lease] of [...this.activeListenerLeases]) {
      await this.runWithListenerTenantIdentity(lease.tenant_id, async () => {
        const renewed = await this.channelRepo.renewListener(
          lease.channel_id,
          lease.claim_token,
          GATEWAY_LISTENER_LEASE_MS
        );
        if (!renewed) {
          await this.stopChannelListener(lease.channel_id, { releaseClaim: false });
          return;
        }
        this.activeListenerLeases.set(key, { ...renewed, tenant_id: lease.tenant_id });
      });
    }

    const refs = this.listenerDiscoveryTenantId
      ? await this.runWithListenerTenantIdentity(this.listenerDiscoveryTenantId, async () => {
          const channelIds = await this.channelRepo.findEnabledListenerCandidateIds(
            GATEWAY_LISTENER_SCAN_BATCH,
            this.listenerDiscoveryCursor?.channel_id
          );
          return channelIds.map((channelId) => ({
            channel_id: channelId,
            tenant_id: this.listenerDiscoveryTenantId!,
          }));
        })
      : await runWithSystemDatabaseScope(
          this.db,
          'gateway listener discovery',
          (systemDb) =>
            new GatewayListenerDiscoveryRepository(systemDb).findEnabledTenantRefs({
              limit: GATEWAY_LISTENER_SCAN_BATCH,
              after: this.listenerDiscoveryCursor,
            }),
          { capability: 'gateway_listener_discovery' }
        );

    if (refs.length === 0) {
      this.listenerDiscoveryCursor = undefined;
      return 0;
    }
    const last = refs.at(-1)!;
    this.listenerDiscoveryCursor = {
      tenant_id: last.tenant_id as TenantID,
      channel_id: last.channel_id,
    };

    for (const ref of refs) {
      await this.runWithListenerTenantIdentity(ref.tenant_id, async () => {
        const key = this.listenerKey(ref.tenant_id, ref.channel_id);
        if (this.activeListeners.has(key) || this.listenerRetries.has(key)) return;
        const channel = await this.channelRepo.findById(ref.channel_id);
        if (!channel?.enabled) return;
        if (tenantIdFromGatewayChannel(channel) !== ref.tenant_id) {
          throw new Error(
            `Gateway listener discovery tenant mismatch for channel ${ref.channel_id}`
          );
        }
        this.activeChannelTenants.add(ref.tenant_id);
        if (channel.channel_type === 'slack') {
          this.mcpSlackRecoveryTenants.add(ref.tenant_id);
          this.scheduleMcpSlackRecoveryRepair(ref.tenant_id);
          this.ensureMcpSlackPeriodicSweep();
        }
        if (!hasConnector(channel.channel_type as ChannelType) || !hasListeningConfig(channel)) {
          return;
        }
        // Provider authentication/connect is external network work and must not
        // hold up the bounded/fair discovery cursor. The channel-row claim
        // prevents a second start while this promise is in flight.
        void this.startChannelListener(channel, ref.tenant_id).catch(() => {
          console.warn(
            `[gateway.listener] event=start_failed channel_id=${JSON.stringify(channel.id)} provider=${channel.channel_type} code=supervisor_unavailable`
          );
        });
      }).catch(() => {
        console.warn(
          `[distributed-work.gateway-listener] event=candidate_failed tenant_id=${JSON.stringify(ref.tenant_id)} channel_id=${JSON.stringify(ref.channel_id)} code=candidate_unavailable`
        );
      });
    }
    return refs.length;
  }

  /**
   * Start Socket Mode listeners for all enabled channels that support it.
   * Called once at daemon startup. Inbound messages are routed through
   * the gateway's create() method (same path as webhook POST).
   */
  async startListeners(): Promise<void> {
    const tenantId = requireCurrentTenantId(
      'Missing tenant context while starting gateway listeners'
    );
    this.durableListenerOwnership = await runWithTenantDatabaseScope(
      this.db,
      tenantId,
      async (scopedDb) => isPostgresDatabase(scopedDb)
    );
    const channels = await this.channelRepo.findAll();
    if (channels.some((channel) => channel.enabled)) this.activeChannelTenants.add(tenantId);
    if (channels.some((channel) => channel.enabled && channel.channel_type === 'slack')) {
      this.mcpSlackRecoveryTenants.add(tenantId);
      this.scheduleMcpSlackRecoveryRepair(tenantId);
      this.ensureMcpSlackPeriodicSweep();
    }
    if (this.durableListenerOwnership) {
      this.listenerDiscoveryTenantId = tenantId;
      await this.startListenerWorker();
      return;
    }
    if (channels.some((channel) => channel.enabled)) {
      this.activeChannelTenants.add(tenantId);
    } else {
      this.activeChannelTenants.delete(tenantId);
    }
    const eligible = channels.filter(
      (ch) => ch.enabled && hasConnector(ch.channel_type as ChannelType) && hasListeningConfig(ch)
    );

    if (eligible.length === 0) {
      console.log('[gateway] No channels with listener config (Socket Mode / polling)');
      return;
    }

    for (const channel of eligible) {
      await this.startChannelListener(channel, tenantId);
    }
  }

  /**
   * Discover enabled channels across tenants at daemon startup. The system
   * transaction returns only channel and tenant IDs. Credentials and all
   * connector-owned work are reloaded under the discovered tenant's RLS scope.
   */
  async startListenersAcrossTenants(): Promise<void> {
    this.durableListenerOwnership = await runWithSystemDatabaseScope(
      this.db,
      'gateway listener dialect detection',
      async (systemDb) => isPostgresDatabase(systemDb)
    );
    if (this.durableListenerOwnership) {
      this.listenerDiscoveryTenantId = undefined;
      await this.startListenerWorker();
      return;
    }
    const refs = await runWithSystemDatabaseScope(
      this.db,
      'gateway listener discovery',
      (systemDb) => new GatewayListenerDiscoveryRepository(systemDb).findEnabledTenantRefs(),
      { capability: 'gateway_listener_discovery' }
    );

    if (refs.length === 0) {
      console.log('[gateway] No enabled channels found during listener discovery');
      return;
    }

    for (const ref of refs) {
      const tenantId = ref.tenant_id;

      try {
        await this.runWithListenerTenantIdentity(tenantId, async () => {
          const channel = await this.channelRepo.findById(ref.channel_id);
          if (!channel) {
            console.warn(
              `[gateway] Channel ${ref.channel_id} disappeared before tenant-scoped listener startup`
            );
            return;
          }

          const rowTenantId = tenantIdFromGatewayChannel(channel);
          if (rowTenantId !== tenantId) {
            throw new Error(
              `Gateway listener discovery tenant mismatch for channel ${ref.channel_id}`
            );
          }
          if (!channel.enabled) {
            console.warn(
              `[gateway] Channel ${ref.channel_id} was disabled before tenant-scoped listener startup`
            );
            return;
          }

          this.activeChannelTenants.add(tenantId);
          if (channel.channel_type === 'slack') {
            this.mcpSlackRecoveryTenants.add(tenantId);
            this.scheduleMcpSlackRecoveryRepair(tenantId);
            this.ensureMcpSlackPeriodicSweep();
          }
          if (hasConnector(channel.channel_type as ChannelType) && hasListeningConfig(channel)) {
            await this.startChannelListener(channel, tenantId);
          }
        });
      } catch (error) {
        console.error(
          `[gateway] Refusing listener startup for channel ${ref.channel_id} in tenant ${tenantId}:`,
          error
        );
      }
    }
  }

  /**
   * Start or stop a Socket Mode listener for a single channel based on its enabled state
   * (public wrapper for hook usage)
   */
  async startListenerForChannel(channelId: string): Promise<void> {
    const tenantId = requireCurrentTenantId(
      'Missing tenant context while managing a gateway listener'
    );
    this.durableListenerOwnership = await runWithTenantDatabaseScope(
      this.db,
      tenantId,
      async (scopedDb) => isPostgresDatabase(scopedDb)
    );
    const channel = await this.channelRepo.findById(channelId);
    this.invalidateListenerLifecycle(tenantId, channelId);
    await this.cancelListenerRetry(tenantId, channelId, true);
    if (!channel) {
      console.warn(`[gateway] Cannot manage listener: channel ${channelId} not found`);
      return;
    }
    if (channel.enabled && channel.channel_type === 'slack') {
      this.mcpSlackRecoveryTenants.add(tenantId);
      this.scheduleMcpSlackRecoveryRepair(tenantId);
      this.ensureMcpSlackPeriodicSweep();
    }

    // If channel is disabled, stop the listener
    if (!channel.enabled) {
      await this.stopChannelListener(channelId);
      console.log(`[gateway] Stopped listener for disabled channel ${channel.name}`);
      return;
    }

    // If no connector or missing listener config, stop any existing listener
    if (!hasConnector(channel.channel_type as ChannelType)) {
      console.warn(`[gateway] No connector for channel type: ${channel.channel_type}`);
      await this.stopChannelListener(channelId);
      return;
    }
    if (!hasListeningConfig(channel)) {
      console.log(
        `[gateway] Skipping listener for channel ${channel.name} (missing listener config)`
      );
      await this.stopChannelListener(channelId);
      return;
    }

    // Stop existing listener first so config changes are picked up.
    // startChannelListener() is a no-op if a listener already exists,
    // so we must tear down the old one before creating a new connector
    // with the updated config (e.g. enable_channels toggled).
    if (this.activeListeners.has(this.listenerKey(tenantId, channelId))) {
      console.log(
        `[gateway] Restarting listener for channel "${channel.name}" to pick up config changes`
      );
      await this.stopChannelListener(channelId);
    }

    // Start with fresh config
    await this.startChannelListener(channel, tenantId);
  }

  /**
   * Stop a Socket Mode listener for a single channel
   */
  async stopChannelListener(
    channelId: string,
    options: { releaseClaim?: boolean } = {}
  ): Promise<boolean> {
    const tenantId = requireCurrentTenantId(
      'Missing tenant context while stopping a gateway listener'
    );
    const key = this.listenerKey(tenantId, channelId);
    this.invalidateListenerLifecycle(tenantId, channelId);
    const connector = this.activeListeners.get(key);
    const lease = this.activeListenerLeases.get(key);
    const retry = this.listenerRetries.get(key);
    if (retry?.timer) clearTimeout(retry.timer);
    this.listenerRetries.delete(key);
    if (!connector) {
      this.activeListenerLeases.delete(key);
      if (lease && options.releaseClaim !== false) {
        await this.channelRepo.releaseListener(lease.channel_id, lease.claim_token);
      }
      return true; // Not listening
    }

    // Always remove from activeListeners so a fresh start can proceed,
    // even if stopListening() throws (e.g. socket already closed).
    this.activeListeners.delete(key);
    this.activeListenerLeases.delete(key);

    let stopped = false;
    try {
      if (connector.stopListening) {
        await withGatewayTimeout(connector.stopListening(), GATEWAY_LISTENER_STOP_TIMEOUT_MS);
      }
      stopped = true;
      console.log(`[gateway] Listener stopped for channel ${shortId(channelId)}`);
    } catch {
      // A transport that ignores stop may still deliver, but every callback and
      // checkpoint remains fenced by its opaque database token. Do not release
      // the lease early; expiry is the safe takeover path.
      console.warn(
        `[gateway.listener] event=stop_failed channel_id=${JSON.stringify(channelId)} code=transport_stop_failed`
      );
    }

    // Releasing after the provider transport has stopped avoids handing the
    // channel to a new owner while the old socket/poller can still receive.
    // A failed/timed-out stop is fenced by expiry instead.
    if (stopped && lease && options.releaseClaim !== false) {
      await this.channelRepo.releaseListener(lease.channel_id, lease.claim_token);
    }
    return stopped;
  }

  /**
   * Start a Socket Mode listener for a single channel
   */
  private async startChannelListener(
    channel: GatewayChannel,
    listenerTenantId: TenantID | string,
    claimedLease?: GatewayListenerLease,
    expectedGeneration?: number
  ): Promise<void> {
    if (this.listenerStopped || this.listenerDraining) return;
    const rowTenantId = tenantIdFromGatewayChannel(channel);
    if (rowTenantId && rowTenantId !== listenerTenantId) {
      throw new Error(`Gateway listener tenant mismatch for channel ${channel.id}`);
    }

    const key = this.listenerKey(listenerTenantId, channel.id);
    if (!this.listenerLifecycleGenerations.has(key)) {
      this.listenerLifecycleGenerations.set(key, 0);
    }
    const generation = expectedGeneration ?? this.listenerLifecycleGenerations.get(key) ?? 0;
    if (this.listenerLifecycleGenerations.get(key) !== generation) return;
    if (this.activeListeners.has(key)) {
      return; // Already listening
    }

    if (this.durableListenerOwnership && channel.channel_type === 'teams') {
      console.error(
        `[distributed-work.gateway-listener] event=provider_unsupported provider=teams tenant_id=${JSON.stringify(listenerTenantId)} channel_id=${JSON.stringify(channel.id)} reason=${JSON.stringify('Teams webhook ingress and ConversationReference routing are process-local')}`
      );
      return;
    }

    let lease = claimedLease;
    if (lease) {
      const renewedLease = await this.runWithListenerTenantIdentity(listenerTenantId, () =>
        this.channelRepo.renewListener(channel.id, lease!.claim_token, GATEWAY_LISTENER_LEASE_MS)
      );
      if (!renewedLease) {
        if (this.listenerLifecycleGenerations.get(key) === generation) {
          const retry = this.listenerRetries.get(key);
          if (retry?.timer) clearTimeout(retry.timer);
          this.listenerRetries.delete(key);
          this.activeListenerLeases.delete(key);
        }
        return;
      }
      lease = renewedLease;
    }
    if (this.durableListenerOwnership && !lease) {
      const claim = await this.channelRepo.claimListener({
        channelId: channel.id,
        claimToken: generateId(),
        leaseDurationMs: GATEWAY_LISTENER_LEASE_MS,
        instanceId: this.workIdentity.instanceId,
        bootId: this.workIdentity.bootId,
      });
      if (claim.outcome !== 'claimed') return;
      lease = claim.lease;
    }

    const priorRetry = this.listenerRetries.get(key);
    const priorAttempt = priorRetry?.attempt ?? 0;
    if (priorRetry?.timer) clearTimeout(priorRetry.timer);

    return runWithoutTenantDatabaseScope(async () => {
      let connector: GatewayConnector | undefined;
      try {
        connector = getConnector(channel.channel_type as ChannelType, channel.config);

        if (!connector.startListening) {
          if (lease) {
            await this.runWithListenerTenantIdentity(listenerTenantId, () =>
              this.channelRepo.releaseListener(channel.id, lease!.claim_token)
            );
          }
          return; // Connector doesn't support listening
        }

        const callback = (msg: InboundMessage) =>
          this.handleListenerInboundMessage(channel, listenerTenantId, msg, lease);

        const isDiscord = channel.channel_type === 'discord';
        await connector.startListening(callback, {
          ...(isDiscord ? {} : { checkpoint: lease?.checkpoint }),
          durableEventIdempotency: !!lease,
          ...(lease && !isDiscord
            ? {
                saveCheckpoint: (checkpoint: Record<string, unknown>) =>
                  this.runWithListenerTenantIdentity(listenerTenantId, () =>
                    this.channelRepo.saveListenerCheckpoint(
                      channel.id,
                      lease!.claim_token,
                      checkpoint
                    )
                  ),
              }
            : {}),
          onError: async (error) => {
            if (this.listenerStopped || this.listenerDraining) return;
            await this.runWithListenerTenantIdentity(listenerTenantId, async () => {
              const currentLease = lease ?? this.activeListenerLeases.get(key);
              await this.stopChannelListener(channel.id, { releaseClaim: false });
              if (!this.listenerStopped && !this.listenerDraining) {
                this.recordListenerFailure(
                  channel,
                  listenerTenantId,
                  currentLease,
                  gatewayListenerFailure(error)
                );
              }
            });
          },
        });
        const leaseIsCurrent = lease
          ? await this.runWithListenerTenantIdentity(listenerTenantId, () =>
              this.channelRepo.listenerClaimIsCurrent(channel.id, lease!.claim_token)
            )
          : true;
        if (
          this.listenerStopped ||
          this.listenerDraining ||
          this.listenerLifecycleGenerations.get(key) !== generation ||
          !leaseIsCurrent
        ) {
          let stopped = !connector.stopListening;
          if (connector.stopListening) {
            try {
              await withGatewayTimeout(connector.stopListening(), GATEWAY_LISTENER_STOP_TIMEOUT_MS);
              stopped = true;
            } catch (_stopError) {
              console.warn(
                `[gateway.listener] event=stop_failed channel_id=${JSON.stringify(channel.id)} code=transport_stop_failed`
              );
            }
          }
          if (lease && stopped) {
            await this.runWithListenerTenantIdentity(listenerTenantId, () =>
              this.channelRepo.releaseListener(channel.id, lease!.claim_token)
            ).catch(() => undefined);
          }
          return;
        }
        this.listenerRetries.delete(key);
        this.activeListeners.set(key, connector);
        if (lease) {
          this.activeListenerLeases.set(key, { ...lease, tenant_id: listenerTenantId });
        }
        console.log(
          `[gateway.listener] event=${priorAttempt > 0 ? 'recovered' : 'started'} channel_id=${JSON.stringify(channel.id)} provider=${channel.channel_type}`
        );
      } catch (error) {
        const failure = gatewayListenerFailure(error);
        let stopped = !connector;
        if (connector?.stopListening) {
          try {
            await withGatewayTimeout(connector.stopListening(), GATEWAY_LISTENER_STOP_TIMEOUT_MS);
            stopped = true;
          } catch (_stopError) {
            console.warn(
              `[gateway.listener] event=stop_failed channel_id=${JSON.stringify(channel.id)} code=transport_stop_failed`
            );
          }
        }
        if (!stopped) {
          // An uncertain transport is fenced by lease expiry; never overlap it.
          this.listenerRetries.delete(key);
          this.activeListenerLeases.delete(key);
          return;
        }
        if (this.listenerLifecycleGenerations.get(key) !== generation) return;
        this.recordListenerFailure(channel, listenerTenantId, lease, failure, priorAttempt);
      }
    });
  }

  private recordListenerFailure(
    channel: GatewayChannel,
    tenantId: TenantID | string,
    lease: GatewayListenerLease | undefined,
    failure: ReturnType<typeof gatewayListenerFailure>,
    priorAttempt = 0
  ): void {
    const key = this.listenerKey(tenantId, channel.id);
    const attempt = priorAttempt + 1;
    const generation = ++this.listenerRetryGeneration;
    const state: GatewayListenerRetryState = {
      tenantId,
      channel,
      lease,
      attempt,
      generation,
      lifecycleGeneration: this.listenerLifecycleGenerations.get(key) ?? 0,
    };
    this.listenerRetries.set(key, state);
    if (lease) this.activeListenerLeases.set(key, { ...lease, tenant_id: tenantId });

    if (failure.kind === 'permanent') {
      console.warn(
        `[gateway.listener] event=start_blocked channel_id=${JSON.stringify(channel.id)} provider=${channel.channel_type} code=${failure.code} retry=operator_action`
      );
      return;
    }

    const delayMs = boundedBackoffDelay(
      attempt,
      {
        baseDelayMs: GATEWAY_LISTENER_RETRY_BASE_MS,
        maxDelayMs: GATEWAY_LISTENER_RETRY_MAX_MS,
        jitterRatio: 0.2,
      },
      Math.random()
    );
    console.warn(
      `[gateway.listener] event=start_retry_scheduled channel_id=${JSON.stringify(channel.id)} provider=${channel.channel_type} code=${failure.code} attempt=${attempt} delay_ms=${delayMs}`
    );
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.retryChannelListener(key, generation);
    }, delayMs);
    state.timer.unref?.();
  }

  private async retryChannelListener(key: string, generation: number): Promise<void> {
    const state = this.listenerRetries.get(key);
    if (
      !state ||
      state.generation !== generation ||
      this.listenerLifecycleGenerations.get(key) !== state.lifecycleGeneration ||
      this.listenerStopped ||
      this.listenerDraining
    )
      return;
    try {
      await this.runWithListenerTenantIdentity(state.tenantId, async () => {
        const current = await this.channelRepo.findById(state.channel.id);
        if (!current?.enabled || !hasListeningConfig(current)) {
          await this.cancelListenerRetry(state.tenantId, state.channel.id, true);
          return;
        }
        // A CRUD refresh changes the lifecycle generation and starts immediately.
        await this.startChannelListener(
          state.channel,
          state.tenantId,
          state.lease,
          state.lifecycleGeneration
        );
      });
    } catch {
      if (this.listenerRetries.get(key) !== state) return;
      this.recordListenerFailure(
        state.channel,
        state.tenantId,
        state.lease,
        gatewayListenerFailure(undefined),
        state.attempt
      );
    }
  }

  private invalidateListenerLifecycle(tenantId: TenantID | string, channelId: string): void {
    const key = this.listenerKey(tenantId, channelId);
    this.listenerLifecycleGenerations.set(
      key,
      (this.listenerLifecycleGenerations.get(key) ?? 0) + 1
    );
  }

  private async cancelListenerRetry(
    tenantId: TenantID | string,
    channelId: string,
    releaseClaim: boolean
  ): Promise<void> {
    const key = this.listenerKey(tenantId, channelId);
    const state = this.listenerRetries.get(key);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.listenerRetries.delete(key);
    const lease = this.activeListenerLeases.get(key);
    this.activeListenerLeases.delete(key);
    if (releaseClaim && lease) {
      await this.channelRepo.releaseListener(lease.channel_id, lease.claim_token);
    }
  }

  private async handleListenerInboundMessage(
    channel: GatewayChannel,
    tenantId: TenantID | string | undefined,
    msg: InboundMessage,
    lease?: GatewayListenerLease
  ): Promise<void> {
    if (!tenantId) {
      throw new Error(`Missing tenant context for gateway listener channel ${channel.id}`);
    }

    const queueKey = this.listenerKey(tenantId, `${channel.id}\0${msg.threadId}`);
    const prior = this.inboundThreadQueues.get(queueKey) ?? Promise.resolve();
    const current = prior
      .catch(() => undefined)
      .then(() =>
        this.runWithListenerTenantIdentity(tenantId, async () => {
          if (this.listenerDraining) throw new Error('Gateway listener is draining');

          let eventId: import('@agor/core/types').GatewayInboundEventID | undefined;
          let metadata = msg.metadata;
          let deliveryMetadata: Record<string, unknown> | undefined;
          if (this.durableListenerOwnership) {
            if (!lease || !msg.providerEventId) {
              throw new Error(
                `Provider ${channel.channel_type} did not supply a durable event identity or listener fence`
              );
            }
            const admitted = await this.inboundEventRepo.claim({
              channelId: channel.id,
              providerEventId: msg.providerEventId,
              threadId: msg.threadId,
              processingToken: lease.claim_token,
              leaseDurationMs: GATEWAY_EVENT_PROCESSING_LEASE_MS,
              requireListenerClaim: true,
            });
            if (admitted.outcome === 'completed_duplicate') return;
            if (admitted.outcome === 'in_progress_elsewhere') {
              throw new Error(
                'Gateway inbound event is still being processed by the previous listener owner'
              );
            }
            if (admitted.outcome === 'listener_lost') {
              throw new Error('Gateway listener ownership lost before inbound admission');
            }
            eventId = admitted.event.id;
            deliveryMetadata = admitted.event.delivery_metadata ?? undefined;
          }

          if (
            lease &&
            !(await this.channelRepo.listenerClaimIsCurrent(channel.id, lease.claim_token))
          ) {
            throw new Error('Gateway listener ownership lost before provider acknowledgement');
          }
          let skipProviderThreadMaterialization = false;
          if (
            channel.channel_type === 'discord' &&
            (() => {
              const discordMetadata = parseDiscordAuthorityMetadata(msg.metadata);
              return (
                discordMetadata?.[DISCORD_METADATA_KEY.isThread] === false &&
                typeof discordMetadata?.[DISCORD_METADATA_KEY.channelId] === 'string' &&
                typeof discordMetadata?.[DISCORD_METADATA_KEY.replyToMessageId] === 'string'
              );
            })()
          ) {
            // A proactive Discord seed is intentionally a legacy top-level
            // message.  Resolve it before the connector's provider-side
            // preparation so the first human reply does not create a second
            // public thread.
            const discordMetadata = parseDiscordAuthorityMetadata(msg.metadata);
            if (!discordMetadata) throw new Error('Malformed Discord authority metadata');
            const seedThreadId = buildDiscordMessageThreadKey(
              discordMetadata[DISCORD_METADATA_KEY.channelId] as string,
              discordMetadata[DISCORD_METADATA_KEY.replyToMessageId] as string
            );
            // Reserve the existing seed admission here as a read-before-
            // preparation gate. The create path repeats the same atomic
            // admission and receives the reserved identity.
            skipProviderThreadMaterialization = Boolean(
              await this.outboundRepo.admitReplySession(channel.id, seedThreadId)
            );
          }
          if (!deliveryMetadata) {
            // Keep the daemon source compatible with an already-installed
            // @agor/core declaration while watch mode refreshes its package
            // output after the connector contract changes.
            const prepareDelivery = msg.prepareDelivery as
              | ((context?: {
                  skipProviderThreadMaterialization?: boolean;
                }) => Promise<Record<string, unknown> | undefined>)
              | undefined;
            const prepared = await prepareDelivery?.({
              ...(skipProviderThreadMaterialization
                ? { skipProviderThreadMaterialization: true }
                : {}),
            });
            if (prepared) {
              if (eventId && lease) {
                const recorded = await this.inboundEventRepo.recordDeliveryMetadata({
                  eventId,
                  channelId: channel.id,
                  processingToken: lease.claim_token,
                  metadata: prepared,
                  requireListenerClaim: true,
                });
                if (!recorded) {
                  throw new Error(
                    'Gateway listener ownership lost while recording provider acknowledgement'
                  );
                }
              }
              deliveryMetadata = prepared;
            }
          }
          if (deliveryMetadata) metadata = { ...(metadata ?? {}), ...deliveryMetadata };
          if (
            lease &&
            !(await this.channelRepo.listenerClaimIsCurrent(channel.id, lease.claim_token))
          ) {
            throw new Error('Gateway listener ownership lost before inbound routing');
          }

          const result = await this.create({
            channel_key: channel.channel_key,
            thread_id:
              channel.channel_type === 'discord' &&
              typeof parseDiscordAuthorityMetadata(metadata)?.[DISCORD_METADATA_KEY.threadId] ===
                'string'
                ? (parseDiscordAuthorityMetadata(metadata)?.[
                    DISCORD_METADATA_KEY.threadId
                  ] as string)
                : msg.threadId,
            text: msg.text,
            user_name: msg.userId,
            ...(msg.files ? { files: msg.files } : {}),
            metadata,
            ...(eventId && lease
              ? {
                  gateway_inbound_event_id: eventId,
                  idempotency_task_id: gatewayInboundTaskId(eventId),
                  idempotency_session_id: gatewayInboundSessionId(eventId),
                  listener_claim_token: lease.claim_token,
                  listener_channel_id: channel.id,
                }
              : {}),
          });

          if (eventId && lease) {
            const completed = await this.inboundEventRepo.complete({
              eventId,
              channelId: channel.id,
              processingToken: lease.claim_token,
              ...(result.sessionId ? { sessionId: result.sessionId as SessionID } : {}),
              ...(result.taskId ? { taskId: result.taskId } : {}),
              requireListenerClaim: true,
            });
            if (!completed) {
              throw new Error('Gateway listener ownership lost before inbound completion');
            }
          }
        })
      );
    this.inboundThreadQueues.set(queueKey, current);
    try {
      await current;
    } finally {
      if (this.inboundThreadQueues.get(queueKey) === current) {
        this.inboundThreadQueues.delete(queueKey);
      }
    }
  }

  /**
   * Stop all active listeners (called on shutdown)
   */
  async stopListeners(): Promise<void> {
    this.listenerStopped = true;
    this.listenerDraining = true;
    if (this.listenerTimer) clearTimeout(this.listenerTimer);
    this.listenerTimer = null;
    if (this.mcpSlackSweepTimer) clearTimeout(this.mcpSlackSweepTimer);
    this.mcpSlackSweepTimer = null;
    this.mcpSlackRecoveryTenants.clear();
    this.mcpSlackRepairTenants.clear();
    this.mcpSlackRecoveryExpiryTimers.clear();
    this.mcpSlackDeliveryRetryTimers.clear();
    this.mcpSlackOAuthStartClaimTimers.clear();
    this.mcpSlackConnectExpiryTimers.clear();
    this.mcpSlackConnectRetryTimers.clear();
    const leases = new Map(this.activeListenerLeases);
    const retryKeys = new Set(this.listenerRetries.keys());
    for (const retry of this.listenerRetries.values()) {
      if (retry.timer) clearTimeout(retry.timer);
    }
    this.listenerRetries.clear();
    this.listenerLifecycleGenerations.clear();
    const stoppedTransports = new Set<string>();
    for (const key of retryKeys) stoppedTransports.add(key);
    for (const listenerKey of [...this.activeListeners.keys()]) {
      const separator = listenerKey.indexOf('\0');
      const tenantId = listenerKey.slice(0, separator);
      const channelId = listenerKey.slice(separator + 1);
      const stopped = await this.runWithListenerTenantIdentity(tenantId, () =>
        this.stopChannelListener(channelId, { releaseClaim: false })
      );
      if (stopped) stoppedTransports.add(listenerKey);
    }

    // Keep claims while callbacks already admitted by the provider drain. This
    // makes graceful shutdown finish occurrence completion before handoff. If
    // draining exceeds the bound, leave every claim to database expiry rather
    // than let a replacement overlap an old in-flight callback.
    let callbacksDrained = false;
    try {
      await withGatewayTimeout(
        Promise.allSettled([...this.inboundThreadQueues.values()]).then(() => undefined),
        GATEWAY_LISTENER_STOP_TIMEOUT_MS
      );
      callbacksDrained = true;
    } catch (_error) {
      console.warn('[gateway] In-flight listener callbacks did not drain before shutdown');
    }

    if (callbacksDrained) {
      for (const [listenerKey, lease] of leases) {
        if (!stoppedTransports.has(listenerKey)) continue;
        await this.runWithListenerTenantIdentity(lease.tenant_id, () =>
          this.channelRepo.releaseListener(lease.channel_id, lease.claim_token)
        ).catch((error) => {
          console.warn(
            `[gateway] Failed to release drained listener claim for ${lease.channel_id}:`,
            error
          );
        });
      }
    }
    this.activeChannelTenants.clear();
    console.log(
      `[distributed-work.gateway-listener] event="loop_stopped" instance_id=${JSON.stringify(this.workIdentity.instanceId)} boot_id=${JSON.stringify(this.workIdentity.bootId)} callbacks_drained=${callbacksDrained}`
    );
  }
}

/**
 * Service factory function
 */
export function createGatewayService(
  db: TenantScopeAwareDatabase,
  app: Application
): GatewayService {
  return new GatewayService(db, app);
}
