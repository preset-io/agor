/**
 * OAuth 2.0 Authentication for MCP Servers
 *
 * Handles OAuth 2.0 token fetching and caching for MCP servers that require OAuth authentication.
 * Supports Client Credentials flow with automatic token expiry handling.
 *
 * Debug Features:
 * - Detailed step-by-step diagnostics
 * - Request/response logging with sanitized credentials
 * - Auto-detection tracking
 * - Cache hit/miss tracking
 */

export interface OAuthConfig {
  token_url: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  grant_type?: string;
  insecure?: boolean;
  /** Exact loopback HTTP exception for standalone development only. */
  allowLocalhostHttp?: boolean;
  /** Trusted tenant/server/subject namespace for process-local caching. */
  cacheNamespace?: string;
  /** Durable daemon paths disable this process-local bearer cache. */
  cache?: boolean;
  /** Optional live request authority for secret-bearing provider work. */
  assertCurrent?: () => void;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
  fetchedAt: number;
}

export interface OAuthDebugStep {
  step: string;
  status: 'success' | 'error' | 'warning' | 'info';
  details: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface OAuthDebugInfo {
  steps: OAuthDebugStep[];
  tokenUrl: string;
  tokenUrlSource: 'provided' | 'auto-detected' | 'template';
  credentialsSource: 'explicit' | 'env_vars' | 'partial';
  clientIdMasked: string;
  scope?: string;
  grantType: string;
  tokenExpiresIn?: number;
  cacheKey: string;
  cacheHit: boolean;
  tokenFetchedAt?: Date;
  tokenExpiresAt?: Date;
}

import { createHash } from 'node:crypto';
import { safeOutboundFetch } from '../../utils/safe-outbound-fetch';
import { asMCPExternalError, sanitizeMCPExternalError } from './external-error';
import { resolveTokenExpiry } from './oauth-token-expiry';

// Cache tokens per unique credential set to avoid cross-tenant leakage
const oauthTokenCache = new Map<string, CachedToken>();

// In-memory cache TTL fallback when `resolveTokenExpiry` cannot determine an
// expiry from the token response. This bounds the lifetime of THIS module's
// `oauthTokenCache` map only — there is no DB persistence for client-credentials
// tokens, so this is purely local-cache hygiene.
const UNKNOWN_EXPIRY_CACHE_TTL_SECONDS = 900;

// Buffer before expiry to avoid using soon-to-expire tokens
const EXPIRY_BUFFER_SECONDS = 30;

/**
 * Generate a non-secret cache key for OAuth credentials. Callers that can
 * serve more than one authority domain must supply a trusted namespace (or
 * disable the cache); the daemon always disables it in PostgreSQL mode.
 */
function getCacheKey(config: OAuthConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 2,
        namespace: config.cacheNamespace ?? '<standalone>',
        tokenUrl: config.token_url,
        clientId: config.client_id ?? null,
        clientSecret: config.client_secret ?? null,
        scope: config.scope ?? null,
        grantType: config.grant_type ?? 'client_credentials',
      }),
      'utf8'
    )
    .digest('hex');
}

/**
 * Sanitize OAuth config for logging (mask secrets)
 */
function sanitizeConfigForLogging(config: OAuthConfig): Record<string, unknown> {
  return {
    has_token_url: Boolean(config.token_url),
    has_client_id: Boolean(config.client_id),
    has_client_secret: Boolean(config.client_secret),
    has_scope: Boolean(config.scope),
    grant_type: config.grant_type === 'client_credentials' ? 'client_credentials' : 'configured',
    insecure: config.insecure || false,
  };
}

/**
 * Fetch OAuth 2.0 access token from token endpoint
 *
 * Supports Client Credentials flow with automatic caching based on expires_in.
 * Returns detailed debug information for troubleshooting OAuth issues.
 *
 * @param config - OAuth configuration
 * @param debug - Enable detailed debug tracking
 * @returns Object with token and optional debug info
 * @throws Error if token fetch fails
 */
