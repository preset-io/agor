import type { JsonWebKey, KeyObject } from 'node:crypto';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import {
  type AgorConfig,
  resolveMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@agor/core/config';
import {
  type Database,
  eq,
  generateId,
  hash,
  insert,
  reattributeLegacyAnonymousRows,
  runWithTenantDatabaseScope,
  select,
  update,
  users,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type {
  Params,
  TenantContext,
  User,
  UserExternalIdentity,
  UserID,
  UserRole,
} from '@agor/core/types';
import { normalizeRole, ROLES } from '@agor/core/types';
import jwt, { type JwtHeader, type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { issueRuntimeTokenPair, runtimeTenantClaims } from './runtime-tokens.js';
import { authTokenIssuedAtClaim } from './token-invalidation.js';
import { redactUserAuthMetadata } from './user-redaction.js';

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
  allowAdminRoles: boolean;
  trustVerifiedEmailForLinking: boolean;
  requestTimeoutMs: number;
  algorithms?: string[];
}

export interface PublicLaunchAuthSettings {
  enabled: boolean;
  loginRedirectUrl?: string;
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
  email_verified?: boolean;
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

type StoredExternalIdentity = UserExternalIdentity;

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
    allowAdminRoles: raw?.allow_admin_roles === true,
    trustVerifiedEmailForLinking: raw?.trust_verified_email_for_linking === true,
    requestTimeoutMs: raw?.request_timeout_ms ?? DEFAULT_TIMEOUT_MS,
    algorithms: raw?.algorithms,
  };
}

export function resolvePublicLaunchAuthSettings(config: AgorConfig): PublicLaunchAuthSettings {
  const raw = config.external_launch;
  const enabled = envFlag(process.env.AGOR_EXTERNAL_LAUNCH_ENABLED) ?? raw?.enabled === true;

  return {
    enabled,
    ...(enabled && raw?.login_redirect_url ? { loginRedirectUrl: raw.login_redirect_url } : {}),
  };
}

function assertConfigured(settings: ResolvedLaunchSettings): void {
  const rejectConfig = (reason: string): never => {
    console.warn(`[auth/launch] ${reason}`);
    throw new NotAuthenticated('One-time launch authentication is unavailable');
  };

  if (!settings.enabled) {
    rejectConfig('disabled');
  }
  if (!settings.exchangeUrl) {
    rejectConfig('missing exchange_url');
  }
  if (!settings.issuer || !settings.audience) {
    rejectConfig('missing issuer or audience');
  }
  const configuredKeyCount = [
    settings.jwksUrl,
    settings.publicKey,
    settings.devSharedSecret,
  ].filter(Boolean).length;
  if (configuredKeyCount === 0) {
    rejectConfig('missing assertion verification key');
  }
  if (configuredKeyCount > 1) {
    rejectConfig('multiple assertion verification methods configured');
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

function getExternalIdentities(
  data: UserDataWithExternalIdentities | null | undefined
): StoredExternalIdentity[] {
  return Array.isArray(data?.external_identities) ? data.external_identities : [];
}

function normalizeLaunchEmail(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  if (!email) return undefined;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

function mapRole(
  claimedRole: string | undefined,
  settings: ResolvedLaunchSettings,
  allowSuperadmin: boolean | undefined,
  existingRole?: UserRole
): UserRole {
  const role = normalizeRole(claimedRole);
  const allowedRoles: UserRole[] = settings.allowAdminRoles
    ? [ROLES.VIEWER, ROLES.MEMBER, ROLES.ADMIN, ROLES.SUPERADMIN]
    : [ROLES.VIEWER, ROLES.MEMBER];
  const mapped = allowedRoles.includes(role) ? role : ROLES.MEMBER;
  const capped = mapped === ROLES.SUPERADMIN && !allowSuperadmin ? ROLES.ADMIN : mapped;
  // Existing local roles are preserved unless admin role mapping is explicitly
  // enabled above; a default launch provider cannot silently escalate or
  // downgrade a previously mapped user.
  return existingRole && !settings.allowAdminRoles ? existingRole : capped;
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

async function findUserByTrustedEmail(
  db: Database,
  email: string | undefined,
  key: string,
  settings: ResolvedLaunchSettings,
  claims: LaunchClaims
): Promise<typeof users.$inferSelect | null> {
  if (!settings.trustVerifiedEmailForLinking || claims.email_verified !== true || !email) {
    return null;
  }

  const existing = await select(db).from(users).where(eq(users.email, email)).one();
  if (!existing) return null;

  const identities = getExternalIdentities(existing.data as UserDataWithExternalIdentities);
  // Preserve explicit mappings to other external identities. The trusted-email
  // path is primarily for first Agor Cloud joins where a local seeded/manual
  // account already exists with the verified registration email.
  if (identities.length > 0 && !identities.some((identity) => identity.key === key)) {
    return null;
  }

  return existing;
}

async function upsertLaunchUser(
  options: LaunchAuthServiceOptions,
  claims: LaunchClaims,
  tenant?: TenantContext
): Promise<User> {
  const { db, config, usersService } = options;
  const issuer = claims.iss;
  const subject = claims.sub;
  const settings = resolveLaunchSettings(config);
  const userLookupParams = {
    provider: undefined,
    ...(tenant ? { tenant } : {}),
  };
  const provider = claims.provider || settings.providerId || issuer;
  const key = identityKey(provider, issuer, subject);
  const now = new Date();
  const nowIso = now.toISOString();
  const email = normalizeLaunchEmail(claims.email);
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

  const existing =
    (await findUserByExternalIdentity(db, key)) ??
    (await findUserByTrustedEmail(db, email, key, settings, claims));
  if (existing) {
    const role = mapRole(
      claims.role,
      settings,
      config.execution?.allow_superadmin,
      normalizeRole(existing.role ?? undefined)
    );
    const data = (existing.data ?? {}) as UserDataWithExternalIdentities;
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
          avatar_url: avatar ?? data.avatar_url ?? data.avatar,
          avatar_source: avatar ? 'launch-auth' : data.avatar_source,
          external_identities: nextIdentities,
        },
      })
      .where(eq(users.user_id, existing.user_id))
      .run();
    await reattributeLegacyAnonymousRows(db, existing.user_id);

    return usersService.get(existing.user_id as UserID, userLookupParams);
  }

  const role = mapRole(claims.role, settings, config.execution?.allow_superadmin);
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
        avatar_url: avatar,
        avatar,
        avatar_source: avatar ? 'launch-auth' : undefined,
        preferences: {},
        external_identities: [identity],
      } as UserDataWithExternalIdentities,
    })
    .run();
  await reattributeLegacyAnonymousRows(db, userId);

  return usersService.get(userId, userLookupParams);
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

  if (!header.kid) {
    throw new NotAuthenticated('Launch assertion verification failed');
  }

  const jwks = await fetchJson(settings.jwksUrl, { method: 'GET' }, settings.requestTimeoutMs);
  const keys = (jwks as { keys?: JsonWebKey[] })?.keys;
  const jwk = keys?.find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new NotAuthenticated('Launch assertion verification failed');
  if (jwk.use && jwk.use !== 'sig')
    throw new NotAuthenticated('Launch assertion verification failed');
  if (header.alg && jwk.alg && jwk.alg !== header.alg) {
    throw new NotAuthenticated('Launch assertion verification failed');
  }
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
  if (typeof claims.exp !== 'number') {
    throw new NotAuthenticated('Invalid one-time launch assertion expiration');
  }
  if (settings.instanceId) {
    const claimInstance = claims.instance_id || claims.runtime_instance_id;
    if (typeof claimInstance !== 'string' || claimInstance !== settings.instanceId) {
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
  refreshTokenTtl: SignOptions['expiresIn'],
  tenantClaim = 'tenant_id',
  tenantId?: string
): LaunchAuthResult {
  const tokens = issueRuntimeTokenPair(user, jwtSecret, accessTokenTtl, refreshTokenTtl, {
    ...authTokenIssuedAtClaim(Date.now(), user),
    ...runtimeTenantClaims(tenantId ?? (user as { tenant_id?: string }).tenant_id, tenantClaim),
  });

  return {
    ...tokens,
    authentication: { strategy: 'launch' },
    user: redactUserAuthMetadata(user),
  };
}

export function createLaunchAuthService(options: LaunchAuthServiceOptions) {
  const multiTenancy = resolveMultiTenancyConfig(options.config);
  const tenantClaim = multiTenancy.auth_claim ?? 'tenant_id';
  return {
    async create(data: { launchCode?: string; launch_code?: string }, params?: Params) {
      const launchCode =
        typeof data?.launchCode === 'string'
          ? data.launchCode.trim()
          : typeof data?.launch_code === 'string'
            ? data.launch_code.trim()
            : '';
      if (!launchCode) {
        throw new BadRequest('launchCode is required');
      }
      if (launchCode.length > 4096) {
        throw new BadRequest('launchCode is too long');
      }

      const settings = resolveLaunchSettings(options.config);
      assertConfigured(settings);

      try {
        const exchange = await exchangeLaunchCode(launchCode, settings);
        if (!exchange.assertion) {
          throw new NotAuthenticated('Invalid one-time launch exchange response');
        }
        const claims = await verifyLaunchAssertion(exchange.assertion, settings);
        const tenant = resolveTenantContext(multiTenancy, {
          params,
          authPayload: claims,
          headers: params?.headers as Record<string, unknown> | undefined,
        });
        return await runWithTenantDatabaseScope(options.db, tenant.tenant_id, async () => {
          const user = await upsertLaunchUser(options, claims, tenant);
          return issueRuntimeTokens(
            user,
            options.jwtSecret,
            options.accessTokenTtl,
            options.refreshTokenTtl,
            tenantClaim,
            tenant.tenant_id
          );
        });
      } catch (error) {
        if (error instanceof BadRequest || error instanceof NotAuthenticated) {
          throw error;
        }
        if (error instanceof TenantResolutionError) {
          throw new NotAuthenticated(error.message);
        }
        throw new NotAuthenticated('Invalid or expired one-time launch code');
      }
    },
  };
}
