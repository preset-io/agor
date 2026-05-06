/**
 * MCP OAuth Token Refresh (RFC 6749 §6)
 *
 * Exchanges a saved refresh_token for a new access_token without user
 * interaction. Invoked just-in-time from the daemon service that hands
 * auth headers to the executor.
 *
 * Contract with the refresh call site:
 *   - The caller MUST hold a per-(user, server) mutex — two concurrent
 *     refreshes against the same refresh_token can fail or, with strict
 *     providers, revoke the entire grant chain. `refreshAndPersistToken`
 *     in this module does the locking.
 *   - On `invalid_grant`, the token row is deleted so the user gets an
 *     "please re-auth" state. All other HTTP/network errors are surfaced
 *     to the caller (NOT swallowed) — the access token stays in place
 *     in case the failure is transient.
 *
 * Out of scope (tracked as follow-ups in the PR description):
 *   - Retry-on-401 shim for the MCP transport.
 *   - `registration_access_token` / `registration_client_uri` capture
 *     from DCR for future client-management.
 *   - Background refresh scheduler (deliberately rejected — JIT is
 *     simpler, avoids wasted refreshes on idle users, and has the same
 *     correctness properties for our access patterns).
 */

import type { Database } from '../../db/client';
import { MCPServerRepository, UserMCPOAuthTokenRepository } from '../../db/repositories';
import type { MCPServerID, UserID } from '../../types';
import { inferOAuthTokenUrl } from './oauth-auth';
import { resolveTokenExpiry } from './oauth-token-expiry';

/** 60s safety window before hard expiry. */
export const REFRESH_BUFFER_MS = 60_000;

export class InvalidGrantError extends Error {
  readonly code = 'invalid_grant';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGrantError';
  }
}

export class MissingRefreshTokenError extends Error {
  readonly code = 'missing_refresh_token';
  constructor(message: string = 'No stored refresh_token available for this grant') {
    super(message);
    this.name = 'MissingRefreshTokenError';
  }
}

export class MissingTokenEndpointError extends Error {
  readonly code = 'missing_token_endpoint';
  constructor(message: string = 'Could not determine OAuth token endpoint for refresh') {
    super(message);
    this.name = 'MissingTokenEndpointError';
  }
}

export interface RefreshMCPTokenOptions {
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  /** Public clients omit this. */
  clientSecret?: string;
}

export interface RefreshMCPTokenResult {
  access_token: string;
  /**
   * Present when the provider rotates refresh tokens (OAuth 2.1 / public
   * clients). Callers must persist this and DISCARD the old value.
   */
  refresh_token?: string;
  /** Seconds until the access token expires. */
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
  error_description?: string;
}

/**
 * Pure HTTP call: POST `grant_type=refresh_token` to the token endpoint.
 *
 * Mirrors `exchangeCodeForToken` in oauth-mcp-transport.ts for auth style —
 * Basic auth when `client_secret` is present (RFC 6749 §2.3.1), otherwise
 * `client_id` in the request body for public clients.
 *
 * Does NOT persist. Callers should prefer `refreshAndPersistToken`, which
 * handles mutexing, DB lookup, and invalid_grant cleanup.
 */
export async function refreshMCPToken(
  opts: RefreshMCPTokenOptions
): Promise<RefreshMCPTokenResult> {
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (opts.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')}`;
  } else {
    body.client_id = opts.clientId;
  }

  const response = await fetch(opts.tokenEndpoint, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const rawText = await response.text();
  let parsed: OAuthRefreshRawResponse;
  try {
    parsed = rawText ? (JSON.parse(rawText) as OAuthRefreshRawResponse) : {};
  } catch {
    throw new Error(
      `Token refresh returned non-JSON body (HTTP ${response.status}): ${rawText.slice(0, 200)}`
    );
  }

  if (!response.ok || parsed.error) {
    const err = parsed.error || `http_${response.status}`;
    const description = parsed.error_description ? ` — ${parsed.error_description}` : '';
    if (err === 'invalid_grant') {
      throw new InvalidGrantError(`invalid_grant${description}`);
    }
    throw new Error(`Token refresh failed (${response.status}): ${err}${description}`);
  }

  if (!parsed.access_token) {
    throw new Error(
      `Token refresh succeeded but response has no access_token. Keys: ${Object.keys(parsed).join(', ')}`
    );
  }

  const expiresInNum =
    parsed.expires_in != null
      ? Number.isFinite(Number(parsed.expires_in))
        ? Number(parsed.expires_in)
        : undefined
      : undefined;

  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    expires_in: expiresInNum,
    token_type: parsed.token_type,
    scope: parsed.scope,
  };
}

