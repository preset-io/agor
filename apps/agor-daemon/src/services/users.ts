/**
 * Users Service
 *
 * Handles user authentication and management.
 * Only active when authentication is enabled via config.
 */

import {
  materializeAgenticToolConfiguration,
  normalizeAgenticToolModelConfiguration,
} from '@agor/agentic-tools/config';
import {
  type AgorConfig,
  type AgorIdentityCapability,
  AgorLocalAuthMode,
  AgorRoleAuthority,
  AgorUserLifecycleAuthority,
  assertInlineAgenticConfigurationAllowed,
  assertSecurePassword,
  assertV05Scope,
  getEnvVarBlockReason,
  AgorIdentityCapability as IdentityCapability,
  isEnvVarAllowed,
  normalizeStoredEnvMap,
  PasswordPolicyError,
  PasswordValidationCode,
  type ResolvedIdentityAuthority,
  resolveIdentityAuthority,
  resolveUserEnvironment,
  type StoredEnvVar,
  validateEnvVar,
} from '@agor/core/config';
import {
  and,
  boards,
  branches,
  compare,
  decryptApiKey,
  deleteFrom,
  encryptApiKey,
  eq,
  generateId,
  getCurrentTenantId,
  hashLocalPassword,
  inArray,
  insert,
  isExecutionHomeKeyAvailable,
  isNull,
  isPostgresDatabaseHandle,
  jsonExtract,
  runWithTenantDatabaseTransaction,
  select,
  sessionEnvSelections,
  sessions,
  sql,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UserPrimaryTeammateRepository,
  update,
  users,
} from '@agor/core/db';
import {
  type Application,
  BadRequest,
  Forbidden,
  NotAuthenticated,
  NotFound,
} from '@agor/core/feathers';
import { isLikelyGitToken } from '@agor/core/git/pure';
import { isInvalidModelConfigError } from '@agor/core/models';
import type {
  AgenticAuthMethods,
  AgenticCredentialSources,
  AgenticToolName,
  AgenticToolsConfig,
  AgenticToolsUpdate,
  AuthenticatedParams,
  Branch,
  BranchID,
  EnvVarMetadata,
  EnvVarScope,
  InternalUser,
  Paginated,
  Params,
  StoredAgenticTools,
  User,
  UserAvatarSettings,
  UserAvatarSyncRequest,
  UserAvatarSyncResult,
  UserID,
  UserRole,
} from '@agor/core/types';
import {
  AGENTIC_TOOL_NAMES,
  canAssignUserRole,
  extractAgenticToolsPublicValues,
  hasMinimumRole,
  hasRoleAuthorityOver,
  isAgenticToolName,
  isUserRole,
  isValidExecutionHomeKey,
  normalizeRole,
  ROLES,
  toAgenticToolsStatus,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor/core/types';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import type { ClaudeUserCredentialPatchCoordinator } from './claude-credential-mutation.js';
import { lockTenantAuthorizationFence } from './tenant-authorization-fence.js';
import { UserAvatarSyncManager } from './user-avatar-sync.js';
import {
  getTrustedUserMutationPurpose,
  type TrustedUserMutationPurpose,
} from './user-mutation-trust.js';

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return Math.floor(numeric);
}

function queryString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function usersTableHasTenantColumn(): boolean {
  return 'tenant_id' in (users as unknown as object);
}

function tenantPredicate(params?: Params) {
  const tenantId = (params as { tenant?: { tenant_id?: string } } | undefined)?.tenant?.tenant_id;
  if (!tenantId || !usersTableHasTenantColumn()) return undefined;
  return eq((users as never as { tenant_id: never }).tenant_id, tenantId);
}

function withTenantPredicate(params: Params | undefined, predicate: unknown) {
  const tenant = tenantPredicate(params);
  return tenant ? and(predicate as never, tenant) : predicate;
}

function tenantInsertValues(params?: Params): { tenant_id?: string } {
  const tenantId = (params as { tenant?: { tenant_id?: string } } | undefined)?.tenant?.tenant_id;
  return tenantId && usersTableHasTenantColumn() ? { tenant_id: tenantId } : {};
}

/**
 * Public User transport surface. UsersService is not a DrizzleService and
 * defines no `update` — listing the verb here would make Feathers' hook wiring
 * throw "Can not apply hooks. 'update' is not a function" at startup.
 */
export const USERS_SERVICE_TRANSPORT_METHODS = [
  'find',
  'get',
  'create',
  'patch',
  'remove',
  'getAvatarSettings',
  'updateAvatarSettings',
  'syncAvatars',
  'getPrimaryTeammate',
  'getPrimaryTeammateCandidates',
  'setPrimaryTeammate',
  'setPrimaryTeammateIfUnset',
  'setPrimaryAgenticToolIfUnset',
] as const;

export const LOCAL_AUTH_LOOKUP_PARAM = Symbol('agor.users.local-auth-lookup');
export const AUTH_INTERNAL_USER_LOOKUP_PARAM = Symbol('agor.users.auth-internal-lookup');
const USER_PATCH_LOCK_HELD_PARAM = Symbol('agor.users.patch-lock-held');

// SQLite runs one daemon and has no cross-process writer, but two async
// requests can still read the same users.data snapshot and then overlap on the
// one libSQL handle. Serialize per tenant/user through authorization,
// encryption, and the final transaction. PostgreSQL keeps its database
// advisory/CAS fences as the cross-replica authority; this local lock merely
// avoids needless same-process conflicts there.
const userPatchLocks = new Map<string, Promise<void>>();
const sqliteTenantAuthorityLocks = new Map<string, Promise<void>>();

async function withSqliteTenantAuthorityLock<T>(
  db: TenantScopeAwareDatabase | TenantScopedDatabase,
  params: Params | undefined,
  work: () => Promise<T>
): Promise<T> {
  if (isPostgresDatabaseHandle(db)) return work();
  const tenantId =
    (params as AuthenticatedParams | undefined)?.tenant?.tenant_id ??
    getCurrentTenantId() ??
    '<standalone>';
  const key = String(tenantId);
  const previous = sqliteTenantAuthorityLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  sqliteTenantAuthorityLocks.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (sqliteTenantAuthorityLocks.get(key) === current) sqliteTenantAuthorityLocks.delete(key);
  }
}

async function withUserPatchLock<T>(
  id: UserID,
  params: Params | undefined,
  work: (params: Params) => Promise<T>
): Promise<T> {
  const tenantId =
    (params as AuthenticatedParams | undefined)?.tenant?.tenant_id ??
    getCurrentTenantId() ??
    '<standalone>';
  const key = `${tenantId}\0${id}`;
  const previous = userPatchLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  userPatchLocks.set(key, current);
  await previous;
  try {
    const lockedParams = { ...(params ?? {}) } as Params & {
      [USER_PATCH_LOCK_HELD_PARAM]: boolean;
    };
    lockedParams[USER_PATCH_LOCK_HELD_PARAM] = true;
    return await work(lockedParams);
  } finally {
    release();
    if (userPatchLocks.get(key) === current) userPatchLocks.delete(key);
  }
}

export interface LocalAuthenticationLookupParams extends Params {
  [LOCAL_AUTH_LOOKUP_PARAM]?: true;
  [AUTH_INTERNAL_USER_LOOKUP_PARAM]?: true;
}

export function markLocalAuthenticationLookup(params: Params): void {
  (params as LocalAuthenticationLookupParams)[LOCAL_AUTH_LOOKUP_PARAM] = true;
}

export function markAuthenticationUserLookup(params: Params): void {
  (params as LocalAuthenticationLookupParams)[AUTH_INTERNAL_USER_LOOKUP_PARAM] = true;
}

export function isLocalAuthenticationLookup(params: Params | undefined): boolean {
  return (
    (params as LocalAuthenticationLookupParams | undefined)?.[LOCAL_AUTH_LOOKUP_PARAM] === true
  );
}

export function isAuthenticationUserLookup(params: Params | undefined): boolean {
  return (
    (params as LocalAuthenticationLookupParams | undefined)?.[AUTH_INTERNAL_USER_LOOKUP_PARAM] ===
    true
  );
}

function shouldIncludeAuthMetadata(params: Params | undefined, includePassword = false): boolean {
  return includePassword || !params?.provider || isAuthenticationUserLookup(params);
}

function isServiceAccount(params: Params | undefined): boolean {
  return !!(params as AuthenticatedParams | undefined)?.user?._isServiceAccount;
}

function isAdmin(params: Params | undefined): boolean {
  return hasMinimumRole((params as AuthenticatedParams | undefined)?.user?.role, ROLES.ADMIN);
}

function isSelfEmailLookup(params: Params | undefined, email: string): boolean {
  const requesterEmail = (params as AuthenticatedParams | undefined)?.user?.email;
  return !!requesterEmail && requesterEmail.toLowerCase() === email.toLowerCase();
}

