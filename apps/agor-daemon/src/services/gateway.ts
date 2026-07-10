/**
 * Gateway Service
 *
 * Core routing service that orchestrates message routing between
 * messaging platforms and Agor sessions. Custom service (not DrizzleService)
 * since it orchestrates across multiple repositories and services.
 */

import { PublicBaseUrlNotConfiguredError, requirePublicBaseUrl } from '@agor/core/config';
import {
  BranchRepository,
  GatewayChannelRepository,
  GatewayOutboundMessageRepository,
  getCurrentTenantId,
  getHiddenTenantId,
  MCPServerRepository,
  runWithoutTenantDatabaseScope,
  runWithTenantDatabaseScope,
  SessionRepository,
  shortId,
  type TenantScopeAwareDatabase,
  ThreadSessionMapRepository,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  GatewayConnector,
  GatewayContext,
  InboundFile,
  InboundMessage,
  SlackThreadHistoryRequest,
  SlackThreadHistoryResult,
} from '@agor/core/gateway';
import {
  formatGatewayContext,
  formatGatewayFollowUpRoutingMessage,
  formatGatewaySessionCreatedMessage,
  formatGatewaySystemPayload,
  getConnector,
  hasConnector,
  normalizeOutbound,
  parseGitHubThreadId,
} from '@agor/core/gateway';
import { resolveSessionDefaults } from '@agor/core/sessions';
import type {
  AgenticToolName,
  BranchPermissionLevel,
  ChannelType,
  GatewayChannel,
  GatewayOutboundMessage,
  GatewayOutboundMessageID,
  MCPServerID,
  MessageSource,
  Session,
  SessionID,
  Task,
  TenantID,
  ThreadSessionMap,
  User,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES, SessionStatus } from '@agor/core/types';
import { getSessionUrl } from '@agor/core/utils/url';
import { hasBranchPermission } from '../utils/branch-authorization.js';
import {
  buildPromptWithAttachments,
  ingestInboundImageAttachments,
} from '../utils/gateway-attachments.js';
import { deferWithTenantDatabaseScope } from '../utils/tenant-db-scope.js';

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
}

/**
 * Inbound message response
 */
interface PostMessageResult {
  success: boolean;
  sessionId: string;
  created: boolean;
}

/**
 * Outbound routing data (session → platform)
 */
interface RouteMessageData {
  session_id: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Outbound routing response
 */
interface RouteMessageResult {
  routed: boolean;
  channelType?: string;
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
  channel_type: 'slack';
  platform_channel_id: string;
  platform_message_id: string;
  platform_thread_id: string;
  platform_permalink?: string | null;
}

interface SlackOutboundTarget {
  kind: 'channel_id' | 'channel_name' | 'email';
  channel?: string;
  name?: string;
  email?: string;
}

interface SlackDirectConnector extends GatewayConnector {
  sendSlackMessage(req: {
    channel: string;
    text: string;
    blocks?: unknown[];
    thread_ts?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ ts: string; channel: string; thread_ts: string; permalink?: string | null }>;
  resolveChannelByName?(name: string): Promise<{ channel: string; name: string }>;
  openDmByEmail?(email: string): Promise<{ channel: string; user_id: string }>;
}

interface SlackHistoryConnector extends GatewayConnector {
  fetchThreadHistory(req: SlackThreadHistoryRequest): Promise<SlackThreadHistoryResult>;
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
    default:
      return false;
  }
}

export function tenantIdFromGatewayChannel(channel: GatewayChannel): TenantID | string | undefined {
  return getHiddenTenantId(channel);
}

function isSlackThinkingPlaceholder(text: string): boolean {
  return /^thinking\s*\.{3}$/i.test(text.trim());
}

function parseSlackOutboundTarget(target: string): SlackOutboundTarget {
  const trimmed = target.trim();
  const channelMatch = /^channel:([^:\s]+)$/.exec(trimmed);
  if (channelMatch) {
    return { kind: 'channel_id', channel: channelMatch[1] };
  }

  const channelNameMatch = /^channel_name:([^\s]+)$/.exec(trimmed);
  if (channelNameMatch) {
    return { kind: 'channel_name', name: channelNameMatch[1].replace(/^#/, '') };
  }

  if (/^#[^\s]+$/.test(trimmed)) {
    return { kind: 'channel_name', name: trimmed.slice(1) };
  }

  const emailMatch = /^(?:email:|user_email:)?([^@\s]+@[^@\s]+\.[^@\s]+)$/.exec(trimmed);
  if (emailMatch) {
    return { kind: 'email', email: emailMatch[1] };
  }

  throw new Error(
    'Invalid Slack outbound target. Expected channel:C123, #channel-name, channel_name:channel-name, or user@example.com'
  );
}

function redactProviderErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '[redacted-slack-token]')
    .replace(/xapp-[A-Za-z0-9-]+/g, '[redacted-slack-token]');
}

function previewText(text: string, maxChars = 500): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
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
  const slackSenderName =
    typeof args.metadata?.slack_user_name === 'string' ? args.metadata.slack_user_name : undefined;
  const slackSenderId =
    typeof args.metadata?.slack_user_id === 'string' ? args.metadata.slack_user_id : undefined;
  const slackSenderEmail =
    typeof args.metadata?.slack_user_email === 'string'
      ? args.metadata.slack_user_email
      : undefined;
  const slackChannelName =
    typeof args.metadata?.slack_channel_name === 'string'
      ? args.metadata.slack_channel_name
      : undefined;

