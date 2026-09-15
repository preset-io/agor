/** PostgreSQL-coordinated MCP OAuth refresh with rotating-token fencing. */
import type { KeyObject } from 'node:crypto';
// Keep the daemon's guarded handle, scope registry, and repositories in the
// same runtime module. The independently bundled tools entry point must not
// manufacture a second tenant proxy WeakMap/AsyncLocalStorage owner.
import {
  type Database,
  getCurrentTenantId,
  getManagedOAuthDeferredClaim,
  isPostgresDatabaseHandle,
  type MCPOAuthRefreshVersion,
  MCPServerRepository,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type UserMCPOAuthToken,
  UserMCPOAuthTokenRepository,
} from '@agor/core/db';
import {
  ROTATING_GRANT_OBSERVE_INTERVAL_MS,
  ROTATING_GRANT_OBSERVE_TIMEOUT_MS,
  refreshRotatingGrant,
} from '../../oauth/rotating-grant-refresh';
import {
  assertDirectMCPOAuthClient,
  type MCPOAuthClientMode,
  type MCPServerID,
  type UserID,
} from '../../types';
import type {
  MCPManagedOAuthRefreshAdapter,
  MCPManagedOAuthTokenCommit,
} from '../../types/mcp-managed-oauth';
import { managedOAuthWireGeneration } from '../../types/mcp-managed-oauth';
import {
  McpOAuthOperationResponseSchema,
  type McpOAuthOwner,
  type McpOAuthRefreshRequest,
} from '../../types/mcp-managed-oauth-contract';
import {
  type OutboundDnsLookup,
  OutboundPreDispatchAuthorityError,
  safeOutboundFetch,
} from '../../utils/safe-outbound-fetch';
import { assertMcpGrantSubjectEntitled } from './grant-entitlement';
import {
  executeManagedOAuthOperation,
  type ManagedMCPOAuthClient,
  ManagedMCPOAuthOperationError,
  recoverManagedOAuthOperation,
} from './managed-oauth-client';
import { inferOAuthTokenUrl } from './oauth-auth';
import {
  applyClientAuthentication,
  type MCPOAuthTokenEndpointAuthMethod,
} from './oauth-mcp-transport';
import { resolveTokenExpiry } from './oauth-token-expiry';

export const REFRESH_BUFFER_MS = 60_000;
const REFRESH_OBSERVE_TIMEOUT_MS = ROTATING_GRANT_OBSERVE_TIMEOUT_MS;
const REFRESH_OBSERVE_INTERVAL_MS = ROTATING_GRANT_OBSERVE_INTERVAL_MS;

// Process-local proof issued only after this refresh owner's exact DB CAS has
// certified no token consumption. Error names or wire-shaped caller objects are
// not proof. The acquisition boundary must still reread and validate the grant.
const deferredManagedRefreshes = new WeakMap<object, Readonly<MCPOAuthRefreshVersion>>();
export function getManagedOAuthDeferredRefresh(
  error: unknown
): Readonly<MCPOAuthRefreshVersion> | undefined {
  return error !== null && typeof error === 'object'
    ? deferredManagedRefreshes.get(error)
    : undefined;
}
function certifyDeferredManagedRefresh(error: unknown, fence: MCPOAuthRefreshVersion): Error {
  const failure = error instanceof Error ? error : new Error('Managed OAuth refresh deferred');
  deferredManagedRefreshes.set(
    failure,
    Object.freeze({
      grantGeneration: fence.grantGeneration,
      grantBindingFingerprint: fence.grantBindingFingerprint,
      refreshGeneration: fence.refreshGeneration,
    })
  );
  return failure;
}

export class InvalidGrantError extends Error {
  readonly code = 'invalid_grant';
  constructor(message = 'OAuth refresh grant is no longer valid') {
    super(message);
    this.name = 'InvalidGrantError';
  }
}

export class MissingRefreshTokenError extends Error {
  readonly code = 'missing_refresh_token';
  constructor(message = 'No stored refresh token is available for this grant') {
    super(message);
    this.name = 'MissingRefreshTokenError';
  }
}

export class MissingTokenEndpointError extends Error {
  readonly code = 'missing_token_endpoint';
  constructor(message = 'Could not determine the OAuth token endpoint for refresh') {
    super(message);
    this.name = 'MissingTokenEndpointError';
  }
}

export class MissingClientIdError extends Error {
  readonly code = 'missing_client_id';
  constructor(message = 'Cannot refresh OAuth token without a client ID') {
    super(message);
    this.name = 'MissingClientIdError';
  }
}

export class AmbiguousRefreshError extends Error {
  readonly code = 'ambiguous_refresh';
  constructor(message = 'OAuth refresh outcome is ambiguous; reconnect safely') {
    super(message);
    this.name = 'AmbiguousRefreshError';
  }
}

/** No terminal journal result: only the original claim's receipt may be recovered. */
export class ManagedRefreshInProgressError extends Error {
  readonly code = 'managed_refresh_in_progress';
  constructor() {
    super('Managed OAuth refresh is awaiting its original operation receipt');
    this.name = 'ManagedRefreshInProgressError';
  }
}