function requireCallerId(params: Params | undefined): UserID {
  const userId = (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined;
  if (!userId) {
    throw new NotAuthenticated('Authentication required');
  }
  return userId;
}

function ensureCanExactEmailLookup(params: Params | undefined, email: string): void {
  // Internal service calls are trusted and may perform exact-email lookups for
  // auth/session bootstrap paths. External callers need an authenticated admin,
  // service account, or a self lookup. The Feathers local strategy is the lone
  // unauthenticated external path; it receives the password hash only inside the
  // authentication pipeline and must never be exposed by /users responses.
  if (!params?.provider || isLocalAuthenticationLookup(params)) return;

  if (!(params as AuthenticatedParams | undefined)?.user) {
    throw new NotAuthenticated('Authentication required');
  }

  if (isServiceAccount(params) || isAdmin(params) || isSelfEmailLookup(params, email)) {
    return;
  }

  throw new Forbidden('Exact email user lookup is restricted');
}

/**
 * Apply a per-tool credential patch to the encrypted-at-rest blob.
 *
 * Patch semantics (mirror UpdateUserInput.agentic_tools):
 *   - `string` value → encrypt and set the field
 *   - `null` value   → delete the field
 *   - omitted field  → untouched
 *   - if a tool's bucket becomes empty post-patch, the bucket is removed
 *
 * Returns the next stored shape (caller writes it back to `data.agentic_tools`).
 */
function applyAgenticToolsPatch(
  current: StoredAgenticTools,
  patch: AgenticToolsUpdate
): StoredAgenticTools {
  const next: StoredAgenticTools = { ...current };
  for (const [tool, fields] of Object.entries(patch) as Array<
    [AgenticToolName, Record<string, string | null> | undefined]
  >) {
    if (!fields) continue;
    const bucket: Record<string, string> = { ...((next[tool] as Record<string, string>) ?? {}) };
    for (const [field, value] of Object.entries(fields)) {
      if (value === null || value === undefined) {
        delete bucket[field];
      } else {
        try {
          bucket[field] = encryptApiKey(value);
          console.log(`🔐 Encrypted user agentic_tools.${tool}.${field}`);
        } catch (err) {
          console.error(`Failed to encrypt agentic_tools.${tool}.${field}:`, err);
          throw new Error(`Failed to encrypt agentic_tools.${tool}.${field}`);
        }
      }
    }
    if (Object.keys(bucket).length > 0) {
      (next as Record<string, Record<string, string>>)[tool] = bucket;
    } else {
      delete next[tool];
    }
  }
  return next;
}

/**
 * Create user input
 */
interface CreateUserData {
  email: string;
  password: string;
  name?: string;
  emoji?: string;
  role?: UserRole;
  unix_username?: string;
  filesystem_home?: string;
  must_change_password?: boolean;
  avatar_url?: string | null;
  avatar?: string | null;
  avatar_source?: string | null;
  avatar_source_id?: string | null;
  avatar_synced_at?: string | null;
}

/**
 * Update user input
 */
interface UpdateUserData {
  email?: string;
  password?: string;
  name?: string;
  emoji?: string;
  role?: UserRole;
  unix_username?: string;
  filesystem_home?: string;
  must_change_password?: boolean;
  avatar_url?: string | null;
  avatar?: string | null;
  avatar_source?: string | null;
  avatar_source_id?: string | null;
  avatar_synced_at?: string | null;
  preferences?: Record<string, unknown>;
  onboarding_completed?: boolean;
  /**
   * Per-tool credential patch. Each tool's sub-object is a partial patch —
   * `string` sets and encrypts, `null` clears, omitted fields are untouched.
   * Field names are env var names exported into the SDK CLI environment.
   */
  agentic_tools?: AgenticToolsUpdate;
  agentic_auth_methods?: AgenticAuthMethods;
  agentic_credential_sources?: AgenticCredentialSources;
  // Environment variables for update (accepts plaintext, encrypted before storage)
  env_vars?: Record<string, string | null>; // { "GITHUB_TOKEN": "ghp_...", "NPM_TOKEN": null }
  // Per-var scope updates (v0.5: 'global' | 'session'). Applied after env_vars
  // changes in the same PATCH. Scope for a var that doesn't exist is a no-op.
  env_var_scopes?: Record<string, EnvVarScope>;
  // Default agentic tool configurations
  primary_agentic_tool?: AgenticToolName;
  default_agentic_config?: import('@agor/core/types').DefaultAgenticConfig;
  default_agentic_selection?: import('@agor/core/types').UserAgenticDefaultSelections;
  default_mcp_server_ids?: string[];
}

type UserRow = typeof users.$inferSelect;

interface AuthorizedUserMutation {
  target: UserRow;
  actor?: UserRow;
}

const USER_AUTHORITY_DENIED = 'You do not have authority to manage this user';
const ADMIN_OWNED_USER_FIELDS = new Set<keyof UpdateUserData>([
  'role',
  'unix_username',
  'filesystem_home',
  'must_change_password',
]);
const TRUSTED_USER_MUTATION_FIELDS: Readonly<
  Record<TrustedUserMutationPurpose, ReadonlySet<keyof UpdateUserData>>
> = {
  'avatar-sync': new Set([
    'avatar_url',
    'avatar',
    'avatar_source',
    'avatar_source_id',
    'avatar_synced_at',
  ]),
  'env-vars-widget': new Set(['env_vars', 'env_var_scopes']),
  'claude-auth': new Set(['agentic_tools', 'agentic_auth_methods', 'agentic_credential_sources']),
};

function canonicalizeRoleWrite(value: unknown): UserRole {
  const normalized = value === 'owner' ? ROLES.SUPERADMIN : value;
  if (!isUserRole(normalized)) {
    throw new BadRequest('Invalid user role');
  }
  return normalized;
}

function assertSingleUserMutation(data: unknown): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new BadRequest('Bulk user mutations are not supported');
  }
  if (Object.hasOwn(data, 'password_hash') || Object.hasOwn(data, 'passwordHash')) {
    throw new BadRequest('Password hashes cannot be assigned through the users service.', {
      code: PasswordValidationCode.HASH_NOT_ACCEPTED,
    });
  }
  if (Object.hasOwn(data, 'credential_generation') || Object.hasOwn(data, 'tokens_valid_after')) {
    throw new BadRequest(
      'Password credential metadata cannot be assigned through the users service.',
      { code: PasswordValidationCode.CREDENTIAL_METADATA_NOT_ACCEPTED }
    );
  }
}

function assertTrustedMutationFields(
  purpose: TrustedUserMutationPurpose,
  data: UpdateUserData
): void {
  const allowed = TRUSTED_USER_MUTATION_FIELDS[purpose];
  if (!Object.keys(data).every((field) => allowed.has(field as keyof UpdateUserData))) {
    throw new Forbidden(`${purpose} cannot modify the requested user fields`);
  }
}

function assertValidExecutionHomeKeyWrite(value: string | undefined): void {
  if (value === undefined || isValidExecutionHomeKey(value)) return;
  throw new BadRequest(
    'Execution home key must start with a lowercase letter or underscore, contain only lowercase letters, numbers, hyphens, or underscores, and be at most 32 characters.'
  );
}

function validatedAssignedPassword(password: unknown, email?: string): string {
  try {
    assertSecurePassword(password, { email });
    return password;
  } catch (error) {
    if (!(error instanceof PasswordPolicyError)) throw error;
    throw new BadRequest(error.message, {
      code: error.code,
      policy: error.requirements.profile,
      min_length: error.requirements.min_length,
      max_utf8_bytes: error.requirements.max_utf8_bytes,
    });
  }
}

/**
 * Users Service Methods
 */
export class UsersService {
  private avatarSync?: UserAvatarSyncManager;
  private readonly identityAuthority: ResolvedIdentityAuthority;

  constructor(
    protected db: TenantScopeAwareDatabase | TenantScopedDatabase,
    protected app?: Application,
    config?: AgorConfig,
    private readonly claudeCredentialPatches?: ClaudeUserCredentialPatchCoordinator
  ) {
    const effectiveConfig = config ?? (app?.get('config') as AgorConfig | undefined) ?? {};
    this.identityAuthority = resolveIdentityAuthority(effectiveConfig);
    if (app) {
      // Application-bound services are created only from the long-lived,
      // tenant-scope-aware base handle. Transaction-bound services omit app.
      this.avatarSync = new UserAvatarSyncManager(db as TenantScopeAwareDatabase, app);
    }
  }

  private externallyManaged(
    capability: AgorIdentityCapability,
    authority: typeof AgorUserLifecycleAuthority.EXTERNAL | typeof AgorRoleAuthority.CLAIMS
  ): never {
    throw new Forbidden('This user field is managed by the configured identity provider', {
      code: 'IDENTITY_EXTERNALLY_MANAGED',
      capability,
      authority,
    });
  }

  private assertCreateAllowed(): void {
    if (!this.identityAuthority.capabilities.users.create) {
      this.externallyManaged(IdentityCapability.USER_CREATE, AgorUserLifecycleAuthority.EXTERNAL);
    }
  }

  private assertDeleteAllowed(): void {
    if (!this.identityAuthority.capabilities.users.delete) {
      this.externallyManaged(IdentityCapability.USER_DELETE, AgorUserLifecycleAuthority.EXTERNAL);
    }
  }

  private assertPatchAllowed(data: UpdateUserData): void {
    if (data.role !== undefined && !this.identityAuthority.capabilities.users.roleWrite) {
      this.externallyManaged(IdentityCapability.USER_ROLE_WRITE, AgorRoleAuthority.CLAIMS);
    }

    const identityFields: Array<keyof UpdateUserData> = [
      'email',
      'name',
      'unix_username',
      'avatar_url',
      'avatar',
      'avatar_source',
      'avatar_source_id',
      'avatar_synced_at',
    ];
    if (
      identityFields.some((field) => data[field] !== undefined) &&
      !this.identityAuthority.capabilities.users.identityWrite
    ) {
      this.externallyManaged(
        IdentityCapability.USER_IDENTITY_WRITE,
        AgorUserLifecycleAuthority.EXTERNAL
      );
    }

    if (
      (Object.hasOwn(data, 'password') || data.must_change_password !== undefined) &&
      !this.identityAuthority.capabilities.users.passwordWrite
    ) {
      this.externallyManaged(
        IdentityCapability.USER_PASSWORD_WRITE,
        AgorUserLifecycleAuthority.EXTERNAL
      );
    }
  }

