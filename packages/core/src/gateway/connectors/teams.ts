/** Microsoft Teams connector and pure activity normalization helpers.
 *
 * HTTP ingress is owned by the daemon's shared route. This connector is
 * intentionally stateless: outbound workers provide a decrypted durable
 * ConversationReference and the Agents SDK owns Bot Framework auth/client
 * behavior. There is no per-channel listener or process-local address map. */

import { createHash } from 'node:crypto';
import { Activity } from '@microsoft/agents-activity';
import { type AuthConfiguration, MsalTokenProvider } from '@microsoft/agents-hosting';
import type {
  ChannelType,
  GatewayConnectionTestFailure,
  GatewayConnectionTestResult,
  TeamsChannelPostsResult,
  TeamsGatewayConfig,
  TeamsThreadHistoryResult,
} from '../../types/gateway';
import type {
  GatewayConnector,
  GatewayProviderHistoryRequest,
  GatewayProviderHistoryResult,
  InboundFile,
  InboundSkippedFile,
} from '../connector';
import { GATEWAY_READABLE_MIMES, readableMimeForFilename } from '../readable-files';
import { isTeamsFileDownloadUrl, isTeamsTokenHost } from '../teams-service-url';
import {
  fetchTeamsThreadHistory,
  listTeamsChannelPosts,
  type TeamsChannelPostsRequest,
  type TeamsThreadHistoryRequest,
} from './teams-channel-history';
import {
  fetchTeamsTeamChannels,
  type TeamsGraphCacheScope,
  type TeamsTeamChannel,
} from './teams-graph';
import { fetchTeamsProviderHistory } from './teams-history';
import {
  botFrameworkScope,
  type PreparedTeamsSend,
  prepareTeamsSend,
  startTeamsChannelThread,
  type TeamsAccessTokenProvider,
  type TeamsChannelThreadResult,
  TeamsSendError,
} from './teams-send';

/** Bot Framework resource whose app-only token proves the bot credentials. */
const TEAMS_BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com';
const TEAMS_PROBE_TIMEOUT_MS = 10_000;
const TEAMS_MEMBER_LOOKUP_TIMEOUT_MS = 5_000;

/** What a passing Teams credential probe cannot prove. */
export const TEAMS_NOT_VERIFIABLE = [
  'The Azure Bot messaging endpoint points at this channel callback URL',
  'The Teams app is installed in the team, group chat, or personal scope',
  'Inbound activities reach Agor through your public HTTPS ingress',
  'Resource-specific consent for channel catch-up',
] as const;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Map Entra token-endpoint error codes to bounded operator guidance. */
function teamsTokenFailureReason(errorCodes: unknown, status: number): string {
  const codes = Array.isArray(errorCodes) ? errorCodes.filter((c) => typeof c === 'number') : [];
  if (codes.includes(7000215) || codes.includes(7000222)) {
    return 'The app password is invalid or expired. Use the client secret value, not its ID.';
  }
  if (codes.includes(700016)) {
    return 'The app ID is not registered in this Microsoft tenant.';
  }
  if (codes.includes(90002) || codes.includes(900023)) {
    return 'The Microsoft tenant ID was not found.';
  }
  return `Microsoft identity platform rejected the credentials (HTTP ${status}).`;
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Prove the Teams bot credentials with an uncached client-credentials token
 * request for the Bot Framework resource in the configured tenant. The token
 * is inspected for identity and then discarded; it is never stored or logged.
 */
export async function probeTeamsCredentials(
  config: Pick<TeamsGatewayConfig, 'app_id' | 'app_password' | 'microsoft_tenant_id'>,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<GatewayConnectionTestResult> {
  const notVerifiable = [...TEAMS_NOT_VERIFIABLE];
  const fail = (failure: GatewayConnectionTestFailure): GatewayConnectionTestResult => ({
    ok: false,
    failures: [failure],
    notVerifiable,
  });
  const appId = config.app_id?.trim();
  const tenantId = config.microsoft_tenant_id?.trim();
  if (!appId || !config.app_password || !tenantId) {
    return fail({
      capability: 'config',
      reason: 'App ID, app password, and Microsoft tenant ID are required.',
    });
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: appId,
          client_secret: config.app_password,
          scope: `${TEAMS_BOT_FRAMEWORK_SCOPE}/.default`,
        }).toString(),
        signal: AbortSignal.timeout(options.timeoutMs ?? TEAMS_PROBE_TIMEOUT_MS),
      }
    );
  } catch {
    return fail({
      capability: 'app_password',
      reason: 'Could not reach the Microsoft identity platform. Check outbound network access.',
    });
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // A non-JSON body is classified by status below.
  }
  if (!response.ok || typeof body.access_token !== 'string') {
    return fail({
      capability: 'app_password',
      reason: teamsTokenFailureReason(body.error_codes, response.status),
    });
  }
  const claims = decodeJwtClaims(body.access_token);
  const tokenAppId = claims?.appid ?? claims?.azp;
  if (
    (typeof tokenAppId === 'string' && tokenAppId !== appId) ||
    (typeof claims?.tid === 'string' && claims.tid.toLowerCase() !== tenantId.toLowerCase())
  ) {
    return fail({
      capability: 'app_id',
      reason: 'The issued token does not match the configured app ID and tenant.',
    });
  }
  return {
    ok: true,
    verifiedInstallationId: appId,
    bot: { userId: `28:${appId}`, name: appId },
    verification: { status: 'verified', warnings: [] },
    failures: [],
    notVerifiable,
  };
}