export class FailedRefreshError extends Error {
  readonly code = 'failed_refresh';
  constructor(message = 'The observed OAuth refresh failed; retry or reconnect safely') {
    super(message);
    this.name = 'FailedRefreshError';
  }
}

export class GrantConfigurationChangedError extends Error {
  readonly code = 'grant_configuration_changed';
  constructor(message = 'MCP OAuth grant or server configuration changed during refresh') {
    super(message);
    this.name = 'GrantConfigurationChangedError';
  }
}

export class OAuthRefreshExchangeError extends Error {
  constructor(
    readonly category: 'provider_rejected' | 'transport_ambiguous' | 'response_ambiguous',
    readonly ambiguous: boolean
  ) {
    super(`OAuth refresh failed (${category})`);
    this.name = 'OAuthRefreshExchangeError';
  }
}

/** No refresh credential was dispatched because caller authority changed. */
export class OAuthRefreshAuthorityCancelledError extends Error {
  readonly code = 'oauth_refresh_authority_cancelled';

  constructor(readonly authorityCause: unknown) {
    super('OAuth refresh authority changed before dispatch');
    this.name = 'OAuthRefreshAuthorityCancelledError';
  }
}

export interface RefreshMCPTokenOptions {
  oauthClientMode?: MCPOAuthClientMode;
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  resourceUri?: string;
  /** Exact negotiated method; client errors never authorize an alternate-method replay. */
  tokenEndpointAuthMethod?: MCPOAuthTokenEndpointAuthMethod;
  /** Exact redirect used to issue this grant (required by GitLab on refresh). */
  redirectUri?: string;
  /** Exact loopback HTTP exception for standalone development/tests only. */
  allowLocalhostHttp?: boolean;
  /** Task/session/rollout fence checked immediately before credential dispatch. */
  assertCurrent?: () => void | Promise<void>;
  resolveDns?: OutboundDnsLookup;
}

export interface RefreshMCPTokenResult {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

interface OAuthRefreshRawResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number | string;
  refresh_token?: string;
  scope?: string;
  error?: string;
}

/** The only emitted failure data is a stable local category/status. */
export async function refreshMCPToken(
  opts: RefreshMCPTokenOptions
): Promise<RefreshMCPTokenResult> {
  assertDirectMCPOAuthClient({ oauth_client_mode: opts.oauthClientMode });
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
  };
  if (opts.resourceUri) body.resource = opts.resourceUri;
  if (opts.redirectUri) body.redirect_uri = opts.redirectUri;
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  applyClientAuthentication(
    body,
    headers,
    opts.clientId,
    opts.clientSecret,
    opts.tokenEndpointAuthMethod ?? 'client_secret_basic'
  );

  let response: Response;
  try {
    response = await safeOutboundFetch(opts.tokenEndpoint, {
      method: 'POST',
      headers,
      body: new URLSearchParams(body).toString(),
      redirect: 'error',
      timeoutMs: 15_000,
      allowLocalhostHttp: opts.allowLocalhostHttp,
      assertCurrent: opts.assertCurrent,
      resolveDns: opts.resolveDns,
    });
  } catch (error) {
    if (error instanceof OutboundPreDispatchAuthorityError) {
      throw new OAuthRefreshAuthorityCancelledError(error.authorityCause);
    }
    throw new OAuthRefreshExchangeError('transport_ambiguous', true);
  }

  let parsed: OAuthRefreshRawResponse;
  try {
    parsed = (await response.json()) as OAuthRefreshRawResponse;
  } catch {
    throw new OAuthRefreshExchangeError('response_ambiguous', true);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OAuthRefreshExchangeError('response_ambiguous', true);
  }
  if (parsed.error !== undefined) {
    // Only an unambiguous error response proves no token pair was issued.
    // Mixed success/error or malformed error JSON may have consumed a
    // rotating token and must never release its dispatch fence for replay.
    if (
      response.ok ||
      typeof parsed.error !== 'string' ||
      !parsed.error ||
      parsed.access_token !== undefined ||
      parsed.refresh_token !== undefined
    ) {
      throw new OAuthRefreshExchangeError('response_ambiguous', true);
    }
    if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(parsed.error)) {
      throw new InvalidGrantError();
    }
    throw new OAuthRefreshExchangeError('provider_rejected', false);
  }
  if (!response.ok || typeof parsed.access_token !== 'string' || !parsed.access_token) {
    throw new OAuthRefreshExchangeError('response_ambiguous', true);
  }
  if (
    (parsed.refresh_token !== undefined &&
      (typeof parsed.refresh_token !== 'string' || !parsed.refresh_token)) ||
    (parsed.token_type !== undefined &&
      (typeof parsed.token_type !== 'string' || parsed.token_type.toLowerCase() !== 'bearer'))
  ) {
    throw new OAuthRefreshExchangeError('response_ambiguous', true);
  }
  const expiresIn = parsed.expires_in == null ? undefined : Number(parsed.expires_in);
  if (
    parsed.expires_in !== undefined &&
    ((typeof parsed.expires_in !== 'number' && typeof parsed.expires_in !== 'string') ||
      !Number.isSafeInteger(expiresIn) ||
      expiresIn! <= 0 ||
      !Number.isFinite(new Date(Date.now() + expiresIn! * 1000).getTime()))
  ) {
    throw new OAuthRefreshExchangeError('response_ambiguous', true);
  }
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    expires_in: Number.isFinite(expiresIn) ? expiresIn : undefined,
    token_type: parsed.token_type,
    scope: parsed.scope,
  };
}