  private assertLocalAuthenticationAllowed(): void {
    if (this.identityAuthority.localAuth === AgorLocalAuthMode.DISABLED) {
      throw new NotAuthenticated('Local authentication is disabled', {
        code: 'LOCAL_AUTH_DISABLED',
      });
    }
  }

  private requireAvatarSync(): UserAvatarSyncManager {
    if (!this.avatarSync) {
      throw new Error('User avatar sync is not available in this service context');
    }
    return this.avatarSync;
  }

  private async loadUserRow(id: string, params?: Params): Promise<UserRow | null> {
    return select(this.db)
      .from(users)
      .where(withTenantPredicate(params, eq(users.user_id, id)))
      .one();
  }

  private mutationNeedsActor(params?: Params): boolean {
    // Feathers' provider-less, actor-less form is the explicit trusted
    // in-process persistence seam used during bootstrap/provisioning. Any call
    // carrying a human actor is authorized even when it is in-process, so
    // internal wrappers cannot accidentally turn a user action into a bypass.
    return !!params?.provider || !!(params as AuthenticatedParams | undefined)?.user;
  }

  /** Resolve the actor from the database so stale token role claims grant no authority. */
  private async loadMutationActor(params?: Params): Promise<UserRow> {
    const claimed = (params as AuthenticatedParams | undefined)?.user;
    if (!claimed || claimed._isServiceAccount) {
      throw new Forbidden(USER_AUTHORITY_DENIED);
    }
    const actor = await this.loadUserRow(claimed.user_id, params);
    if (!actor) {
      // Keep deleted/cross-tenant principals indistinguishable from an
      // insufficiently privileged in-tenant actor.
      throw new Forbidden(USER_AUTHORITY_DENIED);
    }
    return actor;
  }

  private async authorizeCreate(data: CreateUserData, params?: Params): Promise<UserRow | null> {
    if (!this.mutationNeedsActor(params)) return null;

    const actor = await this.loadMutationActor(params);
    if (!hasMinimumRole(actor.role, ROLES.ADMIN)) {
      throw new Forbidden(USER_AUTHORITY_DENIED);
    }
    const requestedRole = canonicalizeRoleWrite(data.role ?? ROLES.MEMBER);
    if (!canAssignUserRole(actor.role, requestedRole)) {
      throw new Forbidden('You cannot assign a role above your own');
    }
    return actor;
  }

  private async authorizePatch(
    id: UserID,
    data: UpdateUserData,
    params?: Params
  ): Promise<AuthorizedUserMutation> {
    const target = await this.loadUserRow(id, params);
    if (!target) throw new Forbidden(USER_AUTHORITY_DENIED);

    // Validation and canonicalization apply even to trusted provisioning.
    // Trust may bypass actor authorization, never the stored role domain.
    const requestedRole = Object.hasOwn(data, 'role')
      ? canonicalizeRoleWrite(data.role)
      : undefined;
    if (requestedRole) data.role = requestedRole;

    const purpose = getTrustedUserMutationPurpose(params);
    if (purpose) {
      assertTrustedMutationFields(purpose, data);
      if (purpose === 'avatar-sync') return { target };
    }

    if (!this.mutationNeedsActor(params)) return { target };

    const claimedActor = (params as AuthenticatedParams).user;
    if (claimedActor?._isServiceAccount) {
      throw new Forbidden(USER_AUTHORITY_DENIED);
    }
    const actor =
      target.user_id === claimedActor?.user_id ? target : await this.loadMutationActor(params);

    // The env-vars widget is separately authorized by session/branch scope, but
    // it must still respect role authority when it writes another user's
    // credential-bearing environment. It does not gain general admin powers.
    if (purpose === 'env-vars-widget') {
      if (!hasRoleAuthorityOver(actor.role, target.role)) {
        throw new Forbidden(USER_AUTHORITY_DENIED);
      }
      return { target, actor };
    }

    if (actor.user_id === target.user_id) {
      if (requestedRole && requestedRole !== normalizeRole(target.role)) {
        throw new Forbidden('You cannot change your own role');
      }
      const writesAdminField = Object.keys(data).some((field) =>
        ADMIN_OWNED_USER_FIELDS.has(field as keyof UpdateUserData)
      );
      if (writesAdminField && !hasMinimumRole(actor.role, ROLES.ADMIN)) {
        throw new Forbidden(USER_AUTHORITY_DENIED);
      }
      return { target, actor };
    }

    if (
      !hasMinimumRole(actor.role, ROLES.ADMIN) ||
      !hasRoleAuthorityOver(actor.role, target.role)
    ) {
      throw new Forbidden(USER_AUTHORITY_DENIED);
    }
    if (requestedRole && !canAssignUserRole(actor.role, requestedRole)) {
      throw new Forbidden('You cannot assign a role above your own');
    }
    return { target, actor };
  }

  private async authorizeRemove(id: UserID, params?: Params): Promise<AuthorizedUserMutation> {
    const target = await this.loadUserRow(id, params);
    if (!target) throw new Forbidden(USER_AUTHORITY_DENIED);
    if (!this.mutationNeedsActor(params)) return { target };

    const claimedActor = (params as AuthenticatedParams).user;
    if (claimedActor?._isServiceAccount) {
      throw new Forbidden(USER_AUTHORITY_DENIED);
    }
    const actor =
      target.user_id === claimedActor?.user_id ? target : await this.loadMutationActor(params);
    if (actor.user_id === target.user_id) {
      throw new Forbidden('You cannot delete your own account');
    }
    if (
      !hasMinimumRole(actor.role, ROLES.ADMIN) ||
      !hasRoleAuthorityOver(actor.role, target.role)
    ) {
      throw new Forbidden(USER_AUTHORITY_DENIED);
    }
    return { target, actor };
  }

  private actorStillCurrentPredicate(actor: UserRow | undefined, params?: Params) {
    if (!actor) return undefined;
    const tenantId = (params as AuthenticatedParams | undefined)?.tenant?.tenant_id;
    const tenantCheck =
      tenantId && usersTableHasTenantColumn()
        ? sql` AND authority_actor.tenant_id = ${tenantId}`
        : sql``;
    return sql`EXISTS (
      SELECT 1 FROM ${users} authority_actor
      WHERE authority_actor.user_id = ${actor.user_id}
        AND authority_actor.role = ${actor.role}${tenantCheck}
    )`;
  }

  private async assertNotLastSuperadmin(target: UserRow, params?: Params): Promise<void> {
    if (normalizeRole(target.role) !== ROLES.SUPERADMIN) return;
    const tenant = tenantPredicate(params);
    const superadmins = tenant
      ? await select(this.db).from(users).where(tenant).all()
      : await select(this.db).from(users).all();
    if (
      superadmins.filter((user: UserRow) => normalizeRole(user.role) === ROLES.SUPERADMIN).length <=
      1
    ) {
      throw new Forbidden('The last superadmin cannot be demoted or deleted');
    }
  }

  /**
   * Find all users.
   *
   * Supports:
   * - `email` exact lookup for authorized callers; password is included only
   *   for the internal local-authentication lookup marker
   * - `search` / `query` / `q` case-insensitive substring lookup across
   *   name, email, and unix_username
   * - Feathers-style `$limit` / `$skip`, plus plain `limit` / `skip` /
   *   `offset` for MCP/client ergonomics
   */
  async find(params?: Params): Promise<Paginated<User>> {
    if (isLocalAuthenticationLookup(params)) this.assertLocalAuthenticationAllowed();
    const rawQuery = (params?.query ?? {}) as Record<string, unknown>;

    // Check if filtering by email (for authentication)
    const email = queryString(rawQuery.email);
    const includePassword = !!email && isLocalAuthenticationLookup(params);
    const requesterId = (params as AuthenticatedParams | undefined)?.user?.user_id as
      | UserID
      | undefined;

    let rows: (typeof users.$inferSelect)[];
    if (email) {
      ensureCanExactEmailLookup(params, email);
      // Find by email (for LocalStrategy / authorized exact lookup)
      const row = await select(this.db)
        .from(users)
        .where(withTenantPredicate(params, eq(users.email, email)))
        .one();
      rows = row ? [row] : [];
    } else {
      // Find all
      rows = tenantPredicate(params)
        ? await select(this.db).from(users).where(tenantPredicate(params)).all()
        : await select(this.db).from(users).all();
    }

    rows = rows.sort(
      (a, b) => a.email.localeCompare(b.email) || a.user_id.localeCompare(b.user_id)
    );

    const search =
      queryString(rawQuery.search) ?? queryString(rawQuery.query) ?? queryString(rawQuery.q);

    if (search) {
      const needle = search.toLowerCase();
      rows = rows.filter((row) =>
        [row.name, row.email, row.unix_username].some((value) =>
          (value ?? '').toLowerCase().includes(needle)
        )
      );
    }

    const total = rows.length;
    const skip =
      optionalNonNegativeInteger(rawQuery.$skip) ??
      optionalNonNegativeInteger(rawQuery.skip) ??
      optionalNonNegativeInteger(rawQuery.offset) ??
      0;
    const limit =
      optionalNonNegativeInteger(rawQuery.$limit) ?? optionalNonNegativeInteger(rawQuery.limit);
    const pageRows =
      limit === undefined ? rows.slice(skip) : rows.slice(skip, skip + Math.max(limit, 0));

    const includeAuthMetadata = shouldIncludeAuthMetadata(params, includePassword);
    const results = pageRows.map((row) =>
      this.rowToUser(row, includePassword, requesterId, includeAuthMetadata)
    );

    return {
      total,
      limit: limit ?? results.length,
      skip,
      data: results,
    };
  }