  const lines = [
    '[Gateway context]',
    '',
    'This Slack thread began from a proactive Agor gateway message. Use the provenance below to understand what the human is replying to.',
    '',
    `Outbound seed ID: ${args.seed.id}`,
    `Originating session: ${args.seed.emitted_by_session_id ?? 'none'}`,
    `Originating task: ${args.seed.emitted_by_task_id ?? 'none'}`,
    `Originating schedule: ${args.seed.emitted_by_schedule_id ?? 'none'}`,
    `Emitted by Agor user: ${args.seed.emitted_by_user_id}`,
    `Gateway channel: ${args.channel.name} (${args.channel.id})`,
    `Slack thread: ${args.seed.platform_thread_id}`,
    `Slack channel: ${slackChannelName ?? args.seed.platform_channel_id}`,
    `Slack sender name: ${slackSenderName ?? 'unknown'}`,
    `Slack sender ID: ${slackSenderId ?? 'unknown'}`,
    `Slack sender email: ${slackSenderEmail ?? 'unknown'}`,
    '',
    'Original proactive Agor message:',
    quoteForPrompt(args.seed.message_text),
    '',
    'Human Slack reply:',
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
export class GatewayService {
  private db: TenantScopeAwareDatabase;
  private channelRepo: GatewayChannelRepository;
  private threadMapRepo: ThreadSessionMapRepository;
  private outboundRepo: GatewayOutboundMessageRepository;
  private branchRepo: BranchRepository;
  private sessionRepo: SessionRepository;
  private usersRepo: UsersRepository;

  private mcpServerRepo: MCPServerRepository;
  private userTokenRepo: UserMCPOAuthTokenRepository;
  private app: Application;

  /** Active Socket Mode listeners keyed by channel ID */
  private activeListeners = new Map<string, GatewayConnector>();

  /**
   * In-memory flag: true when at least one gateway channel exists.
   * Allows routeMessage() to skip the DB lookup entirely when the
   * gateway feature is not in use (the common case for most instances).
   * Updated on startup and whenever channels are created/deleted.
   */
  private hasActiveChannels = false;

  /**
   * GitHub message buffer: keyed by session_id, stores the latest message text.
   * For GitHub channels, we don't send every assistant message in real-time
   * (unlike Slack). Instead, we buffer and only send the last message when
   * the session turn completes (goes idle). Each new message overwrites the
   * previous one — only the final message matters.
   */
  private githubMessageBuffer = new Map<string, string>();

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
  private static SLACK_PROGRESS_MIN_UPDATE_MS = 2500;
  private static SLACK_STREAM_STATUS_REFRESH_MS = 300;
  private static SLACK_STREAMED_MESSAGE_CACHE_MAX = 500;

  constructor(db: TenantScopeAwareDatabase, app: Application) {
    this.db = db;
    this.channelRepo = new GatewayChannelRepository(db);
    this.threadMapRepo = new ThreadSessionMapRepository(db);
    this.outboundRepo = new GatewayOutboundMessageRepository(db);
    this.branchRepo = new BranchRepository(db);
    this.sessionRepo = new SessionRepository(db);
    this.usersRepo = new UsersRepository(db);

    this.mcpServerRepo = new MCPServerRepository(db);
    this.userTokenRepo = new UserMCPOAuthTokenRepository(db);
    this.app = app;
  }

  /**
   * Refresh the in-memory hasActiveChannels flag.
   * Called at startup and should be called when channels are created/deleted.
   */
  async refreshChannelState(): Promise<void> {
    const channels = await this.channelRepo.findAll();
    this.hasActiveChannels = channels.some((ch) => ch.enabled);
    console.log(
      `[gateway] refreshChannelState: found ${channels.length} channels, ${channels.filter((ch) => ch.enabled).length} enabled`
    );
  }

  /**
   * Send a system message to the platform thread (fire-and-forget).
   * Useful for giving the user visibility into what's happening.
   */
  private sendSystemMessage(
    channel: GatewayChannel,
    threadId: string,
    text: string,
    opts?: { suppressSlack?: boolean }
  ): void {
    // GitHub has its editable Processing comment. Slack keeps durable routing
    // messages (session links/errors) but suppresses transient lifecycle noise
    // like "creating session" and queued/status rows via suppressSlack.
    if (channel.channel_type === 'github') return;
    if (channel.channel_type === 'slack' && opts?.suppressSlack) return;

    if (!hasConnector(channel.channel_type as ChannelType)) return;
    try {
      // Prefer the active listener instance — webhook-based connectors (e.g. Teams)
      // store ConversationReferences in memory on the listener instance.
      // Creating a new connector via getConnector() would lose that state.
      const connector =
        this.activeListeners.get(channel.id) ??
        getConnector(channel.channel_type as ChannelType, channel.config);
      connector
        .sendMessage({
          threadId,
          ...formatGatewaySystemPayload(channel.channel_type as ChannelType, text),
        })
        .catch((err) => console.warn('[gateway] Debug message failed:', err));
    } catch {
      // Ignore — debug messages are best-effort
    }
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

  private async findSlackThreadAliasMapping(
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
        return (
          Array.isArray(metadata.slack_thread_aliases) &&
          metadata.slack_thread_aliases.includes(threadId)
        );
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
    deferWithTenantDatabaseScope(
      this.db,
      params,
      async () => {
        await this.updateProgress(data);
      },
      (error) => {
        console.warn('[gateway] Failed to update Slack progress after commit:', error);
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
    if (!this.hasActiveChannels) return;

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
      this.activeListeners.get(channel.id) ??
      getConnector(channel.channel_type as ChannelType, channel.config);
    const activeTaskId =
      typeof metadata.slack_status_task_id === 'string' ? metadata.slack_status_task_id : undefined;

    try {
      if (isTerminal) {
        try {
          await this.stopSlackTaskStream(activeTaskId, connector);
        } catch (error) {
          console.warn('[gateway] Failed to stop Slack task stream:', error);
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

      try {
        const loadingMessage = this.buildSlackAssistantLoadingMessage(data, metadataWithStart);
        await connector.setThreadStatus({
          threadId: slackThreadId,
          status: this.buildSlackAssistantStatus(data, metadataWithStart),
          loadingMessages: loadingMessage ? [loadingMessage] : undefined,
          iconEmoji: ':hourglass_flowing_sand:',
        });
      } catch (error) {
        console.warn('[gateway] Failed to set Slack assistant status:', error);
      }
    } catch (error) {
      console.warn('[gateway] Failed to update Slack progress status:', error);
    }
  }

  async handleMessageStreamingEvent(
    event: 'streaming:start' | 'streaming:chunk' | 'streaming:end' | 'streaming:error',
    data: Record<string, unknown>
  ): Promise<void> {
    if (!this.hasActiveChannels) return;

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
      this.activeListeners.get(channel.id) ??
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
            console.warn('[gateway] Failed to refresh Slack status after stream start:', error);
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
          console.warn('[gateway] Failed to refresh Slack status after stream append:', error);
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
    } catch (error) {
      this.slackStreamsByTask.delete(taskKey);
      this.slackStreamTaskByMessage.delete(messageId);
      console.warn('[gateway] Failed to mirror message stream to Slack:', error);
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

  async emitMessage(data: EmitGatewayMessageData): Promise<EmitGatewayMessageResult> {
    const channel = await this.channelRepo.findById(data.gatewayChannelId);
    if (!channel) throw new Error('Gateway channel not found');
    if (!channel.enabled) throw new Error('Gateway channel is disabled');
    if (channel.channel_type !== 'slack')
      throw new Error('Gateway outbound v0 only supports Slack channels');

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

    const parsedTarget = parseSlackOutboundTarget(target);
    const connector = getConnector(
      channel.channel_type as ChannelType,
      channel.config
    ) as SlackDirectConnector;
    if (typeof connector.sendSlackMessage !== 'function') {
      throw new Error('Slack connector does not support direct outbound sends');
    }

    const { text, blocks } = normalizeOutbound(
      connector.formatMessage ? connector.formatMessage(data.message) : data.message
    );

    let resolvedChannel: string;
    const resolvedTargetMetadata: Record<string, unknown> = {
      target,
      target_kind: parsedTarget.kind,
    };
    if (parsedTarget.kind === 'channel_id') {
      resolvedChannel = parsedTarget.channel as string;
    } else if (parsedTarget.kind === 'channel_name') {
      if (typeof connector.resolveChannelByName !== 'function') {
        throw new Error('Slack connector does not support channel-name resolution');
      }
      let resolved: Awaited<ReturnType<NonNullable<SlackDirectConnector['resolveChannelByName']>>>;
      try {
        resolved = await connector.resolveChannelByName(parsedTarget.name as string);
      } catch (error) {
        throw new Error(`Slack API failure: ${redactProviderErrorMessage(error)}`);
      }
      resolvedChannel = resolved.channel;
      resolvedTargetMetadata.resolved_channel_id = resolved.channel;
      resolvedTargetMetadata.resolved_channel_name = resolved.name;
    } else {
      if (typeof connector.openDmByEmail !== 'function') {
        throw new Error('Slack connector does not support email-to-DM resolution');
      }
      let resolved: Awaited<ReturnType<NonNullable<SlackDirectConnector['openDmByEmail']>>>;
      try {
        resolved = await connector.openDmByEmail(parsedTarget.email as string);
      } catch (error) {
        throw new Error(`Slack API failure: ${redactProviderErrorMessage(error)}`);
      }
      resolvedChannel = resolved.channel;
      resolvedTargetMetadata.resolved_channel_id = resolved.channel;
      resolvedTargetMetadata.resolved_user_id = resolved.user_id;
    }

    let sent: Awaited<ReturnType<SlackDirectConnector['sendSlackMessage']>>;
    try {
      sent = await connector.sendSlackMessage({
        channel: resolvedChannel,
        text,
        blocks,
        ...(data.threadTs ? { thread_ts: data.threadTs } : {}),
        metadata: {
          ...(data.purpose ? { purpose: data.purpose } : {}),
          ...resolvedTargetMetadata,
        },
      });
    } catch (error) {
      throw new Error(`Slack API failure: ${redactProviderErrorMessage(error)}`);
    }

    const platformThreadId = `${sent.channel}-${sent.thread_ts || sent.ts}`;
    const row = await this.outboundRepo.create({
      gateway_channel_id: channel.id,
      channel_type: 'slack',
      platform_channel_id: sent.channel,
      platform_message_id: sent.ts,
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
      },
    });

    await this.channelRepo.updateLastMessage(channel.id);
    console.log(
      `[gateway] Proactive Slack outbound ${shortId(row.id)} sent via ${shortId(channel.id)} to ${target}`
    );

    return {
      success: true,
      gateway_outbound_message_id: row.id,
      gateway_channel_id: channel.id,
      channel_type: 'slack',
      platform_channel_id: sent.channel,
      platform_message_id: sent.ts,
      platform_thread_id: platformThreadId,
      ...(sent.permalink ? { platform_permalink: sent.permalink } : {}),
    };
  }

  private async fetchExistingSessionUrlForGatewayUser(
    sessionId: SessionID,
    user: User
  ): Promise<string | null> {
    try {
      const baseUrl = await requirePublicBaseUrl();
      return getSessionUrl(sessionId, baseUrl);
    } catch (error) {
      if (!(error instanceof PublicBaseUrlNotConfiguredError)) {
        console.warn('[gateway] Failed to build public session URL:', error);
      }
    }

    try {
      const sessionsService = this.app.service('sessions') as {
        get: (id: string, params?: { user: User }) => Promise<Session & { url?: string | null }>;
      };
      const sessionWithUrl = await sessionsService.get(sessionId, { user });
      const sessionUrl = sessionWithUrl.url || null;
      if (!sessionUrl) return null;
      const hostname = new URL(sessionUrl).hostname;
      if (hostname === '0.0.0.0') return null;
      return sessionUrl;
    } catch (error) {
      console.warn('[gateway] Failed to fetch session URL:', error);
      return null;
    }
  }

  /**
   * Inbound routing: platform → session
   *
   * Authenticates via channel_key, looks up or creates a session
   * for the given thread, and sends the prompt to the session.
   */
  async create(data: PostMessageData): Promise<PostMessageResult> {
    // 1. Authenticate via channel_key
    const channel = await this.channelRepo.findByKey(data.channel_key);
    if (!channel) {
      throw new Error('Invalid channel_key');
    }

    if (!channel.enabled) {
      throw new Error('Channel is disabled');
    }

    // 2. Look up existing thread mapping
    let existingMapping = await this.threadMapRepo.findByChannelAndThread(
      channel.id,
      data.thread_id
    );
    if (!existingMapping && channel.channel_type === 'slack') {
      existingMapping = await this.findSlackThreadAliasMapping(channel.id, data.thread_id);
      if (existingMapping) {
        console.log(
          `[gateway] Found Slack thread alias: ${data.thread_id} → ${existingMapping.thread_id}`
        );
      }
    }
    if (existingMapping && channel.channel_type === 'slack') {
      console.log(
        `[gateway] Slack inbound thread ${data.thread_id} → session ${shortId(existingMapping.session_id)} (root ${existingMapping.thread_id})`
      );
    }

    const outboundSeed =
      !existingMapping && channel.channel_type === 'slack'
        ? await this.outboundRepo.findUnconsumedByChannelAndThread(channel.id, data.thread_id)
        : null;
    if (outboundSeed) {
      console.log(
        `[gateway] Slack inbound thread ${data.thread_id} is replying to outbound seed ${shortId(outboundSeed.id)}`
      );
    }

    // 3. Cross-channel ownership check.
    // Non-Slack connectors such as GitHub still use one logical platform thread
    // per issue/PR. Slack explicitly supports multiple distinct bots in the same
    // human thread, so do not globally reserve a Slack thread for one gateway
    // channel. Slack non-mentions are filtered by the connector; explicit mentions
    // may create one mapping per gateway channel.
    if (!existingMapping && channel.channel_type !== 'slack') {
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
    const alignSlackUsers =
      channelConfig.align_slack_users === true || data.metadata?.align_slack_users === true;
    const alignGitHubUsers =
      channelConfig.align_github_users === true || data.metadata?.align_github_users === true;

    // Only fetch and use channel owner when NO alignment is active.
    // When alignment is ON, agor_user_id may be empty (the "Post messages as"
    // field is hidden in the UI), so we must not fetch it unconditionally.
    let user: User = null as unknown as User;
    if (!alignSlackUsers && !alignGitHubUsers) {
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
          } catch (err) {
            console.warn('[gateway] Failed to post config error comment:', err);
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

    // --- Slack user alignment ---
    if (alignSlackUsers) {
      if (data.metadata?.slack_user_email && typeof data.metadata.slack_user_email === 'string') {
        const email = data.metadata.slack_user_email.toLowerCase().trim();
        const matchedUser = await this.usersRepo.findByEmailForAlignment(email);

        if (matchedUser) {
          console.log(
            `[gateway] Slack user aligned: ${email} → Agor user ${shortId(matchedUser.user_id)} (${matchedUser.name || matchedUser.email})`
          );
          user = await usersService.get(matchedUser.user_id);
        } else {
          console.log(`[gateway] Slack user alignment failed: no Agor user with email ${email}`);
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
        console.log(
          `[gateway] Slack user alignment failed: could not resolve email for Slack user ${data.user_name ?? 'unknown'} (thread=${data.thread_id})`
        );
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
      let resolved = false;

      // Tier 1: Explicit user_map (GitHub login → Agor email)
      // Read user_map from fresh channel.config (NOT from connector metadata,
      // which can be stale since the connector holds config from construction time).
      const userMap = channelConfig.user_map as Record<string, string> | undefined;
      const mappedEmail =
        githubLogin && userMap?.[githubLogin] ? userMap[githubLogin].toLowerCase().trim() : null;

      if (mappedEmail) {
        const matchedUser = await this.usersRepo.findByEmailForAlignment(mappedEmail);
        if (matchedUser) {
          console.log(
            `[gateway] GitHub user aligned via user_map: ${githubLogin} → ${mappedEmail} → Agor user ${shortId(matchedUser.user_id)}`
          );
          user = await usersService.get(matchedUser.user_id);
          resolved = true;
        } else {
          console.warn(
            `[gateway] user_map entry ${githubLogin} → ${mappedEmail} but no Agor user with that email`
          );
        }
      }

      // Tier 2: GitHub public email → Agor user email match
      if (!resolved) {
        const githubEmail =
          data.metadata?.github_user_email && typeof data.metadata.github_user_email === 'string'
            ? data.metadata.github_user_email.toLowerCase().trim()
            : null;

        if (githubEmail) {
          const matchedUser = await this.usersRepo.findByEmailForAlignment(githubEmail);
          if (matchedUser) {
            console.log(
              `[gateway] GitHub user aligned via email: ${githubLogin} (${githubEmail}) → Agor user ${shortId(matchedUser.user_id)}`
            );
            user = await usersService.get(matchedUser.user_id);
            resolved = true;
          }
        }
      }

      // Tier 3: Reject — no silent fallback to channel owner
      if (!resolved) {
        console.log(
          `[gateway] GitHub user alignment failed: no Agor mapping for ${githubLogin ?? 'unknown'} (thread=${data.thread_id})`
        );
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

    let sessionId: SessionID;
    let created = false;
    let mcpAuthWarning: string | undefined;
    let mappingForCursor: ThreadSessionMap | null = existingMapping ?? null;

    // Resolve agentic config: channel config > user defaults > system defaults.
    // Channel-level agentic_config maps to the helper's `overrides` (it's the
    // gateway's analogue of an MCP tool's explicit args). Codex sub-config and
    // MCP server lists are first-class fields on `GatewayAgenticConfig`, so
    // thread them all through the helper — otherwise the executor's per-tool
    // settings (which Codex reads from `permission_config.codex`, not `mode`)
    // get silently dropped.
    const agenticConfig = channel.agentic_config;
    const agenticTool: AgenticToolName = (agenticConfig?.agent as AgenticToolName) ?? 'claude-code';
    const {
      permission_config: gatewayPermissionConfig,
      model_config: gatewayModelConfig,
      mcp_server_ids: gatewayMcpServerIds,
    } = resolveSessionDefaults({
      agenticTool,
      user,
      overrides: {
        permissionMode: agenticConfig?.permissionMode,
        modelConfig: agenticConfig?.modelConfig,
        codexSandboxMode: agenticConfig?.codexSandboxMode,
        codexApprovalPolicy: agenticConfig?.codexApprovalPolicy,
        codexNetworkAccess: agenticConfig?.codexNetworkAccess,
        mcpServerIds: agenticConfig?.mcpServerIds,
      },
    });
    const permissionMode = gatewayPermissionConfig.mode;

    if (existingMapping) {
      // Existing thread → existing session
      sessionId = existingMapping.session_id;

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
        create: (data: Partial<Session>) => Promise<Session>;
        setMCPServers: (sessionId: SessionID, serverIds: string[], label: string) => Promise<void>;
      };

      this.sendSystemMessage(
        channel,
        data.thread_id,
        `Creating new ${agenticTool} session (${permissionMode} mode)...`,
        { suppressSlack: true }
      );

      // Build custom_context with gateway metadata + platform-specific fields
      const gatewaySource: Record<string, unknown> = {
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

      const session = await sessionsService.create({
        title: data.text.substring(0, 100),
        description: data.text,
        branch_id: channel.target_branch_id,
        created_by: user.user_id,
        // Stamp session with creator's unix_username for executor impersonation.
        // Normally set by the setSessionUnixUsername hook, but that hook skips
        // internal calls (no provider). Gateway sessions are internal, so we
        // must set it explicitly. When user alignment is active, this uses the
        // aligned user's unix_username; otherwise the channel owner's.
        unix_username: user.unix_username ?? null,
        status: SessionStatus.IDLE,
        agentic_tool: agenticTool,
        permission_config: gatewayPermissionConfig,
        model_config: gatewayModelConfig,
        tasks: [],
        // Denormalized gateway metadata (immutable snapshot at creation time)
        // Avoids N+1 lookups when rendering board cards
        custom_context: {
          gateway_source: gatewaySource,
        },
      });

      sessionId = session.session_id;
      created = true;

      // Attach MCP servers from channel agentic config (reuses sessions service logic)
      // gatewayMcpServerIds came out of resolveSessionDefaults, so user-default
      // inheritance is already applied (channel config > user defaults > []).
      if (gatewayMcpServerIds.length > 0) {
        await sessionsService.setMCPServers(
          session.session_id as SessionID,
          gatewayMcpServerIds,
          'gateway'
        );

        // Check which MCP servers are not authenticated for this user
        const unauthedMcpNames: string[] = [];
        for (const serverId of gatewayMcpServerIds) {
          try {
            const server = await this.mcpServerRepo.findById(serverId);
            if (server?.auth?.type === 'oauth') {
              const oauthMode = server.auth.oauth_mode || 'per_user';
              // Unified token store — shared rows key on user_id=NULL, per_user on the caller's id.
              const tokenUserId = oauthMode === 'shared' ? null : (user.user_id as UserID);
              // Count a row with a valid refresh_token as "authed" even if the
              // access_token is expired — the inject hook will JIT-refresh it
              // before handing it to the executor. This avoids spurious
              // "not authenticated" warnings for users who are one refresh away.
              const row = await this.userTokenRepo.getToken(tokenUserId, serverId as MCPServerID);
              const accessValid = !!(
                row?.oauth_access_token &&
                (!row.oauth_token_expires_at || row.oauth_token_expires_at > new Date())
              );
              const refreshable = !!row?.oauth_refresh_token;
              if (!accessValid && !refreshable) {
                unauthedMcpNames.push(server.display_name || server.name);
              }
            }
          } catch {
            // Non-fatal — skip auth check for this server
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
            }
          : (data.metadata ?? null);
      mappingForCursor = await this.threadMapRepo.create({
        channel_id: channel.id,
        thread_id: data.thread_id,
        session_id: session.session_id,
        branch_id: channel.target_branch_id,
        status: 'active',
        metadata: initialMappingMetadata,
      });

      if (outboundSeed) {
        await this.outboundRepo.markConsumed(
          outboundSeed.id as GatewayOutboundMessageID,
          session.session_id as SessionID
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

      // For GitHub channels: edit the "Processing..." comment to include the session link.
      // The processing_comment_id was stored in inbound metadata by the GitHub connector.
      if (channel.channel_type === 'github' && data.metadata?.processing_comment_id) {
        try {
          const connector = getConnector(channel.channel_type as ChannelType, channel.config);
          const processingText = sessionUrl
            ? `⏳ Processing... [View session](${sessionUrl})`
            : `⏳ Processing in session \`${shortId(sessionId)}\`...`;
          await connector.sendMessage({
            threadId: data.thread_id,
            text: processingText,
            metadata: { edit_comment_id: data.metadata.processing_comment_id },
          });
        } catch (err) {
          console.warn('[gateway] Failed to update processing comment with session URL:', err);
        }
      }
    }

    // Touch channel last_message_at
    await this.channelRepo.updateLastMessage(channel.id);

    // 4. Send prompt via /sessions/:id/prompt — it handles queue-vs-execute internally
    //    (auto-queues when session is busy or has queued items, executes when idle)
    try {
      const promptService = this.app.service('/sessions/:id/prompt') as {
        create: (
          data: { prompt: string; permissionMode?: string; messageSource?: MessageSource },
          params: Record<string, unknown>
        ) => Promise<Task>;
      };

      // For Slack mentions, include catch-up thread context. The connector now
      // requires explicit mentions for channel-like Slack conversations, so each
      // delivered prompt advances the last-delivered cursor. Non-mention replies
      // are picked up here the next time the bot is summoned.
      let promptText = data.text;
      let slackCursorTsToWrite: string | undefined;
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
          this.activeListeners.get(channel.id) ??
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
          } catch (error) {
            console.warn('[gateway] Failed to fetch Slack thread catch-up context:', error);
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
      }

      // Download Slack image attachments server-side and fold their stored
      // paths into the prompt so the agent can Read them. Gated on the
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
          const { paths, failed } = await ingestInboundImageAttachments({
            files: data.files,
            botToken,
          });
          failedAttachments = failed;
          if (paths.length > 0) {
            promptText = buildPromptWithAttachments(promptText, paths);
            console.log(
              `[gateway] Ingested ${paths.length} Slack attachment(s) for session ${shortId(sessionId)}`
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
        (created && (channel.channel_type === 'github' || !!outboundSeed));
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
      const task = await promptService.create(
        { prompt: promptText, permissionMode, messageSource: 'gateway' },
        {
          route: { id: sessionId },
          user,
          ...(tenantId ? { tenant: { tenant_id: tenantId, source: 'explicit' as const } } : {}),
        }
      );

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
          `[gateway] Message queued for session ${shortId(sessionId)} at position ${task.queue_position}`
        );
        this.sendSystemMessage(
          channel,
          data.thread_id,
          `Session is busy, message queued at position ${task.queue_position}`,
          { suppressSlack: true }
        );
        this.updateProgressAfterCommit({
          session_id: sessionId,
          state: 'queued',
          task_id: task.task_id,
          queue_position: task.queue_position,
        });
      } else {
        console.log(
          `[gateway] Prompt sent to session ${shortId(sessionId)} via /sessions/:id/prompt`
        );
        this.updateProgressAfterCommit({
          session_id: sessionId,
          state: 'working',
          task_id: task.task_id,
        });
      }
    } catch (error) {
      console.error('[gateway] Failed to send prompt to session:', error);
      this.sendSystemMessage(channel, data.thread_id, `Error sending prompt: ${error}`);
      this.updateProgressAfterCommit({
        session_id: sessionId,
        state: 'failed',
        error_message: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      success: true,
      sessionId,
      created,
    };
  }

  /**
   * Outbound routing: session → platform
   *
   * Looks up session in thread_session_map. If no mapping exists,
   * returns a cheap no-op. Uses platform connectors to send messages.
   */
  async routeMessage(data: RouteMessageData): Promise<RouteMessageResult> {
    // Fast path: skip DB lookup entirely when no channels are configured
    if (!this.hasActiveChannels) {
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

    // Check if we have a connector for this channel type
    if (!hasConnector(channel.channel_type as ChannelType)) {
      console.warn(`[gateway] No connector for channel type: ${channel.channel_type}`);
      return { routed: false };
    }

    // Touch timestamps
    await this.threadMapRepo.updateLastMessage(mapping.id);
    await this.channelRepo.updateLastMessage(channel.id);

    // For GitHub channels, buffer the message instead of sending immediately.
    // Only the last message will be posted when the session goes idle (via flushGitHubBuffer).
    // This prevents noisy intermediate messages from cluttering PR threads.
    if (channel.channel_type === 'github') {
      this.githubMessageBuffer.set(data.session_id, data.message);
      console.log(
        `[gateway] Buffered GitHub message for session ${shortId(data.session_id)} (${data.message.length} chars)`
      );
      return { routed: true, channelType: 'github' };
    }

    // Non-GitHub channels (e.g. Slack, Teams): send immediately
    try {
      // Prefer the active listener instance — webhook-based connectors (e.g. Teams)
      // store ConversationReferences in memory on the listener instance.
      const connector =
        this.activeListeners.get(channel.id) ??
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

      const sentTs = await connector.sendMessage({
        threadId,
        text,
        blocks,
        metadata: data.metadata,
      });
      if (channel.channel_type === 'slack') {
        await this.addSlackThreadAlias(mapping, sentTs, 'message');
      }

      console.log(`[gateway] Routed message to ${channel.channel_type} thread ${threadId}`);
    } catch (error) {
      console.error(`[gateway] Failed to route message to ${channel.channel_type}:`, error);
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
    deferWithTenantDatabaseScope(
      this.db,
      params,
      async () => {
        await this.routeMessage(data);
      },
      (error) => {
        console.warn('[gateway] Failed to route message after commit:', error);
      }
    );
  }

  /**
   * Flush the GitHub message buffer for a session.
   *
   * Called when a session transitions to idle (turn complete). Posts the
   * last buffered message as a PR/issue comment by editing the "Processing..."
   * comment. If no buffered message exists, this is a no-op.
   */
  async flushGitHubBuffer(sessionId: string): Promise<void> {
    const bufferedMessage = this.githubMessageBuffer.get(sessionId);
    if (!bufferedMessage) {
      return; // No buffered message — nothing to flush
    }

    // Remove from buffer immediately (prevent double-flush)
    this.githubMessageBuffer.delete(sessionId);

    // Look up session → thread mapping
    const mapping = await this.threadMapRepo.findBySession(sessionId);
    if (!mapping) {
      console.warn(
        `[gateway] flushGitHubBuffer: no thread mapping for session ${shortId(sessionId)}`
      );
      return;
    }

    const channel = await this.channelRepo.findById(mapping.channel_id);
    if (!channel?.enabled || channel.channel_type !== 'github') {
      return;
    }

    try {
      const connector = getConnector(channel.channel_type as ChannelType, channel.config);

      const { text, blocks } = normalizeOutbound(
        connector.formatMessage ? connector.formatMessage(bufferedMessage) : bufferedMessage
      );

      // Edit the "Processing..." comment with the final response
      const outboundMetadata: Record<string, unknown> = {};
      if (
        mapping.metadata &&
        typeof (mapping.metadata as Record<string, unknown>).processing_comment_id === 'number'
      ) {
        outboundMetadata.edit_comment_id = (
          mapping.metadata as Record<string, unknown>
        ).processing_comment_id;
      }

      await connector.sendMessage({
        threadId: mapping.thread_id,
        text,
        blocks,
        metadata: outboundMetadata,
      });

      console.log(
        `[gateway] Flushed GitHub buffer for session ${shortId(sessionId)} → ${mapping.thread_id} (${bufferedMessage.length} chars)`
      );
    } catch (error) {
      // Re-queue the message so it can be retried on next flush (e.g. session
      // goes idle again, or daemon restarts). Without this, a transient GitHub
      // API error would permanently lose the agent's final response.
      this.githubMessageBuffer.set(sessionId, bufferedMessage);
      console.error(
        `[gateway] Failed to flush GitHub buffer for session ${shortId(sessionId)} (re-queued):`,
        error
      );
    }
  }

  /**
   * Start Socket Mode listeners for all enabled channels that support it.
   * Called once at daemon startup. Inbound messages are routed through
   * the gateway's create() method (same path as webhook POST).
   */
  async startListeners(): Promise<void> {
    const channels = await this.channelRepo.findAll();
    const eligible = channels.filter(
      (ch) => ch.enabled && hasConnector(ch.channel_type as ChannelType) && hasListeningConfig(ch)
    );

    if (eligible.length === 0) {
      console.log('[gateway] No channels with listener config (Socket Mode / polling)');
      return;
    }

    for (const channel of eligible) {
      await this.startChannelListener(channel);
    }
  }

  /**
   * Start or stop a Socket Mode listener for a single channel based on its enabled state
   * (public wrapper for hook usage)
   */
  async startListenerForChannel(channelId: string): Promise<void> {
    const channel = await this.channelRepo.findById(channelId);
    if (!channel) {
      console.warn(`[gateway] Cannot manage listener: channel ${channelId} not found`);
      return;
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
    if (this.activeListeners.has(channelId)) {
      console.log(
        `[gateway] Restarting listener for channel "${channel.name}" to pick up config changes`
      );
      await this.stopChannelListener(channelId);
    }

    // Start with fresh config
    await this.startChannelListener(channel);
  }

  /**
   * Stop a Socket Mode listener for a single channel
   */
  async stopChannelListener(channelId: string): Promise<void> {
    const connector = this.activeListeners.get(channelId);
    if (!connector) {
      return; // Not listening
    }

    // Always remove from activeListeners so a fresh start can proceed,
    // even if stopListening() throws (e.g. socket already closed).
    this.activeListeners.delete(channelId);

    try {
      if (connector.stopListening) {
        await connector.stopListening();
      }
      console.log(`[gateway] Listener stopped for channel ${shortId(channelId)}`);
    } catch (error) {
      // Old socket may still be alive — duplicate inbound messages are possible
      // until the next daemon restart. See: listener lifecycle serialization (tech debt).
      console.error(
        `[gateway] Error stopping listener for ${channelId} (old socket may still be alive):`,
        error
      );
    }
  }

  /**
   * Start a Socket Mode listener for a single channel
   */
  private async startChannelListener(channel: GatewayChannel): Promise<void> {
    if (this.activeListeners.has(channel.id)) {
      return; // Already listening
    }

    const listenerTenantId = tenantIdFromGatewayChannel(channel) ?? getCurrentTenantId();

    return runWithoutTenantDatabaseScope(async () => {
      try {
        const connector = getConnector(channel.channel_type as ChannelType, channel.config);

        if (!connector.startListening) {
          return; // Connector doesn't support listening
        }

        const callback = (msg: InboundMessage) => {
          this.handleListenerInboundMessage(channel, listenerTenantId, msg).catch((error) => {
            console.error(
              `[gateway] Failed to process inbound message for channel ${channel.name}:`,
              error
            );
          });
        };

        await connector.startListening(callback);
        this.activeListeners.set(channel.id, connector);
        console.log(`[gateway] Socket Mode listener started for channel "${channel.name}"`);
      } catch (error) {
        console.error(`[gateway] Failed to start listener for channel "${channel.name}":`, error);
      }
    });
  }

  private async handleListenerInboundMessage(
    channel: GatewayChannel,
    tenantId: TenantID | string | undefined,
    msg: InboundMessage
  ): Promise<void> {
    if (!tenantId) {
      throw new Error(`Missing tenant context for gateway listener channel ${channel.id}`);
    }

    await runWithTenantDatabaseScope(this.db, tenantId, async () => {
      await this.create({
        channel_key: channel.channel_key,
        thread_id: msg.threadId,
        text: msg.text,
        user_name: msg.userId,
        ...(msg.files ? { files: msg.files } : {}),
        metadata: msg.metadata,
      });
    });
  }

  /**
   * Stop all active listeners (called on shutdown)
   */
  async stopListeners(): Promise<void> {
    for (const [channelId, connector] of this.activeListeners) {
      try {
        if (connector.stopListening) {
          await connector.stopListening();
        }
        console.log(`[gateway] Listener stopped for channel ${shortId(channelId)}`);
      } catch (error) {
        console.error(`[gateway] Error stopping listener for ${channelId}:`, error);
      }
    }
    this.activeListeners.clear();
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
