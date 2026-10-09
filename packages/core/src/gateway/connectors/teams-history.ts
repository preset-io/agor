/** Teams standard-channel history for the shared gateway catch-up path (Graph + RSC). */

import { createHash } from 'node:crypto';
import { DEFAULT_TEAMS_CATCH_UP, type TeamsGatewayConfig } from '../../types/gateway';
import type {
  GatewayProviderHistoryMessage,
  GatewayProviderHistoryRequest,
  GatewayProviderHistoryResult,
} from '../connector';
import { isAllowedTeamsServiceUrl } from '../teams-service-url';
import { parseRetryAfterMs } from './teams-send';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com/.default';
const MAX_RESPONSE_BYTES = 512 * 1024;
const GRAPH_PAGE_SIZE = 50;
const MAX_TRANSIENT_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 2_000;
const TOKEN_EXPIRY_SKEW_MS = 5 * 60_000;
const RSC_DENIED_TTL_MS = 5 * 60_000;
const CACHE_CAPACITY = 1_000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_ID = /^\d{1,20}$/;

/** Verified trigger coordinates the gateway passes as `providerContext`. */
export type TeamsProviderHistoryContext = {
  /** `channelData.team.id` (`19:…@thread.tacv2`), used only to resolve the group GUID. */
  teamId: string | null;
  /** `channelData.team.aadGroupId`, the M365 group GUID Graph addresses teams by. */
  teamGroupId: string | null;
  serviceUrl: string;
  triggerTimestamp: string;
  /** Present only with trusted tenant context; without it nothing is cached. */
  cacheScope?: {
    agorTenantId: string;
    gatewayChannelId: string;
    providerConfigGeneration: number;
  } | null;
};

class ExpiringCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, expiresAt: number): void {
    this.entries.delete(key);
    if (this.entries.size >= CACHE_CAPACITY) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
    this.entries.set(key, { value, expiresAt });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

const tokens = new ExpiringCache<string>();
const teamGroups = new ExpiringCache<string>();
const rscDenied = new ExpiringCache<true>();

/** Test hook: forget cached tokens, team group IDs, and RSC denials. */
export function resetTeamsHistoryCaches(): void {
  tokens.clear();
  teamGroups.clear();
  rscDenied.clear();
}

export class TeamsHistoryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined
  ) {
    super(`Teams history request returned ${status}`);
    this.name = 'TeamsHistoryHttpError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function compareIds(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function isTransient(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (error instanceof TeamsHistoryHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return !(error instanceof Error && error.name === 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('Teams history response is too large');
  }
  return asRecord(JSON.parse(body));
}

// Transient failures (408/429/5xx/network) get at most two quick retries inside the deadline.
async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal });
      if (!response.ok) {
        throw new TeamsHistoryHttpError(
          response.status,
          parseRetryAfterMs(response.headers.get('retry-after'))
        );
      }
      return await readBoundedJson(response);
    } catch (error) {
      if (attempt >= MAX_TRANSIENT_RETRIES || !isTransient(error, signal)) throw error;
      const requested = error instanceof TeamsHistoryHttpError ? error.retryAfterMs : undefined;
      if (requested !== undefined && requested > MAX_RETRY_DELAY_MS) throw error;
      await sleep(requested ?? 250 * (attempt + 1), signal);
    }
  }
}

interface HistoryRuntime {
  fetchImpl: typeof fetch;
  config: TeamsGatewayConfig;
  context: TeamsProviderHistoryContext;
  signal?: AbortSignal;
}

function credentialKey(runtime: HistoryRuntime, ...parts: unknown[]): string | null {
  const scope = runtime.context.cacheScope;
  if (!scope) return null;
  return sha256(
    JSON.stringify([
      scope.agorTenantId,
      scope.gatewayChannelId,
      scope.providerConfigGeneration,
      runtime.config.app_id,
      runtime.config.microsoft_tenant_id,
      sha256(runtime.config.app_password ?? ''),
      ...parts,
    ])
  );
}

async function acquireToken(runtime: HistoryRuntime, scope: string): Promise<string> {
  const key = credentialKey(runtime, 'token', scope);
  const cached = key ? tokens.get(key) : undefined;
  if (cached) return cached;
  const { app_id: appId, app_password: appPassword, microsoft_tenant_id: tenant } = runtime.config;
  if (!appId || !appPassword || !tenant) throw new Error('Teams app credentials are unavailable');
  const body = await requestJson(
    runtime.fetchImpl,
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appPassword,
        scope,
        grant_type: 'client_credentials',
      }),
    },
    runtime.signal
  );
  const token = text(body.access_token);
  if (!token) throw new Error('Teams token response had no access token');
  const lifetimeMs = typeof body.expires_in === 'number' ? body.expires_in * 1000 : 0;
  if (key && lifetimeMs > TOKEN_EXPIRY_SKEW_MS) {
    tokens.set(key, token, Date.now() + lifetimeMs - TOKEN_EXPIRY_SKEW_MS);
  }
  return token;
}