  /**
   * Get user by ID
   */
  async get(id: UserID, params?: Params): Promise<User> {
    const row = await select(this.db)
      .from(users)
      .where(withTenantPredicate(params, eq(users.user_id, id)))
      .one();

    if (!row) {
      throw new NotFound(`User not found: ${id}`);
    }

    const requesterId = (params as AuthenticatedParams | undefined)?.user?.user_id as
      | UserID
      | undefined;
    return this.rowToUser(row, false, requesterId, shouldIncludeAuthMetadata(params));
  }

  /**
   * Create new user
   */
  async create(data: CreateUserData, params?: Params): Promise<User> {
    assertSingleUserMutation(data);
    this.assertCreateAllowed();
    assertValidExecutionHomeKeyWrite(data.unix_username);
    if (data.unix_username && !(await isExecutionHomeKeyAvailable(this.db, data.unix_username))) {
      throw new BadRequest(`Execution home key "${data.unix_username}" is already in use`);
    }
    if (Object.hasOwn(data, 'role')) data.role = canonicalizeRoleWrite(data.role);
    await lockTenantAuthorizationFence(this.db, params);
    await this.authorizeCreate(data, params);
    const assignedPassword = validatedAssignedPassword(data.password, data.email);
    // Check if email already exists
    const existing = await select(this.db)
      .from(users)
      .where(withTenantPredicate(params, eq(users.email, data.email)))
      .one();

    if (existing) {
      throw new Error(`User with email ${data.email} already exists`);
    }

    // Hash password
    const hashedPassword = await hashLocalPassword(assignedPassword);

    // Create user
    const now = new Date();
    const user_id = generateId() as UserID;

    const role = data.role ?? ROLES.MEMBER;
    const defaultEmoji = role === ROLES.ADMIN ? '⭐' : '👤';

    const row = await insert(this.db, users)
      .values({
        user_id,
        email: data.email,
        password: hashedPassword,
        name: data.name,
        emoji: data.emoji || defaultEmoji,
        role,
        unix_username: data.unix_username,
        filesystem_home: data.filesystem_home,
        must_change_password: data.must_change_password ?? false,
        created_at: now,
        updated_at: now,
        ...tenantInsertValues(params),
        data: {
          avatar_url: data.avatar_url ?? data.avatar ?? undefined,
          avatar_source:
            data.avatar_source ?? ((data.avatar_url ?? data.avatar) ? 'manual' : undefined),
          avatar_source_id: data.avatar_source_id ?? undefined,
          avatar_synced_at: data.avatar_synced_at ?? undefined,
          preferences: {},
        },
      })
      .returning()
      .one();

    return this.rowToUser(row, false, undefined, shouldIncludeAuthMetadata(params));
  }

  /**
   * Update user
   */
  async patch(id: UserID, data: UpdateUserData, params?: Params): Promise<User> {
    if (typeof id !== 'string' || !id) {
      throw new BadRequest('Bulk user mutations are not supported');
    }
    if (
      !(params as (Params & { [USER_PATCH_LOCK_HELD_PARAM]?: boolean }) | undefined)?.[
        USER_PATCH_LOCK_HELD_PARAM
      ]
    ) {
      return withUserPatchLock(id, params, (lockedParams) => this.patch(id, data, lockedParams));
    }
    assertSingleUserMutation(data);
    this.assertPatchAllowed(data);
    assertValidExecutionHomeKeyWrite(data.unix_username);
    if (data.primary_agentic_tool !== undefined && !isAgenticToolName(data.primary_agentic_tool)) {
      throw new BadRequest('Invalid primary agentic tool');
    }
    if (
      data.unix_username &&
      !(await isExecutionHomeKeyAvailable(this.db, data.unix_username, id))
    ) {
      throw new BadRequest(`Execution home key "${data.unix_username}" is already in use`);
    }
    const coordinateClaudeCredential = this.claudeCredentialPatches?.applies(data, params) === true;
    const credentialTenantId = coordinateClaudeCredential ? getCurrentTenantId() : undefined;
    if (coordinateClaudeCredential && !credentialTenantId) {
      throw new Error('Missing active tenant context for Claude credential mutation');
    }
    // Keep lock ordering consistent with OAuth finalization: credential
    // authority first, then the users-service role/identity authority.
    const releaseClaudeCredential = coordinateClaudeCredential
      ? await this.claudeCredentialPatches!.lock(String(credentialTenantId), id)
      : undefined;
    try {
      return await withSqliteTenantAuthorityLock(this.db, params, () =>
        this.patchWithClaudeCredentialAuthority(
          id,
          data,
          params,
          coordinateClaudeCredential,
          credentialTenantId
        )
      );
    } finally {
      await releaseClaudeCredential?.();
    }
  }