type MutexKey = string;
interface StandaloneRefreshFlight {
  version: Pick<MCPOAuthRefreshVersion, 'grantGeneration' | 'grantBindingFingerprint'>;
  promise: Promise<string>;
}
const _inFlightRefreshes = new Map<MutexKey, StandaloneRefreshFlight>();
export function __resetRefreshMutexForTests(): void {
  _inFlightRefreshes.clear();
}
export function __refreshMutexSizeForTests(): number {
  return _inFlightRefreshes.size;
}
function mutexKey(deps: RefreshAndPersistDeps): MutexKey {
  return JSON.stringify([
    deps.tenantId ?? getCurrentTenantId() ?? '<standalone>',
    deps.userId,
    deps.mcpServerId,
  ]);
}

export interface RefreshAndPersistDeps {
  /** Absent unless the managed coordinator explicitly enabled this cell. */
  managed?: MCPManagedOAuthRefreshAdapter;
  db: Database | TenantScopeAwareDatabase;
  tenantId?: string;
  userId: UserID | null;
  mcpServerId: MCPServerID;
  /**
   * Exact version read by the caller when it decided a refresh was needed.
   * Both database implementations fence the exchange and any joined refresh
   * result to this version so a stale caller cannot adopt a replacement grant.
   */
  observedRefreshVersion: MCPOAuthRefreshVersion;
  /**
   * Re-resolve the authoritative saved server and verify this exact grant's
   * binding inside the supplied database unit. Daemon callers acquire the
   * server-configuration lock here on PostgreSQL before refresh completion.
   */
  validateGrant: (
    grant: UserMCPOAuthToken,
    db: Database | TenantScopeAwareDatabase
  ) => boolean | Promise<boolean>;
  onInvalidGrant?: (info: { userId: UserID | null; mcpServerId: MCPServerID }) => void;
  /** Internal test/development seam; daemon PostgreSQL callers leave this false. */
  allowLocalhostHttpDevelopment?: boolean;
  assertCurrent?: () => void | Promise<void>;
  /** Deterministic DNS seam used by pre-dispatch authority race tests. */
  resolveDns?: OutboundDnsLookup;
}

function exactGrantMatches(
  token: UserMCPOAuthToken,
  expected: Pick<MCPOAuthRefreshVersion, 'grantGeneration' | 'grantBindingFingerprint'>
): boolean {
  return (
    (token.grant_generation ?? 0) === expected.grantGeneration &&
    (token.grant_binding_fingerprint ?? undefined) === expected.grantBindingFingerprint
  );
}

function exactGrantVersionsMatch(
  left: Pick<MCPOAuthRefreshVersion, 'grantGeneration' | 'grantBindingFingerprint'>,
  right: Pick<MCPOAuthRefreshVersion, 'grantGeneration' | 'grantBindingFingerprint'>
): boolean {
  return (
    left.grantGeneration === right.grantGeneration &&
    left.grantBindingFingerprint === right.grantBindingFingerprint
  );
}

async function assertGrantStillAuthorized(
  deps: RefreshAndPersistDeps,
  grant: UserMCPOAuthToken,
  db: Database | TenantScopeAwareDatabase
): Promise<void> {
  if (!(await deps.validateGrant(grant, db))) throw new GrantConfigurationChangedError();
}

async function loadExactAuthorizedGrant(
  deps: RefreshAndPersistDeps,
  expected: Pick<MCPOAuthRefreshVersion, 'grantGeneration' | 'grantBindingFingerprint'>
): Promise<UserMCPOAuthToken> {
  return tenantWork(deps, async (db) => {
    const token = await new UserMCPOAuthTokenRepository(db).getToken(deps.userId, deps.mcpServerId);
    if (!token) throw new InvalidGrantError();
    if (!exactGrantMatches(token, expected)) throw new GrantConfigurationChangedError();
    await assertGrantStillAuthorized(deps, token, db);
    return token;
  });
}

function resolveTenantId(deps: RefreshAndPersistDeps): string {
  const tenantId = deps.tenantId ?? getCurrentTenantId();
  if (!tenantId) throw new Error('MCP OAuth refresh requires trusted tenant identity');
  return String(tenantId);
}

async function tenantWork<T>(
  deps: RefreshAndPersistDeps,
  work: (db: Database) => Promise<T>
): Promise<T> {
  return runWithTenantDatabaseScope(deps.db, resolveTenantId(deps), (scoped) =>
    work(scoped as Database)
  );
}

function notifyInvalidGrant(deps: RefreshAndPersistDeps): void {
  try {
    deps.onInvalidGrant?.({ userId: deps.userId, mcpServerId: deps.mcpServerId });
  } catch {
    console.error('[MCP OAuth Refresh] callback_failed category=invalid_grant_notification');
  }
}

