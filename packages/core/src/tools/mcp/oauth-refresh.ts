/** PostgreSQL-coordinated MCP OAuth refresh with rotating-token fencing. */

import { getCurrentTenantId, isPostgresDatabaseHandle, runWithTenantDatabaseScope } from '../../db';
import type { Database, TenantScopeAwareDatabase } from '../../db/client';
import {
  type MCPOAuthRefreshVersion,
  MCPServerRepository,
  type UserMCPOAuthToken,
  UserMCPOAuthTokenRepository,
} from '../../db/repositories';
import type { MCPServerID, UserID } from '../../types';
import {
  type OutboundDnsLookup,
  OutboundPreDispatchAuthorityError,
  safeOutboundFetch,
} from '../../utils/safe-outbound-fetch';
import { assertMcpGrantSubjectEntitled } from './grant-entitlement';
import { inferOAuthTokenUrl } from './oauth-auth';
import { resolveTokenExpiry } from './oauth-token-expiry';

export const REFRESH_BUFFER_MS = 60_000;
const REFRESH_OBSERVE_TIMEOUT_MS = 20_000;
const REFRESH_OBSERVE_INTERVAL_MS = 100;

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
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  resourceUri?: string;
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
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
  };
  if (opts.resourceUri) body.resource = opts.resourceUri;
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (opts.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')}`;
  } else {
    body.client_id = opts.clientId;
  }

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
  if (parsed.error === 'invalid_grant') throw new InvalidGrantError();
  if (parsed.error) throw new OAuthRefreshExchangeError('provider_rejected', false);
  if (!response.ok || typeof parsed.access_token !== 'string' || !parsed.access_token) {
    throw new OAuthRefreshExchangeError('response_ambiguous', true);
  }
  const expiresIn = parsed.expires_in == null ? undefined : Number(parsed.expires_in);
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
function mutexKey(userId: UserID | null, serverId: MCPServerID): MutexKey {
  return `${userId ?? '<shared>'}:${serverId}`;
}

export interface RefreshAndPersistDeps {
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
  const claim = await tenantWork(deps, (db) =>
    new UserMCPOAuthTokenRepository(db).claimRefresh(deps.userId, deps.mcpServerId, expected)
  );
  if (claim.outcome === 'observed') {
    return settleObservedRefresh(deps, claim.token, expected);
  }

