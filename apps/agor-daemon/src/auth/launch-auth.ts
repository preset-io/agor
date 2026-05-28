import type { JsonWebKey, KeyObject } from 'node:crypto';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import type { AgorConfig } from '@agor/core/config';
import { type Database, eq, generateId, hash, insert, select, update, users } from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type { Params, User, UserID, UserRole } from '@agor/core/types';
import { normalizeRole, ROLES } from '@agor/core/types';
import jwt, { type JwtHeader, type JwtPayload, type SignOptions } from 'jsonwebtoken';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SERVICE_TOKEN_ENV = 'AGOR_EXTERNAL_LAUNCH_SERVICE_TOKEN';
const DEFAULT_SHARED_SECRET_ENV = 'AGOR_EXTERNAL_LAUNCH_SHARED_SECRET';
const DEFAULT_EXCHANGE_URL_ENV = 'AGOR_EXTERNAL_LAUNCH_EXCHANGE_URL';
const DEFAULT_ISSUER_ENV = 'AGOR_EXTERNAL_LAUNCH_ISSUER';
const DEFAULT_AUDIENCE_ENV = 'AGOR_EXTERNAL_LAUNCH_AUDIENCE';
const DEFAULT_INSTANCE_ID_ENV = 'AGOR_EXTERNAL_LAUNCH_INSTANCE_ID';

interface ResolvedLaunchSettings {
  enabled: boolean;
  exchangeUrl?: string;
  audience?: string;
  issuer?: string;
  instanceId?: string;
  providerId?: string;
  jwksUrl?: string;
  publicKey?: string;
  devSharedSecret?: string;
  serviceCredential?: string;
  requestTimeoutMs: number;
  algorithms?: string[];
}

interface LaunchExchangeResponse {
  assertion?: string;
  claims?: LaunchClaims;
}

interface LaunchClaims extends JwtPayload {
  iss: string;
  sub: string;
  aud?: string | string[];
  email?: string;
  name?: string;
  picture?: string;
  avatar?: string;
  role?: string;
  provider?: string;
  instance_id?: string;
  runtime_instance_id?: string;
  jti?: string;
  nonce?: string;
}

interface StoredExternalIdentity {
  key: string;
  provider: string;
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
  last_login_at: string;
}

type UserDataWithExternalIdentities = NonNullable<(typeof users.$inferSelect)['data']> & {
  external_identities?: StoredExternalIdentity[];
  avatar?: string;
  preferences?: Record<string, unknown>;
};

export interface LaunchAuthResult {
  accessToken: string;
  refreshToken: string;
  authentication: { strategy: 'launch' };
  user: User;
}

export interface LaunchAuthServiceOptions {
  db: Database;
  config: AgorConfig;
  jwtSecret: string;
  accessTokenTtl: SignOptions['expiresIn'];
  refreshTokenTtl: SignOptions['expiresIn'];
  usersService: { get(id: UserID, params?: Params): Promise<User> };
}

function envFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function resolveLaunchSettings(config: AgorConfig): ResolvedLaunchSettings {
  const raw = config.external_launch;
  const serviceTokenEnv = raw?.service_credential_env || DEFAULT_SERVICE_TOKEN_ENV;
  const sharedSecretEnv = raw?.dev_shared_secret_env || DEFAULT_SHARED_SECRET_ENV;

  return {
    enabled: envFlag(process.env.AGOR_EXTERNAL_LAUNCH_ENABLED) ?? raw?.enabled === true,
    exchangeUrl: process.env[DEFAULT_EXCHANGE_URL_ENV] || raw?.exchange_url,
    audience: process.env[DEFAULT_AUDIENCE_ENV] || raw?.audience,
    issuer: process.env[DEFAULT_ISSUER_ENV] || raw?.issuer,
    instanceId: process.env[DEFAULT_INSTANCE_ID_ENV] || raw?.instance_id,
    providerId: raw?.provider_id,
    jwksUrl: raw?.jwks_url,
    publicKey: raw?.public_key,
    devSharedSecret: process.env[sharedSecretEnv] || raw?.dev_shared_secret,
    serviceCredential: process.env[serviceTokenEnv] || raw?.service_credential,
    requestTimeoutMs: raw?.request_timeout_ms ?? DEFAULT_TIMEOUT_MS,
    algorithms: raw?.algorithms,
  };
}

function assertConfigured(settings: ResolvedLaunchSettings): void {
  if (!settings.enabled) {
    throw new NotAuthenticated('One-time launch authentication is not enabled');
  }
  if (!settings.exchangeUrl) {
    throw new NotAuthenticated('One-time launch authentication is not configured');
  }
  if (!settings.issuer || !settings.audience) {
    throw new NotAuthenticated('One-time launch authentication is missing validation settings');
  }
  if (!settings.jwksUrl && !settings.publicKey && !settings.devSharedSecret) {
    throw new NotAuthenticated(
      'One-time launch authentication is missing assertion verification keys'
    );
  }
}