async function observeCommittedRefresh(
  deps: RefreshAndPersistDeps,
  expected: MCPOAuthRefreshVersion
): Promise<string> {
  const deadline = Date.now() + REFRESH_OBSERVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const token = await tenantWork(deps, (db) =>
      new UserMCPOAuthTokenRepository(db).getToken(deps.userId, deps.mcpServerId)
    );
    if (!token) throw new InvalidGrantError();
    if (!exactGrantMatches(token, expected)) throw new GrantConfigurationChangedError();
    if (token.refresh_status === 'ambiguous') throw new AmbiguousRefreshError();
    if (token.refresh_status === 'idle') {
      if (token.refresh_success_generation >= expected.refreshGeneration) {
        await tenantWork(deps, (db) => assertGrantStillAuthorized(deps, token, db));
        return token.oauth_access_token;
      }
      // `idle` alone is not success: a known provider rejection releases the
      // claim for retry while deliberately leaving success generation behind.
      throw new FailedRefreshError();
    }
    await new Promise((resolve) => setTimeout(resolve, REFRESH_OBSERVE_INTERVAL_MS));
  }
  throw new AmbiguousRefreshError('OAuth refresh owner did not commit before the wait timeout');
}

async function settleObservedRefresh(
  deps: RefreshAndPersistDeps,
  token: UserMCPOAuthToken | null,
  expected: MCPOAuthRefreshVersion
): Promise<string> {
  if (!token) throw new InvalidGrantError();
  if (!exactGrantMatches(token, expected)) throw new GrantConfigurationChangedError();
  if (token.refresh_status === 'ambiguous') throw new AmbiguousRefreshError();
  if (token.refresh_status === 'refreshing') {
    return observeCommittedRefresh(deps, {
      grantGeneration: token.grant_generation,
      grantBindingFingerprint: token.grant_binding_fingerprint,
      refreshGeneration: token.refresh_generation,
    });
  }
  if (!token.oauth_refresh_token) throw new MissingRefreshTokenError();
  if (token.refresh_success_generation < token.refresh_generation) {
    throw new FailedRefreshError();
  }
  // A stale caller lost its expected-version CAS to a successfully refreshed
  // row or to a newer atomic grant replacement. It must observe, not exchange.
  await tenantWork(deps, (db) => assertGrantStillAuthorized(deps, token, db));
  return token.oauth_access_token;
}

/**
 * A short receipt-read deadline or HTTP failure is not the two-minute owner
 * deadline and cannot retire another replica's live claim. The dispatch owner
 * has the same uncertainty after a lost response. Keep that exact claim so a
 * later receipt-only reader can recover it; claimRefresh/maintenance enforce
 * expiry using database time. Never release it or allocate another operation.
 */
async function observeManagedRefreshAfterUncertainty(
  deps: RefreshAndPersistDeps,
  fence: MCPOAuthRefreshVersion & { claimId: string },
  operationId: string
): Promise<string> {
  await deps.assertCurrent?.();
  return tenantWork(deps, async (db) => {
    const token = await new UserMCPOAuthTokenRepository(db).getToken(deps.userId, deps.mcpServerId);
    if (!token) throw new InvalidGrantError();
    if (!exactGrantMatches(token, fence)) throw new GrantConfigurationChangedError();
    await assertGrantSubjectForRefresh(deps, db);
    await assertGrantStillAuthorized(deps, token, db);
    if (token.refresh_status === 'ambiguous') throw new AmbiguousRefreshError();
    if (
      token.refresh_status === 'idle' &&
      token.refresh_generation === fence.refreshGeneration &&
      token.refresh_success_generation === fence.refreshGeneration &&
      token.managed_metadata?.operation_id === operationId &&
      token.managed_metadata.claim.claim_id === fence.claimId
    )
      return token.oauth_access_token;
    if (token.refresh_status === 'idle') throw new FailedRefreshError();
    // This is not a no-consumption certificate: acquisition must not infer
    // that an uncertain operation was rejected or reuse a rotating token.
    throw new ManagedRefreshInProgressError();
  });
}

// Shared symbol survives independently bundled entry points but cannot arrive in
// JSON/HTTP errors. Only this adapter mints it before invoking ANY client request.
const managedUndispatched = Symbol.for('agor.internal.managed-oauth.local-undispatched.v1');
class ManagedOAuthLocalAdmissionError extends Error {
  readonly [managedUndispatched] = true;
  constructor(
    readonly operationId: string,
    readonly claimId: string,
    readonly sequence: string
  ) {
    super('Managed OAuth refresh admission is unavailable');
    this.name = 'ManagedOAuthLocalAdmissionError';
  }
}
function isLocalUndispatched(error: unknown, request: McpOAuthRefreshRequest): boolean {
  return (
    error instanceof Error &&
    managedUndispatched in error &&
    error[managedUndispatched] === true &&
    'operationId' in error &&
    error.operationId === request.operation_id &&
    'claimId' in error &&
    error.claimId === request.claim.claim_id &&
    'sequence' in error &&
    error.sequence === request.sequence
  );
}