/** Email-bearing fields the Bot Connector returns for a conversation member. */
export interface TeamsMemberIdentity {
  email: string | null;
  userPrincipalName: string | null;
  aadObjectId: string | null;
}

/** A member lookup failure that may succeed on retry (timeouts, 429, 5xx). */
export class TeamsMemberLookupError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(`Teams member lookup failed: ${code}`);
    this.name = 'TeamsMemberLookupError';
  }
}

export interface TeamsMemberLookupRequest {
  config: TeamsGatewayConfig;
  /** Service URL from the verified inbound activity; the bot token is sent here. */
  serviceUrl: string;
  /** Team ID when the activity came from a team channel, else the conversation ID. */
  conversationId: string;
  userId: string;
}

/**
 * Resolve a sender's email through the Bot Connector conversation-member API
 * (`email`, falling back to `userPrincipalName`). Returns null when Teams has
 * no such member or no email; throws a retryable error for transient failures.
 */
export async function fetchTeamsMemberIdentity(
  request: TeamsMemberLookupRequest,
  options: {
    fetchImpl?: FetchLike;
    getToken?: (config: TeamsGatewayConfig) => Promise<string>;
    timeoutMs?: number;
  } = {}
): Promise<TeamsMemberIdentity | null> {
  let base: URL;
  try {
    base = new URL(request.serviceUrl);
  } catch {
    throw new TeamsMemberLookupError('teams_service_url_invalid', false);
  }
  if (!isTeamsTokenHost(request.serviceUrl)) {
    throw new TeamsMemberLookupError('teams_service_url_invalid', false);
  }
  const getToken =
    options.getToken ??
    ((config: TeamsGatewayConfig) =>
      new MsalTokenProvider().getAccessToken(
        createTeamsAuthConfiguration(config),
        TEAMS_BOT_FRAMEWORK_SCOPE
      ));
  let token: string;
  try {
    token = await getToken(request.config);
  } catch {
    throw new TeamsMemberLookupError('teams_token_unavailable', true);
  }
  const path = `v3/conversations/${encodeURIComponent(request.conversationId)}/members/${encodeURIComponent(request.userId)}`;
  const url = new URL(path, base.href.endsWith('/') ? base.href : `${base.href}/`);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? TEAMS_MEMBER_LOOKUP_TIMEOUT_MS),
    });
  } catch {
    throw new TeamsMemberLookupError('teams_member_lookup_unreachable', true);
  }
  if (response.status === 404 || response.status === 403) return null;
  if (response.status === 429 || response.status >= 500) {
    throw new TeamsMemberLookupError(`teams_member_lookup_http_${response.status}`, true);
  }
  if (!response.ok) {
    throw new TeamsMemberLookupError(`teams_member_lookup_http_${response.status}`, false);
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    email: stringValue(body.email),
    userPrincipalName: stringValue(body.userPrincipalName),
    aadObjectId: stringValue(body.aadObjectId),
  };
}