// ---------------------------------------------------------------------------
// Persistence-aware refresh with per-key mutex
// ---------------------------------------------------------------------------

type MutexKey = string;

/**
 * Module-level map of in-flight refreshes. Keyed on `${user|shared}:${server}`.
 *
 * Rationale: if a provider rotates refresh_tokens and two callers both fire a
 * refresh with the same (now-stale) refresh_token, the second call fails.
 * Worse, some providers treat a replayed refresh_token as a compromise signal
 * and revoke the whole grant chain. The mutex collapses concurrent refresh
 * attempts into a single HTTP call that all callers await.
 *
 * Module-local to avoid leaking internals on the package API surface. Tests
 * that need a clean slate should call {@link __resetRefreshMutexForTests}.
 */
const _inFlightRefreshes = new Map<MutexKey, Promise<string>>();

/**
 * Test-only hook: clears the in-flight refresh map. Do NOT call from
 * production code; there's no race-free reason to reach in here at runtime.
 */
export function __resetRefreshMutexForTests(): void {
  _inFlightRefreshes.clear();
}

/**
 * Test-only hook: snapshot the number of in-flight refreshes. Used to assert
 * the map clears after success/failure. Do NOT call from production code.
 */
export function __refreshMutexSizeForTests(): number {
  return _inFlightRefreshes.size;
}

function mutexKey(userId: UserID | null, serverId: MCPServerID): MutexKey {
  return `${userId ?? '<shared>'}:${serverId}`;
}

export interface RefreshAndPersistDeps {
  db: Database;
  userId: UserID | null;
  mcpServerId: MCPServerID;
  /** Optional hook for "re-auth needed" signals (FeathersJS app, etc.) */
  onInvalidGrant?: (info: { userId: UserID | null; mcpServerId: MCPServerID }) => void;
}

/**
 * Refresh the stored OAuth token and persist the rotation atomically.
 *
 * - Loads refresh_token + client_id + client_secret from `user_mcp_oauth_tokens`.
 * - Loads token endpoint from `mcp_servers.data.auth.oauth_token_url`; if
 *   missing, infers via {@link inferOAuthTokenUrl} from the server URL.
 *   (Full RFC 8414 re-discovery is avoided here because the refresh path is
 *   hot; if the server was originally DCR-registered, we persisted enough to
 *   refresh without re-fetching metadata.)
 * - On success: writes new access_token, rotated refresh_token if any, and
 *   new expiry back. Preserves client_id / client_secret unchanged.
 * - On `invalid_grant`: deletes the token row so the user is surfaced
 *   "please re-auth", then re-throws.
 *
 * Returns the new access_token string.
 */