/** Shared verified broker adapter. It neither claims nor persists a grant. */
export function createManagedOAuthRefreshAdapter(options: {
  client: ManagedMCPOAuthClient;
  issuer: string;
  keys: ReadonlyMap<string, KeyObject>;
  now: () => number;
  assertCurrent: (owner: McpOAuthOwner) => void | Promise<void>;
  acknowledge: (commit: MCPManagedOAuthTokenCommit) => Promise<void>;
}): MCPManagedOAuthRefreshAdapter {
  return {
    acknowledge: options.acknowledge,
    async execute({ request, metadata, recoveryOnly, assertCurrent }) {
      // Recovery never knows whether a prior process dispatched. Once even the
      // first client call is invoked, transport uncertainty cannot regain this proof.
      let requestInvoked = recoveryOnly;
      const client = new Proxy(options.client, {
        get(target, property, receiver) {
          if (property === 'request')
            return (...args: Parameters<ManagedMCPOAuthClient['request']>) => {
              requestInvoked = true;
              return target.request(...args);
            };
          return Reflect.get(target, property, receiver);
        },
      });
      const current = async () => {
        try {
          await assertCurrent();
          await options.assertCurrent(request.owner);
        } catch (error) {
          if (!requestInvoked)
            throw new ManagedOAuthLocalAdmissionError(
              request.operation_id,
              request.claim.claim_id,
              request.sequence
            );
          throw error;
        }
      };
      const policy = {
        client,
        issuer: options.issuer,
        keys: options.keys,
        now: options.now,
        assertCurrent: current,
      };
      const verified = recoveryOnly
        ? await recoverManagedOAuthOperation({
            ...policy,
            expected: {
              owner: request.owner,
              claim: request.claim,
              operationId: request.operation_id,
              sequence: request.sequence,
              handle: request.handle,
              handleEpoch: request.handle_epoch,
            },
          })
        : await executeManagedOAuthOperation({ ...policy, request, sequence: request.sequence });
      const { result, receipt, use } = verified;
      return {
        tokens: result.tokens,
        operation_id: request.operation_id,
        expected_sequence: request.sequence,
        metadata: {
          owner: request.owner,
          transaction_id: metadata.transaction_id,
          handle: result.handle,
          handle_epoch: result.handle_epoch,
          next_sequence: result.next_sequence,
          operation_id: result.operation_id,
          receipt_id: result.receipt_id,
          claim: request.claim,
          signed_receipt: result.signed_receipt,
          receipt_claims: receipt,
          use_authorization: result.use_authorization,
          use_claims: use,
        },
      };
    },
  };
}

/** The existing database claim is the only owner, including receipt-only failover. */
async function refreshManagedPostgres(
  deps: RefreshAndPersistDeps,
  row: UserMCPOAuthToken,
  recoveryOnly: boolean
): Promise<string> {
  if (
    !deps.managed ||
    !deps.userId ||
    !row.managed_metadata ||
    !row.managed_operation_id ||
    !row.refresh_claim_id ||
    !row.refresh_claimed_at ||
    !row.oauth_refresh_token
  ) {
    throw new GrantConfigurationChangedError(
      'Managed OAuth refresh is not available for this authority'
    );
  }
  const adapter = deps.managed;
  const fence = {
    claimId: row.refresh_claim_id,
    refreshGeneration: row.refresh_generation,
    grantGeneration: row.grant_generation,
    grantBindingFingerprint: row.grant_binding_fingerprint,
  };
  const metadata = row.managed_metadata;
  const request: McpOAuthRefreshRequest = {
    protocol_version: 1,
    operation_id: row.managed_operation_id,
    owner: metadata.owner,
    handle: metadata.handle,
    handle_epoch: metadata.handle_epoch,
    sequence: metadata.next_sequence,
    refresh_token: row.oauth_refresh_token,
    claim: {
      kind: 'refresh',
      claim_id: fence.claimId,
      claimed_at: row.refresh_claimed_at.getTime(),
      deadline_at: row.refresh_claimed_at.getTime() + 120000,
      refresh_generation: managedOAuthWireGeneration(row.refresh_generation),
      refresh_success_generation: managedOAuthWireGeneration(row.refresh_success_generation),
    },
  };
  const assertCurrent = async () => {
    await deps.assertCurrent?.();
    await tenantWork(deps, async (db) => {
      await assertGrantSubjectForRefresh(deps, db);
      await assertGrantStillAuthorized(deps, row, db);
    });
  };
  try {
    await assertCurrent();
  } catch (error) {
    // Only this process's new claim is known not to have dispatched. Recovery
    // cannot make that assertion about the original owner's network activity.
    if (!recoveryOnly) {
      const released = await tenantWork(deps, (db) =>
        new UserMCPOAuthTokenRepository(db).releaseUnstartedManagedRefreshClaim(
          deps.userId!,
          deps.mcpServerId,
          fence,
          request.operation_id,
          request.sequence
        )
      );
      if (released) throw certifyDeferredManagedRefresh(error, fence);
    }
    throw error;
  }
  let commit: MCPManagedOAuthTokenCommit;
  try {
    commit = await adapter.execute({ request, metadata, recoveryOnly, assertCurrent });
  } catch (error) {
    if (!recoveryOnly && isLocalUndispatched(error, request)) {
      const released = await tenantWork(deps, (db) =>
        new UserMCPOAuthTokenRepository(db).releaseUnstartedManagedRefreshClaim(
          deps.userId!,
          deps.mcpServerId,
          fence,
          request.operation_id,
          request.sequence
        )
      );
      if (released) throw certifyDeferredManagedRefresh(error, fence);
      throw error;
    }
    // Independently bundled entry points can carry distinct class constructors.
    // Admit only this internal protocol error tag plus a valid exact wire outcome.
    const outcome =
      error instanceof ManagedMCPOAuthOperationError
        ? error.outcome
        : error instanceof Error &&
            error.name === 'ManagedMCPOAuthOperationError' &&
            'outcome' in error
          ? McpOAuthOperationResponseSchema.parse(error.outcome)
          : undefined;
    if (outcome && outcome.status !== 'succeeded') {
      const changed = await tenantWork(deps, (db) =>
        new UserMCPOAuthTokenRepository(db).finishManagedRefreshRejection(
          deps.userId!,
          deps.mcpServerId,
          fence,
          outcome
        )
      );
      if (!changed) return observeCommittedRefresh(deps, fence);
      if (outcome.status === 'grant_invalid') {
        notifyInvalidGrant(deps);
        throw new InvalidGrantError();
      }
      if (
        outcome.status === 'not_dispatched' ||
        outcome.status === 'client_configuration_failed' ||
        outcome.status === 'rejected_non_consuming'
      )
        throw certifyDeferredManagedRefresh(error, fence);
      // App-client pause/rejection remains distinct from user grant invalidation.
      throw error;
    }
    return observeManagedRefreshAfterUncertainty(deps, fence, request.operation_id);
  }
  let committed: boolean;
  try {
    committed = await tenantWork(deps, async (db) => {
      await assertGrantSubjectForRefresh(deps, db);
      await assertGrantStillAuthorized(deps, row, db);
      return new UserMCPOAuthTokenRepository(db).completeClaimedRefresh(
        deps.userId,
        deps.mcpServerId,
        fence,
        {
          accessToken: commit.tokens.access_token,
          refreshToken: commit.tokens.refresh_token,
          expiresAt: new Date(commit.tokens.expires_at),
          managed: commit,
        }
      );
    });
  } catch {
    // A failed/lost local COMMIT acknowledgement is not proof that the broker
    // operation is ambiguous either. Adopt only our exact committed result.
    return observeManagedRefreshAfterUncertainty(deps, fence, request.operation_id);
  }
  if (!committed) return observeCommittedRefresh(deps, fence);
  try {
    await adapter.acknowledge(commit);
  } catch {
    // Metadata retains the exact receipt for an idempotent later ACK. Never
    // poison a successfully committed rotating grant because ACK transport failed.
    console.warn('[MCP OAuth Refresh] managed_ack_deferred');
  }
  return (await loadExactAuthorizedGrant(deps, fence)).oauth_access_token;
}