export async function fetchOAuthToken(
  config: OAuthConfig,
  debug: boolean = false
): Promise<{ token: string; debugInfo?: OAuthDebugInfo }> {
  config.assertCurrent?.();
  const debugSteps: OAuthDebugStep[] = [];
  const startTime = Date.now();

  const addDebugStep = (
    step: string,
    status: OAuthDebugStep['status'],
    details: string,
    data?: Record<string, unknown>
  ) => {
    if (debug) {
      debugSteps.push({
        step,
        status,
        details,
        timestamp: Date.now() - startTime,
        data,
      });
    }
  };

  // Step 1: Validate configuration
  addDebugStep(
    'validate_config',
    'info',
    'Validating OAuth configuration',
    sanitizeConfigForLogging(config)
  );

  if (!config.token_url) {
    addDebugStep('validate_config', 'error', 'Token URL is required but not provided');
    throw new Error('OAuth token URL is required');
  }

  if (!config.client_id || !config.client_secret) {
    addDebugStep(
      'validate_config',
      'error',
      'Client credentials missing. Ensure client_id and client_secret are provided or resolved from environment variables.'
    );
    throw new Error(
      'OAuth credentials not configured. Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET environment variables or provide explicit values.'
    );
  }

  addDebugStep('validate_config', 'success', 'Configuration validated');

  // Step 2: Check cache
  const cacheKey = getCacheKey(config);
  const cacheEnabled = config.cache !== false;
  const cached = cacheEnabled ? oauthTokenCache.get(cacheKey) : undefined;

  if (cached && cached.expiresAt > Date.now()) {
    config.assertCurrent?.();
    const ttlRemaining = Math.floor((cached.expiresAt - Date.now()) / 1000);
    addDebugStep('check_cache', 'success', `Cache hit! Token still valid for ${ttlRemaining}s`, {
      fetchedAt: new Date(cached.fetchedAt).toISOString(),
      expiresAt: new Date(cached.expiresAt).toISOString(),
    });

    if (debug) {
      return {
        token: cached.token,
        debugInfo: {
          steps: debugSteps,
          tokenUrl: '<configured>',
          tokenUrlSource: 'provided',
          credentialsSource: 'explicit',
          clientIdMasked: '<configured>',
          scope: config.scope ? '<configured>' : undefined,
          grantType: config.grant_type || 'client_credentials',
          cacheKey: '<opaque>',
          cacheHit: true,
          tokenFetchedAt: new Date(cached.fetchedAt),
          tokenExpiresAt: new Date(cached.expiresAt),
        },
      };
    }

    return { token: cached.token };
  }

  if (cached) {
    addDebugStep('check_cache', 'info', 'Cached token expired, fetching new token');
  } else if (!cacheEnabled) {
    addDebugStep('check_cache', 'info', 'Process-local OAuth token cache disabled');
  } else {
    addDebugStep('check_cache', 'info', 'No cached token found, fetching new token');
  }

  // Step 3: Prepare request
  const grantType = config.grant_type || 'client_credentials';
  const body = new URLSearchParams({
    grant_type: grantType,
    client_id: config.client_id,
    client_secret: config.client_secret,
  });

  if (config.scope) {
    body.append('scope', config.scope);
  }

  addDebugStep('prepare_request', 'info', 'Preparing OAuth token request', {
    grant_type: grantType,
    has_scope: Boolean(config.scope),
    content_type: 'application/x-www-form-urlencoded',
  });

  // Step 4: Fetch token
  let response: Response;
  try {
    addDebugStep('fetch_token', 'info', 'Sending OAuth token request');

    response = await safeOutboundFetch(config.token_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      redirect: 'error',
      timeoutMs: 15_000,
      allowLocalhostHttp: config.allowLocalhostHttp,
      assertCurrent: config.assertCurrent,
    });

    addDebugStep('fetch_token', 'info', `Received response with status ${response.status}`, {
      status: response.status,
    });
  } catch (error: unknown) {
    // Preserve caller authority errors rather than wrapping them as a generic
    // provider failure that an outer compatibility layer may swallow.
    config.assertCurrent?.();
    const safe = sanitizeMCPExternalError(error, { stage: 'oauth' });
    addDebugStep('fetch_token', 'error', safe.message, safe.diagnostic);
    throw asMCPExternalError(error, { stage: 'oauth' });
  }

  // Step 5: Handle response
  if (!response.ok) {
    addDebugStep('handle_response', 'error', `Token fetch failed with status ${response.status}`, {
      status: response.status,
    });

    // Provide helpful error messages
    throw asMCPExternalError(undefined, {
      stage: 'oauth',
      category: 'provider_rejected',
    });
  }

  // Step 6: Parse response
  let data: OAuthTokenResponse;
  try {
    data = (await response.json()) as OAuthTokenResponse;
    config.assertCurrent?.();
    addDebugStep('parse_response', 'success', 'Successfully parsed OAuth response', {
      expires_in: data.expires_in,
      has_refresh_token: !!data.refresh_token,
    });
  } catch (error: unknown) {
    config.assertCurrent?.();
    const safe = sanitizeMCPExternalError(error, {
      stage: 'oauth',
      category: 'invalid_response',
    });
    addDebugStep('parse_response', 'error', safe.message, safe.diagnostic);
    throw asMCPExternalError(error, { stage: 'oauth', category: 'invalid_response' });
  }

  if (!data.access_token) {
    addDebugStep('parse_response', 'error', 'OAuth response did not contain a usable token');
    throw asMCPExternalError(undefined, { stage: 'oauth', category: 'invalid_response' });
  }

  // Step 7: Cache token. Walk the shared cascade so this client-credentials
  // path agrees with the MCP user-grant paths on TTL resolution. When the
  // cascade returns null (provider gave no hint we could decode), fall back
  // to UNKNOWN_EXPIRY_CACHE_TTL_SECONDS — local-cache hygiene only.
  const fetchedAt = Date.now();
  const resolved = resolveTokenExpiry(data, data.access_token, fetchedAt);
  const ttlSeconds =
    resolved.expiresAt !== null
      ? Math.max(1, Math.floor((resolved.expiresAt.getTime() - fetchedAt) / 1000))
      : UNKNOWN_EXPIRY_CACHE_TTL_SECONDS;
  const expiresInSeconds = ttlSeconds;
  const expiresAt = fetchedAt + (ttlSeconds - EXPIRY_BUFFER_SECONDS) * 1000;

  if (cacheEnabled) {
    oauthTokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt,
      fetchedAt,
    });
  }

  addDebugStep(
    'cache_token',
    'success',
    cacheEnabled
      ? `Token cached for ${expiresInSeconds}s (${EXPIRY_BUFFER_SECONDS}s buffer)`
      : 'Process-local OAuth token cache bypassed',
    {
      expiresIn: expiresInSeconds,
      expiresAt: new Date(expiresAt).toISOString(),
      buffer: EXPIRY_BUFFER_SECONDS,
    }
  );

  if (debug) {
    return {
      token: data.access_token,
      debugInfo: {
        steps: debugSteps,
        tokenUrl: '<configured>',
        tokenUrlSource: 'provided',
        credentialsSource: config.client_id?.includes('{{') ? 'env_vars' : 'explicit',
        clientIdMasked: '<configured>',
        scope: config.scope ? '<configured>' : undefined,
        grantType: grantType,
        tokenExpiresIn: expiresInSeconds,
        cacheKey: '<opaque>',
        cacheHit: false,
        tokenFetchedAt: new Date(fetchedAt),
        tokenExpiresAt: new Date(expiresAt),
      },
    };
  }

  return { token: data.access_token };
}