function identityKey(provider: string, issuer: string, subject: string): string {
  return createHash('sha256').update(`${provider}\0${issuer}\0${subject}`).digest('hex');
}

function sanitizeEmailLocalPart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._+-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'user'
  );
}

function derivedEmail(provider: string, issuer: string, subject: string): string {
  const digest = identityKey(provider, issuer, subject).slice(0, 16);
  return `launch-${digest}@external-launch.local`;
}

async function chooseLocalEmail(
  db: Database,
  requestedEmail: string | undefined,
  key: string,
  provider: string,
  issuer: string,
  subject: string
): Promise<string> {
  const candidate = requestedEmail?.trim().toLowerCase();
  if (candidate) {
    const existing = await select(db).from(users).where(eq(users.email, candidate)).one();
    if (!existing) return candidate;
    const identities = getExternalIdentities(existing.data as UserDataWithExternalIdentities);
    if (identities.some((identity) => identity.key === key)) return candidate;

    const [local, domain] = candidate.split('@');
    if (local && domain) {
      const alias = `${sanitizeEmailLocalPart(local)}+launch-${key.slice(0, 12)}@${domain}`;
      const aliasExisting = await select(db).from(users).where(eq(users.email, alias)).one();
      if (!aliasExisting) return alias;
    }
  }

  const fallback = derivedEmail(provider, issuer, subject);
  const fallbackExisting = await select(db).from(users).where(eq(users.email, fallback)).one();
  if (!fallbackExisting) return fallback;

  return `launch-${key}-${randomBytes(4).toString('hex')}@external-launch.local`;
}

function getExternalIdentities(data: UserDataWithExternalIdentities): StoredExternalIdentity[] {
  return Array.isArray(data.external_identities) ? data.external_identities : [];
}

function mapRole(claimedRole: string | undefined, allowSuperadmin: boolean | undefined): UserRole {
  const role = normalizeRole(claimedRole);
  if (role === ROLES.SUPERADMIN && !allowSuperadmin) return ROLES.ADMIN;
  if ([ROLES.VIEWER, ROLES.MEMBER, ROLES.ADMIN, ROLES.SUPERADMIN].includes(role)) return role;
  return ROLES.MEMBER;
}

async function findUserByExternalIdentity(
  db: Database,
  key: string
): Promise<typeof users.$inferSelect | null> {
  const rows = await select(db).from(users).all();
  for (const row of rows) {
    const identities = getExternalIdentities(row.data as UserDataWithExternalIdentities);
    if (identities.some((identity) => identity.key === key)) return row;
  }
  return null;
}

async function upsertLaunchUser(
  options: LaunchAuthServiceOptions,
  claims: LaunchClaims
): Promise<User> {
  const { db, config, usersService } = options;
  const issuer = claims.iss;
  const subject = claims.sub;
  const provider = claims.provider || resolveLaunchSettings(config).providerId || issuer;
  const key = identityKey(provider, issuer, subject);
  const now = new Date();
  const nowIso = now.toISOString();
  const role = mapRole(claims.role, config.execution?.allow_superadmin);
  const email = claims.email?.trim().toLowerCase();
  const name = claims.name?.trim() || undefined;
  const avatar = claims.avatar || claims.picture;
  const identity: StoredExternalIdentity = {
    key,
    provider,
    issuer,
    subject,
    email,
    name,
    last_login_at: nowIso,
  };

  const existing = await findUserByExternalIdentity(db, key);
  if (existing) {
    const data = existing.data as UserDataWithExternalIdentities;
    const identities = getExternalIdentities(data);
    const nextIdentities = identities.map((existingIdentity) =>
      existingIdentity.key === key ? { ...existingIdentity, ...identity } : existingIdentity
    );
    if (!nextIdentities.some((existingIdentity) => existingIdentity.key === key)) {
      nextIdentities.push(identity);
    }

    await update(db, users)
      .set({
        name: name ?? existing.name,
        role,
        updated_at: now,
        data: {
          ...data,
          avatar: avatar ?? data.avatar,
          external_identities: nextIdentities,
        },
      })
      .where(eq(users.user_id, existing.user_id))
      .run();

    return usersService.get(existing.user_id as UserID, { provider: undefined });
  }

  const localEmail = await chooseLocalEmail(db, email, key, provider, issuer, subject);
  const userId = generateId() as UserID;
  const password = await hash(randomBytes(32).toString('hex'), 10);

  await insert(db, users)
    .values({
      user_id: userId,
      email: localEmail,
      password,
      name,
      emoji: '👤',
      role,
      created_at: now,
      updated_at: now,
      onboarding_completed: false,
      must_change_password: false,
      data: {
        avatar,
        preferences: {},
        external_identities: [identity],
      } as UserDataWithExternalIdentities,
    })
    .run();

  return usersService.get(userId, { provider: undefined });
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new NotAuthenticated('Invalid or expired one-time launch code');
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function exchangeLaunchCode(
  launchCode: string,
  settings: ResolvedLaunchSettings
): Promise<LaunchExchangeResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (settings.serviceCredential) headers.Authorization = `Bearer ${settings.serviceCredential}`;

  const body = {
    launch_code: launchCode,
    audience: settings.audience,
    instance_id: settings.instanceId,
  };

  const json = await fetchJson(
    settings.exchangeUrl as string,
    { method: 'POST', headers, body: JSON.stringify(body) },
    settings.requestTimeoutMs
  );

  if (!json || typeof json !== 'object') {
    throw new NotAuthenticated('Invalid one-time launch exchange response');
  }
  return json as LaunchExchangeResponse;
}