async function refreshPostgres(deps: RefreshAndPersistDeps): Promise<string> {
  const expected = deps.observedRefreshVersion;
  if (!expected) {
    throw new Error('PostgreSQL MCP OAuth refresh requires an observed grant version');
  }
  if (!expected.grantBindingFingerprint) {
    throw new GrantConfigurationChangedError(
      'PostgreSQL MCP OAuth refresh requires the observed grant fingerprint'
    );
  }
  const claim = await tenantWork(deps, async (db) => {
    const repo = new UserMCPOAuthTokenRepository(db);
    const observed = await repo.getToken(deps.userId, deps.mcpServerId);
    if (observed?.credential_origin === 'cloud_managed_v1') {
      if (!deps.managed)
        throw new GrantConfigurationChangedError('Managed OAuth refresh adapter is disabled');
      await assertGrantStillAuthorized(deps, observed, db);
    }
    return repo.claimRefresh(deps.userId, deps.mcpServerId, expected);
  });
  const deferred = getManagedOAuthDeferredClaim(claim);
  if (deferred)
    throw certifyDeferredManagedRefresh(
      new Error('Managed OAuth refresh retry deferred'),
      deferred
    );
  if (claim.outcome === 'observed') {
    if (
      claim.token?.credential_origin === 'cloud_managed_v1' &&
      claim.token.refresh_status === 'refreshing' &&
      exactGrantMatches(claim.token, expected)
    )
      return refreshManagedPostgres(deps, claim.token, true);
    return settleObservedRefresh(deps, claim.token, expected);
  }

  const row = claim.token;
  if (row.credential_origin === 'cloud_managed_v1') return refreshManagedPostgres(deps, row, false);
  type Claim = { row: UserMCPOAuthToken; fence: MCPOAuthRefreshVersion & { claimId: string } };
  return refreshRotatingGrant<Claim, RefreshMCPTokenResult, string>({
    async claim() {
      // The sole repository claim above routes managed authority before the direct adapter.
      return {
        owned: true,
        claim: {
          row,
          fence: {
            claimId: claim.claimId,
            refreshGeneration: claim.refreshGeneration,
            grantGeneration: claim.grantGeneration,
            grantBindingFingerprint: row.grant_binding_fingerprint,
          },
        },
      };
    },
    async prepare({ row }) {
      if (!row.oauth_refresh_token) throw new MissingRefreshTokenError();
      if (!row.oauth_client_id) throw new MissingClientIdError();
      if (!row.oauth_token_endpoint) throw new MissingTokenEndpointError();
      await tenantWork(deps, (db) => assertGrantStillAuthorized(deps, row, db));
    },
    exchange: ({ row }) =>
      refreshMCPToken({
        tokenEndpoint: row.oauth_token_endpoint!,
        refreshToken: row.oauth_refresh_token!,
        clientId: row.oauth_client_id!,
        clientSecret: row.oauth_client_secret,
        resourceUri: row.oauth_resource_uri,
        redirectUri: row.oauth_redirect_uri,
        tokenEndpointAuthMethod: row.oauth_token_endpoint_auth_method,
        allowLocalhostHttp: deps.allowLocalhostHttpDevelopment,
        assertCurrent: deps.assertCurrent,
        resolveDns: deps.resolveDns,
      }),
    commit: ({ row, fence }, result) =>
      tenantWork(deps, async (db) => {
        await assertGrantSubjectForRefresh(deps, db);
        await assertGrantStillAuthorized(deps, row, db);
        return new UserMCPOAuthTokenRepository(db).completeClaimedRefresh(
          deps.userId,
          deps.mcpServerId,
          fence,
          {
            accessToken: result.access_token,
            refreshToken: result.refresh_token,
            expiresAt: resolveTokenExpiry(result, result.access_token).expiresAt,
          }
        );
      }),
    deliver: async ({ fence }) => (await loadExactAuthorizedGrant(deps, fence)).oauth_access_token,
    observe: ({ fence }) => observeCommittedRefresh(deps, fence),
    async recoverCommitted({ fence }) {
      const row = await tenantWork(deps, (db) =>
        new UserMCPOAuthTokenRepository(db).getToken(deps.userId, deps.mcpServerId)
      );
      if (
        !row ||
        !exactGrantMatches(row, fence) ||
        row.refresh_status !== 'idle' ||
        row.refresh_success_generation < fence.refreshGeneration
      )
        return null;
      return { value: (await loadExactAuthorizedGrant(deps, fence)).oauth_access_token };
    },
    classify(error) {
      if (error instanceof InvalidGrantError) return 'invalid';
      if (error instanceof OAuthRefreshAuthorityCancelledError) return 'cancelled';
      if (error instanceof OAuthRefreshExchangeError && !error.ambiguous) return 'rejected';
      return 'ambiguous';
    },
    async settle({ fence }, outcome) {
      if (outcome === 'invalid') {
        const deleted = await tenantWork(deps, (db) =>
          new UserMCPOAuthTokenRepository(db).deleteClaimedInvalidGrant(
            deps.userId,
            deps.mcpServerId,
            fence
          )
        );
        if (deleted) notifyInvalidGrant(deps);
        else await observeCommittedRefresh(deps, fence);
        return;
      }
      await tenantWork(deps, (db) =>
        new UserMCPOAuthTokenRepository(db).finishRefreshClaim(
          deps.userId,
          deps.mcpServerId,
          fence,
          outcome === 'ambiguous' ? 'ambiguous' : 'idle'
        )
      );
    },
  });
}