// A rejected token is evicted and replaced once; a second 401 is a real failure.
async function authorizedJson(
  runtime: HistoryRuntime,
  scope: string,
  url: string
): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt += 1) {
    const token = await acquireToken(runtime, scope);
    try {
      return await requestJson(
        runtime.fetchImpl,
        url,
        { headers: { accept: 'application/json', authorization: `Bearer ${token}` } },
        runtime.signal
      );
    } catch (error) {
      if (!(error instanceof TeamsHistoryHttpError) || error.status !== 401 || attempt > 0) {
        throw error;
      }
      const key = credentialKey(runtime, 'token', scope);
      if (key) tokens.delete(key);
    }
  }
}

function serviceUrlBase(serviceUrl: string): string {
  const parsed = new URL(serviceUrl);
  if (parsed.hash || !isAllowedTeamsServiceUrl(serviceUrl)) {
    throw new Error('Teams service URL is not an allowed Bot Connector origin');
  }
  return parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
}

// Graph addresses teams by M365 group GUID, never by the `19:…@thread` team ID.
async function resolveTeamGroupId(runtime: HistoryRuntime): Promise<string> {
  const { teamGroupId, teamId, serviceUrl } = runtime.context;
  if (teamGroupId && GUID.test(teamGroupId)) return teamGroupId;
  if (!teamId) throw new Error('Teams team identity is unavailable');
  const scope = runtime.context.cacheScope;
  const key = scope
    ? sha256(JSON.stringify([scope.agorTenantId, scope.gatewayChannelId, teamId]))
    : null;
  const cached = key ? teamGroups.get(key) : undefined;
  if (cached) return cached;
  const details = await authorizedJson(
    runtime,
    BOT_FRAMEWORK_SCOPE,
    `${serviceUrlBase(serviceUrl)}v3/teams/${encodeURIComponent(teamId)}`
  );
  const resolved = text(details.aadGroupId);
  if (!resolved || !GUID.test(resolved)) throw new Error('Teams team has no M365 group ID');
  if (key) teamGroups.set(key, resolved, Number.POSITIVE_INFINITY);
  return resolved;
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .trim();
}

function toHistoryMessage(
  raw: unknown,
  config: TeamsGatewayConfig
): GatewayProviderHistoryMessage | null {
  const message = asRecord(raw);
  const id = text(message.id);
  if (!id || !MESSAGE_ID.test(id)) return null;
  const from = asRecord(message.from);
  const user = asRecord(from.user);
  const application = asRecord(from.application);
  const body = asRecord(message.body);
  const content = typeof body.content === 'string' ? body.content : '';
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const allowlist = config.allowed_user_aad_object_ids ?? [];
  const userId = text(user.id);
  return {
    providerMessageId: id,
    timestamp: text(message.createdDateTime) ?? '',
    actorLabel: text(user.displayName) ?? text(application.displayName) ?? 'Teams participant',
    text: body.contentType === 'html' ? stripHtml(content) : content.trim(),
    isBot: Object.keys(application).length > 0 || !userId,
    isSystem: message.messageType !== 'message' || message.deletedDateTime != null,
    isRich: attachments.some((attachment) =>
      String(asRecord(attachment).contentType ?? '').startsWith('application/vnd.microsoft.card')
    ),
    isTrigger: false,
    isMention: mentions.some(
      (mention) => asRecord(asRecord(asRecord(mention).mentioned).application).id === config.app_id
    ),
    ...(allowlist.length > 0 ? { senderAllowlisted: !!userId && allowlist.includes(userId) } : {}),
  };
}

function graphNextLink(value: unknown): string | null {
  const link = text(value);
  if (!link) return null;
  if (new URL(link).origin !== GRAPH_ORIGIN) throw new Error('Unexpected Graph pagination origin');
  return link;
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
  const runtime: HistoryRuntime = {
    fetchImpl: options.fetchImpl ?? fetch,
    config,
    context: readContext(req.providerContext),
    signal: req.signal,
  };
  const triggerMessage: GatewayProviderHistoryMessage = {
    providerMessageId: trigger,
    timestamp: runtime.context.triggerTimestamp,
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

  const groupId = await resolveTeamGroupId(runtime);
  const deniedKey = credentialKey(runtime, 'rsc_denied', groupId);
  if (deniedKey && rscDenied.get(deniedKey)) return incomplete;
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
    if (error instanceof TeamsHistoryHttpError && error.status === 403) {
      if (deniedKey) rscDenied.set(deniedKey, true, Date.now() + RSC_DENIED_TTL_MS);
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
