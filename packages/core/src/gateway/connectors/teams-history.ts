/** Teams standard-channel history for the shared gateway catch-up path (Graph + RSC). */

import { DEFAULT_TEAMS_CATCH_UP, type TeamsGatewayConfig } from '../../types/gateway';
import type {
  GatewayProviderHistoryMessage,
  GatewayProviderHistoryRequest,
  GatewayProviderHistoryResult,
} from '../connector';
import {
  asRecord,
  authorizedJson,
  GRAPH_ORIGIN,
  GRAPH_SCOPE,
  graphNextLink,
  isTeamsRscDenied,
  TEAMS_MESSAGE_ID as MESSAGE_ID,
  markTeamsRscDenied,
  parseGraphChatMessage,
  resolveTeamGroupId,
  TEAMS_CATCH_UP_RETRY,
  type TeamsGraphCacheScope,
  TeamsGraphHttpError,
  type TeamsGraphRuntime,
  text,
} from './teams-graph';

const GRAPH_PAGE_SIZE = 50;

/** Verified trigger coordinates the gateway passes as `providerContext`. */
export type TeamsProviderHistoryContext = {
  /** `channelData.team.id` (`19:…@thread.tacv2`), used only to resolve the group GUID. */
  teamId: string | null;
  /** `channelData.team.aadGroupId`, the M365 group GUID Graph addresses teams by. */
  teamGroupId: string | null;
  serviceUrl: string;
  triggerTimestamp: string;
  /** Present only with trusted tenant context; without it nothing is cached. */
  cacheScope?: TeamsGraphCacheScope | null;
};