/**
 * The grant subject's standing, as a precondition of persisting a refreshed
 * token. `userId === null` is the tenant-owned `shared` grant, which has no
 * individual role to re-check. Its consenter attribution is immutable through
 * refresh, and the immediate FK cascade retires it on hard deletion. Both
 * completion methods are update-only and version-fenced, so neither a removed
 * grant nor another user's replacement can be resurrected by in-flight work.
 */
async function assertGrantSubjectForRefresh(
  deps: RefreshAndPersistDeps,
  db: Database | TenantScopeAwareDatabase
): Promise<void> {
  await assertMcpGrantSubjectEntitled({
    db,
    tenantId: deps.tenantId ?? getCurrentTenantId(),
    subjectUserId: deps.userId,
    oauthMode: deps.userId === null ? 'shared' : 'per_user',
  });
}

async function loadObservedStandaloneGrant(
  deps: RefreshAndPersistDeps,
  expected: Pick<MCPOAuthRefreshVersion, 'grantGeneration' | 'grantBindingFingerprint'>
): Promise<UserMCPOAuthToken> {
  const userTokenRepo = new UserMCPOAuthTokenRepository(deps.db as Database);
  const row = await userTokenRepo.getToken(deps.userId, deps.mcpServerId);
  if (!row) throw new MissingRefreshTokenError();
  if (row.credential_origin === 'cloud_managed_v1' || row.grant_binding_version === 5)
    throw new GrantConfigurationChangedError('Managed OAuth requires PostgreSQL');
  if (!exactGrantMatches(row, expected)) throw new GrantConfigurationChangedError();
  await assertGrantStillAuthorized(deps, row, deps.db);
  return row;
}

