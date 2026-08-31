import {
  and,
  eq,
  GatewayChannelRepository,
  GatewayInboundEventRepository,
  gatewayChannels,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  select,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  createTeamsAuthConfiguration,
  type NormalizedTeamsActivity,
  normalizeTeamsActivity,
} from '@agor/core/gateway';
import type { GatewayChannel, TeamsGatewayConfig } from '@agor/core/types';
import { validateTeamsConfig, withTeamsConfigDefaults } from '@agor/core/types';
import { authorizeJWT, buildJwksUri } from '@microsoft/agents-hosting';
import type { Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { teamsGatewayErrorCode } from '../utils/teams-error.js';

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

function safeTeamsInboundMetadata(
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

const BOT_FRAMEWORK_JWKS = new Set([
  'https://login.botframework.com/v1/.well-known/keys',
  'https://login.botframework.azure.us/v1/.well-known/keys',
]);
const jwkCache = new Map<string, { jwk: TeamsSigningJwk; expiresAt: number }>();

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Read the raw JWK selected by the already SDK-authorized token. The SDK is
 * still the signature/JWKS authority; this second, same-URI read exists only
 * because jwks-rsa intentionally discards Bot Framework's `endorsements`
 * extension when it turns a JWK into a PEM public key.
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
  const cacheKey = `${jwksUri}|${kid}`;
  const cached = jwkCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.jwk;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(jwksUri, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Bot Framework JWKS returned ${response.status}`);
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > 256 * 1024) {
      throw new Error('Bot Framework JWKS response is too large');
    }
    const parsed = JSON.parse(body) as { keys?: unknown };
    const key = Array.isArray(parsed.keys)
      ? parsed.keys.find(
          (candidate): candidate is TeamsSigningJwk =>
            !!candidate &&
            typeof candidate === 'object' &&
            (candidate as TeamsSigningJwk).kid === kid
        )
      : undefined;
    if (!key) throw new Error('Bot Framework signing key was not found');
    jwkCache.set(cacheKey, { jwk: key, expiresAt: Date.now() + 5 * 60_000 });
    return key;
  } finally {
    clearTimeout(timeout);
  }
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
  return null;
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
}): void {
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
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

      const discovery = await runWithSystemDatabaseScope(
        input.db,
        'teams gateway ingress channel discovery',
        async (systemDb) => {
          const tenantColumn = (
            gatewayChannels as unknown as { tenant_id?: typeof gatewayChannels.id }
          ).tenant_id;
          if (!tenantColumn) {
            const row = await select(systemDb, { channel_id: gatewayChannels.id })
              .from(gatewayChannels)
              .where(
                and(
                  eq(gatewayChannels.id, channelId),
                  eq(gatewayChannels.channel_type, 'teams'),
                  eq(gatewayChannels.enabled, true)
                )
              )
              .one();
            return row ? { tenant_id: 'default', channel_id: channelId } : null;
          }
          const row = (await select(systemDb, { tenant_id: tenantColumn })
            .from(gatewayChannels)
            .where(
              and(
                eq(gatewayChannels.id, channelId),
                eq(gatewayChannels.channel_type, 'teams'),
                eq(gatewayChannels.enabled, true)
              )
            )
            .one()) as { tenant_id?: string } | undefined;
          return row?.tenant_id ? { tenant_id: row.tenant_id, channel_id: channelId } : null;
        },
        { capability: 'teams_gateway_ingress_discovery' }
      );
      if (!discovery) {
        res.status(404).end();
        return;
      }

      let channel: GatewayChannel | null = null;
      let config: TeamsGatewayConfig;
      try {
        // This is intentionally a short metadata scope. In particular, never
        // hold a PostgreSQL transaction while the SDK fetches JWKS or while a
        // worker-independent request performs normalization.
        channel = await runWithTenantDatabaseScope(
          input.db,
          discovery.tenant_id,
          async (tenantDb) => new GatewayChannelRepository(tenantDb).findById(channelId)
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
          '[teams] ingress configuration lookup failed',
          `code=${teamsGatewayErrorCode(error)}`
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
          '[teams] signing-key endorsement lookup failed',
          `code=${teamsGatewayErrorCode(error)}`
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
      const allowlistError = allowlisted(
        config! as unknown as Record<string, unknown>,
        rawActivity
      );
      if (allowlistError) {
        res.status(403).json({ error: 'Teams activity is not allowlisted', code: allowlistError });
        return;
      }

      let normalized: NormalizedTeamsActivity;
      try {
        normalized = normalizeTeamsActivity(rawActivity, config!);
      } catch (error) {
        res.status(400).json({
          error: 'Teams activity is malformed',
          code: teamsGatewayErrorCode(error),
        });
        return;
      }
      const tenantId = normalized.tenantId;
      if (!tenantId || tenantId !== config!.microsoft_tenant_id) {
        res.status(403).json({ error: 'Teams activity tenant rejected', code: 'invalid_tenant' });
        return;
      }
      if (
        normalized.userId === config!.app_id ||
        (normalized.activityType === 'message' && normalized.userId === `28:${config!.app_id}`)
      ) {
        res
          .status(403)
          .json({ error: 'Teams bot self-message rejected', code: 'bot_self_message' });
        return;
      }

      try {
        const teamsAppId = config!.app_id as string;
        const teamsTenantId = config!.microsoft_tenant_id as string;
        // Only this final phase is the HTTP acknowledgement fence: the event
        // and refreshed encrypted address commit before 200 is observable.
        await runWithTenantDatabaseScope(input.db, discovery.tenant_id, async (tenantDb) => {
          await new GatewayInboundEventRepository(tenantDb).admitVerifiedHttp({
            channelId: channel!.id,
            providerEventId: normalized.providerEventId,
            threadId: normalized.threadId,
            payload: normalized as unknown as Record<string, unknown>,
            deliveryMetadata: safeTeamsInboundMetadata(normalized.metadata),
            address: {
              gatewayChannelId: channel!.id,
              threadId: normalized.threadId,
              conversationId: normalized.conversationId,
              rootMessageId: normalized.rootMessageId,
              address: normalized.address,
              verifiedAppId: teamsAppId,
              verifiedTenantId: teamsTenantId,
              providerConfigGeneration: channel!.provider_config_generation,
            },
            providerConfigGeneration: channel!.provider_config_generation,
            verifiedAppId: teamsAppId,
            verifiedTenantId: teamsTenantId,
          });
        });
        res.status(200).json({ ok: true });
      } catch (error) {
        if (!res.headersSent) {
          console.error('[teams] ingress admission failed', `code=${teamsGatewayErrorCode(error)}`);
          res.status(503).json({ error: 'Teams activity was not durably admitted' });
        }
      }
    }
  );
}
