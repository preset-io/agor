/**
 * JWT Authentication for MCP Servers
 *
 * Handles JWT token fetching and caching for MCP servers that require JWT authentication.
 * Tokens are cached for 15 minutes to avoid excessive API calls.
 */

import { createHash } from 'node:crypto';
import type { MCPAuth } from '../../types/mcp';
import { type OutboundDnsLookup, safeOutboundFetch } from '../../utils/safe-outbound-fetch';
import { asMCPExternalError } from './external-error';
import { fetchOAuthToken, inferOAuthTokenUrl } from './oauth-auth';

interface JWTConfig {
  api_url: string;
  api_token: string;
  api_secret: string;
  insecure?: boolean;
}

interface CachedToken {
  apiUrl: string;
  token: string;
  expiresAt: number;
}

export interface JWTTokenFetchOptions {
  /** Exact loopback HTTP exception for standalone development only. */
  allowLocalhostHttp?: boolean;
  /** Trusted tenant/server/user namespace for the process-local compatibility cache. */
  cacheNamespace?: string;
  /** PostgreSQL/hosted callers disable process-local bearer caching. */
  cache?: boolean;
  /** Optional live request authority for secret-bearing provider work. */
  assertCurrent?: () => void | Promise<void>;
  /** Optional narrower fence invoked by safeOutboundFetch only at physical dispatch. */
  assertBeforeDispatch?: () => void | Promise<void>;
  /** Injectable DNS boundary for deterministic authority-race tests. */
  resolveDns?: OutboundDnsLookup;
}

// Cache tokens per unique credential set to avoid cross-tenant leakage
const tokenCache = new Map<string, CachedToken>();
// Token validity duration: 15 minutes (in milliseconds)
const TOKEN_TTL_MS = 15 * 60 * 1000;

function getCacheKey(config: JWTConfig, namespace: string): string {
  // Do not retain credentials in a Map key, heap snapshot, or diagnostic dump.
  return createHash('sha256')
    .update('agor:mcp-jwt-cache:v1\0')
    .update(namespace)
    .update('\0')
    .update(config.api_url)
    .update('\0')
    .update(config.api_token)
    .update('\0')
    .update(config.api_secret)
    .digest('hex');
}

/**
 * Fetch a JWT token from the authentication endpoint
 *
 * @param config - JWT configuration containing api_url, api_token, and api_secret
 * @returns The access token string
 * @throws Error if token fetch fails
 */