/**
 * Infer OAuth token URL from MCP server URL
 *
 * Tries common OAuth token endpoint patterns based on the MCP URL path structure.
 * Common patterns:
 * - /oauth/token (standard OAuth 2.0)
 * - /token (simplified path)
 * - Same path as MCP with /oauth/token suffix (e.g., /mcp -> /mcp/oauth/token)
 *
 * @param mcpUrl - MCP server URL (e.g., "https://example.com/mcp")
 * @returns Inferred token URL (e.g., "https://example.com/oauth/token")
 *
 * @example
 * inferOAuthTokenUrl("https://api.example.com/mcp")
 * // Returns: "https://api.example.com/oauth/token"
 *
 * @example
 * inferOAuthTokenUrl("https://example.com/v1/mcp")
 * // Returns: "https://example.com/oauth/token"
 */
export function inferOAuthTokenUrl(mcpUrl: string): string {
  try {
    const url = new URL(mcpUrl);

    // Strategy 1: If MCP is at /mcp, try /oauth/token at root
    // Most common pattern: MCP at /mcp, OAuth at /oauth/token
    if (url.pathname === '/mcp' || url.pathname.endsWith('/mcp')) {
      return `${url.origin}/oauth/token`;
    }

    // Strategy 2: If MCP is in a versioned path (e.g., /v1/mcp), use root /oauth/token
    if (url.pathname.match(/^\/v\d+\//)) {
      return `${url.origin}/oauth/token`;
    }

    // Strategy 3: Try token endpoint relative to MCP path
    // e.g., /services/mcp -> /services/oauth/token
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length > 1) {
      pathParts.pop(); // Remove last segment (e.g., "mcp")
      return `${url.origin}/${pathParts.join('/')}/oauth/token`;
    }

    // Strategy 4: Default to /oauth/token at origin
    return `${url.origin}/oauth/token`;
  } catch {
    return '';
  }
}

/**
 * Clear cached OAuth token for specific credentials
 *
 * Use this when you need to force token refresh, such as when:
 * - Credentials have been updated
 * - Token has been revoked server-side
 * - User is switching accounts
 *
 * @param config - OAuth config to clear (optional, clears all tokens if not provided)
 *
 * @example
 * // Clear specific server's token
 * clearOAuthCache({ token_url: "https://api.example.com/oauth/token", client_id: "..." })
 *
 * @example
 * // Clear all cached tokens (e.g., on logout)
 * clearOAuthCache()
 */
export function clearOAuthCache(config?: OAuthConfig): void {
  if (config) {
    const cacheKey = getCacheKey(config);
    oauthTokenCache.delete(cacheKey);
  } else {
    oauthTokenCache.clear();
  }
}

/**
 * Get OAuth token cache statistics for debugging and monitoring
 *
 * Useful for:
 * - Monitoring cache efficiency
 * - Debugging token expiry issues
 * - Understanding token refresh patterns
 *
 * @returns Object with totalEntries, validEntries, and expiredEntries counts
 *
 * @example
 * const stats = getOAuthCacheStats();
 * console.log(`Cache: ${stats.validEntries}/${stats.totalEntries} valid tokens`);
 */
export function getOAuthCacheStats(): {
  totalEntries: number;
  validEntries: number;
  expiredEntries: number;
} {
  const now = Date.now();
  let validEntries = 0;
  let expiredEntries = 0;

  for (const cached of oauthTokenCache.values()) {
    if (cached.expiresAt > now) {
      validEntries++;
    } else {
      expiredEntries++;
    }
  }

  return {
    totalEntries: oauthTokenCache.size,
    validEntries,
    expiredEntries,
  };
}