export interface NormalizedTeamsActivity {
  activityId: string;
  providerEventId: string;
  threadId: string;
  conversationId: string;
  rootMessageId: string | null;
  conversationType: string;
  serviceUrl: string;
  text: string;
  activityType: string;
  userId: string;
  userName: string | null;
  userAadObjectId: string | null;
  tenantId: string | null;
  hasMention: boolean;
  timestamp: string;
  address: Record<string, unknown>;
  metadata: Record<string, unknown>;
  /** Readable files with their download URLs; kept only in the encrypted inbound payload. */
  files?: InboundFile[];
  /** Attachments Agor will not read, by name, so the agent can say so. */
  skippedFiles?: InboundSkippedFile[];
}

export function createTeamsAuthConfiguration(config: TeamsGatewayConfig): AuthConfiguration {
  if (!config.app_id || !config.app_password) {
    throw new Error('Teams auth requires app_id and app_password');
  }
  const connection: AuthConfiguration = {
    clientId: config.app_id,
    clientSecret: config.app_password,
    ...(config.microsoft_tenant_id ? { tenantId: config.microsoft_tenant_id } : {}),
    authType: 'ClientSecret',
    // Bot Framework service tokens use these issuers. SDK signature and
    // audience/tenant validation remains authoritative; this narrows the
    // accepted channel identity before the durable admission transaction.
    issuers: ['https://api.botframework.com', 'https://api.botframework.us'],
    validateIssuer: true,
  };
  // authorizeJWT resolves a token through the Agents SDK connection registry;
  // provide a single dynamic connection rather than relying on process-wide
  // environment configuration. The registry is scoped to this channel and
  // contains no Agor tenant data or other channel credentials.
  return {
    ...connection,
    connections: new Map([['teams', connection]]),
    connectionsMap: [{ serviceUrl: '*', audience: config.app_id, connection: 'teams' }],
  };
}

/**
 * Parse a composite thread ID into conversationId + activityId. Kept as a
 * pure compatibility helper for existing integrations and tests.
 */
export function parseThreadId(threadId: string): { conversationId: string; activityId: string } {
  const lastPipe = threadId.lastIndexOf('|');
  if (lastPipe === -1) {
    throw new Error(
      `Invalid Teams thread ID format: "${threadId}" (expected "{conversationId}|{activityId}")`
    );
  }
  const conversationId = threadId.substring(0, lastPipe);
  const activityId = threadId.substring(lastPipe + 1);
  if (!conversationId || !activityId) {
    throw new Error(
      `Invalid Teams thread ID format: "${threadId}" (expected "{conversationId}|{activityId}")`
    );
  }
  return { conversationId, activityId };
}

export function stripMention(text: string, botName: string): string {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`<at>${escaped}</at>\\s*`, 'gi'), '').trim();
}

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

// Only Teams' own lowercase formatting markup; `<string>`, `<Button …>` and `<id>` are user text.
const TEAMS_MARKUP_TAG =
  /<\/?(?:a|at|b|blockquote|br|code|del|details|div|em|h[1-6]|hr|i|img|li|ol|p|pre|s|span|strike|strong|sub|summary|sup|table|tbody|td|th|thead|tr|u|ul)(?:\s[^<>]*)?\/?>/g;

