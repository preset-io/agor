import type { TeamsCatchUpActivity, TeamsCatchUpResult } from '@agor/core/gateway';
import type { GatewayChannel } from '@agor/core/types';
import jwt from 'jsonwebtoken';

/** The app role required by the Teams RSC catch-up request. */
export const TEAMS_GRAPH_CHANNEL_MESSAGE_PERMISSION = 'ChannelMessage.Read.Group';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const TOKEN_CACHE_MAX = 128;
const MAX_GRAPH_RESPONSE_BYTES = 256 * 1024;

interface GraphMessage {
  id?: unknown;
  createdDateTime?: unknown;
  from?: {
    user?: { id?: unknown; displayName?: unknown };
    application?: { id?: unknown; displayName?: unknown };
  };
  body?: { content?: unknown };
  mentions?: unknown;
}

interface GraphCollection {
  value?: unknown;
  '@odata.nextLink'?: unknown;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export interface TeamsStandardChannelHistoryRequest {
  channel: GatewayChannel;
  activity: {
    activityId: string;
    conversationId: string;
    rootMessageId: string | null;
    threadId: string;
    text: string;
    userId: string;
    userAadObjectId: string | null;
  };
  teamId: string | null;
  channelId: string | null;
  afterActivityId: string | null;
  maxMessages: number;
}

export type TeamsStandardChannelHistoryFetcher = (
  request: TeamsStandardChannelHistoryRequest
) => Promise<TeamsCatchUpResult>;

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function graphPathPart(value: string): string {
  return encodeURIComponent(value);
}

function channelConfig(channel: GatewayChannel): Record<string, unknown> {
  return channel.config as Record<string, unknown>;
}

function graphTokenHasPermission(accessToken: string): boolean {
  // The Graph service remains the authority for this bearer token. This local
  // claim check only avoids an API call when the app role was not granted; it
  // is never used as a signature or issuer verifier.
  const decoded = jwt.decode(accessToken);
  const roles =
    decoded && typeof decoded === 'object' && Array.isArray(decoded.roles) ? decoded.roles : [];
  return roles.includes(TEAMS_GRAPH_CHANNEL_MESSAGE_PERMISSION);
}

function toActivity(message: GraphMessage, fallback?: string): TeamsCatchUpActivity | null {
  const activityId = textValue(message.id);
  const timestamp = textValue(message.createdDateTime);
  if (!activityId || !timestamp) return null;
  const from = message.from;
  const applicationId = textValue(from?.application?.id);
  const actorLabel =
    textValue(from?.user?.displayName) ??
    textValue(from?.application?.displayName) ??
    'Teams participant';
  const rawText = textValue(message.body?.content) ?? fallback ?? '';
  const text = stripHtml(rawText);
  if (!text) return null;
  return {
    activityId,
    timestamp,
    actorLabel,
    text,
    isBot: Boolean(applicationId),
    isMention: Array.isArray(message.mentions) && message.mentions.length > 0,
  };
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_GRAPH_RESPONSE_BYTES) {
    throw new Error('Teams Graph history response is too large');
  }
  return JSON.parse(body) as unknown;
}

/**
 * Build the real standard-channel RSC fetcher. It deliberately makes only
 * the two bounded Graph calls needed for the root and its replies. Graph
 * reply pages are not followed: an opaque nextLink means the interval is
 * incomplete, so the worker falls back to the current mention.
 */
