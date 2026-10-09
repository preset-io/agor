/** Shared Microsoft Graph and Bot Connector reads for Teams: app tokens, team group IDs, bounded JSON. */

import { createHash } from 'node:crypto';
import type { TeamsGatewayConfig } from '../../types/gateway';
import { isTeamsTokenHost } from '../teams-service-url';
import { parseRetryAfterMs } from './teams-send';

export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com/.default';
const MAX_RESPONSE_BYTES = 512 * 1024;
const TOKEN_EXPIRY_SKEW_MS = 5 * 60_000;
const RSC_DENIED_TTL_MS = 5 * 60_000;
const CACHE_CAPACITY = 1_000;
export const TEAMS_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TEAMS_MESSAGE_ID = /^\d{1,20}$/;

/** Trusted tenant context; without it nothing is cached. */
export type TeamsGraphCacheScope = {
  agorTenantId: string;
  gatewayChannelId: string;
  providerConfigGeneration: number;
};

/** How long a caller is willing to wait out transient failures and `Retry-After`. */
export interface TeamsGraphRetryPolicy {
  maxRetries: number;
  maxDelayMs: number;
}

/** Catch-up: at most two quick retries inside its own deadline. */
export const TEAMS_CATCH_UP_RETRY: TeamsGraphRetryPolicy = { maxRetries: 2, maxDelayMs: 2_000 };

export interface TeamsGraphRuntime {
  fetchImpl: typeof fetch;
  config: TeamsGatewayConfig;
  cacheScope?: TeamsGraphCacheScope | null;
  signal?: AbortSignal;
  retry?: TeamsGraphRetryPolicy;
}

/** Team coordinates from a verified activity or a fenced stored address. */
export interface TeamsTeamReference {
  /** `channelData.team.id` (`19:…@thread.tacv2`), used only to resolve the group GUID. */
  teamId: string | null;
  /** `channelData.team.aadGroupId`, the M365 group GUID Graph addresses teams by. */
  teamGroupId: string | null;
  serviceUrl: string;
}

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
export function resetTeamsGraphCaches(): void {
  tokens.clear();
  teamGroups.clear();
  rscDenied.clear();
}

export class TeamsGraphHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined
  ) {
    super(`Teams Graph request returned ${status}`);
    this.name = 'TeamsGraphHttpError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isTransient(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (error instanceof TeamsGraphHttpError) {
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
    throw new Error('Teams Graph response is too large');
  }
  return asRecord(JSON.parse(body));
}

// Transient failures (408/429/5xx/network) retry within the caller's policy and deadline.
async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  retry: TeamsGraphRetryPolicy
): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal });
      if (!response.ok) {
        throw new TeamsGraphHttpError(
          response.status,
          parseRetryAfterMs(response.headers.get('retry-after'))
        );
      }
      return await readBoundedJson(response);
    } catch (error) {
      if (attempt >= retry.maxRetries || !isTransient(error, signal)) throw error;
      const requested = error instanceof TeamsGraphHttpError ? error.retryAfterMs : undefined;
      if (requested !== undefined && requested > retry.maxDelayMs) throw error;
      await sleep(requested ?? 250 * (attempt + 1), signal);
    }
  }
}

function credentialKey(runtime: TeamsGraphRuntime, ...parts: unknown[]): string | null {
  const scope = runtime.cacheScope;
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

async function acquireToken(runtime: TeamsGraphRuntime, scope: string): Promise<string> {
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
    runtime.signal,
    runtime.retry ?? TEAMS_CATCH_UP_RETRY
  );
  const token = text(body.access_token);
  if (!token) throw new Error('Teams token response had no access token');
  const lifetimeMs = typeof body.expires_in === 'number' ? body.expires_in * 1000 : 0;
  if (key && lifetimeMs > TOKEN_EXPIRY_SKEW_MS) {
    tokens.set(key, token, Date.now() + lifetimeMs - TOKEN_EXPIRY_SKEW_MS);
  }
  return token;
}

/** GET with an app token for `scope`; a rejected token is evicted and replaced once. */
export async function authorizedJson(
  runtime: TeamsGraphRuntime,
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
        runtime.signal,
        runtime.retry ?? TEAMS_CATCH_UP_RETRY
      );
    } catch (error) {
      if (!(error instanceof TeamsGraphHttpError) || error.status !== 401 || attempt > 0) {
        throw error;
      }
      const key = credentialKey(runtime, 'token', scope);
      if (key) tokens.delete(key);
    }
  }
}