function compareIds(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function toHistoryMessage(
  raw: unknown,
  config: TeamsGatewayConfig
): GatewayProviderHistoryMessage | null {
  const message = parseGraphChatMessage(raw, config.app_id);
  if (!message) return null;
  const allowlist = config.allowed_user_aad_object_ids ?? [];
  return {
    providerMessageId: message.id,
    timestamp: message.createdAt,
    actorLabel: message.actorLabel,
    text: message.text,
    isBot: message.isBot,
    isSystem: message.isSystem,
    isRich: message.isRich,
    isTrigger: false,
    isMention: message.isMention,
    ...(allowlist.length > 0
      ? { senderAllowlisted: !!message.authorAadId && allowlist.includes(message.authorAadId) }
      : {}),
  };
}

function maxMessages(config: TeamsGatewayConfig): number {
  const configured = config.catch_up?.max_messages;
  return typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_TEAMS_CATCH_UP.max_messages;
}

function readContext(value: unknown): TeamsProviderHistoryContext {
  const record = asRecord(value);
  const serviceUrl = text(record.serviceUrl);
  const triggerTimestamp = text(record.triggerTimestamp);
  if (!serviceUrl || !triggerTimestamp) throw new Error('Teams history context is incomplete');
  const scope = asRecord(record.cacheScope);
  const cacheScope =
    text(scope.agorTenantId) &&
    text(scope.gatewayChannelId) &&
    Number.isSafeInteger(scope.providerConfigGeneration)
      ? {
          agorTenantId: scope.agorTenantId as string,
          gatewayChannelId: scope.gatewayChannelId as string,
          providerConfigGeneration: scope.providerConfigGeneration as number,
        }
      : null;
  return {
    teamId: text(record.teamId),
    teamGroupId: text(record.teamGroupId),
    serviceUrl,
    triggerTimestamp,
    cacheScope,
  };
}

// One reply-chain interval (after cursor, through the mention); IDs are epoch-ms compared numerically.
// Coverage is proven only by exhausting pagination or by descending pages reaching the cursor.
export async function fetchTeamsProviderHistory(
  config: TeamsGatewayConfig,
  req: GatewayProviderHistoryRequest,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<GatewayProviderHistoryResult> {
  const separator = req.threadId.lastIndexOf('|');
  const channelId = separator > 0 ? req.threadId.slice(0, separator) : '';
  const rootId = separator > 0 ? req.threadId.slice(separator + 1) : '';
  const trigger = req.triggerProviderCursor;
  const after = req.afterProviderCursor;
  if (
    !channelId ||
    !MESSAGE_ID.test(rootId) ||
    !MESSAGE_ID.test(trigger) ||
    req.throughProviderCursor !== trigger ||
    (after !== undefined && (!MESSAGE_ID.test(after) || compareIds(after, trigger) >= 0))
  ) {
    throw new Error('Teams history interval is not a numeric channel reply chain');
  }
  const context = readContext(req.providerContext);
  const runtime: TeamsGraphRuntime = {
    fetchImpl: options.fetchImpl ?? fetch,
    config,
    cacheScope: context.cacheScope,
    signal: req.signal,
    retry: TEAMS_CATCH_UP_RETRY,
  };
  const triggerMessage: GatewayProviderHistoryMessage = {
    providerMessageId: trigger,
    timestamp: context.triggerTimestamp,
    actorLabel: 'Teams participant',
    text: '',
    isBot: false,
    isSystem: false,
    isRich: false,
    isTrigger: true,
    isMention: true,
  };
  const incomplete = { threadId: req.threadId, messages: [triggerMessage], complete: false };
  // A top-level post that is itself the mention has no earlier context in its chain.
  if (rootId === trigger) return { ...incomplete, complete: true };

  const groupId = await resolveTeamGroupId(runtime, context);
  if (isTeamsRscDenied(runtime, groupId)) return incomplete;
  const base = `${GRAPH_ORIGIN}/v1.0/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(rootId)}`;
  const limit = maxMessages(config);
  const collected = new Map<string, GatewayProviderHistoryMessage>();
  let earlierOmitted = false;
  try {
    // The root precedes every reply, so only a first read (no cursor) can include it.
    if (after === undefined) {
      const root = toHistoryMessage(await authorizedJson(runtime, GRAPH_SCOPE, base), config);
      if (root) collected.set(root.providerMessageId, root);
    }
    let next: string | null = `${base}/replies?$top=${GRAPH_PAGE_SIZE}`;
    let previousPageMin: string | null = null;
    let descending = true;
    let reachedCursor = false;
    const pageCap = Math.ceil(limit / GRAPH_PAGE_SIZE) + 1;
    for (let page = 0; next && page < pageCap && !reachedCursor; page += 1) {
      const body = await authorizedJson(runtime, GRAPH_SCOPE, next);
      next = graphNextLink(body['@odata.nextLink']);
      const ids: string[] = [];
      for (const raw of Array.isArray(body.value) ? body.value : []) {
        const message = toHistoryMessage(raw, config);
        if (!message) continue;
        ids.push(message.providerMessageId);
        collected.set(message.providerMessageId, message);
      }
      for (let index = 1; index < ids.length; index += 1) {
        if (compareIds(ids[index], ids[index - 1]) > 0) descending = false;
      }
      if (previousPageMin && ids.length && compareIds(ids[0], previousPageMin) >= 0) {
        descending = false;
      }
      if (ids.length) previousPageMin = ids[ids.length - 1];
      reachedCursor =
        descending &&
        after !== undefined &&
        ids.length > 0 &&
        compareIds(ids[ids.length - 1], after) <= 0;
    }
    // Newest-first pages past the cap still prove a contiguous tail up to the mention.
    if (next && !reachedCursor && !descending) return incomplete;
    earlierOmitted = Boolean(next && !reachedCursor);
  } catch (error) {
    // RSC is granted per team and never appears in token roles; 403 is the only signal.
    if (error instanceof TeamsGraphHttpError && error.status === 403) {
      markTeamsRscDenied(runtime, groupId);
      return incomplete;
    }
    throw error;
  }
  const interval = [...collected.values()]
    .filter(
      (message) =>
        compareIds(message.providerMessageId, trigger) < 0 &&
        (after === undefined || compareIds(message.providerMessageId, after) > 0)
    )
    .sort((left, right) => compareIds(left.providerMessageId, right.providerMessageId));
  if (interval.length > limit) earlierOmitted = true;
  return {
    threadId: req.threadId,
    messages: [...interval.slice(-limit), triggerMessage],
    complete: true,
    ...(earlierOmitted ? { earlierOmitted } : {}),
  };
}