async function resolveVerificationKey(
  header: JwtHeader,
  settings: ResolvedLaunchSettings
): Promise<string | KeyObject> {
  if (settings.devSharedSecret) return settings.devSharedSecret;
  if (settings.publicKey) return settings.publicKey;
  if (!settings.jwksUrl) throw new NotAuthenticated('Launch assertion verification failed');

  const jwks = await fetchJson(settings.jwksUrl, { method: 'GET' }, settings.requestTimeoutMs);
  const keys = (jwks as { keys?: JsonWebKey[] })?.keys;
  const jwk = header.kid ? keys?.find((candidate) => candidate.kid === header.kid) : keys?.[0];
  if (!jwk) throw new NotAuthenticated('Launch assertion verification failed');
  return createPublicKey({ key: jwk, format: 'jwk' });
}

async function verifyLaunchAssertion(
  assertion: string,
  settings: ResolvedLaunchSettings
): Promise<LaunchClaims> {
  const decoded = jwt.decode(assertion, { complete: true });
  if (!decoded || typeof decoded !== 'object') {
    throw new NotAuthenticated('Invalid one-time launch assertion');
  }

  const key = await resolveVerificationKey(decoded.header, settings);
  const algorithms = settings.algorithms ?? (settings.devSharedSecret ? ['HS256'] : undefined);
  const claims = jwt.verify(assertion, key, {
    issuer: settings.issuer,
    audience: settings.audience,
    algorithms: algorithms as jwt.Algorithm[] | undefined,
  }) as LaunchClaims;

  validateLaunchClaims(claims, settings);
  return claims;
}

function validateLaunchClaims(claims: LaunchClaims, settings: ResolvedLaunchSettings): void {
  if (!claims.iss || claims.iss !== settings.issuer) {
    throw new NotAuthenticated('Invalid one-time launch assertion issuer');
  }
  if (!claims.sub || typeof claims.sub !== 'string') {
    throw new NotAuthenticated('Invalid one-time launch assertion subject');
  }
  if (settings.instanceId) {
    const claimInstance = claims.instance_id || claims.runtime_instance_id;
    if (claimInstance && claimInstance !== settings.instanceId) {
      throw new NotAuthenticated('Invalid one-time launch assertion instance');
    }
  }
  if (claims.jti !== undefined && typeof claims.jti !== 'string') {
    throw new NotAuthenticated('Invalid one-time launch assertion id');
  }
  if (claims.nonce !== undefined && typeof claims.nonce !== 'string') {
    throw new NotAuthenticated('Invalid one-time launch assertion nonce');
  }
}

function issueRuntimeTokens(
  user: User,
  jwtSecret: string,
  accessTokenTtl: SignOptions['expiresIn'],
  refreshTokenTtl: SignOptions['expiresIn']
): LaunchAuthResult {
  const accessToken = jwt.sign({ sub: user.user_id, type: 'access' }, jwtSecret, {
    expiresIn: accessTokenTtl,
    issuer: 'agor',
    audience: 'https://agor.dev',
  });
  const refreshToken = jwt.sign({ sub: user.user_id, type: 'refresh' }, jwtSecret, {
    expiresIn: refreshTokenTtl,
    issuer: 'agor',
    audience: 'https://agor.dev',
  });

  return {
    accessToken,
    refreshToken,
    authentication: { strategy: 'launch' },
    user,
  };
}

export function createLaunchAuthService(options: LaunchAuthServiceOptions) {
  return {
    async create(data: { launchCode?: string; launch_code?: string }, _params?: Params) {
      const launchCode = data?.launchCode || data?.launch_code;
      if (!launchCode || typeof launchCode !== 'string') {
        throw new BadRequest('launchCode is required');
      }

      const settings = resolveLaunchSettings(options.config);
      assertConfigured(settings);

      try {
        const exchange = await exchangeLaunchCode(launchCode, settings);
        if (!exchange.assertion) {
          throw new NotAuthenticated('Invalid one-time launch exchange response');
        }
        const claims = await verifyLaunchAssertion(exchange.assertion, settings);
        const user = await upsertLaunchUser(options, claims);
        return issueRuntimeTokens(
          user,
          options.jwtSecret,
          options.accessTokenTtl,
          options.refreshTokenTtl
        );
      } catch (error) {
        if (error instanceof BadRequest || error instanceof NotAuthenticated) {
          throw error;
        }
        throw new NotAuthenticated('Invalid or expired one-time launch code');
      }
    },
  };
}