async function refreshStandalone(
  deps: RefreshAndPersistDeps,
  observedVersion: MCPOAuthRefreshVersion
): Promise<string> {
  const userTokenRepo = new UserMCPOAuthTokenRepository(deps.db as Database);
  const exactGrantVersion = {
    grantGeneration: observedVersion.grantGeneration,
    grantBindingFingerprint: observedVersion.grantBindingFingerprint,
    refreshGeneration: observedVersion.refreshGeneration,
  };
  // Repeat the caller-bound check inside the mutex owner. The saved row may
  // have changed after the pre-mutex validation but before this promise ran.
  const row = await loadObservedStandaloneGrant(deps, exactGrantVersion);
  if (row.refresh_status === 'ambiguous') throw new AmbiguousRefreshError();
  // No in-process owner exists here. A persisted dispatch from a previous
  // daemon may have consumed the rotating token; never replay it.
  if (row.refresh_status === 'refreshing') {
    await userTokenRepo.setStandaloneRefreshState(
      deps.userId,
      deps.mcpServerId,
      exactGrantVersion,
      'refreshing',
      'ambiguous'
    );
    throw new AmbiguousRefreshError();
  }
  if (row.refresh_generation > observedVersion.refreshGeneration) {
    return row.oauth_access_token;
  }

  if (!row.oauth_refresh_token) throw new MissingRefreshTokenError();
  const server = await new MCPServerRepository(deps.db as Database).findById(deps.mcpServerId);
  const clientId = row.oauth_client_id ?? server?.auth?.oauth_client_id;
  if (!clientId) throw new MissingClientIdError();
  let tokenEndpoint = row.oauth_token_endpoint ?? server?.auth?.oauth_token_url;
  if (!tokenEndpoint && server?.url) tokenEndpoint = inferOAuthTokenUrl(server.url);
  if (!tokenEndpoint) throw new MissingTokenEndpointError();
  if (
    !(await userTokenRepo.setStandaloneRefreshState(
      deps.userId,
      deps.mcpServerId,
      exactGrantVersion,
      'idle',
      'refreshing'
    ))
  )
    throw new GrantConfigurationChangedError();
  try {
    const result = await refreshMCPToken({
      tokenEndpoint,
      refreshToken: row.oauth_refresh_token,
      clientId,
      clientSecret: row.oauth_client_secret ?? server?.auth?.oauth_client_secret,
      resourceUri: row.oauth_resource_uri,
      redirectUri: row.oauth_redirect_uri,
      tokenEndpointAuthMethod: row.oauth_token_endpoint_auth_method,
      allowLocalhostHttp: true,
      assertCurrent: deps.assertCurrent,
      resolveDns: deps.resolveDns,
    });
    const expiry = resolveTokenExpiry(result, result.access_token);
    await assertGrantSubjectForRefresh(deps, deps.db);
    await assertGrantStillAuthorized(deps, row, deps.db);
    const committed = await userTokenRepo.completeStandaloneRefresh(
      deps.userId,
      deps.mcpServerId,
      exactGrantVersion,
      {
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: expiry.expiresAt,
      }
    );
    if (!committed) throw new GrantConfigurationChangedError();
    const current = await userTokenRepo.getToken(deps.userId, deps.mcpServerId);
    if (!current) throw new InvalidGrantError();
    if (!exactGrantMatches(current, exactGrantVersion)) throw new GrantConfigurationChangedError();
    await assertGrantStillAuthorized(deps, current, deps.db);
    return result.access_token;
  } catch (error) {
    if (error instanceof InvalidGrantError) {
      const deleted = await userTokenRepo.deleteGrantVersion(
        deps.userId,
        deps.mcpServerId,
        exactGrantVersion.grantGeneration,
        exactGrantVersion.grantBindingFingerprint
      );
      if (deleted) notifyInvalidGrant(deps);
      else throw new GrantConfigurationChangedError();
    }
    if (!(error instanceof InvalidGrantError)) {
      const retrySafe =
        error instanceof OAuthRefreshAuthorityCancelledError ||
        (error instanceof OAuthRefreshExchangeError && !error.ambiguous);
      await userTokenRepo.setStandaloneRefreshState(
        deps.userId,
        deps.mcpServerId,
        exactGrantVersion,
        'refreshing',
        retrySafe ? 'idle' : 'ambiguous'
      );
    }
    throw error;
  }
}

export async function refreshAndPersistToken(deps: RefreshAndPersistDeps): Promise<string> {
  if (isPostgresDatabaseHandle(deps.db)) return refreshPostgres(deps);
  const expected = deps.observedRefreshVersion;
  if (!expected) {
    throw new Error('Standalone MCP OAuth refresh requires an observed grant version');
  }

  // Validate the caller's exact observation before it may create or join a
  // user/server mutex. A caller authorized against an old row must not learn,
  // refresh, or invalidate the replacement row occupying the same subject.
  await loadObservedStandaloneGrant(deps, expected);
  const key = mutexKey(deps);
  const existing = _inFlightRefreshes.get(key);
  if (existing) {
    if (!exactGrantVersionsMatch(existing.version, expected)) {
      throw new GrantConfigurationChangedError();
    }
    const result = await existing.promise;
    // A Settings mutation or replacement may have landed while this caller
    // was awaiting another request's exchange. Fence the shared result too.
    await loadObservedStandaloneGrant(deps, expected);
    return result;
  }
  const flight: StandaloneRefreshFlight = {
    version: {
      grantGeneration: expected.grantGeneration,
      grantBindingFingerprint: expected.grantBindingFingerprint,
    },
    promise: refreshStandalone(deps, expected),
  };
  _inFlightRefreshes.set(key, flight);
  try {
    return await flight.promise;
  } finally {
    if (_inFlightRefreshes.get(key) === flight) _inFlightRefreshes.delete(key);
  }
}

export function needsRefresh(expiresAt: Date | number | null | undefined): boolean {
  if (expiresAt == null) return false;
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : expiresAt;
  return Date.now() >= ms - REFRESH_BUFFER_MS;
}