function stripTeamsMarkup(text: string): string {
  return text.replace(TEAMS_MARKUP_TAG, '');
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function extractQuotedReplyText(
  attachments: Array<{ contentType?: string; content?: string }> | undefined
): string | null {
  if (!attachments) return null;
  for (const attachment of attachments) {
    if (attachment.contentType !== 'text/html' || !attachment.content) continue;
    if (!attachment.content.includes('schema.skype.com/Reply')) continue;
    const afterQuote = attachment.content.split('</blockquote>').pop();
    // Entities stay encoded; normalization decodes them once.
    const text = afterQuote ? stripHtmlTags(afterQuote).trim() : '';
    if (decodeHtmlEntities(text).trim()) return text;
  }
  return null;
}

const MAX_TEAMS_ATTACHMENTS = 10;
const TEAMS_FILE_DOWNLOAD_INFO = 'application/vnd.microsoft.teams.file.download.info';

/** Readable files (token-host images, SharePoint personal files) and named skips; URLs stay in the encrypted payload. */
export function partitionTeamsInboundFiles(
  attachments: unknown,
  options: { filesEnabled: boolean; activityId: string; personalChat: boolean }
): { files: InboundFile[]; skipped: InboundSkippedFile[] } {
  const files: InboundFile[] = [];
  const skipped: InboundSkippedFile[] = [];
  if (!Array.isArray(attachments)) return { files, skipped };
  for (const [index, attachment] of attachments.entries()) {
    if (files.length + skipped.length >= MAX_TEAMS_ATTACHMENTS) break;
    const record = asRecord(attachment);
    const contentType = stringValue(record.contentType)?.toLowerCase() ?? '';
    // The message's own HTML rendering (including quoted replies) and cards are not files.
    if (!contentType || contentType === 'text/html' || contentType.includes('.card.')) continue;
    const isImage = contentType.startsWith('image/');
    const name = (
      stringValue(record.name) ??
      (isImage ? `image-${files.length + skipped.length + 1}` : 'attachment')
    ).slice(0, 200);
    const skip = (reason: InboundSkippedFile['reason']) => skipped.push({ name, reason });
    // Only personal chats carry pre-authenticated file URLs; elsewhere files live in SharePoint.
    if (
      contentType === 'reference' ||
      (contentType === TEAMS_FILE_DOWNLOAD_INFO && !options.personalChat)
    ) {
      skip('channel_file');
      continue;
    }
    const content = asRecord(record.content);
    // Pasted images arrive as `image/*`; the downloaded body's own type decides what is staged.
    const mimetype = isImage
      ? contentType === 'image/*'
        ? 'image/png'
        : GATEWAY_READABLE_MIMES.has(contentType)
          ? contentType
          : undefined
      : contentType === TEAMS_FILE_DOWNLOAD_INFO
        ? (readableMimeForFilename(name) ??
          readableMimeForFilename(`.${stringValue(content.fileType) ?? ''}`))
        : undefined;
    if (!mimetype) {
      skip('unsupported_type');
      continue;
    }
    if (!options.filesEnabled) {
      skip('files_disabled');
      continue;
    }
    const id = createHash('sha256')
      .update(JSON.stringify([options.activityId, index]))
      .digest('hex')
      .slice(0, 16);
    const url = stringValue(isImage ? record.contentUrl : content.downloadUrl);
    if (isImage && isTeamsTokenHost(url)) {
      files.push({
        id,
        name,
        mimetype,
        size: -1,
        url_private_download: url,
        auth: 'provider_token',
      });
    } else if (!isImage && isTeamsFileDownloadUrl(url)) {
      files.push({ id, name, mimetype, size: -1, url_private_download: url });
    } else {
      skip('invalid');
    }
  }
  return { files, skipped };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Normalize an SDK Activity without retaining the untrusted raw request. */
export function normalizeTeamsActivity(
  raw: Record<string, unknown>,
  config: TeamsGatewayConfig
): NormalizedTeamsActivity {
  const activity = Activity.fromObject(raw);
  const activityRecord = activity as unknown as Record<string, unknown>;
  const activityId = stringValue(activityRecord.id);
  const conversation = asRecord(activityRecord.conversation);
  const conversationId = stringValue(conversation.id);
  const serviceUrl = stringValue(activityRecord.serviceUrl);
  const channelId = stringValue(activityRecord.channelId);
  if (!activityId || !conversationId || !serviceUrl || channelId !== 'msteams') {
    throw new Error('Teams activity is missing required identity fields');
  }

  const conversationType = stringValue(conversation.conversationType) ?? 'unknown';
  const normalizedConversationType = conversationType.toLowerCase();
  const replyToId = stringValue(activityRecord.replyToId);
  let baseConversationId = conversationId;
  let messageIdFromConversation: string | null = null;
  const marker = conversationId.indexOf(';messageid=');
  if (marker >= 0) {
    baseConversationId = conversationId.slice(0, marker);
    messageIdFromConversation = stringValue(conversationId.slice(marker + ';messageid='.length));
  }

  let threadId = conversationId;
  let rootMessageId: string | null = null;
  if (normalizedConversationType === 'channel') {
    rootMessageId = messageIdFromConversation ?? replyToId ?? activityId;
    threadId = `${baseConversationId}|${rootMessageId}`;
  } else if (
    normalizedConversationType === 'groupchat' ||
    normalizedConversationType === 'personal'
  ) {
    // Whole conversation mapping: quote replies and new messages remain one lane.
    threadId = baseConversationId;
  } else {
    throw new Error(`Unsupported Teams conversation type: ${conversationType}`);
  }

  const from = asRecord(activityRecord.from);
  const channelData = asRecord(activityRecord.channelData);
  const tenant = asRecord(channelData.tenant);
  const team = asRecord(channelData.team);
  const channel = asRecord(channelData.channel);
  const entities = Array.isArray(activityRecord.entities) ? activityRecord.entities : [];
  const attachments = Array.isArray(activityRecord.attachments)
    ? (activityRecord.attachments as Array<{ contentType?: string; content?: string }>)
    : undefined;
  let text = extractQuotedReplyText(attachments) ?? stringValue(activityRecord.text) ?? '';
  let hasMention = false;
  for (const entity of entities) {
    const record = asRecord(entity);
    if (record.type !== 'mention') continue;
    const mentioned = asRecord(record.mentioned);
    const mentionedId = stringValue(mentioned.id) ?? '';
    const appId = config.app_id ?? '';
    if (!appId || (mentionedId !== appId && mentionedId !== `28:${appId}`)) continue;
    hasMention = true;
    const mentionText = stringValue(record.text);
    if (mentionText) text = text.replace(mentionText, '').trim();
  }
  text = decodeHtmlEntities(stripTeamsMarkup(text)).trim();
  const userAadObjectId = stringValue(from.aadObjectId);
  const tenantId = stringValue(tenant.id) ?? stringValue(from.tenantId);
  const userId = stringValue(from.id) ?? 'unknown';
  const timestamp = stringValue(activityRecord.timestamp) ?? new Date().toISOString();
  const address = activity.getConversationReference() as unknown as Record<string, unknown>;
  const { files, skipped: skippedFiles } = partitionTeamsInboundFiles(activityRecord.attachments, {
    filesEnabled: config.files === true,
    activityId,
    personalChat: normalizedConversationType === 'personal',
  });

  return {
    activityId,
    // Activity IDs are conversation-scoped. A tuple preserves delimiters in
    // either component, and the base conversation ignores the reply-chain suffix.
    providerEventId: `teams:activity:${JSON.stringify([baseConversationId, activityId])}`,
    threadId,
    conversationId: baseConversationId,
    rootMessageId,
    serviceUrl,
    conversationType,
    text,
    activityType: stringValue(activityRecord.type) ?? 'unknown',
    userId,
    userName: stringValue(from.name),
    userAadObjectId,
    tenantId,
    hasMention,
    timestamp,
    address,
    metadata: {
      teams_conversation_type: conversationType,
      teams_channel_type:
        stringValue(channel.type) ??
        stringValue(channel.membershipType) ??
        stringValue(channelData.channelType),
      teams_channel_name: stringValue(channel.name),
      teams_team_name: stringValue(team.name),
      teams_team_id: stringValue(team.id),
      teams_team_aad_group_id: stringValue(team.aadGroupId),
      teams_user_name: stringValue(from.name),
      teams_has_mention: hasMention,
    },
    ...(files.length > 0 ? { files } : {}),
    ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
  };
}

export interface TeamsConnectorDependencies {
  tokenProvider?: TeamsAccessTokenProvider;
}

export class TeamsConnector implements GatewayConnector {
  readonly channelType: ChannelType = 'teams';
  private readonly config: TeamsGatewayConfig;
  private readonly tokens: TeamsAccessTokenProvider;

  constructor(config: Record<string, unknown>, dependencies: TeamsConnectorDependencies = {}) {
    this.config = config as TeamsGatewayConfig;
    if (!this.config.app_id) {
      throw new Error('Teams connector requires app_id in config');
    }
    if (!this.config.app_password) {
      throw new Error('Teams connector requires app_password in config');
    }
    this.tokens =
      dependencies.tokenProvider ??
      new MsalTokenProvider(createTeamsAuthConfiguration(this.config));
  }

  /** Host check, token, and client; failures here happen before any provider effect. */
  prepareSend(address: Record<string, unknown>, textBudget?: number): Promise<PreparedTeamsSend> {
    return prepareTeamsSend(address, this.tokens, { textBudget });
  }

  /** The bot token for an inline image URL; refused unless the URL is on a Bot Connector host. */
  async downloadToken(url: string): Promise<string> {
    if (!isTeamsTokenHost(url)) {
      throw new TeamsSendError({ phase: 'prepare', reason: 'service_url_not_allowed' });
    }
    return this.tokens.getAccessToken(botFrameworkScope(url));
  }

  /** Drop cached Bot Framework tokens after a 401 so the next prepare fetches a new one. */
  invalidateTokens(): void {
    MsalTokenProvider.clearSharedCaches();
  }

  /** No unfenced sends: replies and notices use `prepareSend` with a fenced stored address. */
  async sendMessage(): Promise<string> {
    throw new TeamsSendError({ phase: 'prepare', reason: 'address_invalid' });
  }

  async fetchProviderHistory(
    req: GatewayProviderHistoryRequest
  ): Promise<GatewayProviderHistoryResult> {
    return fetchTeamsProviderHistory(this.config, req);
  }

  /** Start a new channel thread from a fenced anchor address; targeting checks belong to the caller. */
  startChannelThread(
    anchor: Record<string, unknown>,
    input: { channelId: string; chunks: string[]; signal?: AbortSignal }
  ): Promise<TeamsChannelThreadResult> {
    return startTeamsChannelThread(anchor, this.tokens, {
      ...input,
      appId: this.config.app_id as string,
      tenantId: this.config.microsoft_tenant_id ?? '',
    });
  }

  /** A team's channels through a fenced anchor's service URL. */
  listTeamChannels(req: {
    teamId: string;
    serviceUrl: string;
    cacheScope?: TeamsGraphCacheScope | null;
  }): Promise<TeamsTeamChannel[]> {
    return fetchTeamsTeamChannels(this.config, req);
  }

  /** Agent read of one standard-channel thread page; access checks belong to the caller. */
  fetchThreadHistory(req: TeamsThreadHistoryRequest): Promise<TeamsThreadHistoryResult> {
    return fetchTeamsThreadHistory(this.config, req);
  }

  /** Agent list of a standard channel's posts; access checks belong to the caller. */
  listChannelPosts(req: TeamsChannelPostsRequest): Promise<TeamsChannelPostsResult> {
    return listTeamsChannelPosts(this.config, req);
  }

  /** Prove the configured app credentials; see {@link probeTeamsCredentials}. */
  async testConnection(): Promise<GatewayConnectionTestResult> {
    return probeTeamsCredentials(this.config);
  }

  formatMessage(markdown: string): string {
    return formatTeamsMarkdown(markdown);
  }
}

// Fenced blocks (an unclosed fence runs to the end, as in the chunker) and inline spans of any backtick length.
const TEAMS_CODE_SEGMENT = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[^\n]*?(?<!`)\2(?!`)/g;

/**
 * Teams renders some inline HTML in markdown, so prose drops HTML tags and
 * `<details>` collapses to a bold summary; code passes through unchanged.
 */
export function formatTeamsMarkdown(markdown: string): string {
  const formatProse = (prose: string, afterInline: boolean, beforeInline: boolean) => {
    const stripped = stripTeamsMarkup(
      prose
        .replace(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*/gi, (_match, summary: string) => {
          return `**${summary.trim()}**\n`;
        })
        .replace(/\s*<\/details>/gi, '')
    );
    // Teams markdown drops a lone newline; a hard break keeps the line, also next to inline code.
    const edged = `${afterInline ? '\0' : ''}${stripped}${beforeInline ? '\0' : ''}`;
    const broken = edged.replace(/([^\n])\n(?=[^\n])/g, '$1  \n');
    return broken.slice(afterInline ? 1 : 0, beforeInline ? -1 : undefined);
  };

  let formatted = '';
  let offset = 0;
  let afterInline = false;
  for (const match of markdown.matchAll(TEAMS_CODE_SEGMENT)) {
    const inline = match[2] !== undefined;
    formatted += formatProse(markdown.slice(offset, match.index), afterInline, inline) + match[0];
    offset = match.index + match[0].length;
    afterInline = inline;
  }
  return (formatted + formatProse(markdown.slice(offset), afterInline, false)).trim();
}
