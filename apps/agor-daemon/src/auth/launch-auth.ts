import type { JsonWebKey, KeyObject } from 'node:crypto';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { analyticsLogger } from '@agor/core/analytics';
import {
  AgorAvatarAuthority,
  type AgorConfig,
  AgorRoleAuthority,
  AgorUserLifecycleAuthority,
  type ResolvedExternalLaunchProvider,
  resolveIdentityAuthority,
  resolveMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@agor/core/config';
import {
  and,
  eq,
  generateId,
  hash,
  insert,
  isExecutionHomeKeyAvailable,
  reattributeLegacyAnonymousRows,
  runWithTenantContext,
  runWithTenantDatabaseTransaction,
  seedInitialDataInTransaction,
  select,
  sql,
  TenantDisplayRepository,
  TenantPublicRoutingRepository,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UserApiKeysRepository,
  UserExternalIdentitiesRepository,
  update,
  userExternalIdentities,
  users,
  validateTenantDisplay,
  validateTenantPublicRouting,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated, Unavailable } from '@agor/core/feathers';
import type {
  Params,
  TenantDisplay,
  User,
  UserExternalIdentity,
  UserID,
  UserRole,
} from '@agor/core/types';
import {
  isValidExecutionHomeKey,
  MCP_OAUTH_RELAY,
  normalizeRole,
  PRODUCT_ANALYTICS_EVENTS,
  ROLES,
} from '@agor/core/types';
import jwt, { type JwtHeader, type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { lockTenantAuthorizationFence } from '../services/tenant-authorization-fence.js';
import { safeLaunchDiagnostic } from './launch-redaction.js';
import {
  issueRuntimeTokenPair,
  resolveSignedRuntimeTenant,
  runtimeTenantClaims,
} from './runtime-tokens.js';
import { readLaunchSubject, readRevalidatedAtMs, startBrowserSession } from './session-lifetime.js';
import {
  assertAuthenticationUserAuthMetadata,
  authCredentialGenerationClaim,
  authTokenIssuedAtClaim,
  type UserAuthTokenPayload,
} from './token-invalidation.js';
import { redactUserAuthMetadata } from './user-redaction.js';

export interface PublicLaunchAuthSettings {
  enabled: boolean;
  loginRedirectUrl?: string;
  /** Query parameter the UI uses to carry the current host to launch-init. */
  returnHostParam?: string;
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
  unix_username?: string | null;
  provider?: string;
  instance_id?: string;
  runtime_instance_id?: string;
  jti?: string;
  nonce?: string;
  public_base_url?: string;
  /** Optional tenant display label shown in the authenticated header. */
  workspace_display_name?: string;
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
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  provider: ResolvedExternalLaunchProvider;
  jwtSecret: string;
  accessTokenTtl: SignOptions['expiresIn'];
  refreshTokenTtl: number;
  /** Absolute lifetime in seconds of a launched session, counted from the launch. */
  sessionMaxLifetimeSeconds: number;
  usersService: { get(id: UserID, params?: Params): Promise<User> };
  onAuthorizationInvalidated?: (tenantId: string, userId: UserID) => void;
  /** Shared with the session revalidator so both projections use one queue. */
  serializeProjection?: LaunchProjectionSerializer;
}

export type LaunchProjectionSerializer = <T>(key: string, work: () => Promise<T>) => Promise<T>;

/**
 * SQLite uses one process-local connection and cannot begin two IMMEDIATE
 * transactions concurrently. PostgreSQL additionally takes the repository's
 * advisory lock, which extends the same identity serialization across HA
 * replicas. Failed projections release the queue so a later launch can retry.
 */
export function createLaunchProjectionSerializer(): LaunchProjectionSerializer {
  const projectionTails = new Map<string, Promise<void>>();
  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = projectionTails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tail = next.then(
      () => undefined,
      () => undefined
    );
    projectionTails.set(key, tail);
    try {
      return await next;
    } finally {
      if (projectionTails.get(key) === tail) projectionTails.delete(key);
    }
  };
}

export function resolvePublicLaunchAuthSettings(
  provider: ResolvedExternalLaunchProvider
): PublicLaunchAuthSettings {
  const enabled = provider.enabled;

  return {
    enabled,
    ...(enabled && provider.loginRedirectUrl
      ? { loginRedirectUrl: provider.loginRedirectUrl }
      : {}),
    ...(enabled && provider.returnHostParam ? { returnHostParam: provider.returnHostParam } : {}),
  };
}

function assertConfigured(settings: ResolvedExternalLaunchProvider): void {
  const rejectConfig = (reason: string): never => {
    console.warn(`[auth/launch] ${reason}`);
    throw new NotAuthenticated('One-time launch authentication is unavailable');
  };

  if (!settings.enabled) {
    rejectConfig('disabled');
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
  db: TenantScopedDatabase,
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
  settings: ResolvedExternalLaunchProvider,
  allowSuperadmin: boolean | undefined,
  existingRole?: UserRole,
  roleAuthority: AgorRoleAuthority = AgorRoleAuthority.INTERNAL
): UserRole {
  if (roleAuthority === AgorRoleAuthority.CLAIMS) {
    if (
      typeof claimedRole !== 'string' ||
      !['viewer', 'member', 'admin', 'superadmin', 'owner'].includes(claimedRole)
    ) {
      throw new NotAuthenticated('Invalid one-time launch assertion role');
    }
    const authoritativeRole = normalizeRole(claimedRole);
    if (
      (authoritativeRole === ROLES.ADMIN || authoritativeRole === ROLES.SUPERADMIN) &&
      !settings.allowAdminRoles
    ) {
      throw new NotAuthenticated('One-time launch assertion role is not enabled');
    }
    if (authoritativeRole === ROLES.SUPERADMIN && !allowSuperadmin) {
      throw new NotAuthenticated('One-time launch assertion superadmin role is not enabled');
    }
    return authoritativeRole;
  }

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
  db: TenantScopedDatabase,
  repository: UserExternalIdentitiesRepository,
  key: string
): Promise<typeof users.$inferSelect | null> {
  const binding = await repository.findByKey(key);
  if (binding) {
    const boundUser = await select(db).from(users).where(eq(users.user_id, binding.user_id)).one();
    if (!boundUser) {
      throw new NotAuthenticated('Invalid external identity binding');
    }
    return boundUser;
  }

  // Compatibility path for users projected before the relation existed. The
  // caller binds the discovered user transactionally before completing login.
  const rows = await select(db).from(users).all();
  for (const row of rows) {
    const identities = getExternalIdentities(row.data as UserDataWithExternalIdentities);
    if (identities.some((identity) => identity.key === key)) return row;
  }
  return null;
}

async function findUserByTrustedEmail(
  db: TenantScopedDatabase,
  email: string | undefined,
  key: string,
  settings: ResolvedExternalLaunchProvider,
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

async function projectLaunchUser(
  db: TenantScopedDatabase,
  options: Pick<LaunchAuthServiceOptions, 'config' | 'provider'>,
  claims: LaunchClaims,
  /** Revalidation only reprojects an already-bound user; it never links or creates one. */
  mode: 'launch' | 'revalidate' = 'launch'
): Promise<{ userId: UserID; authorizationChanged: boolean }> {
  const { config } = options;
  const issuer = claims.iss;
  const subject = claims.sub;
  const settings = options.provider;
  const identityAuthority = resolveIdentityAuthority(config);
  const provider = claims.provider || settings.providerId || issuer;
  const key = identityKey(provider, issuer, subject);
  const now = new Date();
  const nowIso = now.toISOString();
  const email = normalizeLaunchEmail(claims.email);
  if (
    identityAuthority.userLifecycle === AgorUserLifecycleAuthority.EXTERNAL &&
    claims.email !== undefined &&
    !email
  ) {
    throw new NotAuthenticated('Invalid one-time launch assertion email');
  }
  const name = claims.name?.trim() || undefined;
  const unixUsername = claims.unix_username?.trim() || null;
  if (
    claims.unix_username !== undefined &&
    unixUsername !== null &&
    !isValidExecutionHomeKey(unixUsername)
  ) {
    throw new NotAuthenticated('Invalid one-time launch assertion execution home');
  }
  // Avatar ownership is independent of external account/role authority. Do
  // not rehydrate even a cleared Agor-owned avatar on a subsequent launch.
  const avatar =
    identityAuthority.avatarAuthority === AgorAvatarAuthority.EXTERNAL
      ? claims.avatar || claims.picture
      : undefined;
  const identity: StoredExternalIdentity = {
    key,
    provider,
    issuer,
    subject,
    email,
    name,
    last_login_at: nowIso,
  };

  const planExistingUser = (existing: typeof users.$inferSelect) => {
    const data = (existing.data ?? {}) as UserDataWithExternalIdentities;
    const stored = getExternalIdentities(data).find((candidate) => candidate.key === key);
    return {
      data,
      stored,
      // A refresh is not a sign-in: only a launch moves last_login_at.
      identity:
        mode === 'revalidate' && stored?.last_login_at
          ? { ...identity, last_login_at: stored.last_login_at }
          : identity,
      role: mapRole(
        claims.role,
        settings,
        config.execution?.allow_superadmin,
        normalizeRole(existing.role ?? undefined),
        identityAuthority.roleAuthority
      ),
      email:
        identityAuthority.userLifecycle === AgorUserLifecycleAuthority.EXTERNAL &&
        email !== undefined
          ? email
          : existing.email,
      name: name ?? existing.name,
      unixUsername:
        identityAuthority.userLifecycle === AgorUserLifecycleAuthority.EXTERNAL &&
        claims.unix_username !== undefined
          ? unixUsername
          : (unixUsername ?? existing.unix_username),
      clearsForcedPasswordChange:
        !identityAuthority.capabilities.users.passwordWrite && existing.must_change_password,
    };
  };

  const identityRepository = new UserExternalIdentitiesRepository(db);

  if (mode === 'revalidate') {
    // The usual refresh changes nothing: confirm that without the tenant lock or a write.
    const binding = await identityRepository.findByKey(key);
    const bound = binding
      ? await select(db).from(users).where(eq(users.user_id, binding.user_id)).one()
      : null;
    if (binding && bound) {
      const plan = planExistingUser(bound);
      const unchanged =
        bound.role === plan.role &&
        bound.email === plan.email &&
        (bound.name ?? null) === (plan.name ?? null) &&
        (bound.unix_username ?? null) === (plan.unixUsername ?? null) &&
        !plan.clearsForcedPasswordChange &&
        (!avatar ||
          (plan.data.avatar_url === avatar && plan.data.avatar_source === 'launch-auth')) &&
        plan.stored !== undefined &&
        plan.stored.email === email &&
        plan.stored.name === name &&
        (binding.email ?? undefined) === email &&
        (binding.name ?? undefined) === name;
      if (unchanged) return { userId: bound.user_id as UserID, authorizationChanged: false };
    }
  }

  // Role projection is an authority mutation. Take the same tenant fence as
  // policy, group, prompt, terminal, and user-role commands before reading the
  // current row so a launch assertion cannot interleave a stale authorization
  // decision on another replica.
  await lockTenantAuthorizationFence(db);

  await identityRepository.lockProvisioningKey(`identity:${key}`);
  if (email) await identityRepository.lockProvisioningKey(`email:${email}`);

  const existing =
    (await findUserByExternalIdentity(db, identityRepository, key)) ??
    (mode === 'launch' ? await findUserByTrustedEmail(db, email, key, settings, claims) : null);
  if (!existing && mode === 'revalidate') {
    throw new NotAuthenticated('Invalid external identity binding');
  }
  if (existing) {
    const plan = planExistingUser(existing);
    const { data, role } = plan;
    const identities = getExternalIdentities(data);
    const nextIdentities = identities.map((existingIdentity) =>
      existingIdentity.key === key ? { ...existingIdentity, ...plan.identity } : existingIdentity
    );
    if (!nextIdentities.some((existingIdentity) => existingIdentity.key === key)) {
      nextIdentities.push(plan.identity);
    }

    if (
      plan.unixUsername &&
      !(await isExecutionHomeKeyAvailable(db, plan.unixUsername, existing.user_id))
    ) {
      throw new NotAuthenticated('External execution home is already assigned');
    }

    await update(db, users)
      .set({
        email: plan.email,
        name: plan.name,
        role,
        unix_username: plan.unixUsername,
        // Once identity authority is external there is no authoritative local
        // password-write path. Clear stale seed/manual flags while projecting
        // the linked account so the user cannot be trapped behind an
        // impossible forced-password-change flow.
        ...(identityAuthority.capabilities.users.passwordWrite
          ? {}
          : { must_change_password: false }),
        updated_at: now,
        data: {
          ...data,
          ...(avatar
            ? {
                avatar_url: avatar,
                avatar: undefined,
                avatar_source: 'launch-auth',
                avatar_source_id: undefined,
                avatar_synced_at: undefined,
              }
            : {}),
          external_identities: nextIdentities,
        },
      })
      .where(eq(users.user_id, existing.user_id))
      .run();
    await identityRepository.bind(existing.user_id as UserID, plan.identity, now);
    if (mode === 'launch') await reattributeLegacyAnonymousRows(db, existing.user_id);

    return {
      userId: existing.user_id as UserID,
      authorizationChanged: normalizeRole(existing.role) !== normalizeRole(role),
    };
  }

  const role = mapRole(
    claims.role,
    settings,
    config.execution?.allow_superadmin,
    undefined,
    identityAuthority.roleAuthority
  );
  const localEmail = await chooseLocalEmail(db, email, key, provider, issuer, subject);
  const userId = generateId() as UserID;
  const password = await hash(randomBytes(32).toString('hex'), 10);
  if (unixUsername && !(await isExecutionHomeKeyAvailable(db, unixUsername))) {
    throw new NotAuthenticated('External execution home is already assigned');
  }

  await insert(db, users)
    .values({
      user_id: userId,
      email: localEmail,
      password,
      name,
      emoji: '👤',
      role,
      unix_username: unixUsername,
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
  await identityRepository.bind(userId, identity, now);
  await reattributeLegacyAnonymousRows(db, userId);

  return { userId, authorizationChanged: false };
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new NotAuthenticated('Invalid or expired one-time launch code');
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read the normalized inbound browser Host from the trusted local request
 * context. The value comes from a single configured request header that the
 * trusted proxy / edge owns and overwrites — never from a client-supplied body
 * field. Multiple, array or comma-joined host values are treated as ambiguous
 * and rejected so a caller cannot smuggle a second host past the edge.
 *
 * Returns `undefined` when host forwarding is disabled. Throws (fail closed)
 * when forwarding is enabled but no unambiguous host is available.
 */
export function resolveRequestHost(
  settings: ResolvedExternalLaunchProvider,
  headers: Record<string, unknown> | undefined
): string | undefined {
  if (!settings.forwardRequestHost) return undefined;

  const wanted = settings.trustedHostHeader;
  let raw: unknown;
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === wanted) {
      raw = value;
      break;
    }
  }

  if (Array.isArray(raw)) {
    if (raw.length !== 1) {
      throw new NotAuthenticated('Ambiguous launch request host');
    }
    raw = raw[0];
  }
  if (typeof raw !== 'string') {
    throw new NotAuthenticated('Missing launch request host');
  }
  const host = raw.trim().toLowerCase();
  if (!host || host.includes(',') || /\s/.test(host)) {
    throw new NotAuthenticated('Invalid launch request host');
  }
  return host;
}

async function exchangeLaunchCode(
  launchCode: string,
  settings: ResolvedExternalLaunchProvider,
  requestHost: string | undefined
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
    // Host-bound launch: the issuer binds the code to the exact route the
    // browser entered. Only sent when configured; kept opaque to the daemon.
    ...(settings.forwardRequestHost && requestHost ? { request_host: requestHost } : {}),
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

/** The verification key could not be resolved (JWKS unreachable, or no key for this kid yet). */
class LaunchVerificationKeyUnavailableError extends NotAuthenticated {
  constructor() {
    super('Launch assertion verification failed');
  }
}

export async function resolveVerificationKey(
  header: JwtHeader,
  settings: ResolvedExternalLaunchProvider
): Promise<string | KeyObject> {
  if (settings.devSharedSecret) return settings.devSharedSecret;
  if (settings.publicKey) return settings.publicKey;
  if (!settings.jwksUrl) throw new NotAuthenticated('Launch assertion verification failed');

  if (!header.kid) {
    throw new NotAuthenticated('Launch assertion verification failed');
  }

  let jwks: unknown;
  try {
    jwks = await fetchJson(settings.jwksUrl, { method: 'GET' }, settings.requestTimeoutMs);
  } catch {
    throw new LaunchVerificationKeyUnavailableError();
  }
  const keys = (jwks as { keys?: JsonWebKey[] })?.keys;
  const jwk = keys?.find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new LaunchVerificationKeyUnavailableError();
  if (jwk.use && jwk.use !== 'sig')
    throw new NotAuthenticated('Launch assertion verification failed');
  if (header.alg && jwk.alg && jwk.alg !== header.alg) {
    throw new NotAuthenticated('Launch assertion verification failed');
  }
  return createPublicKey({ key: jwk, format: 'jwk' });
}

/** Purpose claim the issuer puts on refresh-time revalidation assertions; never a login assertion. */
export const LAUNCH_SESSION_REVALIDATION_PURPOSE = 'session_revalidation';

async function verifyLaunchAssertion(
  assertion: string,
  settings: ResolvedExternalLaunchProvider,
  expectedPurpose?: typeof LAUNCH_SESSION_REVALIDATION_PURPOSE
): Promise<LaunchClaims> {
  const decoded = jwt.decode(assertion, { complete: true });
  if (!decoded || typeof decoded !== 'object') {
    throw new NotAuthenticated('Invalid one-time launch assertion');
  }

  // Fail closed on the unsigned `none` algorithm regardless of configuration.
  if (!decoded.header.alg || decoded.header.alg.toLowerCase() === 'none') {
    throw new NotAuthenticated('Launch assertion verification failed');
  }

  const key = await resolveVerificationKey(decoded.header, settings);
  // The shared config parser supplies a key-compatible algorithm allow-list.
  // These fallbacks are defensive for callers constructing resolved settings
  // outside that parser; they preserve the historical JWKS/dev defaults.
  const algorithms = [
    ...(settings.algorithms ?? (settings.devSharedSecret ? ['HS256'] : ['RS256'])),
  ];
  const claims = jwt.verify(assertion, key, {
    issuer: settings.issuer,
    audience: settings.audience,
    algorithms: algorithms as jwt.Algorithm[],
  }) as LaunchClaims;

  validateLaunchClaims(claims, settings, expectedPurpose);
  return claims;
}

function validateLaunchClaims(
  claims: LaunchClaims,
  settings: ResolvedExternalLaunchProvider,
  expectedPurpose?: typeof LAUNCH_SESSION_REVALIDATION_PURPOSE
): void {
  // Callback delivery and revalidation assertions share the launch signing key but are never logins.
  if (
    expectedPurpose
      ? claims.purpose !== expectedPurpose
      : claims.purpose === MCP_OAUTH_RELAY.callbackPurpose ||
        claims.purpose === LAUNCH_SESSION_REVALIDATION_PURPOSE
  ) {
    throw new NotAuthenticated('Invalid one-time launch assertion purpose');
  }
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
  if (claims.public_base_url !== undefined) {
    try {
      validateTenantPublicRouting(claims.public_base_url, claims.iat);
    } catch {
      throw new NotAuthenticated('Invalid one-time launch assertion public URL');
    }
  }
}

/**
 * The display label is cosmetic, so unlike `public_base_url` an invalid value
 * never rejects the launch. It is dropped with one value-free warning code;
 * the label is customer text and is never logged.
 */
function verifiedTenantDisplay(claims: LaunchClaims): TenantDisplay | null {
  if (claims.workspace_display_name === undefined) return null;
  try {
    return validateTenantDisplay(claims.workspace_display_name, claims.iat);
  } catch {
    console.warn('[auth/launch] launch_workspace_display_name_invalid');
    return null;
  }
}

/**
 * Closed, reviewed set of secret-safe launch-failure reason codes. These are
 * the ONLY strings ever written to the operator log for a failed launch. An
 * error's free-text `message` is never logged: an unexpected error (a fetch/DNS
 * failure, a driver/DB error, a dependency exception, a re-thrown assertion or
 * verification detail) can embed a credential-bearing URL such as
 * `?access_token=…`, cookie/header text or connection strings, none of which
 * the structural redactor is guaranteed to catch. Classifying to a static code
 * gives operators useful differentiation while keeping arbitrary text out of
 * logs entirely.
 */
const LAUNCH_FAILURE_REASONS = {
  BAD_REQUEST: 'bad_request',
  EXCHANGE_REJECTED: 'exchange_rejected',
  EXCHANGE_RESPONSE_INVALID: 'exchange_response_invalid',
  ASSERTION_INVALID: 'assertion_invalid',
  ASSERTION_VERIFICATION_FAILED: 'assertion_verification_failed',
  ASSERTION_CLAIMS_INVALID: 'assertion_claims_invalid',
  REQUEST_HOST_INVALID: 'request_host_invalid',
  TENANT_RESOLUTION_FAILED: 'tenant_resolution_failed',
  LAUNCH_REJECTED: 'launch_rejected',
  UNEXPECTED: 'unexpected_error',
} as const;

/**
 * Strict allow-list mapping the module's own static rejection messages to a
 * differentiated reason code. Membership is tested only to SELECT a code — the
 * message itself is never emitted — so this stays a closed enum-like lookup and
 * degrades safely (to the coarse class-based code below) if a message drifts.
 */
const KNOWN_LAUNCH_FAILURE_REASONS: ReadonlyMap<string, string> = new Map([
  ['launchCode is required', LAUNCH_FAILURE_REASONS.BAD_REQUEST],
  ['launchCode is too long', LAUNCH_FAILURE_REASONS.BAD_REQUEST],
  ['Invalid or expired one-time launch code', LAUNCH_FAILURE_REASONS.EXCHANGE_REJECTED],
  ['Invalid one-time launch exchange response', LAUNCH_FAILURE_REASONS.EXCHANGE_RESPONSE_INVALID],
  ['Invalid one-time launch assertion', LAUNCH_FAILURE_REASONS.ASSERTION_INVALID],
  ['Launch assertion verification failed', LAUNCH_FAILURE_REASONS.ASSERTION_VERIFICATION_FAILED],
  ['Invalid one-time launch assertion issuer', LAUNCH_FAILURE_REASONS.ASSERTION_CLAIMS_INVALID],
  ['Invalid one-time launch assertion subject', LAUNCH_FAILURE_REASONS.ASSERTION_CLAIMS_INVALID],
  ['Invalid one-time launch assertion expiration', LAUNCH_FAILURE_REASONS.ASSERTION_CLAIMS_INVALID],
  ['Invalid one-time launch assertion instance', LAUNCH_FAILURE_REASONS.ASSERTION_CLAIMS_INVALID],
  ['Invalid one-time launch assertion id', LAUNCH_FAILURE_REASONS.ASSERTION_CLAIMS_INVALID],
  ['Invalid one-time launch assertion nonce', LAUNCH_FAILURE_REASONS.ASSERTION_CLAIMS_INVALID],
  ['Invalid one-time launch assertion public URL', LAUNCH_FAILURE_REASONS.ASSERTION_CLAIMS_INVALID],
  ['Invalid one-time launch assertion role', LAUNCH_FAILURE_REASONS.ASSERTION_CLAIMS_INVALID],
  ['Invalid one-time launch assertion email', LAUNCH_FAILURE_REASONS.ASSERTION_CLAIMS_INVALID],
  [
    'One-time launch assertion role is not enabled',
    LAUNCH_FAILURE_REASONS.ASSERTION_CLAIMS_INVALID,
  ],
  [
    'One-time launch assertion superadmin role is not enabled',
    LAUNCH_FAILURE_REASONS.ASSERTION_CLAIMS_INVALID,
  ],
  ['Ambiguous launch request host', LAUNCH_FAILURE_REASONS.REQUEST_HOST_INVALID],
  ['Missing launch request host', LAUNCH_FAILURE_REASONS.REQUEST_HOST_INVALID],
  ['Invalid launch request host', LAUNCH_FAILURE_REASONS.REQUEST_HOST_INVALID],
]);

/**
 * Map any launch failure to a static, secret-safe reason code. The raw message
 * is used ONLY as an allow-list lookup key and is never returned or logged; the
 * result is always a compile-time constant from {@link LAUNCH_FAILURE_REASONS}.
 */
export function classifyLaunchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const known = KNOWN_LAUNCH_FAILURE_REASONS.get(message);
  if (known) return known;
  if (error instanceof BadRequest) return LAUNCH_FAILURE_REASONS.BAD_REQUEST;
  if (error instanceof TenantResolutionError) {
    return LAUNCH_FAILURE_REASONS.TENANT_RESOLUTION_FAILED;
  }
  if (error instanceof NotAuthenticated) return LAUNCH_FAILURE_REASONS.LAUNCH_REJECTED;
  return LAUNCH_FAILURE_REASONS.UNEXPECTED;
}

function issueRuntimeTokens(
  user: User,
  options: Pick<
    LaunchAuthServiceOptions,
    'jwtSecret' | 'accessTokenTtl' | 'refreshTokenTtl' | 'sessionMaxLifetimeSeconds'
  >,
  launchSubject: string,
  tenantClaim = 'tenant_id',
  tenantId?: string
): LaunchAuthResult {
  assertAuthenticationUserAuthMetadata(user);
  const nowMs = Date.now();
  // A launch is a new sign-in: it starts a fresh absolute session lifetime.
  const session = startBrowserSession(options.sessionMaxLifetimeSeconds, { launchSubject, nowMs });
  const tokens = issueRuntimeTokenPair(
    user,
    options.jwtSecret,
    options.accessTokenTtl,
    options.refreshTokenTtl,
    {
      ...authCredentialGenerationClaim(user),
      ...authTokenIssuedAtClaim(nowMs, user),
      ...runtimeTenantClaims(tenantId ?? (user as { tenant_id?: string }).tenant_id, tenantClaim),
      ...session.claims,
    },
    { notAfterSeconds: session.notAfterSeconds }
  );

  return {
    ...tokens,
    authentication: { strategy: 'launch' },
    user: redactUserAuthMetadata(user),
  };
}

export function createLaunchAuthService(options: LaunchAuthServiceOptions) {
  const multiTenancy = resolveMultiTenancyConfig(options.config);
  const tenantClaim = multiTenancy.auth_claim ?? 'tenant_id';
  const serializeProjection = options.serializeProjection ?? createLaunchProjectionSerializer();

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

      const settings = options.provider;
      assertConfigured(settings);

      try {
        // Resolve the browser Host from the trusted local request context BEFORE
        // the exchange network call so a code minted for one host cannot be
        // presented through another, and a missing/ambiguous/invalid host fails
        // closed with no launch code ever leaving the daemon. Kept inside the
        // try so a host failure also yields a static, secret-safe diagnostic.
        const requestHost = resolveRequestHost(
          settings,
          params?.headers as Record<string, unknown> | undefined
        );

        const exchange = await exchangeLaunchCode(launchCode, settings, requestHost);
        if (!exchange.assertion) {
          throw new NotAuthenticated('Invalid one-time launch exchange response');
        }
        const claims = await verifyLaunchAssertion(exchange.assertion, settings);
        const display = verifiedTenantDisplay(claims);
        // Tenant scope for the runtime DB/RLS must derive ONLY from the
        // verified, signed assertion — never from params, params.tenant, or
        // request headers, all of which are attacker-influenced on the launch
        // request. We deliberately pass just the signed claims to the generic
        // resolver so `required_from_auth` cannot fall back to a trusted_header
        // or an explicit params tenant; an absent claim fails closed below.
        const tenant = resolveTenantContext(multiTenancy, { authPayload: claims });
        const provider = claims.provider || settings.providerId || claims.iss;
        const projectionKey = `${tenant.tenant_id}\0${provider}\0${claims.iss}\0${claims.sub}`;
        const projection = await serializeProjection(projectionKey, async () => {
          const projected = await runWithTenantDatabaseTransaction(
            options.db,
            tenant.tenant_id,
            async (scopedDb) => {
              const current = await projectLaunchUser(scopedDb, options, claims);
              if (claims.public_base_url !== undefined) {
                await new TenantPublicRoutingRepository(scopedDb).observeVerifiedLaunch(
                  validateTenantPublicRouting(claims.public_base_url, claims.iat)
                );
              }
              if (display) {
                await new TenantDisplayRepository(scopedDb).observeVerifiedLaunch(display);
              }
              // Claim the default Board while the same tenant authority fence
              // still serializes first-user projection. Immutable ownership
              // can therefore never be won by a later concurrent launch.
              await seedInitialDataInTransaction(scopedDb, current.userId);
              return current;
            }
          );
          if (projected.authorizationChanged) {
            // The role write and any first-run Board claim have committed.
            // Evict every socket that may still carry the previous role,
            // including this user's running agent executors.
            options.onAuthorizationInvalidated?.(tenant.tenant_id, projected.userId);
          }
          return projected;
        });
        const userLookupParams = {
          provider: undefined,
          tenant,
        };
        const user = await options.usersService.get(projection.userId, userLookupParams);
        const result = issueRuntimeTokens(user, options, claims.sub, tenantClaim, tenant.tenant_id);
        // The external provider has succeeded, projection committed, and Agor
        // issued its browser tokens. No provider claims enter analytics.
        runWithTenantContext(tenant.tenant_id, () =>
          analyticsLogger.track(
            PRODUCT_ANALYTICS_EVENTS.LOGIN_SUCCEEDED,
            { method: 'external_launch' },
            {
              userId: user.user_id,
            }
          )
        );
        return result;
      } catch (error) {
        // Every launch failure — expected or unexpected — emits exactly one
        // coarse operator diagnostic before rethrowing. Only a static reason
        // code from the closed classification is logged; the raw error message
        // is never emitted, so a credential-bearing URL (e.g. ?access_token=…),
        // assertion/verification text, cookies, DB URLs or dependency exception
        // text can never reach logs/telemetry. safeLaunchDiagnostic additionally
        // scrubs the per-request code/credential as defense in depth.
        console.warn(
          safeLaunchDiagnostic(classifyLaunchFailure(error), [
            launchCode,
            settings.serviceCredential,
            settings.devSharedSecret,
          ])
        );
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

export interface LaunchSessionRevalidatorOptions {
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  provider: ResolvedExternalLaunchProvider;
  serializeProjection: LaunchProjectionSerializer;
  onAuthorizationInvalidated?: (tenantId: string, userId: UserID) => void;
  now?: () => number;
}

export interface LaunchSessionRevalidationInput {
  userId: UserID;
  /** Trusted claims binding the check's tenant: a verified refresh token's, or a verified API key's tenant. */
  payload: UserAuthTokenPayload;
}

export interface LaunchSessionRevalidationResult {
  launchSubject: string;
  /** Last time the issuer confirmed membership; carried by the re-issued tokens. */
  revalidatedAtMs: number;
  /** Set while the issuer is unavailable: the re-issued access token may not outlive it. */
  notAfterSeconds?: number;
}

/**
 * Re-checks a launched user's current external membership before a refresh.
 * Resolves `null` when the user has no launch identity (a local account).
 * A refusal always rejects; an unavailable issuer is tolerated only inside
 * {@link LAUNCH_REVALIDATION_OUTAGE_GRACE_SECONDS} of the last confirmation.
 */
export type LaunchSessionRevalidator = (
  input: LaunchSessionRevalidationInput
) => Promise<LaunchSessionRevalidationResult | null>;

/** The issuer said this user is no longer a member; other rejections are about the response itself. */
export class LaunchMembershipRefusedError extends NotAuthenticated {}

/** The issuer's refusal code: the user is no longer an active member of the session's tenant. */
export const LAUNCH_SESSION_MEMBERSHIP_INACTIVE = 'membership_inactive';

/** True when refresh re-checks launched sessions with the issuer. */
export function launchSessionsAreRevalidated(provider: ResolvedExternalLaunchProvider): boolean {
  return Boolean(provider.enabled && provider.sessionRevalidationUrl);
}

/** Socket bounds for this install: only external launch ever bounds a user socket. */
export function resolveLaunchConnectionBounds(
  provider: ResolvedExternalLaunchProvider,
  sessionMaxLifetimeSeconds: number
): { launchedSessionMaxLifetimeSeconds?: number; userConnectionMaxAgeMs?: number } {
  return {
    ...(provider.enabled ? { launchedSessionMaxLifetimeSeconds: sessionMaxLifetimeSeconds } : {}),
    ...(launchSessionsAreRevalidated(provider)
      ? { userConnectionMaxAgeMs: LAUNCH_REVALIDATION_OUTAGE_GRACE_SECONDS * 1000 }
      : {}),
  };
}

/** How long a session may keep refreshing while the issuer is unreachable or erroring. */
export const LAUNCH_REVALIDATION_OUTAGE_GRACE_SECONDS = 3_600;

class LaunchRevalidationFailure extends Error {
  constructor(
    readonly reason: string,
    /** Transient failures may fall back to the outage grace. */
    readonly transient = false
  ) {
    super(reason);
  }
}

async function requestSessionRevalidation(
  url: string,
  body: Record<string, unknown>,
  settings: ResolvedExternalLaunchProvider
): Promise<string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (settings.serviceCredential) headers.Authorization = `Bearer ${settings.serviceCredential}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      throw new LaunchRevalidationFailure('issuer_unavailable', true);
    }
    if (!response.ok) {
      // Only the issuer's own membership answer is a refusal; proxies, origin checks and credential errors are an outage.
      const error = await response.json().then(
        (body: unknown) => (body as { error?: unknown } | null)?.error,
        () => undefined
      );
      if (response.status === 403 && error === LAUNCH_SESSION_MEMBERSHIP_INACTIVE) {
        throw new LaunchRevalidationFailure('membership_refused');
      }
      throw new LaunchRevalidationFailure('issuer_unavailable', true);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new LaunchRevalidationFailure('response_invalid', true);
    }
    const assertion = (json as { assertion?: unknown } | null)?.assertion;
    if (typeof assertion !== 'string' || !assertion) {
      throw new LaunchRevalidationFailure('response_invalid', true);
    }
    return assertion;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Build the refresh-time membership check for launched sessions. Returns
 * undefined unless external launch is enabled with a session revalidation URL,
 * so local and self-hosted installs keep their refresh behavior unchanged.
 */
export function createLaunchSessionRevalidator(
  options: LaunchSessionRevalidatorOptions
): LaunchSessionRevalidator | undefined {
  const settings = options.provider;
  const revalidationUrl = settings.sessionRevalidationUrl;
  if (!settings.enabled || !revalidationUrl || !settings.issuer) return undefined;
  const issuer = settings.issuer;
  const multiTenancy = resolveMultiTenancyConfig(options.config);
  const now = options.now ?? Date.now;

  return async ({ userId, payload }) => {
    let tenantId: string | undefined;
    try {
      const tenant = resolveSignedRuntimeTenant(multiTenancy, payload);
      if (!tenant) throw new LaunchRevalidationFailure('tenant_unavailable');
      tenantId = tenant.tenant_id;

      let subject = readLaunchSubject(payload);
      if (!subject) {
        // Sessions from before the subject claim, or from API-key sign-in, find the subject from any
        // identity at this issuer: the binding table or a legacy projection's JSON list.
        let subjects: Set<string>;
        try {
          subjects = await runWithTenantDatabaseTransaction(
            options.db,
            tenant.tenant_id,
            async (scopedDb) => {
              const bindings: Array<{ subject: string }> = await select(scopedDb)
                .from(userExternalIdentities)
                .where(
                  and(
                    eq(userExternalIdentities.user_id, userId),
                    eq(userExternalIdentities.issuer, issuer)
                  )
                )
                .all();
              const row = await select(scopedDb).from(users).where(eq(users.user_id, userId)).one();
              const legacy = getExternalIdentities(
                row?.data as UserDataWithExternalIdentities | null | undefined
              ).filter((identity) => identity.issuer === issuer);
              return new Set([...bindings, ...legacy].map((identity) => identity.subject));
            }
          );
        } catch {
          throw new LaunchRevalidationFailure('identity_lookup_unavailable', true);
        }
        if (subjects.size === 0) return null;
        if (subjects.size > 1) throw new LaunchRevalidationFailure('identity_ambiguous');
        [subject] = subjects;
      }

      // Bounded outage tolerance: keep the session until the grace deadline unless the issuer recovers.
      const deferOrThrow = (error: LaunchRevalidationFailure): LaunchSessionRevalidationResult => {
        const lastConfirmedMs = readRevalidatedAtMs(payload);
        if (!error.transient || !lastConfirmedMs || !subject) throw error;
        const notAfterSeconds =
          Math.floor(lastConfirmedMs / 1000) + LAUNCH_REVALIDATION_OUTAGE_GRACE_SECONDS;
        if (Math.floor(now() / 1000) >= notAfterSeconds) throw error;
        console.warn(`[auth.refresh] session_revalidation_deferred reason=${error.reason}`);
        return { launchSubject: subject, revalidatedAtMs: lastConfirmedMs, notAfterSeconds };
      };

      let assertion: string;
      try {
        assertion = await requestSessionRevalidation(
          revalidationUrl,
          {
            subject,
            tenant_id: tenant.tenant_id,
            audience: settings.audience,
            ...(settings.instanceId ? { instance_id: settings.instanceId } : {}),
          },
          settings
        );
      } catch (error) {
        if (!(error instanceof LaunchRevalidationFailure)) throw error;
        return deferOrThrow(error);
      }

      let claims: LaunchClaims;
      try {
        claims = await verifyLaunchAssertion(
          assertion,
          settings,
          LAUNCH_SESSION_REVALIDATION_PURPOSE
        );
      } catch (error) {
        // An unreachable JWKS or a key not yet published is an outage; a bad signature or claim is not.
        if (error instanceof LaunchVerificationKeyUnavailableError) {
          return deferOrThrow(new LaunchRevalidationFailure('verification_key_unavailable', true));
        }
        throw new LaunchRevalidationFailure('assertion_rejected');
      }
      if (claims.sub !== subject) throw new LaunchRevalidationFailure('subject_mismatch');
      let assertionTenant: string;
      try {
        assertionTenant = resolveTenantContext(multiTenancy, { authPayload: claims }).tenant_id;
      } catch {
        throw new LaunchRevalidationFailure('tenant_mismatch');
      }
      if (assertionTenant !== tenant.tenant_id) {
        throw new LaunchRevalidationFailure('tenant_mismatch');
      }

      const provider = claims.provider || settings.providerId || claims.iss;
      const projectionKey = `${tenant.tenant_id}\0${provider}\0${claims.iss}\0${claims.sub}`;
      try {
        await options.serializeProjection(projectionKey, async () => {
          const current = await runWithTenantDatabaseTransaction(
            options.db,
            tenant.tenant_id,
            async (scopedDb) => {
              let result: { userId: UserID; authorizationChanged: boolean };
              try {
                result = await projectLaunchUser(scopedDb, options, claims, 'revalidate');
              } catch (error) {
                // Projection rules refuse with NotAuthenticated; database errors stay transient.
                if (error instanceof NotAuthenticated) {
                  throw new LaunchRevalidationFailure('projection_rejected');
                }
                throw error;
              }
              // Throwing here rolls back a projection onto any other local user.
              if (result.userId !== userId) {
                throw new LaunchRevalidationFailure('identity_mismatch');
              }
              return result;
            }
          );
          if (current.authorizationChanged) {
            options.onAuthorizationInvalidated?.(tenant.tenant_id, current.userId);
          }
          return current;
        });
      } catch (error) {
        if (error instanceof LaunchRevalidationFailure) throw error;
        return deferOrThrow(new LaunchRevalidationFailure('projection_unavailable', true));
      }
      return { launchSubject: subject, revalidatedAtMs: now() };
    } catch (error) {
      // Reasons are static literals from this module, so they are safe to log.
      const reason = error instanceof LaunchRevalidationFailure ? error.reason : 'unexpected_error';
      console.warn(`[auth.refresh] session_revalidation_failed reason=${reason}`);
      // An outage past the grace issues nothing but leaves the credential alive, so the client retries.
      if (error instanceof LaunchRevalidationFailure && error.transient) {
        throw new Unavailable('Session check is temporarily unavailable');
      }
      if (reason === 'membership_refused' && tenantId) {
        const refusedTenantId = tenantId;
        try {
          // Same fence as a password change: the generation holds against racing refreshes and clock skew.
          await runWithTenantDatabaseTransaction(options.db, refusedTenantId, async (scopedDb) => {
            await update(scopedDb, users)
              .set({
                tokens_valid_after: new Date(now()),
                credential_generation: sql`${users.credential_generation} + 1`,
              })
              .where(eq(users.user_id, userId))
              .run();
            // Personal keys carry no generation claim, so a refusal has to remove them.
            await new UserApiKeysRepository(scopedDb).deleteAllForUser(userId);
          });
        } catch {
          console.warn('[auth.refresh] session_revalidation_fence_failed');
        }
        options.onAuthorizationInvalidated?.(refusedTenantId, userId);
        throw new LaunchMembershipRefusedError('Invalid or expired refresh token');
      }
      throw new NotAuthenticated('Invalid or expired refresh token');
    }
  };
}
