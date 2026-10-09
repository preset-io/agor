import { createHash } from 'node:crypto';
import {
  and,
  eq,
  GatewayChannelRepository,
  GatewayInboundEventRepository,
  gatewayChannels,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  select,
  TeamsConversationAddressRepository,
  TeamsInboundAuthorityChangedError,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  createTeamsAuthConfiguration,
  gatewayFailureCode,
  isAllowedTeamsServiceUrl,
  type NormalizedTeamsActivity,
  normalizeTeamsActivity,
  safeTeamsMetadata,
  teamsAddressRevocationFromActivity,
} from '@agor/core/gateway';
import type { GatewayChannel, GatewayChannelID, TeamsGatewayConfig } from '@agor/core/types';
import { validateTeamsConfig, withTeamsConfigDefaults } from '@agor/core/types';
import { authorizeJWT, buildJwksUri } from '@microsoft/agents-hosting';
import type { Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import jwt from 'jsonwebtoken';

const MAX_ACTIVITY_BYTES = 1_024 * 1_024;

const BOT_FRAMEWORK_ISSUERS = new Set([
  'https://api.botframework.com',
  'https://api.botframework.us',
]);

function claimString(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function exactString(value: Record<string, unknown>, name: string): string | null {
  const candidate = value[name];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

export interface TeamsSigningJwk {
  kid?: unknown;
  endorsements?: unknown;
  [key: string]: unknown;
}

const BOT_FRAMEWORK_JWKS = new Set([
  'https://login.botframework.com/v1/.well-known/keys',
  'https://login.botframework.azure.us/v1/.well-known/keys',
]);
// The live Bot Framework document is ~870 KB (250 keys) as of 2026-10.
const JWKS_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
const JWKS_DOCUMENT_TTL_MS = 24 * 60 * 60_000;
const JWKS_FORCED_REFRESH_INTERVAL_MS = 60_000;
const jwksDocuments = new Map<string, { keys: TeamsSigningJwk[]; fetchedAt: number }>();
const jwksRefreshes = new Map<string, Promise<TeamsSigningJwk[]>>();

/** Test hook: forget cached Bot Framework key documents. */
export function resetTeamsSigningJwksCache(): void {
  jwksDocuments.clear();
  jwksRefreshes.clear();
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

async function fetchJwksDocument(jwksUri: string): Promise<TeamsSigningJwk[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(jwksUri, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Bot Framework JWKS returned ${response.status}`);
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > JWKS_DOCUMENT_MAX_BYTES) {
      throw new Error('Bot Framework JWKS response is too large');
    }
    const parsed = JSON.parse(body) as { keys?: unknown };
    if (!Array.isArray(parsed.keys)) throw new Error('Bot Framework JWKS has no keys');
    return parsed.keys.filter(
      (candidate): candidate is TeamsSigningJwk =>
        !!candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    );
  } finally {
    clearTimeout(timeout);
  }
}

// Single-flight per document; a forced refresh (unknown kid) is rate-limited per URI.
function loadJwksDocument(jwksUri: string, force: boolean): Promise<TeamsSigningJwk[]> {
  const cached = jwksDocuments.get(jwksUri);
  const age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
  if (cached && age < (force ? JWKS_FORCED_REFRESH_INTERVAL_MS : JWKS_DOCUMENT_TTL_MS)) {
    return Promise.resolve(cached.keys);
  }
  let refresh = jwksRefreshes.get(jwksUri);
  if (!refresh) {
    refresh = fetchJwksDocument(jwksUri)
      .then((keys) => {
        jwksDocuments.set(jwksUri, { keys, fetchedAt: Date.now() });
        return keys;
      })
      .finally(() => jwksRefreshes.delete(jwksUri));
    jwksRefreshes.set(jwksUri, refresh);
  }
  return refresh;
}

/**
 * Read the raw JWK selected by the already SDK-authorized token from a cached
 * copy of the same Bot Framework key document. jwks-rsa discards the
 * `endorsements` extension, so the SDK cannot answer the channel question.
 */
export async function fetchTeamsSigningJwk(
  req: Request,
  claims: Record<string, unknown>,
  config: TeamsGatewayConfig
): Promise<TeamsSigningJwk> {
  const token = bearerToken(req);
  const complete = token ? jwt.decode(token, { complete: true }) : null;
  const header =
    complete &&
    typeof complete === 'object' &&
    complete.header &&
    typeof complete.header === 'object'
      ? (complete.header as unknown as Record<string, unknown>)
      : null;
  const kid = typeof header?.kid === 'string' ? header.kid : null;
  const issuer = claimString(claims, 'iss');
  if (!kid || !issuer) throw new Error('Teams signing key identity is unavailable');
  const jwksUri = buildJwksUri(issuer, createTeamsAuthConfiguration(config));
  if (!BOT_FRAMEWORK_JWKS.has(jwksUri)) throw new Error('Teams signing key issuer is unavailable');
  const find = (keys: TeamsSigningJwk[]) => keys.find((candidate) => candidate.kid === kid);
  const key =
    find(await loadJwksDocument(jwksUri, false)) ?? find(await loadJwksDocument(jwksUri, true));
  if (!key) throw new Error('Bot Framework signing key was not found');
  return key;
}

/**
 * The Agents SDK owns JWT signature/JWKS validation. These checks bind the
 * verified Bot Framework identity to this Teams channel before persistence.
 * The SDK's verified Bot Framework issuer/key is the endorsement boundary; no
 * local JWT parser or hand-rolled signature verifier is used here.
 */
export function validateTeamsVerifiedIdentity(
  claims: Record<string, unknown>,
  config: Record<string, unknown>,
  activity: Record<string, unknown>,
  signingJwk?: TeamsSigningJwk
): string | null {
  const issuer = claimString(claims, 'iss');
  const appId = claimString(config, 'app_id');
  const configuredTenant = claimString(config, 'microsoft_tenant_id');
  const audience = claims.aud;
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!issuer || !BOT_FRAMEWORK_ISSUERS.has(issuer)) return 'invalid_botframework_issuer';
  if (!appId || !audiences.includes(appId)) return 'invalid_audience';
  const endorsements = signingJwk?.endorsements;
  if (!Array.isArray(endorsements) || !endorsements.includes('msteams')) {
    return 'invalid_channel_endorsement';
  }
  const activityTenant = (
    (activity.channelData as Record<string, unknown> | undefined)?.tenant as
      | Record<string, unknown>
      | undefined
  )?.id;
  if (
    !configuredTenant ||
    typeof activityTenant !== 'string' ||
    activityTenant !== configuredTenant
  ) {
    return 'invalid_tenant';
  }
  const tokenTenant = claimString(claims, 'tid');
  if (tokenTenant && tokenTenant !== configuredTenant) return 'invalid_tenant';
  const serviceUrl = exactString(activity, 'serviceUrl');
  const tokenServiceUrl = exactString(claims, 'serviceurl');
  if (!serviceUrl || !tokenServiceUrl || serviceUrl !== tokenServiceUrl) {
    return 'invalid_service_url';
  }
  try {
    const parsed = new URL(serviceUrl);
    if (
      serviceUrl !== serviceUrl.trim() ||
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      return 'invalid_service_url';
  } catch {
    return 'invalid_service_url';
  }
  if (!isAllowedTeamsServiceUrl(serviceUrl)) return 'invalid_service_url';
  return null;
}

function metadataString(activity: NormalizedTeamsActivity, key: string): string | null {
  const value = activity.metadata[key];
  return typeof value === 'string' && value ? value : null;
}

function allowlisted(
  config: Record<string, unknown>,
  activity: Record<string, unknown>
): string | null {
  const channelData = (activity.channelData as Record<string, unknown> | undefined) ?? {};
  const team = (channelData.team as Record<string, unknown> | undefined) ?? {};
  const channel = (channelData.channel as Record<string, unknown> | undefined) ?? {};
  const from = (activity.from as Record<string, unknown> | undefined) ?? {};
  const checks: Array<[string, unknown, unknown]> = [
    ['allowed_team_ids', team.id, config.allowed_team_ids],
    ['allowed_channel_ids', channel.id, config.allowed_channel_ids],
    ['allowed_user_aad_object_ids', from.aadObjectId, config.allowed_user_aad_object_ids],
  ];
  for (const [name, actual, configured] of checks) {
    if (!Array.isArray(configured) || configured.length === 0) continue;
    if (typeof actual !== 'string' || !configured.includes(actual))
      return `not_allowlisted_${name}`;
  }
  return null;
}

export function registerTeamsGatewayIngressRoute(input: {
  app: Application;
  db: TenantScopeAwareDatabase;
  /** Defaults to the local worker registered on the app after startup. */
  wakeWorker?: () => void;
}): void {
  const wakeWorker =
    input.wakeWorker ??
    (() => (input.app.get('teamsGatewayWorker') as { wake?: () => void } | undefined)?.wake?.());
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Only rejected requests spend the budget; verified Microsoft traffic never 429s.
    skipSuccessfulRequests: true,
    // Teams shares provider egress IPs across customers. Never let a request
    // to one channel consume another channel's pre-authentication budget.
    keyGenerator: (req) =>
      createHash('sha256')
        .update(JSON.stringify([req.params.gatewayChannelId, ipKeyGenerator(req.ip ?? 'unknown')]))
        .digest('hex'),
  });

  // @ts-expect-error - FeathersJS app extends Express
  input.app.post(
    '/gateway/teams/:gatewayChannelId/activities',
    limiter,
    async (req: Request, res: Response) => {
      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_ACTIVITY_BYTES) {
        res.status(413).json({ error: 'Teams activity exceeds the 1 MiB limit' });
        return;
      }
      if (Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8') > MAX_ACTIVITY_BYTES) {
        res.status(413).json({ error: 'Teams activity exceeds the 1 MiB limit' });
        return;
      }
      const channelId = String(req.params.gatewayChannelId ?? '');
      if (!channelId) {
        res.status(404).end();
        return;
      }

      const agorTenantId = await runWithSystemDatabaseScope(
        input.db,
        'teams gateway ingress channel discovery',
        async (systemDb) => {
          const tenantColumn = (
            gatewayChannels as unknown as { tenant_id?: typeof gatewayChannels.id }
          ).tenant_id;
          const row = (await select(systemDb, { tenant_id: tenantColumn ?? gatewayChannels.id })
            .from(gatewayChannels)
            .where(
              and(
                eq(gatewayChannels.id, channelId),
                eq(gatewayChannels.channel_type, 'teams'),
                eq(gatewayChannels.enabled, true)
              )
            )
            .one()) as { tenant_id?: string } | undefined;
          // SQLite has no tenant column and runs as the single default tenant.
          return tenantColumn ? row?.tenant_id || null : row ? 'default' : null;
        },
        { capability: 'teams_gateway_ingress_discovery' }
      );
      if (!agorTenantId) {
        res.status(404).end();
        return;
      }

      let channel: GatewayChannel | null = null;
      let config: TeamsGatewayConfig;
      try {
        // This is intentionally a short metadata scope. In particular, never
        // hold a PostgreSQL transaction while the SDK fetches JWKS or while a
        // worker-independent request performs normalization.
        channel = await runWithTenantDatabaseScope(input.db, agorTenantId, async (tenantDb) =>
          new GatewayChannelRepository(tenantDb).findById(channelId)
        );
        if (!channel?.enabled || channel.channel_type !== 'teams') {
          res.status(404).end();
          return;
        }
        config = withTeamsConfigDefaults(channel.config);
        const validation = validateTeamsConfig(config as unknown as Record<string, unknown>);
        if (!validation.ok) {
          res.status(503).json({ error: 'Teams gateway configuration is not ready' });
          return;
        }
      } catch (error) {
        console.error(
          `[gateway.teams.ingress] event=configuration_lookup_failed code=${gatewayFailureCode(error)}`
        );
        res.status(503).json({ error: 'Teams activity was not durably admitted' });
        return;
      }

      const rawActivity = (req.body ?? {}) as Record<string, unknown>;
      let authorized = false;
      let authorizationError: unknown;
      try {
        await authorizeJWT(createTeamsAuthConfiguration(config!))(
          req as never,
          res as never,
          () => {
            authorized = true;
          }
        );
      } catch (error) {
        authorizationError = error;
      }
      if (!authorized || authorizationError) {
        if (!res.headersSent)
          res.status(401).json({ error: 'Teams activity authentication failed' });
        return;
      }

      const claims = (req as Request & { user?: Record<string, unknown> }).user ?? {};
      let signingJwk: TeamsSigningJwk;
      try {
        signingJwk = await fetchTeamsSigningJwk(req, claims, config!);
      } catch (error) {
        console.warn(
          `[gateway.teams.ingress] event=endorsement_lookup_failed code=${gatewayFailureCode(error)}`
        );
        res.status(503).json({ error: 'Teams activity authentication is temporarily unavailable' });
        return;
      }
      const identityError = validateTeamsVerifiedIdentity(
        claims,
        config! as unknown as Record<string, unknown>,
        rawActivity,
        signingJwk
      );
      if (identityError) {
        res.status(403).json({ error: 'Teams activity identity rejected', code: identityError });
        return;
      }
      const teamsAppId = config!.app_id as string;
      // Lifecycle and other non-message activities are never queued.
      if (rawActivity.type !== 'message') {
        const revocation = teamsAddressRevocationFromActivity(rawActivity, teamsAppId);
        if (revocation) {
          try {
            const revoked = await runWithTenantDatabaseScope(input.db, agorTenantId, (tenantDb) =>
              new TeamsConversationAddressRepository(tenantDb).revokeForEvent(
                channel!.id as GatewayChannelID,
                revocation
              )
            );
            console.log(
              `[gateway.teams.ingress] event=address_revoked reason=${revocation.reason} count=${revoked}`
            );
          } catch (error) {
            console.error(
              `[gateway.teams.ingress] event=address_revocation_failed code=${gatewayFailureCode(error)}`
            );
            res.status(503).json({ error: 'Teams lifecycle activity was not applied' });
            return;
          }
        }
        res.status(200).json({ ok: true });
        return;
      }

      let normalized: NormalizedTeamsActivity;
      try {
        normalized = normalizeTeamsActivity(rawActivity, config!);
      } catch (error) {
        res.status(400).json({
          error: 'Teams activity is malformed',
          code:
            error instanceof Error &&
            error.message === 'Teams activity is missing required identity fields'
              ? 'invalid_activity'
              : gatewayFailureCode(error),
        });
        return;
      }
      const tenantId = normalized.tenantId;
      if (!tenantId || tenantId !== config!.microsoft_tenant_id) {
        res.status(403).json({ error: 'Teams activity tenant rejected', code: 'invalid_tenant' });
        return;
      }
      if (normalized.userId === teamsAppId || normalized.userId === `28:${teamsAppId}`) {
        res
          .status(403)
          .json({ error: 'Teams bot self-message rejected', code: 'bot_self_message' });
        return;
      }
      // Unmentioned group/channel traffic (RSC receive-all) and empty summons are never stored.
      if (
        (normalized.conversationType.toLowerCase() !== 'personal' && !normalized.hasMention) ||
        (!normalized.text.trim() && !normalized.files?.length && !normalized.skippedFiles?.length)
      ) {
        res.status(200).json({ ok: true });
        return;
      }

      const allowlistError = allowlisted(
        config! as unknown as Record<string, unknown>,
        rawActivity
      );
      if (allowlistError) {
        res.status(403).json({ error: 'Teams activity is not allowlisted', code: allowlistError });
        return;
      }

      try {
        const teamsTenantId = config!.microsoft_tenant_id as string;
        // Only this final phase is the HTTP acknowledgement fence: the event
        // and refreshed encrypted address commit before 200 is observable.
        await runWithTenantDatabaseScope(input.db, agorTenantId, async (tenantDb) => {
          await new GatewayInboundEventRepository(tenantDb).admitVerifiedHttp({
            channelId: channel!.id,
            providerEventId: normalized.providerEventId,
            threadId: normalized.threadId,
            payload: normalized as unknown as Record<string, unknown>,
            deliveryMetadata: safeTeamsMetadata(normalized.metadata),
            address: {
              conversationId: normalized.conversationId,
              rootMessageId: normalized.rootMessageId,
              teamId: metadataString(normalized, 'teams_team_id'),
              teamAadGroupId: metadataString(normalized, 'teams_team_aad_group_id'),
              teamsChannelType: metadataString(normalized, 'teams_channel_type'),
              address: normalized.address,
            },
            providerConfigGeneration: channel!.provider_config_generation,
            verifiedAppId: teamsAppId,
            verifiedTenantId: teamsTenantId,
          });
        });
      } catch (error) {
        if (res.headersSent) return;
        if (error instanceof TeamsInboundAuthorityChangedError) {
          // A retry can never be admitted under the new authority; 5xx would only invite back-off.
          console.warn(`[gateway.teams.ingress] event=not_admitted reason=${error.reason}`);
          if (error.reason === 'channel_unavailable') res.status(404).end();
          else res.status(200).json({ ok: true });
          return;
        }
        console.error(
          `[gateway.teams.ingress] event=admission_failed code=${gatewayFailureCode(error)}`
        );
        res.status(503).json({ error: 'Teams activity was not durably admitted' });
        return;
      }
      res.status(200).json({ ok: true });
      try {
        wakeWorker();
      } catch {
        // Polling remains the cross-replica fallback.
      }
    }
  );
}