export function createTeamsStandardChannelHistoryFetcher(
  options: { fetchImpl?: typeof fetch } = {}
): TeamsStandardChannelHistoryFetcher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenCache = new Map<string, CachedToken>();

  const acquireToken = async (
    config: Record<string, unknown>,
    tenantId: string,
    signal: AbortSignal
  ): Promise<string> => {
    const appId = textValue(config.app_id);
    const appPassword = textValue(config.app_password);
    if (!appId || !appPassword) throw new Error('Teams Graph app credentials are unavailable');
    const cacheKey = `${tenantId}:${appId}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
    const response = await fetchImpl(
      `https://login.microsoftonline.com/${graphPathPart(tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: appId,
          client_secret: appPassword,
          scope: GRAPH_SCOPE,
          grant_type: 'client_credentials',
        }),
        redirect: 'error',
        signal,
      }
    );
    if (!response.ok) throw new Error(`Teams Graph token request returned ${response.status}`);
    const body = (await readJson(response)) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    const accessToken = textValue(body.access_token);
    if (!accessToken || !graphTokenHasPermission(accessToken)) {
      throw new Error(`Teams Graph app role ${TEAMS_GRAPH_CHANNEL_MESSAGE_PERMISSION} is missing`);
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 300;
    tokenCache.set(cacheKey, {
      accessToken,
      expiresAt: Date.now() + Math.max(60, expiresIn) * 1_000,
    });
    while (tokenCache.size > TOKEN_CACHE_MAX) {
      const oldest = tokenCache.keys().next().value;
      if (typeof oldest !== 'string') break;
      tokenCache.delete(oldest);
    }
    return accessToken;
  };

  return async ({ channel, activity, teamId, channelId, afterActivityId, maxMessages }) => {
    const config = channelConfig(channel);
    const tenantId = textValue(config.microsoft_tenant_id);
    const rootMessageId = textValue(activity.rootMessageId);
    if (!tenantId || !teamId || !channelId || !rootMessageId || maxMessages < 1) {
      return {
        activities: [],
        complete: false,
        reason: 'invalid',
        conversationId: activity.conversationId,
        rootMessageId: activity.rootMessageId,
        afterActivityId,
        throughActivityId: activity.activityId,
        triggerActivityId: activity.activityId,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const token = await acquireToken(config, tenantId, controller.signal);
      const base = `https://graph.microsoft.com/v1.0/teams/${graphPathPart(teamId)}/channels/${graphPathPart(channelId)}`;
      const rootResponse = await fetchImpl(`${base}/messages/${graphPathPart(rootMessageId)}`, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!rootResponse.ok)
        throw new Error(`Teams Graph root history returned ${rootResponse.status}`);
      const root = (await readJson(rootResponse)) as GraphMessage;
      const repliesResponse = await fetchImpl(
        `${base}/messages/${graphPathPart(rootMessageId)}/replies?$top=${Math.min(50, maxMessages)}`,
        {
          headers: { accept: 'application/json', authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: controller.signal,
        }
      );
      if (!repliesResponse.ok)
        throw new Error(`Teams Graph reply history returned ${repliesResponse.status}`);
      const repliesBody = (await readJson(repliesResponse)) as GraphCollection;
      if (textValue(repliesBody['@odata.nextLink'])) {
        return {
          activities: [],
          complete: false,
          reason: 'truncated',
          conversationId: activity.conversationId,
          rootMessageId: activity.rootMessageId,
          afterActivityId,
          throughActivityId: activity.activityId,
          triggerActivityId: activity.activityId,
        };
      }
      const replies = Array.isArray(repliesBody.value)
        ? (repliesBody.value.filter(
            (value): value is GraphMessage =>
              !!value && typeof value === 'object' && !Array.isArray(value)
          ) as GraphMessage[])
        : [];
      const messages = [root, ...replies]
        .map((message) =>
          toActivity(message, message.id === activity.activityId ? activity.text : undefined)
        )
        .filter((message): message is TeamsCatchUpActivity => message !== null)
        .sort((left, right) =>
          left.timestamp === right.timestamp
            ? left.activityId.localeCompare(right.activityId)
            : left.timestamp.localeCompare(right.timestamp)
        );
      const triggerIndex = messages.findIndex(
        (message) => message.activityId === activity.activityId
      );
      const cursorIndex = afterActivityId
        ? messages.findIndex((message) => message.activityId === afterActivityId)
        : -1;
      if (
        triggerIndex < 0 ||
        (afterActivityId !== null && cursorIndex < 0) ||
        (cursorIndex >= 0 && cursorIndex >= triggerIndex)
      ) {
        return {
          activities: [],
          complete: false,
          reason: 'invalid',
          conversationId: activity.conversationId,
          rootMessageId: activity.rootMessageId,
          afterActivityId,
          throughActivityId: activity.activityId,
          triggerActivityId: activity.activityId,
        };
      }
      const interval = messages.slice(cursorIndex + 1, triggerIndex + 1);
      if (interval.length > maxMessages) {
        return {
          activities: interval.slice(0, maxMessages),
          complete: false,
          reason: 'truncated',
          conversationId: activity.conversationId,
          rootMessageId: activity.rootMessageId,
          afterActivityId,
          throughActivityId: activity.activityId,
          triggerActivityId: activity.activityId,
        };
      }
      return {
        activities: interval,
        complete: true,
        conversationId: activity.conversationId,
        rootMessageId: activity.rootMessageId,
        afterActivityId,
        throughActivityId: activity.activityId,
        triggerActivityId: activity.activityId,
      };
    } catch {
      return {
        activities: [],
        complete: false,
        reason: 'unavailable',
        conversationId: activity.conversationId,
        rootMessageId: activity.rootMessageId,
        afterActivityId,
        throughActivityId: activity.activityId,
        triggerActivityId: activity.activityId,
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}