  private async patchWithClaudeCredentialAuthority(
    id: UserID,
    data: UpdateUserData,
    params: Params | undefined,
    coordinateClaudeCredential: boolean,
    credentialTenantId: string | undefined
  ): Promise<User> {
    await lockTenantAuthorizationFence(this.db, params);
    const authority = await this.authorizePatch(id, data, params);
    const changesClaudeCredentialSource =
      coordinateClaudeCredential && this.claudeCredentialPatches!.changesSource(data, params);
    const changesClaudeCredentialRoute =
      coordinateClaudeCredential &&
      this.claudeCredentialPatches!.changesRoute(data) &&
      ((data.unix_username !== undefined &&
        data.unix_username !== authority.target.unix_username) ||
        (data.filesystem_home !== undefined &&
          data.filesystem_home !== authority.target.filesystem_home));
    const hasPasswordWrite = Object.hasOwn(data, 'password');
    const assignedPassword = hasPasswordWrite
      ? validatedAssignedPassword(data.password, data.email ?? authority.target.email)
      : undefined;
    if (
      Object.hasOwn(data, 'role') &&
      data.role !== undefined &&
      normalizeRole(authority.target.role) === ROLES.SUPERADMIN &&
      data.role !== ROLES.SUPERADMIN
    ) {
      await this.assertNotLastSuperadmin(authority.target, params);
    }
    const now = new Date();
    const updates: Record<string, unknown> = { updated_at: now };
    const selectionNamesToRemove = new Set<string>();

    // Handle password separately (needs hashing)
    if (assignedPassword !== undefined) {
      updates.password = await hashLocalPassword(assignedPassword);
      // Increment in the same SQL UPDATE as the hash. Interactive tokens carry
      // this generation, so racing login/refresh responses minted from an old
      // credential snapshot remain invalid regardless of replica clock skew.
      updates.credential_generation = sql`${users.credential_generation} + 1`;
      // Auto-clear must_change_password when password is changed,
      // UNLESS explicitly set in the same request (admin reset + force change scenario)
      // e.g., `user update --password newpass --force-password-change` should keep flag true
      updates.must_change_password = data.must_change_password ?? false;
    } else if (data.must_change_password !== undefined) {
      // Handle must_change_password flag when set WITHOUT password change (admin toggle)
      updates.must_change_password = data.must_change_password;
    }

    // Update other fields
    if (data.email) updates.email = data.email;
    if (data.name) updates.name = data.name;
    if (data.emoji !== undefined) updates.emoji = data.emoji;
    if (data.role) updates.role = data.role;
    if (data.unix_username !== undefined) updates.unix_username = data.unix_username;
    if (data.filesystem_home !== undefined) updates.filesystem_home = data.filesystem_home;
    if (data.onboarding_completed !== undefined)
      updates.onboarding_completed = data.onboarding_completed;

    // Update data blob
    if (
      data.avatar_url !== undefined ||
      data.avatar !== undefined ||
      data.avatar_source !== undefined ||
      data.avatar_source_id !== undefined ||
      data.avatar_synced_at !== undefined ||
      data.preferences ||
      data.agentic_tools ||
      data.agentic_auth_methods ||
      data.agentic_credential_sources ||
      data.env_vars ||
      data.env_var_scopes ||
      data.primary_agentic_tool !== undefined ||
      data.default_agentic_config ||
      data.default_agentic_selection ||
      data.default_mcp_server_ids !== undefined
    ) {
      const current = this.rowToUser(
        authority.target,
        false,
        (params as AuthenticatedParams | undefined)?.user?.user_id as UserID | undefined,
        shouldIncludeAuthMetadata(params)
      );
      const currentRow = authority.target;
      const currentData = currentRow?.data as {
        avatar_url?: string;
        avatar?: string;
        avatar_source?: string;
        avatar_source_id?: string;
        avatar_synced_at?: string;
        preferences?: Record<string, unknown>;
        agentic_tools?: StoredAgenticTools;
        agentic_auth_methods?: AgenticAuthMethods;
        agentic_credential_sources?: AgenticCredentialSources;
        env_vars?: Record<string, string | StoredEnvVar>;
        primary_agentic_tool?: AgenticToolName;
        default_agentic_config?: import('@agor/core/types').DefaultAgenticConfig;
        default_agentic_selection?: import('@agor/core/types').UserAgenticDefaultSelections;
        default_mcp_server_ids?: string[];
      };
      const nextDefaultAgenticConfig = {
        ...(data.default_agentic_config ?? current.default_agentic_config),
      };
      const nextDefaultAgenticSelection =
        data.default_agentic_selection ?? current.default_agentic_selection;
      const changedDefaultTools = AGENTIC_TOOL_NAMES.filter(
        (tool) =>
          (data.default_agentic_config !== undefined &&
            JSON.stringify(current.default_agentic_config?.[tool]) !==
              JSON.stringify(nextDefaultAgenticConfig[tool])) ||
          (data.default_agentic_selection !== undefined &&
            JSON.stringify(current.default_agentic_selection?.[tool]) !==
              JSON.stringify(nextDefaultAgenticSelection?.[tool]))
      );
      for (const tool of changedDefaultTools) {
        const selection = nextDefaultAgenticSelection?.[tool];
        try {
          if (selection?.source === 'preset' || selection?.source === 'workspace_default') {
            await materializeAgenticToolConfiguration(this.db, {
              tool,
              source: {
                reference:
                  selection.source === 'preset'
                    ? selection.preset_id
                    : WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
              },
              executionOwnerId: id,
            });
          } else {
            await assertInlineAgenticConfigurationAllowed(this.db, tool);
            const configuration = nextDefaultAgenticConfig[tool] ?? {};
            const modelConfig = normalizeAgenticToolModelConfiguration(
              tool,
              configuration.modelConfig
            );
            nextDefaultAgenticConfig[tool] = {
              ...configuration,
              ...(modelConfig
                ? {
                    modelConfig: {
                      mode: modelConfig.mode,
                      model: modelConfig.model,
                      ...(modelConfig.provider ? { provider: modelConfig.provider } : {}),
                      ...(modelConfig.effort ? { effort: modelConfig.effort } : {}),
                      ...(modelConfig.advisorModel
                        ? { advisorModel: modelConfig.advisorModel }
                        : {}),
                    },
                  }
                : {}),
            };
          }
        } catch (error) {
          if (isInvalidModelConfigError(error)) throw new BadRequest(error.message);
          throw error;
        }
      }

      // Handle per-tool credential patches (encrypt-on-write, drop-on-null).
      const nextAgenticTools: StoredAgenticTools = data.agentic_tools
        ? applyAgenticToolsPatch(currentData?.agentic_tools ?? {}, data.agentic_tools)
        : (currentData?.agentic_tools ?? {});

      // Keep Claude's coarse auth method and exact credential source in the
      // same users-row update as the encrypted credential patch. This is the
      // authority boundary for every UI/API save and clear, including older
      // clients that do not yet send `agentic_credential_sources`.
      const nextAgenticAuthMethods: AgenticAuthMethods = {
        ...currentData.agentic_auth_methods,
        ...data.agentic_auth_methods,
      };
      const nextAgenticCredentialSources: AgenticCredentialSources = {
        ...currentData.agentic_credential_sources,
      };
      const claudePatch = data.agentic_tools?.['claude-code'];
      if (claudePatch) {
        const writesSubscriptionToken =
          typeof claudePatch.CLAUDE_CODE_OAUTH_TOKEN === 'string' &&
          claudePatch.CLAUDE_CODE_OAUTH_TOKEN.trim().length > 0;
        const writesApiCredential = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].some((field) => {
          const value = claudePatch[field as keyof typeof claudePatch];
          return typeof value === 'string' && value.trim().length > 0;
        });
        if (writesSubscriptionToken) {
          nextAgenticCredentialSources['claude-code'] = 'subscription_token';
        } else if (writesApiCredential) {
          nextAgenticCredentialSources['claude-code'] = 'api_key';
        } else if (
          claudePatch.CLAUDE_CODE_OAUTH_TOKEN === null &&
          (nextAgenticCredentialSources['claude-code'] === 'subscription_token' ||
            (nextAgenticCredentialSources['claude-code'] === undefined &&
              currentData.agentic_auth_methods?.['claude-code'] === 'subscription' &&
              Boolean(currentData.agentic_tools?.['claude-code']?.CLAUDE_CODE_OAUTH_TOKEN)))
        ) {
          // Source-less rows written before this field existed still need a
          // durable transition. Require the pre-patch token as well as the
          // legacy subscription marker so an unrelated clear cannot invent
          // authority or disable a different credential family.
          nextAgenticCredentialSources['claude-code'] = 'none';
        } else if (
          nextAgenticCredentialSources['claude-code'] === 'api_key' &&
          (claudePatch.ANTHROPIC_API_KEY === null || claudePatch.ANTHROPIC_AUTH_TOKEN === null) &&
          !nextAgenticTools['claude-code']?.ANTHROPIC_API_KEY &&
          !nextAgenticTools['claude-code']?.ANTHROPIC_AUTH_TOKEN
        ) {
          nextAgenticCredentialSources['claude-code'] = 'none';
        }
      }
      const requestedClaudeSource = data.agentic_credential_sources?.['claude-code'];
      if (
        requestedClaudeSource !== undefined &&
        !(['api_key', 'subscription_token', 'managed_file', 'none'] as const).includes(
          requestedClaudeSource
        )
      ) {
        throw new BadRequest('Invalid Claude credential source');
      }
      if (requestedClaudeSource !== undefined) {
        nextAgenticCredentialSources['claude-code'] = requestedClaudeSource;
      } else if (
        claudePatch === undefined &&
        Object.hasOwn(data.agentic_auth_methods ?? {}, 'claude-code')
      ) {
        // Preserve the released method-only API as a source transition for old
        // clients and external callers. Exact source in the same patch wins;
        // otherwise select only a backed source and never infer a native file
        // from a coarse subscription marker.
        const requestedClaudeMethod = data.agentic_auth_methods?.['claude-code'];
        if (requestedClaudeMethod === 'api_key') {
          nextAgenticCredentialSources['claude-code'] =
            nextAgenticTools['claude-code']?.ANTHROPIC_API_KEY ||
            nextAgenticTools['claude-code']?.ANTHROPIC_AUTH_TOKEN
              ? 'api_key'
              : 'none';
        } else if (requestedClaudeMethod === 'subscription') {
          if (currentData.agentic_credential_sources?.['claude-code'] === 'managed_file') {
            nextAgenticCredentialSources['claude-code'] = 'managed_file';
          } else {
            nextAgenticCredentialSources['claude-code'] = nextAgenticTools['claude-code']
              ?.CLAUDE_CODE_OAUTH_TOKEN
              ? 'subscription_token'
              : 'none';
          }
        } else {
          nextAgenticCredentialSources['claude-code'] = 'none';
        }
      }

      const claudeSource = nextAgenticCredentialSources['claude-code'];
      if (
        requestedClaudeSource === 'managed_file' &&
        getTrustedUserMutationPurpose(params) !== 'claude-auth'
      ) {
        throw new Forbidden('Managed Claude credential sources can only be set by Claude sign-in');
      }
      if (claudeSource === 'subscription_token') {
        if (!nextAgenticTools['claude-code']?.CLAUDE_CODE_OAUTH_TOKEN) {
          throw new BadRequest('A pasted Claude subscription source requires a stored token');
        }
        nextAgenticAuthMethods['claude-code'] = 'subscription';
      } else if (claudeSource === 'managed_file') {
        nextAgenticAuthMethods['claude-code'] = 'subscription';
      } else if (claudeSource === 'api_key') {
        if (
          !nextAgenticTools['claude-code']?.ANTHROPIC_API_KEY &&
          !nextAgenticTools['claude-code']?.ANTHROPIC_AUTH_TOKEN
        ) {
          throw new BadRequest('A Claude API-key source requires a stored API credential');
        }
        nextAgenticAuthMethods['claude-code'] = 'api_key';
      } else if (claudeSource === 'none') {
        nextAgenticAuthMethods['claude-code'] = undefined;
      }

      // Handle env vars (encrypt before storage).
      //
      // Stored shape is `Record<name, StoredEnvVar>` where StoredEnvVar carries
      // scope metadata (v0.5 env-var-access). We tolerate legacy plain-string
      // values on read and promote them to the object shape on any write.
      const normalizedExisting = normalizeStoredEnvMap(currentData?.env_vars);
      const nextEnvVars: Record<string, StoredEnvVar> = { ...normalizedExisting };

      if (data.env_vars) {
        for (const [key, value] of Object.entries(data.env_vars)) {
          // Validate variable name
          if (!isEnvVarAllowed(key)) {
            const reason = getEnvVarBlockReason(key);
            throw new Error(`Cannot set environment variable "${key}": ${reason}`);
          }

          // Managed Git consumes these values through its bounded transport DTO
          // and accepts only the `isLikelyGitToken` shape before constructing an
          // authorization header. Reject unusable values at ingest so the saved
          // settings contract and the transport boundary stay aligned.
          if ((key === 'GITHUB_TOKEN' || key === 'GH_TOKEN') && value) {
            if (!isLikelyGitToken(value)) {
              throw new Error(
                `Invalid ${key}: must match [A-Za-z0-9_-]{20,255}. ` +
                  `GitHub / GitLab tokens should not contain spaces, newlines, or special characters.`
              );
            }
          }

          if (value === null || value === undefined) {
            // Clear variable
            delete nextEnvVars[key];
            selectionNamesToRemove.add(key);
            console.log(`🗑️  Cleared user env var: ${key}`);
          } else {
            // Validate and encrypt
            const errors = validateEnvVar(key, value);
            if (errors.length > 0) {
              const message = errors.map((e) => e.message).join('; ');
              throw new Error(`Invalid environment variable: ${message}`);
            }

            try {
              const prior = nextEnvVars[key];
              nextEnvVars[key] = {
                value_encrypted: encryptApiKey(value),
                // Preserve existing scope if we're just rotating the value;
                // default to 'global' for brand-new vars.
                scope: prior?.scope ?? 'global',
                resource_id: prior?.resource_id ?? null,
                extra_config: prior?.extra_config ?? null,
              };
              console.log(`🔐 Encrypted user env var: ${key}`);
            } catch (err) {
              console.error(`Failed to encrypt env var ${key}:`, err);
              throw new Error(`Failed to encrypt environment variable: ${key}`);
            }
          }
        }
      }

      // Apply per-var scope updates. Scopes are validated in the app layer
      // (no SQL CHECK constraint) so new scope values don't require a migration.
      if (data.env_var_scopes) {
        for (const [key, scope] of Object.entries(data.env_var_scopes)) {
          assertV05Scope(scope);
          const existing = nextEnvVars[key];
          if (!existing) {
            // Scope update for a non-existent var — ignore silently; the UI
            // should have created the var first.
            console.warn(`[users] Ignoring scope update for unknown env var: ${key}`);
            continue;
          }
          nextEnvVars[key] = { ...existing, scope };
          // A selection is not a durable future grant. Clear it on every
          // transition so global → session cannot reactivate stale metadata.
          if (existing.scope !== scope) {
            selectionNamesToRemove.add(key);
          }
          console.log(`🔧 Updated scope for env var ${key}: ${scope}`);
        }
      }

      const avatarUrlTouched = data.avatar_url !== undefined || data.avatar !== undefined;
      const avatarCleared = data.avatar_url === null || data.avatar === null;
      const inferredManualAvatarSource =
        avatarUrlTouched && !avatarCleared && data.avatar_source === undefined;
      const avatarSourceChangedAwayFromSlack =
        data.avatar_source !== undefined &&
        data.avatar_source !== null &&
        data.avatar_source !== 'slack';

      updates.data = {
        ...currentData,
        avatar_url: avatarCleared
          ? undefined
          : (data.avatar_url ?? data.avatar ?? current.avatar_url),
        // Deprecated legacy alias: read for back-compat, stop writing it on avatar updates.
        avatar: undefined,
        avatar_source:
          data.avatar_source === null || avatarCleared
            ? undefined
            : data.avatar_source !== undefined
              ? data.avatar_source
              : inferredManualAvatarSource
                ? 'manual'
                : current.avatar_source,
        avatar_source_id:
          data.avatar_source_id === null ||
          avatarCleared ||
          inferredManualAvatarSource ||
          (avatarSourceChangedAwayFromSlack && data.avatar_source_id === undefined)
            ? undefined
            : (data.avatar_source_id ?? current.avatar_source_id),
        avatar_synced_at:
          data.avatar_synced_at === null ||
          avatarCleared ||
          inferredManualAvatarSource ||
          (avatarSourceChangedAwayFromSlack && data.avatar_synced_at === undefined)
            ? undefined
            : (data.avatar_synced_at ?? current.avatar_synced_at),
        preferences: data.preferences ?? current.preferences,
        agentic_tools: Object.keys(nextAgenticTools).length > 0 ? nextAgenticTools : undefined,
        agentic_auth_methods:
          Object.keys(nextAgenticAuthMethods).length > 0 ? nextAgenticAuthMethods : undefined,
        agentic_credential_sources:
          Object.keys(nextAgenticCredentialSources).length > 0
            ? nextAgenticCredentialSources
            : undefined,
        env_vars: Object.keys(nextEnvVars).length > 0 ? nextEnvVars : undefined,
        primary_agentic_tool: data.primary_agentic_tool ?? current.primary_agentic_tool,
        default_agentic_config: nextDefaultAgenticConfig,
        default_agentic_selection: nextDefaultAgenticSelection,
        default_mcp_server_ids: data.default_mcp_server_ids ?? current.default_mcp_server_ids,
      };
    }