export async function refreshAndPersistToken(deps: RefreshAndPersistDeps): Promise<string> {
  const key = mutexKey(deps.userId, deps.mcpServerId);

  const existing = _inFlightRefreshes.get(key);
  if (existing) {
    console.log(`[MCP OAuth Refresh] Piggybacking on in-flight refresh for ${key}`);
    return existing;
  }

  const promise = (async () => {
    const userTokenRepo = new UserMCPOAuthTokenRepository(deps.db);
    const mcpServerRepo = new MCPServerRepository(deps.db);

    const row = await userTokenRepo.getToken(deps.userId, deps.mcpServerId);
    if (!row) {
      throw new MissingRefreshTokenError(
        `No OAuth token row for user=${deps.userId ?? '<shared>'} server=${deps.mcpServerId}`
      );
    }
    if (!row.oauth_refresh_token) {
      throw new MissingRefreshTokenError();
    }

    const server = await mcpServerRepo.findById(deps.mcpServerId);
    const serverAuth = server?.auth;

    // client_id/client_secret come from the token row first (DCR-bound), with
    // fallback to server config for admin pre-registered apps where all users
    // share the same client credentials.
    const clientId = row.oauth_client_id ?? serverAuth?.oauth_client_id;
    const clientSecret = row.oauth_client_secret ?? serverAuth?.oauth_client_secret;

    if (!clientId) {
      throw new Error(
        `Cannot refresh OAuth token: no client_id available for server ${deps.mcpServerId}`
      );
    }

    let tokenEndpoint = serverAuth?.oauth_token_url;
    if (!tokenEndpoint && server?.url) {
      try {
        tokenEndpoint = inferOAuthTokenUrl(server.url);
        console.log(
          `[MCP OAuth Refresh] Inferred token endpoint from server URL: ${tokenEndpoint}`
        );
      } catch {
        // fall through to the throw below
      }
    }
    if (!tokenEndpoint) {
      throw new MissingTokenEndpointError();
    }

    console.log(
      `[MCP OAuth Refresh] Refreshing token for user=${deps.userId ?? '<shared>'} ` +
        `server=${deps.mcpServerId} endpoint=${tokenEndpoint}`
    );

    try {
      const result = await refreshMCPToken({
        tokenEndpoint,
        refreshToken: row.oauth_refresh_token,
        clientId,
        clientSecret,
      });

      // Resolve expiry via the shared cascade so this site behaves
      // identically to `persistOAuthToken` (initial-auth path). For providers
      // that omit `expires_in` on refresh (e.g. Notion), `expiry.expiresAt`
      // will be `null`, which `saveToken` writes as a literal `NULL` to
      // `oauth_token_expires_at` — surfaced in the UI as
      // "expires in: unknown" rather than the previous silent oscillation
      // between fake-1h and stale-NULL values. See Phase 3.5 in
      // `context/explorations/mcp-oauth-token-lifecycle.md`.
      const expiry = resolveTokenExpiry(result, result.access_token);

      // Persist atomically. Per RFC 6749 §6, an omitted refresh_token in the
      // response means the old one is still valid — keep it. When present,
      // the rotation replaces the old value.
      await userTokenRepo.saveToken(deps.userId, deps.mcpServerId, {
        accessToken: result.access_token,
        expiresAt: expiry.expiresAt, // Date | null — null means "unknown"
        refreshToken: result.refresh_token, // undefined = keep existing
        // Don't touch client_id / client_secret — same grant, same client.
      });

      console.log(
        `[MCP OAuth Refresh] ✓ Refreshed token for user=${deps.userId ?? '<shared>'} ` +
          `server=${deps.mcpServerId} (expiry source: ${expiry.source}` +
          `${expiry.expiresAt !== null ? `, expires=${expiry.expiresAt.toISOString()}` : ', expires=unknown'})` +
          `${result.refresh_token ? ' (with rotated refresh_token)' : ''}`
      );

      return result.access_token;
    } catch (err) {
      if (err instanceof InvalidGrantError) {
        console.warn(
          `[MCP OAuth Refresh] invalid_grant for user=${deps.userId ?? '<shared>'} ` +
            `server=${deps.mcpServerId} — deleting token row, user must re-auth`
        );
        try {
          await userTokenRepo.deleteToken(deps.userId, deps.mcpServerId);
        } catch (deleteErr) {
          console.error(
            '[MCP OAuth Refresh] Failed to delete token row after invalid_grant:',
            deleteErr
          );
        }
        if (deps.onInvalidGrant) {
          try {
            deps.onInvalidGrant({ userId: deps.userId, mcpServerId: deps.mcpServerId });
          } catch (hookErr) {
            console.error('[MCP OAuth Refresh] onInvalidGrant hook threw:', hookErr);
          }
        }
      }
      throw err;
    }
  })();

  _inFlightRefreshes.set(key, promise);
  try {
    return await promise;
  } finally {
    _inFlightRefreshes.delete(key);
  }
}

/**
 * Check whether a token needs refreshing. Returns `true` when the token is
 * absent, expired, or within {@link REFRESH_BUFFER_MS} of expiry.
 */
export function needsRefresh(expiresAt: Date | number | null | undefined): boolean {
  if (expiresAt == null) return false; // unknown expiry → trust current token
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : expiresAt;
  return Date.now() >= ms - REFRESH_BUFFER_MS;
}