  const row = claim.token;
  const fence = {
    claimId: claim.claimId,
    refreshGeneration: claim.refreshGeneration,
    grantGeneration: claim.grantGeneration,
    grantBindingFingerprint: row.grant_binding_fingerprint,
  };
  const releaseUnstartedClaim = async (error: Error): Promise<never> => {
    await tenantWork(deps, (db) =>
      new UserMCPOAuthTokenRepository(db).finishRefreshClaim(
        deps.userId,
        deps.mcpServerId,
        fence,
        'idle'
      )
    );
    throw error;
  };
  if (!row.oauth_refresh_token) {
    return releaseUnstartedClaim(new MissingRefreshTokenError());
  }
  if (!row.oauth_client_id) return releaseUnstartedClaim(new MissingClientIdError());
  if (!row.oauth_token_endpoint) {
    return releaseUnstartedClaim(new MissingTokenEndpointError());
  }
  try {
    await tenantWork(deps, (db) => assertGrantStillAuthorized(deps, row, db));
  } catch (error) {
    return releaseUnstartedClaim(
      error instanceof Error ? error : new GrantConfigurationChangedError()
    );
  }
  try {
    const result = await refreshMCPToken({
      tokenEndpoint: row.oauth_token_endpoint,
      refreshToken: row.oauth_refresh_token,
      clientId: row.oauth_client_id,
      clientSecret: row.oauth_client_secret,
      resourceUri: row.oauth_resource_uri,
      allowLocalhostHttp: deps.allowLocalhostHttpDevelopment,
      assertCurrent: deps.assertCurrent,
      resolveDns: deps.resolveDns,
    });
    const expiry = resolveTokenExpiry(result, result.access_token);
    const committed = await tenantWork(deps, async (db) => {
      // Inside this unit of work rather than before it: the entitlement is a
      // precondition of the write, and on PostgreSQL this callback is the
      // transaction the write commits in. See `assertMcpGrantSubjectEntitled`
      // for the residual window this still leaves open.
      await assertGrantSubjectForRefresh(deps, db);
      await assertGrantStillAuthorized(deps, row, db);
      return new UserMCPOAuthTokenRepository(db).completeClaimedRefresh(
        deps.userId,
        deps.mcpServerId,
        fence,
        {
          accessToken: result.access_token,
          refreshToken: result.refresh_token,
          expiresAt: expiry.expiresAt,
        }
      );
    });
    if (!committed) return observeCommittedRefresh(deps, fence);
    console.log('[MCP OAuth Refresh] refresh_succeeded category=committed');
    return (await loadExactAuthorizedGrant(deps, fence)).oauth_access_token;
  } catch (error) {
    if (error instanceof InvalidGrantError) {
      const deleted = await tenantWork(deps, (db) =>
        new UserMCPOAuthTokenRepository(db).deleteClaimedInvalidGrant(
          deps.userId,
          deps.mcpServerId,
          fence
        )
      );
      if (!deleted) return observeCommittedRefresh(deps, fence);
      console.warn('[MCP OAuth Refresh] refresh_failed category=invalid_grant');
      notifyInvalidGrant(deps);
      throw error;
    }
    if (error instanceof OAuthRefreshAuthorityCancelledError) {
      await tenantWork(deps, (db) =>
        new UserMCPOAuthTokenRepository(db).finishRefreshClaim(
          deps.userId,
          deps.mcpServerId,
          fence,
          'idle'
        )
      );
      console.warn('[MCP OAuth Refresh] refresh_cancelled category=authority_pre_dispatch');
      throw error;
    }
    const ambiguous = !(error instanceof OAuthRefreshExchangeError) || error.ambiguous;
    await tenantWork(deps, (db) =>
      new UserMCPOAuthTokenRepository(db).finishRefreshClaim(
        deps.userId,
        deps.mcpServerId,
        fence,
        ambiguous ? 'ambiguous' : 'idle'
      )
    );
    console.warn(
      `[MCP OAuth Refresh] refresh_failed category=${
        error instanceof OAuthRefreshExchangeError ? error.category : 'local_ambiguous'
      }`
    );
    throw error;
  }
}

/**
 * The grant subject's standing, as a precondition of persisting a refreshed
 * token. `userId === null` is the tenant-owned `shared` grant, which has no
 * individual subject to re-check.
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
  if (!exactGrantMatches(row, expected)) throw new GrantConfigurationChangedError();
  await assertGrantStillAuthorized(deps, row, deps.db);
  return row;
}

async function refreshStandalone(
  deps: RefreshAndPersistDeps,
  observedVersion: Pick<MCPOAuthRefreshVersion, 'grantGeneration' | 'grantBindingFingerprint'>
): Promise<string> {
  const userTokenRepo = new UserMCPOAuthTokenRepository(deps.db as Database);
  const exactGrantVersion = {
    grantGeneration: observedVersion.grantGeneration,
    grantBindingFingerprint: observedVersion.grantBindingFingerprint,
  };
  // Repeat the caller-bound check inside the mutex owner. The saved row may
  // have changed after the pre-mutex validation but before this promise ran.
  const row = await loadObservedStandaloneGrant(deps, exactGrantVersion);
  if (!row.oauth_refresh_token) throw new MissingRefreshTokenError();
  const server = await new MCPServerRepository(deps.db as Database).findById(deps.mcpServerId);
  const clientId = row.oauth_client_id ?? server?.auth?.oauth_client_id;
  if (!clientId) throw new MissingClientIdError();
  let tokenEndpoint = row.oauth_token_endpoint ?? server?.auth?.oauth_token_url;
  if (!tokenEndpoint && server?.url) tokenEndpoint = inferOAuthTokenUrl(server.url);
  if (!tokenEndpoint) throw new MissingTokenEndpointError();
  try {
    const result = await refreshMCPToken({
      tokenEndpoint,
      refreshToken: row.oauth_refresh_token,
      clientId,
      clientSecret: row.oauth_client_secret ?? server?.auth?.oauth_client_secret,
      resourceUri: row.oauth_resource_uri,
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
  const key = mutexKey(deps.userId, deps.mcpServerId);
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