    if (assignedPassword !== undefined) {
      // Retain the timestamp marker for backward-compatible invalidation of
      // pre-generation tokens. Capture it immediately before the authoritative
      // write rather than before bcrypt or the other awaited preparation work.
      const credentialUpdatedAt = new Date();
      updates.updated_at = credentialUpdatedAt;
      updates.tokens_valid_after = credentialUpdatedAt;
    }

    const authorityActorPredicate = this.actorStillCurrentPredicate(authority.actor, params);
    if (changesClaudeCredentialRoute) {
      // The old row is still authoritative here. Invalidate attempts and
      // generation-delete its credential before publishing a different route;
      // reversing this order would strand secrets in a home no longer
      // discoverable from the user record.
      await this.claudeCredentialPatches!.cleanupRouteBeforePatch(String(credentialTenantId), id);
    }
    const row = await runWithTenantDatabaseTransaction(
      this.db,
      (params as AuthenticatedParams | undefined)?.tenant?.tenant_id ?? getCurrentTenantId(),
      async (mutationDb) => {
        const updated = await update(mutationDb, users)
          .set(updates)
          .where(
            withTenantPredicate(
              params,
              and(
                eq(users.user_id, id),
                eq(users.role, authority.target.role),
                // SQLite has no request-wide advisory lock. Compare the JSON
                // snapshot so concurrent credential patches fail instead of
                // silently replacing each other's encrypted values.
                eq(users.data, authority.target.data),
                authorityActorPredicate
              )
            )
          )
          .returning()
          .one();

        if (!updated) {
          throw new Forbidden(USER_AUTHORITY_DENIED);
        }

        // Keep metadata cleanup in the same native transaction as the secret
        // mutation. A failed delete cannot commit the user JSON update alone.
        if (selectionNamesToRemove.size > 0) {
          await deleteFrom(mutationDb, sessionEnvSelections)
            .where(
              and(
                // Keep owned-session filtering inside SQL rather than
                // materializing every Session ID into a parameter list. A
                // prolific user must still be able to delete one variable
                // without exceeding SQLite/PostgreSQL bind limits.
                sql`${sessionEnvSelections.session_id} IN (
                  SELECT ${sessions.session_id}
                  FROM ${sessions}
                  WHERE ${sessions.created_by} = ${id}
                )`,
                inArray(sessionEnvSelections.env_var_name, [...selectionNamesToRemove])
              )
            )
            .run();
        }
        return updated;
      }
    );

    if (changesClaudeCredentialSource) {
      // Authorization and the SQL update have succeeded, but the surrounding
      // tenant transaction has not committed. Invalidate attempts and advance
      // the per-home generation now; a failure rolls back the metadata change.
      await this.claudeCredentialPatches!.complete(String(credentialTenantId), id);
    }

