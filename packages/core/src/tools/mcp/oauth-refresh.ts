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
import { safeOutboundFetch } from '../../utils/safe-outbound-fetch';
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

export class OAuthRefreshExchangeError extends Error {
  constructor(
    readonly category: 'provider_rejected' | 'transport_ambiguous' | 'response_ambiguous',
    readonly ambiguous: boolean
  ) {
    super(`OAuth refresh failed (${category})`);
    this.name = 'OAuthRefreshExchangeError';
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
    });
  } catch {
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
const _inFlightRefreshes = new Map<MutexKey, Promise<string>>();
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
   * Version read by the caller when it decided a PostgreSQL refresh was
   * needed. Required at runtime for PostgreSQL so a delayed caller cannot
   * refresh a peer's newly rotated token.
   */
  observedRefreshVersion?: MCPOAuthRefreshVersion;
  onInvalidGrant?: (info: { userId: UserID | null; mcpServerId: MCPServerID }) => void;
  /** Internal test/development seam; daemon PostgreSQL callers leave this false. */
  allowLocalhostHttpDevelopment?: boolean;
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
    if (token.refresh_status === 'ambiguous') throw new AmbiguousRefreshError();
    if (token.refresh_status === 'idle') {
      // A newer authorization replaced the old grant atomically and is valid
      // independently of the old refresh attempt.
      if (token.grant_generation !== expected.grantGeneration) {
        return token.oauth_access_token;
      }
      if (token.refresh_success_generation >= expected.refreshGeneration) {
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
  token: UserMCPOAuthToken | null
): Promise<string> {
  if (!token) throw new InvalidGrantError();
  if (token.refresh_status === 'ambiguous') throw new AmbiguousRefreshError();
  if (token.refresh_status === 'refreshing') {
    return observeCommittedRefresh(deps, {
      grantGeneration: token.grant_generation,
      refreshGeneration: token.refresh_generation,
    });
  }
  if (!token.oauth_refresh_token) throw new MissingRefreshTokenError();
  if (token.refresh_success_generation < token.refresh_generation) {
    throw new FailedRefreshError();
  }
  // A stale caller lost its expected-version CAS to a successfully refreshed
  // row or to a newer atomic grant replacement. It must observe, not exchange.
  return token.oauth_access_token;
}

async function refreshPostgres(deps: RefreshAndPersistDeps): Promise<string> {
  const expected = deps.observedRefreshVersion;
  if (!expected) {
    throw new Error('PostgreSQL MCP OAuth refresh requires an observed grant version');
  }
  const claim = await tenantWork(deps, (db) =>
    new UserMCPOAuthTokenRepository(db).claimRefresh(deps.userId, deps.mcpServerId, expected)
  );
  if (claim.outcome === 'observed') {
    return settleObservedRefresh(deps, claim.token);
  }

  const row = claim.token;
  const fence = {
    claimId: claim.claimId,
    refreshGeneration: claim.refreshGeneration,
    grantGeneration: claim.grantGeneration,
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
    const result = await refreshMCPToken({
      tokenEndpoint: row.oauth_token_endpoint,
      refreshToken: row.oauth_refresh_token,
      clientId: row.oauth_client_id,
      clientSecret: row.oauth_client_secret,
      resourceUri: row.oauth_resource_uri,
      allowLocalhostHttp: deps.allowLocalhostHttpDevelopment,
    });
    const expiry = resolveTokenExpiry(result, result.access_token);
    const committed = await tenantWork(deps, (db) =>
      new UserMCPOAuthTokenRepository(db).completeClaimedRefresh(
        deps.userId,
        deps.mcpServerId,
        fence,
        {
          accessToken: result.access_token,
          refreshToken: result.refresh_token,
          expiresAt: expiry.expiresAt,
        }
      )
    );
    if (!committed) return observeCommittedRefresh(deps, fence);
    console.log('[MCP OAuth Refresh] refresh_succeeded category=committed');
    return result.access_token;
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

async function refreshStandalone(deps: RefreshAndPersistDeps): Promise<string> {
  const userTokenRepo = new UserMCPOAuthTokenRepository(deps.db as Database);
  const row = await userTokenRepo.getToken(deps.userId, deps.mcpServerId);
  if (!row?.oauth_refresh_token) throw new MissingRefreshTokenError();
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
    });
    const expiry = resolveTokenExpiry(result, result.access_token);
    await userTokenRepo.saveToken(deps.userId, deps.mcpServerId, {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: expiry.expiresAt,
    });
    return result.access_token;
  } catch (error) {
    if (error instanceof InvalidGrantError) {
      await userTokenRepo.deleteToken(deps.userId, deps.mcpServerId);
      notifyInvalidGrant(deps);
    }
    throw error;
  }
}

export async function refreshAndPersistToken(deps: RefreshAndPersistDeps): Promise<string> {
  if (isPostgresDatabaseHandle(deps.db)) return refreshPostgres(deps);
  const key = mutexKey(deps.userId, deps.mcpServerId);
  const existing = _inFlightRefreshes.get(key);
  if (existing) return existing;
  const refresh = refreshStandalone(deps);
  _inFlightRefreshes.set(key, refresh);
  try {
    return await refresh;
  } finally {
    _inFlightRefreshes.delete(key);
  }
}

export function needsRefresh(expiresAt: Date | number | null | undefined): boolean {
  if (expiresAt == null) return false;
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : expiresAt;
  return Date.now() >= ms - REFRESH_BUFFER_MS;
}