/** A Bot Connector base URL that may receive the bot token, with a trailing slash. */
export function teamsServiceUrlBase(serviceUrl: string): string {
  const parsed = new URL(serviceUrl);
  if (parsed.hash || !isTeamsTokenHost(serviceUrl)) {
    throw new Error('Teams service URL is not an allowed Bot Connector origin');
  }
  return parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
}

// Graph addresses teams by M365 group GUID, never by the `19:…@thread` team ID.
export async function resolveTeamGroupId(
  runtime: TeamsGraphRuntime,
  team: TeamsTeamReference
): Promise<string> {
  const { teamGroupId, teamId, serviceUrl } = team;
  if (teamGroupId && TEAMS_GUID.test(teamGroupId)) return teamGroupId;
  if (!teamId) throw new Error('Teams team identity is unavailable');
  const scope = runtime.cacheScope;
  const key = scope
    ? sha256(JSON.stringify([scope.agorTenantId, scope.gatewayChannelId, teamId]))
    : null;
  const cached = key ? teamGroups.get(key) : undefined;
  if (cached) return cached;
  const details = await authorizedJson(
    runtime,
    BOT_FRAMEWORK_SCOPE,
    `${teamsServiceUrlBase(serviceUrl)}v3/teams/${encodeURIComponent(teamId)}`
  );
  const resolved = text(details.aadGroupId);
  if (!resolved || !TEAMS_GUID.test(resolved)) throw new Error('Teams team has no M365 group ID');
  if (key) teamGroups.set(key, resolved, Number.POSITIVE_INFINITY);
  return resolved;
}

// RSC is granted per team and never appears in token roles; a Graph 403 is the only signal.
export function isTeamsRscDenied(runtime: TeamsGraphRuntime, groupId: string): boolean {
  const key = credentialKey(runtime, 'rsc_denied', groupId);
  return !!key && rscDenied.get(key) === true;
}

export function markTeamsRscDenied(runtime: TeamsGraphRuntime, groupId: string): void {
  const key = credentialKey(runtime, 'rsc_denied', groupId);
  if (key) rscDenied.set(key, true, Date.now() + RSC_DENIED_TTL_MS);
}

export function stripHtml(value: string): string {
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

/** A Graph `@odata.nextLink`, refused unless it stays on the Graph origin. */
export function graphNextLink(value: unknown): string | null {
  const link = text(value);
  if (!link) return null;
  if (new URL(link).origin !== GRAPH_ORIGIN) throw new Error('Unexpected Graph pagination origin');
  return link;
}

/** The fields Agor reads from a Graph `chatMessage`; attachment URLs are dropped here. */
export interface ParsedGraphChatMessage {
  id: string;
  createdAt: string;
  lastModifiedAt: string;
  actorLabel: string;
  authorAadId: string | null;
  subject: string | null;
  text: string;
  isBot: boolean;
  isSystem: boolean;
  isRich: boolean;
  isMention: boolean;
  attachments: Array<{ name: string; content_type?: string }>;
}

export function parseGraphChatMessage(
  raw: unknown,
  appId: string | undefined
): ParsedGraphChatMessage | null {
  const message = asRecord(raw);
  const id = text(message.id);
  if (!id || !TEAMS_MESSAGE_ID.test(id)) return null;
  const from = asRecord(message.from);
  const user = asRecord(from.user);
  const application = asRecord(from.application);
  const body = asRecord(message.body);
  const content = typeof body.content === 'string' ? body.content : '';
  const rawAttachments = (Array.isArray(message.attachments) ? message.attachments : []).map(
    asRecord
  );
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const userId = text(user.id);
  const isCard = (attachment: Record<string, unknown>) =>
    String(attachment.contentType ?? '').startsWith('application/vnd.microsoft.card');
  const createdAt = text(message.createdDateTime) ?? '';
  return {
    id,
    createdAt,
    lastModifiedAt: text(message.lastModifiedDateTime) ?? createdAt,
    actorLabel: text(user.displayName) ?? text(application.displayName) ?? 'Teams participant',
    authorAadId: userId,
    subject: text(message.subject),
    text: body.contentType === 'html' ? stripHtml(content) : content.trim(),
    isBot: Object.keys(application).length > 0 || !userId,
    isSystem: message.messageType !== 'message' || message.deletedDateTime != null,
    isRich: rawAttachments.some(isCard),
    isMention:
      !!appId &&
      mentions.some(
        (mention) => asRecord(asRecord(asRecord(mention).mentioned).application).id === appId
      ),
    attachments: rawAttachments
      .filter((attachment) => !isCard(attachment))
      .map((attachment) => ({
        name: (text(attachment.name) ?? 'attachment').slice(0, 200),
        ...(text(attachment.contentType)
          ? { content_type: (text(attachment.contentType) as string).slice(0, 100) }
          : {}),
      })),
  };
}