    const requesterId = (params as AuthenticatedParams | undefined)?.user?.user_id as
      | UserID
      | undefined;
    return this.rowToUser(row, false, requesterId, shouldIncludeAuthMetadata(params));
  }

  /**
   * Delete user
   */
  async remove(id: UserID, params?: Params): Promise<User> {
    if (typeof id !== 'string' || !id) {
      throw new BadRequest('Bulk user mutations are not supported');
    }
    this.assertDeleteAllowed();
    const coordinateClaudeCredential = this.claudeCredentialPatches?.coordinatesRemoval() === true;
    const credentialTenantId = coordinateClaudeCredential ? getCurrentTenantId() : undefined;
    if (coordinateClaudeCredential && !credentialTenantId) {
      throw new Error('Missing active tenant context for Claude credential mutation');
    }
    // Credential authority always precedes users/role authority. OAuth
    // finalization and route deletion therefore cannot deadlock by taking
    // these locks in opposite orders.
    const releaseClaudeCredential = coordinateClaudeCredential
      ? await this.claudeCredentialPatches.lock(String(credentialTenantId), id)
      : undefined;
    try {
      return await withSqliteTenantAuthorityLock(this.db, params, () =>
        this.removeWithClaudeCredentialAuthority(
          id,
          params,
          coordinateClaudeCredential,
          credentialTenantId
        )
      );
    } finally {
      await releaseClaudeCredential?.();
    }
  }

  private async removeWithClaudeCredentialAuthority(
    id: UserID,
    params: Params | undefined,
    coordinateClaudeCredential: boolean,
    credentialTenantId: string | undefined
  ): Promise<User> {
    await lockTenantAuthorizationFence(this.db, params);
    const authority = await this.authorizeRemove(id, params);
    await this.assertNotLastSuperadmin(authority.target, params);
    const requesterId = (params as AuthenticatedParams | undefined)?.user?.user_id as
      | UserID
      | undefined;
    const user = this.rowToUser(
      authority.target,
      false,
      requesterId,
      shouldIncludeAuthMetadata(params)
    );

    const [ownedBoard, ownedBranch] = await Promise.all([
      select(this.db, { board_id: boards.board_id })
        .from(boards)
        .where(eq(boards.primary_owner_user_id, id))
        .limit(1)
        .one(),
      select(this.db, { branch_id: branches.branch_id })
        .from(branches)
        .where(eq(branches.primary_owner_user_id, id))
        .limit(1)
        .one(),
    ]);
    if (ownedBoard || ownedBranch) {
      throw new BadRequest(
        'This user still owns boards or branches. Delete those resources before deleting the user.'
      );
    }

    if (coordinateClaudeCredential) {
      // Remove the generation-fenced file while the old route and owner row
      // still exist. Only after cleanup succeeds may the home key become
      // reusable through the SQL delete below.
      await this.claudeCredentialPatches!.cleanupRouteBeforeRemove(String(credentialTenantId), id);
    }

    const authorityActorPredicate = this.actorStillCurrentPredicate(authority.actor, params);
    const removed = await deleteFrom(this.db, users)
      .where(
        withTenantPredicate(
          params,
          and(eq(users.user_id, id), eq(users.role, authority.target.role), authorityActorPredicate)
        )
      )
      .run();
    if (removed.rowsAffected !== 1) {
      throw new Forbidden(USER_AUTHORITY_DENIED);
    }

    return user;
  }

  /**
   * Find user by email (for authentication)
   */
  async findByEmail(email: string): Promise<User | null> {
    const row = await select(this.db).from(users).where(eq(users.email, email)).one();

    return row ? this.rowToUser(row) : null;
  }

  /**
   * Verify password
   */
  async verifyPassword(user: User, password: string): Promise<boolean> {
    // Need to fetch password from database (not in User type)
    const row = await select(this.db).from(users).where(eq(users.user_id, user.user_id)).one();

    if (!row) return false;

    return compare(password, row.password);
  }

  /**
   * Get a single decrypted credential field scoped to a specific agentic tool.
   *
   * Replaces the legacy flat-namespace `getApiKey(userId, 'ANTHROPIC_API_KEY')`
   * call site with `(userId, 'claude-code', 'ANTHROPIC_API_KEY')` so an
   * Anthropic key stored on the user can no longer leak into a Codex spawn.
   */
  async getToolConfigField<T extends AgenticToolName>(
    userId: UserID,
    tool: T,
    field: keyof AgenticToolsConfig[T] & string
  ): Promise<string | undefined> {
    const row = await select(this.db).from(users).where(eq(users.user_id, userId)).one();
    if (!row) return undefined;

    const data = row.data as { agentic_tools?: StoredAgenticTools };
    const encrypted = data.agentic_tools?.[tool]?.[field];
    if (!encrypted) return undefined;

    try {
      return decryptApiKey(encrypted);
    } catch (err) {
      console.error(`Failed to decrypt agentic_tools.${tool}.${field} for user ${userId}:`, err);
      return undefined;
    }
  }

  /**
   * Get the full decrypted credential bag for one tool. Used when spawning an
   * SDK so the executor environment receives only that tool's env vars.
   * Returns `null` if the user has no stored config for the tool.
   */
  async getToolConfig<T extends AgenticToolName>(
    userId: UserID,
    tool: T
  ): Promise<AgenticToolsConfig[T] | null> {
    const row = await select(this.db).from(users).where(eq(users.user_id, userId)).one();
    if (!row) return null;

    const data = row.data as { agentic_tools?: StoredAgenticTools };
    const fields = data.agentic_tools?.[tool];
    if (!fields || Object.keys(fields).length === 0) return null;

    const out: Record<string, string> = {};
    for (const [field, encrypted] of Object.entries(fields)) {
      if (!encrypted) continue;
      try {
        out[field] = decryptApiKey(encrypted);
      } catch (err) {
        console.error(`Failed to decrypt agentic_tools.${tool}.${field} for user ${userId}:`, err);
      }
    }

    return Object.keys(out).length > 0 ? (out as AgenticToolsConfig[T]) : null;
  }

  /**
   * Get the user's global environment through the canonical resolver.
   *
   * This legacy internal convenience must not bypass scope filtering. A caller
   * that needs selected session variables must supply that session explicitly
   * to `resolveUserEnvironment` instead of receiving every stored scope.
   */
  async getEnvironmentVariables(userId: UserID): Promise<Record<string, string>> {
    return resolveUserEnvironment(userId, this.db);
  }

  async getAvatarSettings(_data?: unknown, params?: Params): Promise<UserAvatarSettings> {
    return this.requireAvatarSync().getSettings(params);
  }

  async updateAvatarSettings(
    data: Partial<UserAvatarSettings>,
    params?: Params
  ): Promise<UserAvatarSettings> {
    if (!this.identityAuthority.capabilities.users.avatarSettingsWrite) {
      this.externallyManaged(
        IdentityCapability.USER_AVATAR_SETTINGS_WRITE,
        AgorUserLifecycleAuthority.EXTERNAL
      );
    }
    return this.requireAvatarSync().updateSettings(data, params);
  }

  async syncAvatars(
    data: UserAvatarSyncRequest = {},
    params?: Params
  ): Promise<UserAvatarSyncResult> {
    if (!this.identityAuthority.capabilities.users.avatarSettingsWrite) {
      this.externallyManaged(
        IdentityCapability.USER_AVATAR_SETTINGS_WRITE,
        AgorUserLifecycleAuthority.EXTERNAL
      );
    }
    return this.requireAvatarSync().syncAvatars(data, params);
  }

  async refreshAvatarFromSettings(userId: UserID): Promise<UserAvatarSyncResult | null> {
    if (!this.identityAuthority.capabilities.users.avatarSettingsWrite) return null;
    return this.requireAvatarSync().refreshUserFromSettings(userId);
  }

  /** Resolve the calling user's primary teammate branch, or null when unset or inaccessible. */
  async getPrimaryTeammate(_data: unknown, params?: Params): Promise<Branch | null> {
    const userId = requireCallerId(params);
    return new UserPrimaryTeammateRepository(this.db).resolvePrimaryTeammate(userId, {
      enforceAccess: this.shouldEnforcePrimaryTeammateAccess(params),
    });
  }

  private async emitUserPreferencePatched(userId: UserID, params?: Params): Promise<void> {
    if (!this.app) return;
    const row = await select(this.db).from(users).where(eq(users.user_id, userId)).one();
    if (!row) return;
    emitServiceEvent(this.app, {
      path: 'users',
      event: 'patched',
      id: userId,
      data: this.rowToUser(row, false, undefined, false),
      params,
    });
  }

  private shouldEnforcePrimaryTeammateAccess(params?: Params): boolean {
    // Services instantiated without an Application (focused repository/service
    // tests) retain the safer RBAC-on behavior. Production supplies the app.
    if (!this.app) return true;
    const execution = this.app.get('config').execution;
    if (execution?.branch_rbac !== true) return false;
    if (
      execution.allow_superadmin === true &&
      hasMinimumRole((params as AuthenticatedParams | undefined)?.user?.role, ROLES.SUPERADMIN)
    ) {
      return false;
    }
    return true;
  }

  /** List active teammates the caller is allowed to start sessions on. */
  async getPrimaryTeammateCandidates(_data: unknown, params?: Params): Promise<Branch[]> {
    const userId = this.requirePrimaryTeammateMember(params);
    return new UserPrimaryTeammateRepository(this.db).findEligiblePrimaryTeammates(userId, {
      enforceAccess: this.shouldEnforcePrimaryTeammateAccess(params),
    });
  }

  /**
   * Set the calling user's primary teammate to a branch they can access. The
   * pick is a manual user action, so it is recorded with `source: 'explicit'`.
   * Rejects branches the caller cannot access to avoid persisting a pointer
   * that would immediately resolve back to null.
   */
  async setPrimaryTeammate(
    data: { branchId: string; expectedUserId: UserID },
    params?: Params
  ): Promise<Branch | null> {
    const userId = this.requirePrimaryTeammateMember(params);
    if (data?.expectedUserId !== userId) {
      throw new Forbidden(USER_AUTHORITY_DENIED);
    }
    const branchId = data?.branchId as BranchID | undefined;
    if (!branchId) {
      throw new Forbidden('A branchId is required to set a primary teammate');
    }

    const primaryTeammates = new UserPrimaryTeammateRepository(this.db);
    const branch = await primaryTeammates.findEligiblePrimaryTeammate(branchId, userId, {
      enforceAccess: this.shouldEnforcePrimaryTeammateAccess(params),
    });
    if (!branch) {
      throw new Forbidden(
        'Primary assistant must be an active teammate you can create sessions on'
      );
    }

    await primaryTeammates.setPrimaryTeammate(userId, branchId, {
      source: 'explicit',
    });
    await this.emitUserPreferencePatched(userId, params);
    return branch;
  }

  /**
   * Persist an onboarding/default selection without overwriting a concurrent
   * manual pick. Validation is identical to explicit selection, but provenance
   * remains `default` for analytics and future preference migrations.
   */
  async setPrimaryTeammateIfUnset(
    data: { branchId: string; expectedUserId: UserID },
    params?: Params
  ): Promise<Branch | null> {
    const userId = this.requirePrimaryTeammateMember(params);
    if (data?.expectedUserId !== userId) {
      throw new Forbidden(USER_AUTHORITY_DENIED);
    }
    const branchId = data?.branchId as BranchID | undefined;
    if (!branchId) {
      throw new Forbidden('A branchId is required to set a primary teammate');
    }

    const primaryTeammates = new UserPrimaryTeammateRepository(this.db);
    const branch = await primaryTeammates.findEligiblePrimaryTeammate(branchId, userId, {
      enforceAccess: this.shouldEnforcePrimaryTeammateAccess(params),
    });
    if (!branch) {
      throw new Forbidden(
        'Primary assistant must be an active teammate you can create sessions on'
      );
    }

    const inserted = await primaryTeammates.setPrimaryTeammateIfUnset(userId, branchId, {
      source: 'default',
    });
    if (inserted) await this.emitUserPreferencePatched(userId, params);
    return inserted
      ? branch
      : primaryTeammates.resolvePrimaryTeammate(userId, {
          enforceAccess: this.shouldEnforcePrimaryTeammateAccess(params),
        });
  }

  /**
   * Seed the caller's primary coding agent after onboarding or their first
   * successful session creation. The conditional update makes the first
   * successful choice win without overwriting an explicit Settings change.
   */
  async setPrimaryAgenticToolIfUnset(
    data: { tool: AgenticToolName; expectedUserId: UserID },
    params?: Params
  ): Promise<User> {
    const userId = this.requireMemberCaller(params, 'set a primary coding agent');
    if (data?.expectedUserId !== userId) {
      throw new Forbidden(USER_AUTHORITY_DENIED);
    }
    const tool = data?.tool;
    if (!isAgenticToolName(tool)) {
      throw new BadRequest('Invalid primary agentic tool');
    }

    await lockTenantAuthorizationFence(this.db, params);
    // Tenant ownership is ambient here: the users service hook has already
    // entered the trusted tenant database scope, and PostgreSQL RLS applies it
    // to every query through this.db. Do not derive SQL scope from request
    // params; those identify the caller, not the persistence boundary.
    const currentRow = await select(this.db).from(users).where(eq(users.user_id, userId)).one();
    if (!currentRow) throw new Forbidden(USER_AUTHORITY_DENIED);

    const currentData = currentRow.data as Record<string, unknown> & {
      primary_agentic_tool?: AgenticToolName;
    };
    if (currentData.primary_agentic_tool !== undefined) {
      return this.rowToUser(currentRow, false, userId, shouldIncludeAuthMetadata(params)) as User;
    }

    const updatedRow = await update(this.db, users)
      .set({
        updated_at: new Date(),
        data: { ...currentData, primary_agentic_tool: tool },
      })
      .where(
        and(
          eq(users.user_id, userId),
          isNull(jsonExtract(this.db, users.data, 'primary_agentic_tool'))
        )
      )
      .returning()
      .one();

    const effectiveRow =
      updatedRow ?? (await select(this.db).from(users).where(eq(users.user_id, userId)).one());
    if (!effectiveRow) throw new Forbidden(USER_AUTHORITY_DENIED);

    if (updatedRow && this.app) {
      emitServiceEvent(this.app, {
        path: 'users',
        event: 'patched',
        id: userId,
        // Owner-only decrypted presentation values must never ride a broadcast.
        data: this.rowToUser(updatedRow, false, undefined, false),
        params,
      });
    }

    return this.rowToUser(effectiveRow, false, userId, shouldIncludeAuthMetadata(params)) as User;
  }

  private requireMemberCaller(params: Params | undefined, action: string): UserID {
    const userId = requireCallerId(params);
    const caller = (params as AuthenticatedParams | undefined)?.user;
    if (!hasMinimumRole(caller?.role, ROLES.MEMBER)) {
      throw new Forbidden(`Member role or higher is required to ${action}`);
    }
    return userId;
  }

  private requirePrimaryTeammateMember(params?: Params): UserID {
    return this.requireMemberCaller(params, 'create assistant sessions');
  }

  /**
   * Convert database row to User type
   *
   * @param row - Database row
   * @param includePassword - Include password field (for authentication only)
   * @param requesterId - Authenticated user making the request. When equal to
   *   the row's `user_id`, the returned DTO includes `agentic_tools_public_values`
   *   (decrypted plaintext for the whitelisted non-secret fields like
   *   `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`). For any other requester —
   *   including admins viewing someone else's profile — public values are
   *   omitted, since base URLs can leak internal hostnames.
   */
  private rowToUser(
    row: typeof users.$inferSelect,
    includePassword = false,
    requesterId?: UserID,
    includeAuthMetadata = true
  ): (User | InternalUser) & { password?: string } {
    const data = row.data as {
      avatar_url?: string;
      avatar?: string;
      avatar_source?: string;
      avatar_source_id?: string;
      avatar_synced_at?: string;
      preferences?: Record<string, unknown>;
      agentic_tools?: StoredAgenticTools; // Encrypted per-tool credential blobs
      agentic_auth_methods?: AgenticAuthMethods;
      agentic_credential_sources?: AgenticCredentialSources;
      env_vars?: Record<string, string | StoredEnvVar>; // Encrypted env vars (legacy + v0.5 shape)
      primary_agentic_tool?: AgenticToolName;
      primary_teammate_id?: BranchID;
      default_agentic_config?: import('@agor/core/types').DefaultAgenticConfig;
      default_agentic_selection?: import('@agor/core/types').UserAgenticDefaultSelections;
      default_mcp_server_ids?: string[];
    };

    const normalizedEnvVars = normalizeStoredEnvMap(data.env_vars);
    const envVarMetadata: Record<string, EnvVarMetadata> | undefined =
      Object.keys(normalizedEnvVars).length > 0
        ? Object.fromEntries(
            Object.entries(normalizedEnvVars).map(([name, entry]) => [
              name,
              { set: true, scope: entry.scope, resource_id: entry.resource_id ?? null },
            ])
          )
        : undefined;

    const user: (User | InternalUser) & { password?: string } = {
      user_id: row.user_id as UserID,
      email: row.email,
      name: row.name ?? undefined,
      emoji: row.emoji ?? undefined,
      role: normalizeRole(row.role ?? undefined),
      unix_username: row.unix_username ?? undefined,
      avatar_url: data.avatar_url ?? data.avatar,
      avatar: data.avatar,
      avatar_source: data.avatar_source,
      avatar_source_id: data.avatar_source_id,
      avatar_synced_at: data.avatar_synced_at,
      preferences: data.preferences,
      onboarding_completed: !!row.onboarding_completed,
      must_change_password: !!row.must_change_password,
      created_at: row.created_at,
      updated_at: row.updated_at ?? undefined,
      // Per-tool credential presence (boolean only — never expose decrypted values).
      agentic_tools: toAgenticToolsStatus(data.agentic_tools),
      agentic_auth_methods: data.agentic_auth_methods,
      agentic_credential_sources: data.agentic_credential_sources,
      // Self-only: return plaintext for whitelisted non-secret fields
      // (base URLs) so the UI can render the saved value back. Field-level
      // secrets are NEVER on the whitelist; see `AGENTIC_TOOLS_PUBLIC_FIELDS`.
      agentic_tools_public_values:
        requesterId === row.user_id
          ? extractAgenticToolsPublicValues(data.agentic_tools, decryptApiKey)
          : undefined,
      // Return env var metadata (presence + scope), NOT actual values
      env_vars: envVarMetadata,
      // Return default agentic config
      primary_agentic_tool: isAgenticToolName(data.primary_agentic_tool)
        ? data.primary_agentic_tool
        : undefined,
      primary_teammate_id: data.primary_teammate_id,
      default_agentic_config: data.default_agentic_config,
      default_agentic_selection: data.default_agentic_selection,
      default_mcp_server_ids: data.default_mcp_server_ids,
    };

    if (includeAuthMetadata) {
      (user as InternalUser).credential_generation = row.credential_generation;
      if (row.tokens_valid_after) {
        (user as InternalUser).tokens_valid_after = new Date(row.tokens_valid_after);
      }
    }
    if (includeAuthMetadata && 'tenant_id' in row) {
      (user as InternalUser).tenant_id = row.tenant_id;
    }

    // Include password for authentication (FeathersJS LocalStrategy needs this)
    if (includePassword) {
      user.password = row.password;
    }

    return user;
  }
}

