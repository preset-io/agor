/** Microsoft Teams connector and pure activity normalization helpers.
 *
 * HTTP ingress is owned by the daemon's shared route. This connector is
 * intentionally stateless: outbound workers provide a decrypted durable
 * ConversationReference and the Agents SDK owns Bot Framework auth/client
 * behavior. There is no per-channel listener or process-local address map. */

import { Activity } from '@microsoft/agents-activity';
import { type AuthConfiguration, CloudAdapter } from '@microsoft/agents-hosting';

import type { ChannelType, TeamsGatewayConfig } from '../../types/gateway';
import type { GatewayConnector } from '../connector';

export function teamsSafeInboundMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of [
    'teams_conversation_type',
    'teams_channel_type',
    'teams_channel_name',
    'teams_team_name',
    'teams_user_name',
    'teams_has_mention',
    'requires_mapping_verification',
  ]) {
    const value = metadata?.[key];
    if (typeof value === 'string' || typeof value === 'boolean') safe[key] = value;
  }
  return safe;
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

export function createTeamsCloudAdapter(config: TeamsGatewayConfig): CloudAdapter {
  return new CloudAdapter(createTeamsAuthConfiguration(config), undefined, undefined, {
    validateServiceUrl: true,
  });
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

export function extractQuotedReplyText(
  attachments: Array<{ contentType?: string; content?: string }> | undefined
): string | null {
  if (!attachments) return null;
  for (const attachment of attachments) {
    if (attachment.contentType !== 'text/html' || !attachment.content) continue;
    if (!attachment.content.includes('schema.skype.com/Reply')) continue;
    const afterQuote = attachment.content.split('</blockquote>').pop();
    const text = afterQuote ? stripHtmlTags(afterQuote).trim() : '';
    if (text) return text;
  }
  return null;
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
  text = stripHtmlTags(text).trim();
  const userAadObjectId = stringValue(from.aadObjectId);
  const tenantId = stringValue(tenant.id) ?? stringValue(from.tenantId);
  const userId = stringValue(from.id) ?? 'unknown';
  const timestamp = stringValue(activityRecord.timestamp) ?? new Date().toISOString();
  const address = activity.getConversationReference() as unknown as Record<string, unknown>;

  return {
    activityId,
    providerEventId: `teams:activity:${activityId}`,
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
      teams_channel_type: stringValue(channel.type) ?? stringValue(channelData.channelType),
      teams_conversation_id: baseConversationId,
      teams_root_message_id: rootMessageId,
      teams_service_url: serviceUrl,
      teams_channel_name: stringValue(channel.name),
      teams_team_name: stringValue(team.name),
      teams_team_id: stringValue(team.id),
      teams_channel_id: stringValue(channel.id),
      teams_user_name: stringValue(from.name),
      teams_user_aad_id: userAadObjectId,
      teams_tenant_id: tenantId,
      teams_has_mention: hasMention,
      requires_mapping_verification:
        normalizedConversationType === 'channel' && !hasMention && !!replyToId,
    },
  };
}

export class TeamsConnector implements GatewayConnector {
  readonly channelType: ChannelType = 'teams';
  private readonly config: TeamsGatewayConfig;
  private readonly adapter: CloudAdapter;

  constructor(config: Record<string, unknown>) {
    this.config = config as TeamsGatewayConfig;
    if (!this.config.app_id) {
      throw new Error('Teams connector requires app_id in config');
    }
    if (!this.config.app_password) {
      throw new Error('Teams connector requires app_password in config');
    }
    this.adapter = createTeamsCloudAdapter(this.config);
  }

  async sendMessage(req: {
    threadId: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const address = req.metadata?.teams_conversation_address;
    if (!address || typeof address !== 'object' || Array.isArray(address)) {
      throw new Error(`No durable Teams ConversationReference for thread ${req.threadId}`);
    }
    let sentActivityId = '';
    await this.adapter.continueConversation(
      this.config.app_id as string,
      address as never,
      async (turnContext) => {
        const response = await turnContext.sendActivity(this.formatMessage(req.text));
        sentActivityId = response?.id ?? '';
      }
    );
    return sentActivityId;
  }

  formatMessage(markdown: string): string {
    const collapsed = markdown.replace(
      /<details>\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)<\/details>/gi,
      (_match, summary: string, content: string) => `**${summary.trim()}**\n${content.trim()}`
    );
    return stripHtmlTags(collapsed).trim();
  }
}