export async function fetchJWTToken(
  config: JWTConfig,
  options: JWTTokenFetchOptions = {}
): Promise<string> {
  await options.assertCurrent?.();
  const { api_url, api_token, api_secret } = config;
  const shouldCache = options.cache !== false;
  const cacheKey = getCacheKey(config, options.cacheNamespace ?? '<standalone>');

  // Check cache first
  const cached = shouldCache ? tokenCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    await options.assertCurrent?.();
    return cached.token;
  }

  // Fetch new token
  let response: Response;
  try {
    response = await safeOutboundFetch(api_url, {
      method: 'POST',
      redirect: 'error',
      timeoutMs: 15_000,
      maxResponseBytes: 256 * 1024,
      allowLocalhostHttp: options.allowLocalhostHttp ?? true,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: api_token,
        secret: api_secret,
      }),
      assertCurrent: options.assertBeforeDispatch ?? options.assertCurrent,
      resolveDns: options.resolveDns,
    });
  } catch (error) {
    // Network/TLS libraries may reflect the endpoint or request values. Keep
    // their exception entirely behind the closed MCP error boundary.
    await options.assertCurrent?.();
    throw asMCPExternalError(error, { stage: 'jwt' });
  }

  if (!response.ok) {
    // Provider bodies frequently contain secrets or reflected internal data.
    // Emit only a stable category and status.
    throw asMCPExternalError(undefined, { stage: 'jwt', category: 'provider_rejected' });
  }

  let data: { access_token?: string; payload?: { access_token?: string } };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    await options.assertCurrent?.();
    throw asMCPExternalError(undefined, { stage: 'jwt', category: 'invalid_response' });
  }
  await options.assertCurrent?.();

  // Handle different response formats
  const token = data.access_token || data.payload?.access_token;
  if (!token) {
    throw asMCPExternalError(undefined, { stage: 'jwt', category: 'invalid_response' });
  }

  // Cache the token
  if (shouldCache) {
    tokenCache.set(cacheKey, {
      apiUrl: api_url,
      token,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
  }

  return token;
}

/**
 * Clear cached token for a specific API URL
 *
 * @param api_url - The API URL to clear from cache
 */
export function clearJWTToken(api_url: string): void {
  for (const [key, value] of tokenCache.entries()) {
    if (value.apiUrl === api_url) {
      tokenCache.delete(key);
    }
  }
}

/**
 * Clear all cached JWT tokens
 */
export function clearAllJWTTokens(): void {
  tokenCache.clear();
}

/**
 * Get MCP server connection args with JWT authentication
 *
 * For MCP servers using JWT auth, this returns the mcp-remote compatible
 * command and args. The token is passed via environment variable to avoid
 * exposing it in process arguments (visible via ps/logs).
 *
 * @param serverUrl - The MCP server URL
 * @param jwtConfig - JWT configuration
 * @returns Object with command, args, and env for spawning the MCP connection
 */
export async function getMCPRemoteArgsWithJWT(
  serverUrl: string,
  jwtConfig: JWTConfig
): Promise<{ command: string; args: string[]; env: Record<string, string> }> {
  const token = await fetchJWTToken(jwtConfig);

  // SECURITY: Pass token via environment variable instead of command-line args
  // to prevent exposure in process lists (ps) and supervisor logs
  return {
    command: 'npx',
    args: ['mcp-remote', serverUrl, '--header', 'Authorization: Bearer $MCP_AUTH_TOKEN'],
    env: {
      MCP_AUTH_TOKEN: token,
    },
  };
}

/**
 * Build Authorization headers for an MCP server based on its auth config.
 *
 * @param auth - MCP authentication configuration
 * @param mcpUrl - MCP server URL (used for OAuth token URL auto-detection)
 * @returns Header map including Authorization when applicable
 */
export async function resolveMCPAuthHeaders(
  auth?: MCPAuth,
  mcpUrl?: string,
  options: {
    allowLocalhostHttp?: boolean;
    cacheNamespace?: string;
    disableProcessTokenCache?: boolean;
    /** Optional live request authority for provider/token use. */
    assertCurrent?: () => void /**
     * Identifies the authority that supplied OAuth credentials for this
     * handoff. The executor repository is tenant/user/generation scoped and
     * authoritative: an empty result must not fall through to a second
     * client-credentials exchange from persisted configuration.
     */;
    oauthCredentialAuthority?: 'configuration' | 'executor_repository';
  } = {}
): Promise<Record<string, string> | undefined> {
  options.assertCurrent?.();
  if (!auth || auth.type === 'none') {
    return undefined;
  }

  if (auth.type === 'bearer') {
    if (!auth.token) {
      console.warn('MCP bearer authentication configured without a token');
      return undefined;
    }
    return {
      Authorization: `Bearer ${auth.token}`,
    };
  }

  if (auth.type === 'jwt') {
    const { api_url, api_token, api_secret } = auth;
    if (!api_url || !api_token || !api_secret) {
      console.warn('MCP JWT authentication missing api_url, api_token, or api_secret');
      return undefined;
    }

    const token = await fetchJWTToken(
      {
        api_url,
        api_token,
        api_secret,
        insecure: auth.insecure,
      },
      {
        allowLocalhostHttp: options.allowLocalhostHttp ?? true,
        cacheNamespace: options.cacheNamespace,
        cache: options.disableProcessTokenCache !== true,
        assertCurrent: options.assertCurrent,
      }
    );

    return {
      Authorization: `Bearer ${token}`,
    };
  }

  if (auth.type === 'oauth') {
    // Priority 1: Check for database-stored OAuth 2.1 token (persisted from browser flow)
    if (auth.oauth_access_token) {
      // Check if token is expired
      if (auth.oauth_token_expires_at && auth.oauth_token_expires_at <= Date.now()) {
      } else {
        return {
          Authorization: `Bearer ${auth.oauth_access_token}`,
        };
      }
    }

    // The executor repository is authoritative for per-user OAuth grants. If
    // it returned no token, do not fan out into a second client-credentials
    // probe with persisted configuration from the same server row.
    if (options.oauthCredentialAuthority === 'executor_repository') return undefined;

    // Browser authorization-code tokens must arrive through the caller's
    // trusted, server/user-scoped durable record. The legacy origin-only
    // process cache is deliberately not consulted here: two tenants or users
    // can configure different grants for the same MCP origin.
    if (!auth.oauth_client_id && !auth.oauth_client_secret) {
      return undefined;
    }

    // Auto-detect token URL if not provided
    let tokenUrl = auth.oauth_token_url;
    if (!tokenUrl && mcpUrl) {
      tokenUrl = inferOAuthTokenUrl(mcpUrl);
      // The inferred endpoint can retain user-derived origin/path material.
      // Its presence is operationally useful; its value is not safe to log.
      console.log('[OAuth] Token URL inferred from MCP endpoint');
    }

    if (!tokenUrl) {
      console.warn('[OAuth] Token URL could not be determined');
      return undefined;
    }

    try {
      const { token } = await fetchOAuthToken({
        token_url: tokenUrl,
        client_id: auth.oauth_client_id,
        client_secret: auth.oauth_client_secret,
        scope: auth.oauth_scope,
        grant_type: auth.oauth_grant_type,
        insecure: auth.insecure,
        // Direct core/executor use is the standalone compatibility path.
        // PostgreSQL daemon callers explicitly pass false and disable caching.
        allowLocalhostHttp: options.allowLocalhostHttp ?? true,
        cacheNamespace: options.cacheNamespace,
        cache: options.disableProcessTokenCache !== true,
        assertCurrent: options.assertCurrent,
      });

      return {
        Authorization: `Bearer ${token}`,
      };
    } catch {
      // Never downgrade identity/authority loss into an unauthenticated MCP
      // fallback after client credentials crossed the provider boundary.
      options.assertCurrent?.();
      // Provider/network exceptions may include the endpoint, redirected URL,
      // response body, or reflected credentials. Keep this diagnostic fixed.
      console.warn('[OAuth] Token fetch failed');
      return undefined;
    }
  }

  return undefined;
}