/**
 * User service with password field for authentication
 * This version includes the password field for FeathersJS local strategy
 */
interface UserWithPassword extends InternalUser {
  password: string;
}

/**
 * Users service with authentication support
 */
class UsersServiceWithAuth extends UsersService {
  /**
   * Override get to include password for authentication
   * (FeathersJS LocalStrategy needs this)
   */
  async getWithPassword(id: UserID): Promise<UserWithPassword> {
    const row = await select(this.db).from(users).where(eq(users.user_id, id)).one();

    if (!row) {
      throw new NotFound(`User not found: ${id}`);
    }

    const data = row.data as {
      avatar_url?: string;
      avatar?: string;
      avatar_source?: string;
      avatar_source_id?: string;
      avatar_synced_at?: string;
      preferences?: Record<string, unknown>;
      agentic_tools?: StoredAgenticTools;
      env_vars?: Record<string, string | StoredEnvVar>;
    };

    const normalizedEnvVars = normalizeStoredEnvMap(data.env_vars);
    const envVarMetadata: Record<string, EnvVarMetadata> | undefined =
      Object.keys(normalizedEnvVars).length > 0
        ? Object.fromEntries(
            Object.entries(normalizedEnvVars).map(([name, entry]) => [
              name,
              { set: true, scope: entry.scope, resource_id: entry.resource_id ?? null },
            ])
          )
        : undefined;

    return {
      user_id: row.user_id as UserID,
      email: row.email,
      password: row.password, // Include for authentication
      name: row.name ?? undefined,
      emoji: row.emoji ?? undefined,
      role: normalizeRole(row.role ?? undefined),
      avatar_url: data.avatar_url ?? data.avatar,
      avatar: data.avatar,
      avatar_source: data.avatar_source,
      avatar_source_id: data.avatar_source_id,
      avatar_synced_at: data.avatar_synced_at,
      preferences: data.preferences,
      onboarding_completed: !!row.onboarding_completed,
      must_change_password: !!row.must_change_password,
      credential_generation: row.credential_generation,
      tokens_valid_after: row.tokens_valid_after ? new Date(row.tokens_valid_after) : undefined,
      created_at: row.created_at,
      updated_at: row.updated_at ?? undefined,
      agentic_tools: toAgenticToolsStatus(data.agentic_tools),
      env_vars: envVarMetadata,
    };
  }
}

/**
 * Create users service
 */
export function createUsersService(
  db: TenantScopeAwareDatabase,
  app?: Application,
  config?: AgorConfig,
  claudeCredentialPatches?: ClaudeUserCredentialPatchCoordinator
): UsersServiceWithAuth {
  return new UsersServiceWithAuth(db, app, config, claudeCredentialPatches);
}

/** Create a provider-less Users service bound to one active tenant transaction. */
export function createTenantTransactionUsersService(
  db: TenantScopedDatabase,
  config: AgorConfig
): UsersServiceWithAuth {
  return new UsersServiceWithAuth(db, undefined, config);
}
